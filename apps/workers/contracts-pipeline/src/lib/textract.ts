type TextractEnvironment = Pick<Env, "AWS_ACCESS_KEY_ID" | "AWS_REGION" | "AWS_SECRET_ACCESS_KEY">;

/**
 * AWS Textract client over aws4fetch (SigV4 signing built for Workers — no
 * Node SDK needed). Uses the ASYNC StartDocumentTextDetection flow reading
 * straight from S3: the Worker never downloads the document, supports files
 * up to 500 MB and multi-page PDFs, and the Workflow polls the job with
 * step.sleep (zero CPU cost).
 *
 * Throttling (ProvisionedThroughputExceededException / ThrottlingException)
 * is expected when many pipelines start at once — those errors are flagged
 * `retryable` so the Workflow's exponential-backoff step retries absorb them.
 */

import { AwsClient } from "aws4fetch";

import { joinPageLines } from "./contract-analysis";

export type TextractError = Error & { retryable?: boolean };

const RETRYABLE_ERRORS = /Throttling|ProvisionedThroughputExceeded|LimitExceeded|InternalServer|ServiceUnavailable/i;

function awsClient(env: TextractEnvironment): AwsClient {
  return new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: env.AWS_REGION,
    service: "textract",
  });
}

async function textractCall<T>(env: TextractEnvironment, target: string, body: Record<string, unknown>): Promise<T> {
  const response = await awsClient(env).fetch(`https://textract.${env.AWS_REGION}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `Textract.${target}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    let errorType = response.headers.get("x-amzn-errortype") ?? "";
    try {
      errorType = (JSON.parse(text).__type as string) ?? errorType;
    } catch {
      // non-JSON error body — keep the header value
    }
    const error: TextractError = new Error(
      `Textract ${target} -> ${response.status} ${errorType}: ${text.slice(0, 200)}`
    );
    error.retryable = RETRYABLE_ERRORS.test(`${errorType} ${text}`) || response.status >= 500;
    throw error;
  }
  return JSON.parse(text) as T;
}

/** Starts an async text-detection job reading directly from S3 (no download). */
export async function startTextDetection(env: TextractEnvironment, bucket: string, key: string): Promise<string> {
  const result = await textractCall<{ JobId?: string }>(env, "StartDocumentTextDetection", {
    DocumentLocation: { S3Object: { Bucket: bucket, Name: key } },
  });
  if (!result.JobId) throw new Error("Textract did not return a JobId");
  return result.JobId;
}

type TextractBlock = { BlockType?: string; Text?: string; Page?: number };
type GetDetectionResponse = {
  JobStatus: "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "PARTIAL_SUCCESS";
  StatusMessage?: string;
  DocumentMetadata?: { Pages?: number };
  Warnings?: { ErrorCode?: string; Pages?: number[] }[];
  Blocks?: TextractBlock[];
  NextToken?: string;
};

/** One page of results — used for cheap status polling (MaxResults=1). The
 * page count is only known once the job has finished. */
export async function getTextDetectionStatus(
  env: TextractEnvironment,
  jobId: string
): Promise<{ status: string; message?: string; pages?: number }> {
  const result = await textractCall<GetDetectionResponse>(env, "GetDocumentTextDetection", {
    JobId: jobId,
    MaxResults: 1,
  });
  return { status: result.JobStatus, message: result.StatusMessage, pages: result.DocumentMetadata?.Pages };
}

/**
 * Collects every result page (NextToken pagination) and joins LINE blocks,
 * opening each page with a `[[p. N]]` marker so the analysis can cite pages.
 * `failedPages` lists pages Textract could not read (PARTIAL_SUCCESS).
 */
export async function collectTextDetectionText(
  env: TextractEnvironment,
  jobId: string,
  options: { pageMarkers?: boolean } = {}
): Promise<{ text: string; pages: number; failedPages: number[] }> {
  const lines: { text: string; page?: number }[] = [];
  const failed = new Set<number>();
  let pages = 0;
  let nextToken: string | undefined;
  do {
    // Pagination is sequential: each call needs the previous NextToken.
    // eslint-disable-next-line no-await-in-loop
    const page: GetDetectionResponse = await textractCall<GetDetectionResponse>(env, "GetDocumentTextDetection", {
      JobId: jobId,
      MaxResults: 1000,
      ...(nextToken ? { NextToken: nextToken } : {}),
    });
    pages = page.DocumentMetadata?.Pages ?? pages;
    for (const warning of page.Warnings ?? []) for (const number of warning.Pages ?? []) failed.add(number);
    for (const block of page.Blocks ?? []) {
      if (block.BlockType === "LINE" && block.Text) lines.push({ text: block.Text, page: block.Page });
    }
    nextToken = page.NextToken;
  } while (nextToken);
  const text = options.pageMarkers === false ? lines.map((line) => line.text).join("\n") : joinPageLines(lines);
  return { text, pages, failedPages: [...failed].sort((a, b) => a - b) };
}
