/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * A contract the assistant prepares from a template: the template, variant
 * and version; one field per variable (typed as its settings say, with where
 * the value came from); the signers by role; a PDF preview with the values;
 * and "Crear borrador", which leaves the request ready and opens the send
 * screen. The person sends it from there: the assistant never sends.
 */

import { useState } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { Eye, FileSignature } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractTemplateWarning } from "@plane/types";
import { cn } from "@plane/utils";
import { TemplateWarnings } from "@/components/file-library/contracts/template-warnings";
import { assistantService } from "@/services/assistant.service";
import { CARD, FIELD, Footer, alreadyUndone, errorText, useOutcome } from "./action-cards";
import { AssistantLink, useAssistantNavigate } from "./links";
import { outcomeFromAction } from "./outcome-store";
import { TraceLine } from "./steps";

type TVariable = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[] | null;
  default?: string | null;
  help?: string | null;
  value: string;
  source?: string | null;
};

type TSigner = {
  index: number;
  role: string;
  name: string;
  email: string;
  source?: string | null;
  requires_name: boolean;
  requires_email: boolean;
};

type TContractProposal = {
  template_name?: string;
  variant_id?: string;
  variant_name?: string;
  revision?: number | null;
  title?: string;
  variables?: TVariable[];
  signers?: TSigner[];
  missing?: string[];
  unknown_values?: string[] | null;
  warnings?: TContractTemplateWarning[] | null;
  document_edits?: {
    operations?: { op: string; applied: unknown[] }[];
    variable_settings?: Record<string, unknown>;
  } | null;
  document_edits_input?: unknown[];
  base_sha256?: string | null;
  variant_name_input?: string;
  summary?: string;
  workspace_slug?: string;
  error?: string;
};

type TApiError = { code?: string; key?: string; label?: string; index?: number; field?: string };

const PREFIX = "assistant.contract_draft";

function apiError(error: unknown): TApiError {
  const failure = error as TApiError & { response?: { data?: TApiError } };
  return failure?.response?.data ?? failure ?? {};
}

