/**
 * The error surface is static on purpose: SDK errors reach logs, so no code
 * path may build a message from a base URL, a token, a key or a response body.
 */

import { describe, expect, it } from "vitest";
import { inspect } from "node:util";

import { SyndrooError, isSyndrooError } from "../src/index.js";
import type { SyndrooErrorCode } from "../src/index.js";
import { projectServerError } from "../src/errors.js";

/** A distinctive value that must never survive into anything a log can print. */
const CANARY = "CANARY-do-not-log-3f6f0c1e";

/** Everything about an error that can end up in a log line. */
function printable(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message, error.stack ?? "");
  }
  try {
    parts.push(JSON.stringify(error) ?? "");
  } catch {
    parts.push("");
  }
  parts.push(inspect(error, { depth: 8 }));
  parts.push(JSON.stringify(projectServerError((error as SyndrooError).serverError) ?? null));
  return parts.join("\n");
}

const CODES: readonly SyndrooErrorCode[] = [
  "INVALID_ARGUMENT",
  "INSECURE_BASE_URL",
  "INVALID_REQUEST",
  "INVALID_RESPONSE",
  "RESPONSE_TOO_LARGE",
  "REDIRECT_NOT_ALLOWED",
  "TRANSPORT",
  "HTTP_ERROR",
  "PROTOCOL",
  "TIMEOUT",
  "ABORTED",
  "WAIT_TIMEOUT",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_EXPIRED",
];

describe("SyndrooError", () => {
  it("carries a stable code and a fixed message for every code", () => {
    for (const code of CODES) {
      const error = new SyndrooError(code);
      expect(error.code).toBe(code);
      expect(error.name).toBe("SyndrooError");
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.message).not.toContain(code);
    }
  });

  it("never interpolates a supplied value into the message", () => {
    // Feed the canary through every channel the constructor accepts, so the
    // assertion can only pass if the value genuinely never reaches the output.
    const error = new SyndrooError("PROTOCOL", {
      status: 400,
      serverError: {
        code: CANARY,
        message: CANARY,
        details: { field: CANARY, operationId: CANARY, retryAt: CANARY },
        extra: CANARY,
      } as never,
    });
    expect(error.message).not.toContain(CANARY);
    expect(error.message).not.toContain("super-secret-token");
    expect(error.message).not.toMatch(/https?:\/\//);
    expect(error.status).toBe(400);
    expect(printable(error)).not.toContain(CANARY);
  });

  it("defaults retryable to transport failures only", () => {
    expect(new SyndrooError("TRANSPORT").retryable).toBe(true);
    expect(new SyndrooError("ABORTED").retryable).toBe(false);
    expect(new SyndrooError("PROTOCOL").retryable).toBe(false);
    expect(new SyndrooError("INVALID_RESPONSE").retryable).toBe(false);
  });

  it("is recognized by isSyndrooError", () => {
    expect(isSyndrooError(new SyndrooError("TRANSPORT"))).toBe(true);
    expect(isSyndrooError(new Error("plain"))).toBe(false);
    expect(isSyndrooError(undefined)).toBe(false);
  });

  describe("server error projection", () => {
    it("drops a canary in message, an extra field and details", () => {
      const error = new SyndrooError("PROTOCOL", {
        status: 409,
        serverError: {
          code: "IDEMPOTENCY_CONFLICT",
          message: `conflict: ${CANARY}`,
          extraTopField: CANARY,
          details: {
            field: CANARY,
            operationId: "op_1",
            retryAt: CANARY,
            extraDetailField: CANARY,
          },
        } as never,
      });

      // The projection is rebuilt from scratch: allowlisted code, static text,
      // and only validated detail values.
      expect(error.serverError).toEqual({
        code: "IDEMPOTENCY_CONFLICT",
        message: "the server rejected the request",
        details: { operationId: "op_1" },
      });
      expect(printable(error)).not.toContain(CANARY);
      expect(error.message).not.toContain(CANARY);
      expect(error.stack ?? "").not.toContain(CANARY);
      expect(JSON.stringify(error)).not.toContain(CANARY);
      expect(inspect(error, { depth: 8 })).not.toContain(CANARY);
    });

    it("replaces an unknown code and drops malformed detail values", () => {
      const projected = projectServerError({
        code: CANARY,
        message: CANARY,
        details: {
          field: "targets[0].options.visibility",
          operationId: "op_abc-123",
          retryAt: "nonsense",
        },
      });
      expect(projected).toEqual({
        code: "UNKNOWN_ERROR",
        message: "the server rejected the request",
        details: {
          field: "targets[0].options.visibility",
          operationId: "op_abc-123",
        },
      });
      expect(JSON.stringify(projected)).not.toContain(CANARY);
    });

    it("accepts a well-formed retryAt and copies nothing by reference", () => {
      const source: Record<string, unknown> = {
        code: "RETRY_INELIGIBLE",
        message: "original text",
        details: { retryAt: "2026-10-08T00:15:00.000Z" },
      };
      const error = new SyndrooError("PROTOCOL", { serverError: source as never });
      source["message"] = CANARY;
      (source["details"] as Record<string, unknown>)["retryAt"] = CANARY;
      expect(error.serverError).toEqual({
        code: "RETRY_INELIGIBLE",
        message: "the server rejected the request",
        details: { retryAt: "2026-10-08T00:15:00.000Z" },
      });
      expect(printable(error)).not.toContain(CANARY);
    });
  });
});
