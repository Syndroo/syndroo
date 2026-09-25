import { randomBytes } from "node:crypto";
import { constants as FS, promises as fs, type Stats } from "node:fs";
import path from "node:path";

import { CliError } from "../../cli-error.js";
import { EXIT_CODE } from "../../exit-codes.js";
import { localError, type LocalErrorCode } from "../errors.js";
import { parseLocalJson } from "../document.js";

/**
 * Filesystem primitives for the local state directory.
 *
 * Every path this module touches is fixed by the store: callers never hand it a
 * record path. The module owns four jobs.
 *
 * 1. Refuse unsafe paths. A controlled directory is a plain directory, owned by
 *    the current uid, mode 0700. A controlled file is a plain file with link
 *    count 1, owned by the current uid, mode 0600. Symlinks, FIFOs, sockets,
 *    devices, and hard links are rejected before their contents matter.
 * 2. Create missing directories itself, one component at a time, resolving
 *    system aliases (for example `/tmp` -> `/private/tmp`) at the deepest
 *    existing ancestor instead of accepting a symlinked state root.
 * 3. Read bounded. Reads use `O_NOFOLLOW | O_NONBLOCK` so a path swapped to a
 *    FIFO cannot block the process before `fstat`, then read in fixed chunks up
 *    to a hard ceiling.
 * 4. Write atomically: same-directory exclusive temporary file, full write,
 *    file sync, close, rename, directory sync.
 */

/**
 * Fault points the store exposes to tests.
 *
 * They are injected through `createLocalFileStore` options only; there is no
 * production flag, environment variable, or command-line switch that reaches
 * them.
 */
export type StoreFaultPoint =
  | "before-temp-write"
  | "after-file-sync"
  | "before-rename"
  | "after-rename"
  | "before-directory-sync"
  | "before-outcome-commit";

export type FaultInjector = (point: StoreFaultPoint) => void | Promise<void>;

/** Hard ceiling for any state file this version reads. */
export const MAX_STATE_FILE_BYTES = 1_048_576;

/** Controlled directory mode: owner-only. */
export const STATE_DIR_MODE = 0o700;

/** Controlled file mode: owner-only. */
export const STATE_FILE_MODE = 0o600;

/** Length of the installation HMAC key. */
export const INTEGRITY_KEY_BYTES = 32;

const READ_CHUNK_BYTES = 65_536;

/**
 * Corruption, version, runtime, and commit failures are local I/O failures:
 * exit 1. Only admission refusals, which happen before any content request in
 * this invocation, are usage errors.
 */
export function stateFailure(
  code:
    | "STATE_CORRUPT"
    | "STATE_VERSION_UNSUPPORTED"
    | "LOCAL_RUNTIME_UNSUPPORTED",
  message: string,
): CliError {
  return localError(code, message, EXIT_CODE.FAILURE);
}

/** An admission refusal: no content request happened in this invocation. */
export function admissionFailure(
  code: LocalErrorCode,
  message: string,
): CliError {
  return localError(code, message);
}

/**
 * An atomic write that did not complete.
 *
 * `committed` records what the process can still prove: `false` means the
 * authoritative target was never replaced, `true` means the rename happened and
 * the outcome is indeterminate. Callers must not claim a rollback when it is
 * true, and must not resend content because of this error.
 */
export function commitFailure(
  stage: string,
  committed: boolean,
  cause: unknown,
): CliError {
  return new CliError("STATE_COMMIT_FAILED: the state write did not complete", {
    code: "STATE_COMMIT_FAILED",
    exitCode: EXIT_CODE.FAILURE,
    details: { stage, committed },
    cause,
  });
}

/** True for an `Error` carrying the given `code` property. */
export function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

export function assertSupportedRuntime(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw stateFailure(
      "LOCAL_RUNTIME_UNSUPPORTED",
      "local state is not supported on this platform",
    );
  }

  if (typeof process.getuid !== "function") {
    throw stateFailure(
      "LOCAL_RUNTIME_UNSUPPORTED",
      "local state needs a POSIX file owner",
    );
  }
}

function currentUid(): number {
  const uid = process.getuid?.();

  if (uid === undefined) {
    throw stateFailure(
      "LOCAL_RUNTIME_UNSUPPORTED",
      "local state needs a POSIX file owner",
    );
  }

  return uid;
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return null;
    }

    throw error;
  }
}

export async function pathExists(target: string): Promise<boolean> {
  return (await lstatOrNull(target)) !== null;
}

