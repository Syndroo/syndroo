import { CliError } from "../cli-error.js";
import { EXIT_CODE, type ExitCode } from "../exit-codes.js";

/**
 * Error codes the local commands report, from the CLI contract (`04` §7).
 *
 * `NOT_DELIVERED` is the documented envelope code for a partial run; it is the
 * same vocabulary, not a second error space.
 */
export type LocalErrorCode =
  | "INVALID_DOCUMENT"
  | "INVALID_JSON"
  | "INPUT_TOO_LARGE"
  | "CONFIRMATION_REQUIRED"
  | "PROVIDER_LOCAL_UNAVAILABLE"
  | "LOCAL_RUNTIME_UNSUPPORTED"
  | "LOCAL_SCHEDULING_UNSUPPORTED"
  | "LOCAL_OAUTH_UNAVAILABLE"
  | "AUTH_SOURCE_UNAVAILABLE"
  | "AUTH_SOURCE_CHANGED"
  | "ACCOUNT_MISMATCH"
  | "BINDING_CHANGED"
  | "PLAN_EXPIRED"
  | "PLAN_TAMPERED"
  | "PLAN_KIND_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "STATE_BUSY"
  | "STATE_CORRUPT"
  | "STATE_VERSION_UNSUPPORTED"
  | "STATE_COMMIT_FAILED"
  | "OUTCOME_UNKNOWN"
  | "RETRY_NOT_READY"
  | "ATTEMPTS_EXHAUSTED"
  | "NOT_DELIVERED";

/**
 * A predicted local failure.
 *
 * `message` is a safe, static sentence: callers must not interpolate raw
 * values, paths, or provider text into it, because this message reaches stdout
 * and stderr. The code is part of the message so assertions and human output
 * both carry it.
 */
export function localError(
  code: LocalErrorCode,
  message: string,
  exitCode: ExitCode = EXIT_CODE.USAGE,
): CliError {
  return new CliError(`${code}: ${message}`, { code, exitCode });
}
