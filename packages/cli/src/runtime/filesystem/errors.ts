import { ProtocolError } from "@syndroo/core";

/**
 * Failure vocabulary of the local filesystem runtime.
 *
 * Every code here is either a protocol code the frozen Core ports already
 * expect (`IDEMPOTENCY_CONFLICT`, `STALE_BINDING`, ...) or one of the local
 * adapter conditions the blueprint names. Nothing else is raised, and every
 * message is static: `ProtocolError` derives the message from the code, so no
 * path, record id, digest, token or secret value can reach an error, a log or a
 * stack frame through this module.
 *
 * `STATE_BUSY` is the one code that is not in the blueprint's stable list. A
 * healthy write lock held by another process is neither state damage
 * (`STATE_RECOVERY_REQUIRED`) nor an unexpected store exception
 * (`DURABILITY_ERROR`), and callers need to tell "retry when the other writer
 * exits" apart from "this state directory needs an operator". The legacy CLI
 * used the same code for the same condition.
 */
export type FailureCode =
  | "INVALID_INPUT"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_FOUND"
  | "STALE_INTENT"
  | "STALE_BINDING"
  | "APPROVAL_INVALID"
  | "APPROVAL_EXPIRED"
  | "REQUEST_IN_PROGRESS"
  | "RETRY_INELIGIBLE"
  | "CONNECT_SESSION_EXPIRED"
  | "CONNECT_STEP_CONFLICT"
  | "CONNECTION_IDENTITY_CHANGED"
  | "CONNECTION_CAPACITY"
  | "STATE_BUSY"
  | "STATE_RECOVERY_REQUIRED"
  | "DURABILITY_ERROR";

export function failure(code: FailureCode): ProtocolError {
  return new ProtocolError(code);
}

export function fail(code: FailureCode): never {
  throw failure(code);
}

/** True for a protocol failure raised by this runtime. */
export function isFailure(error: unknown): error is ProtocolError {
  return error instanceof ProtocolError;
}

/**
 * Reraises protocol failures unchanged and folds everything else into the
 * single safe code the blueprint reserves for unexpected store exceptions.
 */
export function guard<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ProtocolError) {
      throw error;
    }

    return fail("DURABILITY_ERROR");
  }
}

export async function guardAsync<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ProtocolError) {
      throw error;
    }

    return fail("DURABILITY_ERROR");
  }
}

/** True for a Node system error carrying the given `code`. */
export function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}
