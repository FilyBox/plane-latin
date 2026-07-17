import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveInternalApiConfig, WorkerConfigurationError } from "../src/lib/internal-api.ts";

describe("resolveInternalApiConfig", () => {
  it("reports missing bindings instead of throwing a TypeError", () => {
    assert.throws(
      () => resolveInternalApiConfig({} as never),
      (error) =>
        error instanceof WorkerConfigurationError &&
        error.missing.includes("PLANE_INTERNAL_API_URL") &&
        error.missing.includes("PLANE_INTERNAL_API_SECRET")
    );
  });

  it("normalizes a configured API URL", () => {
    assert.deepEqual(
      resolveInternalApiConfig({
        PLANE_INTERNAL_API_URL: " https://plane.example.com/// ",
        PLANE_INTERNAL_API_SECRET: " internal-secret ",
      }),
      {
        baseUrl: "https://plane.example.com",
        secret: "internal-secret",
      }
    );
  });

  it("rejects non-HTTP API URLs", () => {
    assert.throws(
      () =>
        resolveInternalApiConfig({
          PLANE_INTERNAL_API_URL: "file:///tmp/plane",
          PLANE_INTERNAL_API_SECRET: "internal-secret",
        }),
      WorkerConfigurationError
    );
  });
});