function assertDirectoryStat(stat: Stats): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw stateFailure(
      "STATE_CORRUPT",
      "a state directory is not a plain directory",
    );
  }

  if ((stat.mode & 0o777) !== STATE_DIR_MODE) {
    throw stateFailure(
      "STATE_CORRUPT",
      "a state directory does not have safe permissions",
    );
  }

  if (stat.uid !== currentUid()) {
    throw stateFailure(
      "STATE_CORRUPT",
      "a state directory belongs to a different user",
    );
  }
}

function assertFileStat(stat: Stats): void {
  if (!stat.isFile()) {
    throw stateFailure("STATE_CORRUPT", "a state file is not a plain file");
  }

  if (stat.nlink !== 1) {
    throw stateFailure("STATE_CORRUPT", "a state file has extra links");
  }

  if ((stat.mode & 0o777) !== STATE_FILE_MODE) {
    throw stateFailure(
      "STATE_CORRUPT",
      "a state file does not have safe permissions",
    );
  }

  if (stat.uid !== currentUid()) {
    throw stateFailure(
      "STATE_CORRUPT",
      "a state file belongs to a different user",
    );
  }
}

/** Validates an existing controlled directory. Creates nothing. */
export async function assertControlledDirectory(
  dirPath: string,
): Promise<void> {
  assertSupportedRuntime();

  const stat = await lstatOrNull(dirPath);

  if (stat === null) {
    throw stateFailure("STATE_CORRUPT", "a state directory is missing");
  }

  assertDirectoryStat(stat);
}

/**
 * System alias roots that are resolved instead of refused.
 *
 * macOS ships `/tmp`, `/var`, and `/etc` as symlinks into `/private`, and the
 * system temporary directory lives under one of them. Resolving exactly these
 * known aliases keeps that working; every other symlink in a caller-supplied
 * path is refused.
 */
function systemAliasRoots(): ReadonlySet<string> {
  return process.platform === "darwin"
    ? new Set(["/tmp", "/var", "/etc"])
    : new Set<string>();
}

interface ControlledPath {
  /** Deepest existing component, with known system aliases already resolved. */
  readonly resolved: string;
  /** Component names still to create, in order. */
  readonly missing: readonly string[];
}

/**
 * Walks every component of a supplied state path.
 *
 * Known system aliases are resolved; every other symlink component is refused,
 * so a caller cannot redirect the controlled root. Ancestors are only checked
 * to be directories, never chmodded: only directories this process creates are
 * given mode 0700.
 */
async function resolveControlledPath(
  stateHome: string,
): Promise<ControlledPath> {
  const absolute = path.resolve(stateHome);
  const root = path.parse(absolute).root;

  if (absolute === root) {
    throw stateFailure("STATE_CORRUPT", "the state directory is not usable");
  }

  const aliases = systemAliasRoots();
  const parts = absolute.split(path.sep).filter(part => part.length > 0);
  const missing: string[] = [];
  let current = root;

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] as string;
    const next = path.join(current, part);
    const stat = await lstatOrNull(next);

    if (stat === null) {
      missing.push(...parts.slice(index));

      break;
    }

    if (stat.isSymbolicLink()) {
      if (!aliases.has(next)) {
        throw stateFailure(
          "STATE_CORRUPT",
          "a state path component is a symbolic link",
        );
      }

      current = await fs.realpath(next).catch(() => {
        throw stateFailure(
          "STATE_CORRUPT",
          "a state path component is not usable",
        );
      });

      continue;
    }

    if (!stat.isDirectory()) {
      throw stateFailure(
        "STATE_CORRUPT",
        "a state path component is not a directory",
      );
    }

    current = next;
  }

  return { resolved: current, missing };
}

/**
 * Resolves a supplied state root that must already exist.
 *
 * The state root itself must be a plain controlled directory: a symlink, a
 * wrong owner, or a group/other bit is refused rather than repaired.
 */
export async function requireStateDirectory(
  stateHome: string,
): Promise<string> {
  assertSupportedRuntime();

  const { resolved, missing } = await resolveControlledPath(stateHome);

  if (missing.length > 0) {
    throw stateFailure("STATE_CORRUPT", "the state directory is missing");
  }

  await assertControlledDirectory(resolved);

  return resolved;
}

/**
 * Resolves a supplied state root, creating it and any missing component.
 *
 * Missing components are created one at a time with mode 0700 and re-checked
 * with `lstat`, so a path swapped for a symlink during creation is rejected
 * rather than followed.
 */
