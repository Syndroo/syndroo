import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CliError } from "../../cli-error.js";
import { EXIT_CODE } from "../../exit-codes.js";
import {
  admissionFailure,
  assertSupportedRuntime,
  atomicWriteFile,
  commitFailure,
  encodeStateRecord,
  ensureStateDirectory,
  isErrno,
  parseStateValue,
  pathExists,
  readControlledFile,
  removeControlledDirectory,
  stateFailure,
} from "./atomic.js";
import {
  corrupt,
  requireExactFields,
  requireInteger,
  requireIsoTime,
  requireRecord,
  requireString,
  requireVersion,
} from "./validate.js";

/**
 * Cooperative global write lock and the explicit recovery guard.
 *
 * The lock is an exclusively created directory holding an owner record. There
 * is no time to live and no stealing: a lock survives until its owner releases
 * it or an operator runs the explicit recovery path after proving the owner
 * process is gone. The recovery guard is a second directory that normal writers
 * check immediately before and immediately after taking the lock.
 */

export const WRITE_LOCK_DIR_NAME = ".write-lock";
export const RECOVERY_GUARD_DIR_NAME = ".recovery-lock";
export const QUARANTINE_DIR_NAME = "quarantine";
export const LOCK_OWNER_FILE_NAME = "owner.json";

export interface LockOwner {
  readonly schemaVersion: 1;
  /** Release capability. Never printed, never returned by diagnostics. */
  readonly token: string;
  readonly hostname: string;
  readonly pid: number;
  readonly createdAt: string;
}

/** Diagnostic view of a lock owner: no release capability. */
export interface LockOwnerView {
  readonly hostname: string;
  readonly pid: number;
  readonly createdAt: string;
}

export interface LockState {
  /** The lock directory exists, whatever its contents look like. */
  readonly held: boolean;
  /** Parsed owner, or `null` when the owner record is missing or malformed. */
  readonly owner: LockOwner | null;
  /** Device and inode of the lock directory, or `null` when it is not a plain directory. */
  readonly device: number | null;
  readonly inode: number | null;
}

/** Secondary failure attached to a callback error when release also failed. */
export interface LockReleaseFailure {
  readonly code: "STATE_COMMIT_FAILED";
  readonly message: string;
}

export const LOCK_RELEASE_FAILURE: unique symbol = Symbol(
  "syndroo.local.lockReleaseFailure",
);

/**
 * Thrown when the callback succeeded but the lock could not be released.
 *
 * The completed result is preserved on `.result` so composition can keep the
 * execution evidence while still reporting a non-zero, non-usage failure.
 */
export class LocalLockReleaseError<T = unknown> extends CliError {
  readonly result: T;

  constructor(result: T, cause: unknown) {
    super("STATE_COMMIT_FAILED: the state write lock could not be released", {
      code: "STATE_COMMIT_FAILED",
      exitCode: EXIT_CODE.FAILURE,
      details: { lockReleased: false },
      cause,
    });

    this.name = "LocalLockReleaseError";
    this.result = result;
  }
}

const RELEASE_FAILURE: LockReleaseFailure = {
  code: "STATE_COMMIT_FAILED",
  message: "the state write lock could not be released",
};

/** Reads the secondary release failure attached to a callback error, if any. */
export function lockReleaseFailureOf(
  error: unknown,
): LockReleaseFailure | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const attached = (
    error as { [LOCK_RELEASE_FAILURE]?: LockReleaseFailure }
  )[LOCK_RELEASE_FAILURE];

  return attached ?? null;
}

function attachLockReleaseFailure(error: unknown): void {
  if (typeof error !== "object" || error === null) {
    return;
  }

  try {
    Object.defineProperty(error, LOCK_RELEASE_FAILURE, {
      value: RELEASE_FAILURE,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  } catch {
    // A frozen or exotic error object keeps the callback failure as the only
    // evidence; the callback error is never replaced.
  }
}

export function writeLockDir(stateRoot: string): string {
  return path.join(stateRoot, WRITE_LOCK_DIR_NAME);
}

export function recoveryGuardDir(stateRoot: string): string {
  return path.join(stateRoot, RECOVERY_GUARD_DIR_NAME);
}

export function quarantineDir(stateRoot: string): string {
  return path.join(stateRoot, QUARANTINE_DIR_NAME);
}

export function createLockOwner(createdAt: string): LockOwner {
  return {
    schemaVersion: 1,
    token: randomBytes(32).toString("hex"),
    hostname: os.hostname(),
    pid: process.pid,
    createdAt,
  };
}

/** Strips the release capability from an owner record. */
export function lockOwnerView(owner: LockOwner): LockOwnerView {
  return {
    hostname: owner.hostname,
    pid: owner.pid,
    createdAt: owner.createdAt,
  };
}

function validateLockOwner(value: unknown): LockOwner {
  const record = requireRecord(value, "the state write lock owner");

  requireExactFields(
    record,
    ["schemaVersion", "token", "hostname", "pid", "createdAt"],
    "the state write lock owner",
  );

  return {
    schemaVersion: requireVersion(
      record["schemaVersion"],
      "the state write lock owner",
    ),
    token: requireString(record["token"], "the state write lock token", {
      pattern: /^[0-9a-f]{64}$/,
    }),
    hostname: requireString(record["hostname"], "the state write lock host", {
      max: 255,
    }),
    pid: requireInteger(record["pid"], "the state write lock process", {
      min: 1,
    }),
    createdAt: requireIsoTime(
      record["createdAt"],
      "the state write lock creation time",
    ),
  };
}

async function readLockOwnerAt(lockDir: string): Promise<LockOwner | null> {
  let bytes: Buffer | null;

  try {
    bytes = await readControlledFile(path.join(lockDir, LOCK_OWNER_FILE_NAME));
  } catch {
    return null;
  }

  if (bytes === null) {
    return null;
  }

  try {
    return validateLockOwner(parseStateValue(bytes));
  } catch {
    return null;
  }
}

/** Reads the lock directory and its owner. Read-only. */
export async function readLockState(stateRoot: string): Promise<LockState> {
  const lockDir = writeLockDir(stateRoot);
  let stat;

  try {
    stat = await fs.lstat(lockDir);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { held: false, owner: null, device: null, inode: null };
    }

    throw stateFailure(
      "STATE_CORRUPT",
      "the state write lock is not readable",
    );
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { held: true, owner: null, device: null, inode: null };
  }

  return {
    held: true,
    owner: await readLockOwnerAt(lockDir),
    device: stat.dev,
    inode: stat.ino,
  };
}

/** Throws `STATE_BUSY` while a recovery guard exists. Read-only. */
export async function assertNoRecoveryGuard(stateRoot: string): Promise<void> {
  const guard = recoveryGuardDir(stateRoot);
  let stat;

  try {
    stat = await fs.lstat(guard);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return;
    }

    throw stateFailure(
      "STATE_CORRUPT",
      "the state recovery guard is not readable",
    );
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw stateFailure(
      "STATE_CORRUPT",
      "the state recovery guard is not a plain directory",
    );
  }

  throw admissionFailure("STATE_BUSY", "state recovery is in progress");
}

