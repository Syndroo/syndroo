import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";

import {
  assertSupportedRuntime,
  createOwnedFile,
  decodeUtf8,
  ensureOwnedDirectory,
  readOwnedFile,
  removeOwnedDirectory,
  requireOwnedDirectory,
} from "./atomic.js";
import { fail, failure, isErrno } from "./errors.js";
import { RUNTIME_FORMAT, layoutOf } from "./paths.js";

/**
 * Local writer coordination.
 *
 * Two layers exist for two different problems:
 *
 * - an in-process queue, because two async callers in one process must queue
 *   instead of observing each other's lock as contention;
 * - an exclusively created lock directory, because two processes may share one
 *   state root.
 *
 * The lock is never stolen. A lock directory with a valid owner record means
 * another writer exists as far as this process can prove, and a lock directory
 * whose owner record is missing, unreadable or malformed is damaged evidence
 * that is reported rather than repaired. Process liveness is deliberately not
 * consulted: `ESRCH` is not proof that a crashed writer published nothing, and
 * the blueprint forbids timeout-only stealing.
 */

const PROCESS_QUEUE = new Map<string, Promise<unknown>>();

export type LockOwner = {
  readonly format: string;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly createdAt: string;
};

/**
 * Serializes work per state root inside this process.
 *
 * A rejected call never blocks the next one. The queue is keyed by the
 * syntactically resolved root, so two spellings of one root (for example
 * `/var/...` and `/private/var/...` on macOS) queue separately and fall back to
 * the cross-process lock, which reports contention instead of interleaving.
 */
export function withProcessQueue<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = PROCESS_QUEUE.get(key) ?? Promise.resolve();
  const next = previous.then(
    () => work(),
    () => work(),
  );

  PROCESS_QUEUE.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );

  return next;
}

function lockOwnerOf(now: string): LockOwner {
  return {
    format: RUNTIME_FORMAT,
    token: randomBytes(32).toString("base64url"),
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: now,
  };
}

/**
 * Reads the current lock owner, or `null` when the record is missing or
 * unreadable. A `null` owner never means "free".
 */
async function readLockOwner(root: string): Promise<LockOwner | null> {
  let bytes: Buffer | null;

  try {
    bytes = await readOwnedFile(layoutOf(root).lockOwner);
  } catch {
    return null;
  }

  if (bytes === null) {
    return null;
  }

  let value: unknown;

  try {
    value = JSON.parse(decodeUtf8(bytes));
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (
    record["format"] !== RUNTIME_FORMAT ||
    typeof record["token"] !== "string" ||
    record["token"].length < 16 ||
    typeof record["pid"] !== "number" ||
    !Number.isSafeInteger(record["pid"]) ||
    typeof record["hostname"] !== "string" ||
    typeof record["createdAt"] !== "string"
  ) {
    return null;
  }

  return {
    format: RUNTIME_FORMAT,
    token: record["token"],
    pid: record["pid"],
    hostname: record["hostname"],
    createdAt: record["createdAt"],
  };
}

export type HeldLock = {
  readonly token: string;
};

/**
 * Creates the exclusive writer lock, or reports why it cannot be taken.
 *
 * `STATE_BUSY` means a healthy lock exists (this process must not touch it).
 * `STATE_RECOVERY_REQUIRED` means the lock evidence is damaged, so no writer can
 * prove the directory is safe to remove.
 */
export async function acquireWriteLock(
  root: string,
  now: string,
): Promise<HeldLock> {
  assertSupportedRuntime();

  const lockDirectory = layoutOf(root).lock;
  const owner = lockOwnerOf(now);

  try {
    await fs.mkdir(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      const existing = await readLockOwner(root);

      fail(existing === null ? "STATE_RECOVERY_REQUIRED" : "STATE_BUSY");
    }

    throw failure("DURABILITY_ERROR");
  }

  try {
    await ensureOwnedDirectory(lockDirectory);
    await requireOwnedDirectory(lockDirectory);
    await createOwnedFile(
      lockDirectory,
      "owner.json",
      Buffer.from(`${JSON.stringify(owner)}\n`, "utf8"),
    );
  } catch (error) {
    // This process created the directory, so removing it is safe.
    await removeOwnedDirectory(lockDirectory).catch(() => undefined);

    throw error;
  }

  return { token: owner.token };
}

/**
 * Releases the lock only while this process still owns it.
 *
 * A changed token or an unreadable owner record means the lock is left in place
 * and the failure is reported instead of deleting another writer's lock. A
 * release failure is not raised to the caller: the business action already
 * committed, and the surviving lock is itself the visible signal (the next
 * writer fails with `STATE_BUSY`, which is an operator problem, not a data
 * problem).
 */
export async function releaseWriteLock(
  root: string,
  held: HeldLock,
): Promise<void> {
  const lockDirectory = layoutOf(root).lock;

  try {
    const current = await readLockOwner(root);

    if (current === null || current.token !== held.token) {
      return;
    }

    await removeOwnedDirectory(lockDirectory);
  } catch {
    // The lock stays; a later writer reports it instead of interleaving.
  }
}
