/**
 * Portable read-only authorization-operation projection.
 *
 * One authenticated read answers "what is happening with this authorization
 * attempt": the frozen `projectAuthOperation` applies the expiry projection, and
 * the *current* active platform status comes from the accepted preparation path,
 * so a status read and an operation read never disagree.
 *
 * Guarantees:
 *
 * - no token exchange, no claim, no candidate write, no slot mutation, no TTL
 *   renewal and no provider request;
 * - the operation's platform is checked before anything is exposed, so an
 *   operation id cannot be used to read another platform;
 * - a completed operation still replays its stored receipt with a blocked (not
 *   failed) active status, so replay needs no usable cipher or configuration;
 * - a failed or corrupt *store read* stays the controlled error it already is:
 *   nothing here invents revision 0, an empty slot or an Env fallback.
 *
 * Completing an operation (candidate activation, target confirmation and receipt
 * replay precedence over key/config checks) belongs to the complete/refresh
 * scope, not to this reader.
 */

import { isPlatform, type Platform } from "@syndroo/core";

import { isOpaqueId } from "../contracts/primitives.js";
import {
  projectAuthOperation,
  type AuthOperationProjection,
  type SafePlatformStatus,
} from "../contracts/status.js";
import type { CredentialStore } from "../ports/credential-store.js";
import type { PublisherPreparation } from "../ports/publisher-strategy.js";
import { AuthUseCaseError, authFailure } from "./auth-errors.js";
import type { PreparePublisher } from "./prepare-publisher.js";
import { readClockNow, type UseCaseClock } from "./shared.js";

export interface AuthOperationReadInput {
  readonly platform: Platform;
  readonly operationId: string;
}

export interface AuthOperationReadDependencies {
  readonly credentials: CredentialStore;
  /** The accepted preparation binder; it yields status, never platform calls. */
  readonly prepare: PreparePublisher;
  readonly clock: UseCaseClock;
}

export async function readAuthOperationProjection(
  input: AuthOperationReadInput,
  dependencies: AuthOperationReadDependencies,
): Promise<AuthOperationProjection> {
  // The read input is untrusted: hostile property access becomes one fixed
  // error instead of escaping with its own message.
  let platform: Platform;
  let operationId: string;
  try {
    platform = requirePlatform(input);
    operationId = requireOperationId(input);
  } catch (error) {
    throw authFailure(error, "INVALID_REQUEST", "platform");
  }
  const now = readClockNow(dependencies.clock);

  let operation = null;
  try {
    operation = await dependencies.credentials.readAuthOperation({ operationId });
  } catch {
    // A failed read is never an absent operation with revision 0.
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "store_unavailable");
  }
  if (operation === null || operation.platform !== platform) {
    // An operation that belongs to another platform stays indistinguishable from
    // one that does not exist.
    throw new AuthUseCaseError("NOT_FOUND", "operation_not_found");
  }

  let preparation: PublisherPreparation;
  try {
    preparation = await dependencies.prepare(platform, now);
  } catch (error) {
    // Preparation failures are already fixed; anything else becomes one.
    throw authFailure(error, "STORE_UNAVAILABLE", "unavailable");
  }
  const active: SafePlatformStatus =
    preparation.kind === "ready" ? preparation.prepared.status : preparation.status;

  return projectAuthOperation({ operation, active, now });
}

function requirePlatform(input: unknown): Platform {
  const record = asRecord(input);
  if (record === null || !isPlatform(record["platform"])) {
    throw new AuthUseCaseError("INVALID_REQUEST", "platform");
  }
  return record["platform"];
}

function requireOperationId(input: unknown): string {
  const record = asRecord(input);
  const value = record === null ? null : record["operationId"];
  if (!isOpaqueId(value)) {
    // A malformed identifier is reported as "not found": it never confirms which
    // identifiers exist and never echoes the caller's value.
    throw new AuthUseCaseError("NOT_FOUND", "operation_not_found");
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