function ContractDraftForm({ proposal, toolCallId }: { proposal: TContractProposal; toolCallId: string }) {
  const { t } = useTranslation();
  const navigate = useAssistantNavigate();
  const slug = proposal.workspace_slug!;
  const variables = proposal.variables ?? [];
  const [outcome, remember, meta] = useOutcome(`assistant-contract-draft:${toolCallId}`);
  const [title, setTitle] = useState(proposal.title ?? "");
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(variables.map((item) => [item.key, item.value ?? ""]))
  );
  const [signers, setSigners] = useState(() =>
    (proposal.signers ?? []).map((item) => ({ name: item.name ?? "", email: item.email ?? "" }))
  );
  const [invalid, setInvalid] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const busy = outcome.state === "busy";
  const done = outcome.state !== "idle" && outcome.state !== "busy";
  const withEdits = (proposal.document_edits_input?.length ?? 0) > 0;
  const variantName = proposal.variant_name_input ?? `${proposal.variant_name} – ${title}`.slice(0, 200);

  // Optional blanks are left out of the Word, like "dejar en blanco" in "Usar"
  const omitted = variables.filter((item) => !item.required && !values[item.key]?.trim()).map((item) => item.key);
  const missingValues = variables.filter((item) => item.required && !values[item.key]?.trim() && !item.default);
  const missingSigners = (proposal.signers ?? []).filter(
    (item) =>
      (item.requires_name && !signers[item.index]?.name.trim()) ||
      (item.requires_email && !signers[item.index]?.email.includes("@"))
  );

  const body = () => ({
    revision: proposal.revision ?? undefined,
    title: title.trim(),
    values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])),
    omitted_keys: omitted,
    recipients: signers,
    document_edits: withEdits ? proposal.document_edits_input : undefined,
    variable_settings: withEdits ? proposal.document_edits?.variable_settings : undefined,
  });

  const preview = async () => {
    setPreviewing(true);
    try {
      const blob = await assistantService.contractDraftPreview(slug, proposal.variant_id!, body());
      window.open(URL.createObjectURL(blob), "_blank", "noopener");
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: errorText(error, t(`${PREFIX}.preview_failed`)) });
    } finally {
      setPreviewing(false);
    }
  };

  const failureText = (error: unknown) => {
    const failure = apiError(error);
    if (failure.code === "missing_value") {
      setInvalid(`variable:${failure.key}`);
      return t("file_library.contracts.workflow.errors.missing_value", { key: failure.label ?? failure.key ?? "" });
    }
    if (failure.code === "missing_signer" && typeof failure.index === "number") {
      setInvalid(`signer:${failure.index}`);
      return t(
        `file_library.contracts.workflow.errors.${failure.field === "email" ? "missing_signer_email" : "missing_signer_name"}`,
        { number: failure.index + 1 }
      );
    }
    return errorText(error, t("assistant.actions.failed"));
  };

  const apply = async () => {
    setInvalid(null);
    remember({ state: "busy" });
    try {
      const action = await assistantService.createAction(slug, {
        ...meta,
        kind: "CREATE_CONTRACT_DRAFT",
        variant_id: proposal.variant_id,
        base_sha256: withEdits ? proposal.base_sha256 : undefined,
        variant_name: withEdits ? variantName : undefined,
        ...body(),
      });
      remember(outcomeFromAction(action));
      const path = (action.result as { path?: string } | undefined)?.path;
      if (path) navigate(path);
    } catch (error) {
      remember({ state: "idle" });
      setToast({ type: TOAST_TYPE.ERROR, title: failureText(error) });
    }
  };
  const undo = async () => {
    if (!outcome.id) return;
    remember({ ...outcome, state: "busy" });
    try {
      const action = await assistantService.undoAction(slug, outcome.id);
      remember(outcomeFromAction(action));
    } catch (error) {
      if (alreadyUndone(error)) remember({ state: "undone", id: outcome.id });
      else {
        remember({ ...outcome, state: "applied" });
        setToast({ type: TOAST_TYPE.ERROR, title: errorText(error, t("assistant.actions.failed")) });
      }
    }
  };

  const result = outcome.result as { path?: string; title?: string; variant_name?: string } | undefined;
  const sourceOf = (key: string) => variables.find((item) => item.key === key)?.source;
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <FileSignature className="size-4 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">
          {t(`${PREFIX}.title`, { template: proposal.template_name ?? "" })}
        </p>
      </div>
      <p className="mt-0.5 text-11 text-tertiary">
        {t(`${PREFIX}.base`, { variant: proposal.variant_name ?? "", version: proposal.revision ?? "—" })}
      </p>
      {proposal.summary && <p className="mt-1.5 text-12 text-primary">{proposal.summary}</p>}
      {withEdits && (
        <p className="mt-1.5 rounded-md bg-layer-2 px-2 py-1 text-11 text-secondary">
          {t(`${PREFIX}.with_edits`, {
            count: proposal.document_edits?.operations?.length ?? proposal.document_edits_input?.length ?? 0,
            name: variantName,
          })}
        </p>
      )}

      <fieldset disabled={done || busy} className="mt-2 space-y-2">
        <label className="block">
          <span className="text-11 text-tertiary">{t(`${PREFIX}.contract_title`)}</span>
          <input
            value={title}
            maxLength={500}
            onChange={(event) => setTitle(event.target.value)}
            className={cn(FIELD, "mt-0.5")}
          />
        </label>

        {variables.length > 0 && <p className="pt-1 text-11 font-medium text-secondary">{t(`${PREFIX}.values`)}</p>}
        {variables.map((item) => {
          const value = values[item.key] ?? "";
          const empty = !value.trim();
          const flagged = invalid === `variable:${item.key}` || (item.required && empty && !item.default);
          const change = (next: string) => setValues((current) => ({ ...current, [item.key]: next }));
          return (
            <label key={item.key} className="block">
              <span className="flex items-baseline gap-1 text-11 text-tertiary">
                <span className="text-secondary">{item.label}</span>
                {item.required ? <span className="text-danger-primary">*</span> : null}
                <span className="ml-auto truncate text-10">
                  {empty
                    ? item.required && !item.default
                      ? t(`${PREFIX}.missing`)
                      : t(`${PREFIX}.optional`)
                    : sourceOf(item.key)
                      ? t(`${PREFIX}.source`, { source: sourceOf(item.key) })
                      : ""}
                </span>
              </span>
              {item.type === "choice" && item.options?.length ? (
                <select
                  value={value}
                  onChange={(event) => change(event.target.value)}
                  className={cn(FIELD, "mt-0.5", flagged && "border-danger-strong")}
                >
                  <option value="">—</option>
                  {item.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={item.type === "date" ? "date" : "text"}
                  inputMode={item.type === "number" || item.type === "currency" ? "decimal" : undefined}
                  value={value}
                  placeholder={item.default ?? undefined}
                  maxLength={5000}
                  onChange={(event) => change(event.target.value)}
                  className={cn(FIELD, "mt-0.5", flagged && "border-danger-strong")}
                />
              )}
              {item.help ? <span className="mt-0.5 block text-10 text-tertiary">{item.help}</span> : null}
            </label>
          );
        })}

        {signers.length > 0 && <p className="pt-1 text-11 font-medium text-secondary">{t(`${PREFIX}.signers`)}</p>}
        {(proposal.signers ?? []).map((item) => {
          const current = signers[item.index] ?? { name: "", email: "" };
          const flagged = invalid === `signer:${item.index}`;
          const change = (field: "name" | "email", next: string) =>
            setSigners((rows) => rows.map((row, index) => (index === item.index ? { ...row, [field]: next } : row)));
          return (
            <div key={item.index}>
              <span className="flex items-baseline gap-1 text-11">
                <span className="text-secondary">{item.role}</span>
                {item.source ? (
                  <span className="ml-auto truncate text-10 text-tertiary">
                    {t(`${PREFIX}.source`, { source: item.source })}
                  </span>
                ) : null}
              </span>
              <div className="mt-0.5 grid grid-cols-2 gap-1.5">
                <input
                  value={current.name}
                  placeholder={t(`${PREFIX}.name`)}
                  aria-label={`${item.role} – ${t(`${PREFIX}.name`)}`}
                  maxLength={255}
                  onChange={(event) => change("name", event.target.value)}
                  className={cn(FIELD, flagged && "border-danger-strong")}
                />
                <input
                  type="email"
                  value={current.email}
                  placeholder={t(`${PREFIX}.email`)}
                  aria-label={`${item.role} – ${t(`${PREFIX}.email`)}`}
                  maxLength={255}
                  onChange={(event) => change("email", event.target.value)}
                  className={cn(FIELD, flagged && "border-danger-strong")}
                />
              </div>
            </div>
          );
        })}
      </fieldset>

      {(proposal.unknown_values?.length ?? 0) > 0 && (
        <p className="mt-1.5 text-11 text-warning-primary">
          {t(`${PREFIX}.unknown_values`, { keys: proposal.unknown_values!.join(", ") })}
        </p>
      )}
      {(proposal.warnings?.length ?? 0) > 0 && (
        <TemplateWarnings warnings={proposal.warnings!} compact className="mt-2" />
      )}

      {!done && (
        <div className="mt-2.5 space-y-1.5 border-t border-subtle pt-2.5">
          <p className="text-11 text-tertiary">
            {missingValues.length + missingSigners.length > 0
              ? t(`${PREFIX}.still_missing`, { count: missingValues.length + missingSigners.length })
              : t(`${PREFIX}.never_sends`)}
          </p>
          <Button variant="secondary" size="sm" loading={previewing} onClick={() => void preview()}>
            <Eye className="size-3" />
            {t(`${PREFIX}.preview`)}
          </Button>
        </div>
      )}
      <Footer
        outcome={outcome}
        busy={busy}
        doneLabel={t(`${PREFIX}.created`, { title: result?.title ?? title })}
        extra={
          result?.path && outcome.state === "applied" ? (
            <AssistantLink href={result.path} className="shrink-0 text-12">
              {t(`${PREFIX}.open`)}
            </AssistantLink>
          ) : null
        }
        applyLabel={t(`${PREFIX}.apply`)}
        disabled={!title.trim() || missingValues.length > 0 || missingSigners.length > 0}
        onApply={() => void apply()}
        onDiscard={() => remember({ state: "discarded" })}
        onUndo={() => void undo()}
      />
    </div>
  );
}

export const ContractDraftCard = makeAssistantToolUI<Record<string, unknown>, TContractProposal>({
  toolName: "propose_contract_from_template",
  render: function ContractDraftRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    if (status.type === "running" || !result) {
      return (
        <TraceLine live icon={FileSignature} label={t("assistant.steps.propose_contract_from_template.running")} />
      );
    }
    if (result.error || !result.variant_id || !result.workspace_slug) {
      return <p className="text-12 text-tertiary">{result.error ?? t("assistant.actions.failed")}</p>;
    }
    return <ContractDraftForm proposal={result} toolCallId={toolCallId} />;
  },
});