export async function ensureStateDirectory(
  stateHome: string,
): Promise<string> {
  assertSupportedRuntime();

  const { resolved, missing } = await resolveControlledPath(stateHome);
  let current = resolved;

  for (const name of missing) {
    const next = path.join(current, name);

    await createControlledDirectory(next);

    current = next;
  }

  if (missing.length === 0) {
    await assertControlledDirectory(current);
  }

  return current;
}


/** Creates one controlled directory, or validates the one that appeared. */
export async function createControlledDirectory(
  dirPath: string,
): Promise<void> {
  try {
    await fs.mkdir(dirPath, { mode: STATE_DIR_MODE });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw stateFailure(
        "STATE_CORRUPT",
        "a state directory could not be created",
      );
    }

    await assertControlledDirectory(dirPath);

    return;
  }

  try {
    // mkdir is filtered through the process umask, so set the mode explicitly
    // on the directory this process just created.
    await fs.chmod(dirPath, STATE_DIR_MODE);
  } catch {
    throw stateFailure(
      "STATE_CORRUPT",
      "a state directory could not be created",
    );
  }

  const stat = await lstatOrNull(dirPath);

  if (stat === null) {
    throw stateFailure(
      "STATE_CORRUPT",
      "a state directory could not be created",
    );
  }

  assertDirectoryStat(stat);
}

/** Creates (or validates) one fixed child directory of the state root. */
export async function ensureChildDirectory(
  stateRoot: string,
  name: string,
): Promise<string> {
  const child = path.join(stateRoot, name);

  await createControlledDirectory(child);

  return child;
}

/** Removes a directory this process owns. Never follows a symlinked root. */
export async function removeControlledDirectory(
  dirPath: string,
): Promise<void> {
  const stat = await lstatOrNull(dirPath);

  if (stat === null) {
    return;
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw stateFailure(
      "STATE_CORRUPT",
      "a state directory is not a plain directory",
    );
  }

  await fs.rm(dirPath, { recursive: true, force: false });
}

/**
 * Reads one controlled file, or `null` when the intended file does not exist.
 *
 * `O_NOFOLLOW` refuses a symlinked path and `O_NONBLOCK` keeps a FIFO from
 * blocking the open, so the type check always happens on a file descriptor that
 * cannot hang the process.
 */
export async function readControlledFile(
  filePath: string,
): Promise<Buffer | null> {
  assertSupportedRuntime();

  let handle;

  try {
    handle = await fs.open(
      filePath,
      FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK,
    );
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return null;
    }

    throw stateFailure(
      "STATE_CORRUPT",
      "a state file is not readable as a plain file",
    );
  }

  try {
    const stat = await handle.stat();

    assertFileStat(stat);

    const chunks: Buffer[] = [];
    let total = 0;

    for (;;) {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        READ_CHUNK_BYTES,
        null,
      );

      if (bytesRead === 0) {
        break;
      }

      total += bytesRead;

      if (total > MAX_STATE_FILE_BYTES) {
        throw stateFailure(
          "STATE_CORRUPT",
          "a state file is larger than this version accepts",
        );
      }

      chunks.push(buffer.subarray(0, bytesRead));
    }

    return Buffer.concat(chunks, total);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Writes bytes into a fresh same-directory temporary file and syncs it.
 *
 * The caller owns the temporary name so it can always clean up, and reports
 * the current stage back through `setStage` so a failure keeps the same
 * diagnostic detail the atomic writers reported before this was shared.
 */
async function writeTemporary(
  temporary: string,
  bytes: Uint8Array,
  fault: FaultInjector | undefined,
  setStage: (stage: string) => void,
): Promise<void> {
  await fault?.("before-temp-write");

  setStage("temp-write");

  const handle = await fs.open(
    temporary,
    FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | FS.O_NOFOLLOW,
    STATE_FILE_MODE,
  );

  try {
    await handle.chmod(STATE_FILE_MODE);
    await handle.writeFile(bytes);

    setStage("file-sync");

    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }

  await fault?.("after-file-sync");
}

/** Syncs a directory so a rename or link is durable. */
async function syncDirectory(dirPath: string): Promise<void> {
  const directory = await fs.open(dirPath, FS.O_RDONLY);

  try {
    await directory.sync();
  } finally {
    await directory.close().catch(() => undefined);
  }
}

function temporaryPath(dirPath: string): string {
  return path.join(dirPath, `.tmp-${randomBytes(8).toString("hex")}`);
}

