import { ProtocolError } from "@syndroo/core";

import { CliError } from "../cli-error.js";
import { EXIT_CODE, type ExitCode } from "../exit-codes.js";

/** The three protocol families the CLI speaks. */
export type Operation = "connect" | "publish" | "status";

/** The only details a safe error may carry (validated ids/paths/times). */
export type SafeDetails = {
  readonly field?: string;
  readonly operationId?: string;
  readonly retryAt?: string;
};

/** One machine envelope, exactly as the generated schema declares it. */
export type CliEnvelope =
  | {
      readonly protocolVersion: 1;
      readonly operation: Operation;
      readonly ok: true;
      readonly result: unknown;
      readonly error: null;
    }
  | {
      readonly protocolVersion: 1;
      readonly operation: Operation;
      readonly ok: false;
      readonly result: null;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: SafeDetails;
      };
    };

/**
 * Static text keyed by stable code.
 *
 * No message is ever built from a raw error, a stack, a response body, a path
 * or an argv value, so a diagnostic can never carry a secret or a terminal
 * escape sequence through this module.
 */
const MESSAGES: Readonly<Record<string, string>> = {
  INTERNAL: "The command failed.",
  USAGE: "The command line is not valid. Run `syndroo --help`.",
  INPUT_INVALID: "The request document is not valid.",
  INPUT_UNREADABLE: "The request document could not be read.",
  INPUT_SOURCE_MISSING: "Exactly one input source is required.",
  INPUT_SOURCE_CONFLICT: "Only one input source may be used.",
  EXECUTE_REQUIRES_STDIN: "An execute request may only be read from standard input.",
  CONFIG_INVALID: "The configuration file is not valid.",
  CONFIG_NOT_FOUND: "The configuration file does not exist.",
  CONFIG_PATH_NOT_ABSOLUTE: "The configuration path must be absolute.",
  CONFIG_VERSION_UNSUPPORTED: "The configuration version is not supported.",
  CONFIG_SECRET_REJECTED: "The configuration file contains a secret-looking key.",
  CREDENTIAL_SOURCE_MISSING: "This connection needs a credential source.",
  CREDENTIAL_INVALID: "The credential document is not valid.",
  INVALID_INPUT: "The request was rejected as invalid.",
  BODY_TOO_LARGE: "The request body is too large.",
  UNSUPPORTED_MEDIA_TYPE: "The request media type is not supported.",
  UNAUTHORIZED: "Authentication failed.",
  FORBIDDEN: "The request is not permitted.",
  NOT_FOUND: "No record matches the request.",
  TARGET_AMBIGUOUS: "The target connection is ambiguous.",
  DUPLICATE_TARGET: "The same target appears more than once.",
  CONNECTION_IDENTITY_CHANGED: "The connection identity changed.",
  CONNECTION_CAPACITY: "The connection limit was reached.",
  PROVIDER_TRUST_REQUIRED: "The provider is not trusted yet.",
  PROVIDER_INVALID: "The provider is not valid.",
  PROVIDER_UNAVAILABLE: "The provider is not available.",
  PROVIDER_CONFIG_INVALID: "The provider configuration is not valid.",
  PROVIDER_IMPORT_FAILED: "The provider could not be loaded.",
  PROVIDER_RESTART_REQUIRED: "Restart the CLI before using the changed provider.",
  STALE_INTENT: "A newer intent exists for this request.",
  STALE_BINDING: "The connection binding is stale.",
  APPROVAL_INVALID: "The approval token is not valid.",
  APPROVAL_EXPIRED: "The approval window has closed.",
  IDEMPOTENCY_CONFLICT: "The request id was reused with different content.",
  REQUEST_IN_PROGRESS: "The request is still in progress.",
  RETRY_INELIGIBLE: "The target is not eligible for a safe retry.",
  CONNECT_SESSION_EXPIRED: "The connection session has expired.",
  CONNECT_STEP_CONFLICT: "The connection step conflicts with a stored result.",
  CONNECT_STEP_UNKNOWN: "The connection step result is unknown.",
  OAUTH_PROVIDER_UNSUPPORTED: "This provider does not use a local OAuth callback.",
  REDIRECT_URI_INVALID: "The OAuth redirect URI is not valid.",
  CALLBACK_URL_INVALID:
    "The OAuth callback URL is not valid. A delivered callback carries an " +
    "authorization code, so it must be passed on standard input " +
    "(--callback-url -) instead of on the command line.",
  OAUTH_CALLBACK_REJECTED: "The OAuth callback was refused.",
  OAUTH_CALLBACK_TIMEOUT: "No OAuth callback arrived before the attempt expired.",
  OAUTH_CALLBACK_CANCELLED: "The OAuth callback wait was cancelled.",
  OAUTH_ATTEMPT_STORE_UNAVAILABLE: "The local OAuth attempt could not be recorded.",
  OAUTH_LISTENER_UNAVAILABLE: "The loopback OAuth callback address could not be bound.",
  STATE_BUSY: "Another Syndroo write is in progress. Retry shortly.",
  STATE_RECOVERY_REQUIRED: "The local state needs operator recovery.",
  DURABILITY_ERROR: "The local state could not be updated.",
  CANCELLED: "The local call was cancelled.",
};

export function staticMessage(code: string): string {
  return MESSAGES[code] ?? "The command could not be completed.";
}

/**
 * Map any thrown value to a stable code and an exit family.
 *
 * Unknown values collapse to `INTERNAL`/1 rather than leaking a message. Core
 * raises `ProtocolError` for every refusal it makes; those are preflight
 * rejections (exit 2) except a cancelled local call and a damaged or
 * unwritable state root.
 */
export function classify(error: unknown): { code: string; exit: ExitCode } {
  if (error instanceof CliError) {
    return { code: error.code, exit: error.exitCode };
  }

  if (error instanceof ProtocolError) {
    if (error.code === "CANCELLED") {
      return { code: error.code, exit: EXIT_CODE.INTERRUPTED };
    }

    if (
      error.code === "STATE_RECOVERY_REQUIRED" ||
      error.code === "DURABILITY_ERROR"
    ) {
      return { code: error.code, exit: EXIT_CODE.FAILURE };
    }

    return { code: error.code, exit: EXIT_CODE.USAGE };
  }

  return { code: "INTERNAL", exit: EXIT_CODE.FAILURE };
}

export function successEnvelope(operation: Operation, result: unknown): CliEnvelope {
  return { protocolVersion: 1, operation, ok: true, result, error: null };
}

export function failureEnvelope(
  operation: Operation,
  code: string,
  details?: SafeDetails,
): CliEnvelope {
  return {
    protocolVersion: 1,
    operation,
    ok: false,
    result: null,
    error: {
      code,
      message: staticMessage(code),
      ...(details ? { details } : {}),
    },
  };
}

/** Exit family for a returned execution round (a business result, not an error). */
export function exitForExecution(status: string): ExitCode {
  if (status === "unknown") {
    return EXIT_CODE.AMBIGUOUS;
  }

  if (status === "failed" || status === "partial") {
    return EXIT_CODE.NOT_DELIVERED;
  }

  return EXIT_CODE.SUCCESS;
}