/**
 * True while `pid` exists and this process may signal it.
 *
 * Only `ESRCH` proves the process is gone. `EPERM` and any unexpected error
 * mean the answer is unknown, and an unknown owner is never recovered.
 */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

async function createWriteLock(
  lockDir: string,
  owner: LockOwner,
): Promise<number> {
  try {
    await fs.mkdir(lockDir, { mode: 0o700 });
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw admissionFailure(
        "STATE_BUSY",
        "another writer holds the state lock",
      );
    }

    throw stateFailure(
      "STATE_CORRUPT",
      "the state write lock could not be created",
    );
  }

  try {
    await fs.chmod(lockDir, 0o700);

    const stat = await fs.lstat(lockDir);

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      corrupt("the state write lock", "is not a plain directory");
    }

    await atomicWriteFile(
      lockDir,
      LOCK_OWNER_FILE_NAME,
      encodeStateRecord(owner),
      undefined,
    );

    return stat.ino;
  } catch (error) {
    // This process just created the directory, so removing it is safe.
    await removeControlledDirectory(lockDir).catch(() => undefined);

    throw error;
  }
}

/**
 * Releases the lock only when this process still owns it.
 *
 * A changed token or inode, or an unreadable owner record, means the lock is
 * left in place and the failure is reported instead of deleting another
 * writer's lock.
 */
async function releaseWriteLock(
  lockDir: string,
  owner: LockOwner,
  inode: number,
): Promise<unknown | null> {
  try {
    const stat = await fs.lstat(lockDir).catch(error => {
      if (isErrno(error, "ENOENT")) {
        return null;
      }

      throw error;
    });

    if (stat === null) {
      return null;
    }

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return stateFailure(
        "STATE_CORRUPT",
        "the state write lock is not a plain directory",
      );
    }

    if (stat.ino !== inode) {
      return stateFailure(
        "STATE_CORRUPT",
        "the state write lock changed while it was held",
      );
    }

    const current = await readLockOwnerAt(lockDir);

    if (current === null || current.token !== owner.token) {
      return stateFailure(
        "STATE_CORRUPT",
        "the state write lock belongs to another process",
      );
    }

    await removeControlledDirectory(lockDir);

    return null;
  } catch (error) {
    return error;
  }
}

const NO_FAILURE: unique symbol = Symbol("syndroo.local.noFailure");

/**
 * Runs `work` while holding the global write lock.
 *
 * The callback result is returned unchanged. If the callback throws, that error
 * stays primary and any release failure is attached as a secondary
 * `LOCK_RELEASE_FAILURE`. If the callback succeeded but the release failed, the
 * completed result is preserved on a `LocalLockReleaseError`.
 */
export async function withLocalWriteLock<T>(
  stateHome: string,
  work: () => Promise<T>,
): Promise<T> {
  assertSupportedRuntime();

  const root = await ensureStateDirectory(stateHome);

  await assertNoRecoveryGuard(root);

  const lockDir = writeLockDir(root);
  const owner = createLockOwner(new Date().toISOString());
  const inode = await createWriteLock(lockDir, owner);

  if (await pathExists(recoveryGuardDir(root))) {
    // The guard appeared between the check and the lock. Losing this race
    // releases only this process's own lock and refuses to run the callback.
    const releaseError = await releaseWriteLock(lockDir, owner, inode);

    if (releaseError !== null) {
      throw commitFailure("lock-release", false, releaseError);
    }

    throw admissionFailure("STATE_BUSY", "state recovery is in progress");
  }

  let result: T | undefined;
  let failure: unknown = NO_FAILURE;

  try {
    result = await work();
  } catch (error) {
    failure = error;
  }

  const releaseError = await releaseWriteLock(lockDir, owner, inode);

  if (failure !== NO_FAILURE) {
    // The callback error stays primary and is never decorated when the lock was
    // released normally; a secondary is attached only for a real cleanup
    // failure.
    if (releaseError !== null) {
      attachLockReleaseFailure(failure);
    }

    throw failure;
  }

  if (releaseError !== null) {
    throw new LocalLockReleaseError<T>(result as T, releaseError);
  }

  return result as T;
}
