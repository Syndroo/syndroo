import { ProtocolError } from "@syndroo/core";

const CODES = new Set([
  "INVALID_INPUT", "IDEMPOTENCY_CONFLICT", "NOT_FOUND", "STALE_INTENT", "STALE_BINDING",
  "APPROVAL_INVALID", "APPROVAL_EXPIRED", "REQUEST_IN_PROGRESS", "RETRY_INELIGIBLE",
  "CONNECT_SESSION_EXPIRED", "CONNECT_STEP_CONFLICT", "CONNECT_STEP_UNKNOWN",
  "CONNECTION_IDENTITY_CHANGED", "CONNECTION_CAPACITY", "STATE_RECOVERY_REQUIRED",
  "STATE_FORMAT_INVALID", "STATE_SCOPE_MISMATCH", "STORAGE_CONFIG_INVALID", "DURABILITY_ERROR",
  "SECRET_KEY_INVALID", "SECRET_AUTHENTICATION_FAILED", "SECRET_NOT_FOUND", "SECRET_RETIRED",
  "SECRET_STAGE_CONFLICT", "SECRET_PROOF_INVALID",
]);
export type FailureCode = string;
export function safeError(error: { code: string }): { code: string; message: string } {
  const code = CODES.has(error.code) ? error.code : "DURABILITY_ERROR";
  return { code, message: code };
}
export function fail(code: FailureCode): never {
  const error = new ProtocolError(safeError({ code }).code);
  // Core's optional details field is emitted as an own property with value
  // undefined. Storage failures expose no diagnostic payload at all.
  delete (error as { details?: unknown }).details;
  throw error;
}
export function sanitize(error: unknown): never {
  return fail(error instanceof ProtocolError ? error.code : "DURABILITY_ERROR");
}