/**
 * Writes one controlled file atomically, replacing any existing file.
 *
 * Failures before the rename leave the previous authoritative file in place.
 * Failures after the rename are indeterminate and reported as
 * `STATE_COMMIT_FAILED` with `committed: true`; this process never claims it
 * rolled back.
 */
export async function atomicWriteFile(
  dirPath: string,
  name: string,
  bytes: Uint8Array,
  fault: FaultInjector | undefined,
): Promise<void> {
  await assertControlledDirectory(dirPath);

  const target = path.join(dirPath, name);
  const existing = await lstatOrNull(target);

  if (existing !== null) {
    // Replacing an existing record still requires a controlled file: an unsafe
    // owner, mode, or link count is refused, never chmodded into acceptability.
    assertFileStat(existing);
  }

  const temporary = temporaryPath(dirPath);
  let stage = "before-temp-write";
  let committed = false;

  try {
    await writeTemporary(temporary, bytes, fault, next => {
      stage = next;
    });
    await fault?.("before-rename");

    stage = "rename";

    await fs.rename(temporary, target);
    committed = true;

    await fault?.("after-rename");
    await fault?.("before-directory-sync");

    stage = "directory-sync";

    await syncDirectory(dirPath);
  } catch (error) {
    if (!committed) {
      // Only this process's own temporary file is ever removed.
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }

    throw commitFailure(stage, committed, error);
  }
}

/**
 * Creates one controlled file only if the name is still free.
 *
 * The bytes travel through the same temporary-file pipeline as
 * `atomicWriteFile`; the authoritative name appears through `link`, which fails
 * with `EEXIST` instead of replacing a file another writer just published. This
 * is what lets two concurrent creators agree on one winner without a lock.
 *
 * Returns `true` when this call created the file and `false` when the name was
 * already taken; an existing file is never overwritten or removed.
 *
 * The publish checkpoints reuse the `before-rename` / `after-rename` fault
 * names, because both writers publish the authoritative name at that point.
 *
 * A crash between the link and the removal of this process's own temporary name
 * leaves the target with a link count of two. Readers refuse that state instead
 * of guessing, and the evidence is preserved rather than repaired.
 */
export async function atomicCreateFile(
  dirPath: string,
  name: string,
  bytes: Uint8Array,
  fault: FaultInjector | undefined,
): Promise<boolean> {
  await assertControlledDirectory(dirPath);

  const target = path.join(dirPath, name);
  const temporary = temporaryPath(dirPath);
  let stage = "before-temp-write";
  let committed = false;

  try {
    await writeTemporary(temporary, bytes, fault, next => {
      stage = next;
    });
    await fault?.("before-rename");

    stage = "create";

    try {
      await fs.link(temporary, target);
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        // Another writer published first. Only this process's own temporary
        // name is removed; the existing file is left exactly as it is.
        await fs.rm(temporary, { force: true }).catch(() => undefined);

        return false;
      }

      throw error;
    }

    committed = true;

    // Removing our own temporary name is what brings the target back to one
    // link. The directory is still synced afterwards, because the file exists
    // now, and a removal failure is reported instead of hidden: the file is
    // there, but every reader would refuse it until the extra link is gone.
    let temporaryError: unknown = null;

    try {
      await fs.rm(temporary, { force: true });
    } catch (error) {
      temporaryError = error;
    }

    await fault?.("after-rename");
    await fault?.("before-directory-sync");

    stage = "directory-sync";

    await syncDirectory(dirPath);

    if (temporaryError !== null) {
      throw temporaryError;
    }

    return true;
  } catch (error) {
    if (!committed) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }

    throw commitFailure(stage, committed, error);
  }
}

/** Serializes a state record for disk; formatting is not part of any MAC. */
export function encodeStateRecord(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Decodes state bytes as UTF-8, refusing malformed text. */
export function decodeStateText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw stateFailure("STATE_CORRUPT", "a state file is not valid UTF-8");
  }
}

/**
 * Parses one state file with the same strict JSON rules as local documents.
 *
 * Comments, trailing commas, and repeated keys are refused, and the result has
 * no prototype. A parse failure is corruption, never an empty history.
 */
export function parseStateValue(bytes: Uint8Array): unknown {
  const text = decodeStateText(bytes);

  try {
    return parseLocalJson(text);
  } catch (error) {
    if (error instanceof CliError) {
      throw stateFailure("STATE_CORRUPT", "a state file is not strict JSON");
    }

    throw error;
  }
}
