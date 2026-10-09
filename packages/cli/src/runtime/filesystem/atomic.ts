import { randomBytes } from "node:crypto";
import { constants as FS, promises as fs, type Stats } from "node:fs";
import path from "node:path";

import { fail, failure, isErrno, isFailure } from "./errors.js";

/**
 * Filesystem primitives for the local runtime state root.
 *
 * Every path used here is fixed by this module from a caller-supplied state
 * root; no caller hands in a record path. Four properties matter:
 *
 * 1. Controlled paths. A directory this runtime owns is a plain directory,
 *    owned by the current uid, mode 0700. A file it owns is a plain file with
 *    link count 1, owned by the current uid, mode 0600. Symlinks, FIFOs,
 *    sockets, devices and hard links are refused instead of repaired, and a
 *    refused path is never chmodded into acceptability.
 * 2. Explicit creation. Missing components are created one at a time with mode
 *    0700 and re-checked with `lstat`, so a component swapped for a symlink
 *    while it is being created is refused rather than followed.
 * 3. Bounded reads. Reads use `O_NOFOLLOW | O_NONBLOCK` so a path swapped for a
 *    FIFO cannot block the process before `fstat`, and the byte ceiling is
 *    enforced while reading.
 * 4. Atomic replacement. A published file appears through a same-directory
 *    temporary file, fsync, rename and directory fsync.
 */

export const DIRECTORY_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Hard ceiling for any single record or journal file this version reads. */
export const MAX_RECORD_BYTES = 1_048_576;

export const CURRENT_FILE_NAME = "CURRENT";
export const FORMAT_FILE_NAME = "format.json";
export const LOCK_DIRECTORY_NAME = "lock";
export const LOCK_OWNER_FILE_NAME = "owner.json";
export const GENERATIONS_DIRECTORY_NAME = "generations";
export const SECRETS_DIRECTORY_NAME = "secrets";
export const TOMBSTONES_DIRECTORY_NAME = "tombstones";
export const RECORDS_DIRECTORY_NAME = "records";
export const JOURNAL_FILE_NAME = "journal.json";

const READ_CHUNK_BYTES = 65_536;

function currentUid(): number {
  const uid = process.getuid?.();

  if (uid === undefined) {
    fail("DURABILITY_ERROR");
  }

  return uid;
}

/** POSIX only. Windows writes are refused; no claim is made about them. */
export function assertSupportedRuntime(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    fail("DURABILITY_ERROR");
  }

  currentUid();
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return null;
    }

    throw failure("DURABILITY_ERROR");
  }
}

function assertOwnedDirectory(stat: Stats): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  if ((stat.mode & 0o777) !== DIRECTORY_MODE) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  if (stat.uid !== currentUid()) {
    fail("STATE_RECOVERY_REQUIRED");
  }
}

function assertOwnedFile(stat: Stats): void {
  if (!stat.isFile()) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  if (stat.nlink !== 1) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  if ((stat.mode & 0o777) !== FILE_MODE) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  if (stat.uid !== currentUid()) {
    fail("STATE_RECOVERY_REQUIRED");
  }
}

/**
 * System alias roots that are resolved instead of refused.
 *
 * macOS ships `/tmp`, `/var` and `/etc` as symlinks into `/private`, and the
 * system temporary directory lives under one of them. Resolving exactly these
 * known aliases keeps that working; every other symlink in a state path is
 * refused so a caller cannot redirect the controlled root.
 */
function systemAliasRoots(): ReadonlySet<string> {
  return process.platform === "darwin"
    ? new Set(["/tmp", "/var", "/etc"])
    : new Set<string>();
}

interface ControlledPath {
  readonly resolved: string;
  readonly missing: readonly string[];
}

export async function resolveStateRootPath(
  stateRoot: string,
): Promise<ControlledPath> {
  assertSupportedRuntime();

  const absolute = path.resolve(stateRoot);
  const root = path.parse(absolute).root;

  if (absolute === root) {
    fail("STATE_RECOVERY_REQUIRED");
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
        fail("STATE_RECOVERY_REQUIRED");
      }

      current = await fs.realpath(next).catch(() => {
        throw failure("STATE_RECOVERY_REQUIRED");
      });

      continue;
    }

    if (!stat.isDirectory()) {
      fail("STATE_RECOVERY_REQUIRED");
    }

    current = next;
  }

  return { resolved: current, missing };
}

/** Validates one existing owned directory. Creates nothing. */
export async function requireOwnedDirectory(
  directory: string,
): Promise<void> {
  assertSupportedRuntime();

  const stat = await lstatOrNull(directory);

  if (stat === null) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  assertOwnedDirectory(stat);
}

/** Creates one owned directory, or validates the one that already exists. */
export async function ensureOwnedDirectory(
  directory: string,
): Promise<string> {
  assertSupportedRuntime();

  try {
    await fs.mkdir(directory, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw failure("DURABILITY_ERROR");
    }

    await requireOwnedDirectory(directory);

    return directory;
  }

  try {
    // mkdir is filtered through the process umask, so the mode is set
    // explicitly on the directory this process just created.
    await fs.chmod(directory, DIRECTORY_MODE);
    await requireOwnedDirectory(directory);
  } catch (error) {
    if (isFailure(error)) {
      throw error;
    }

    throw failure("DURABILITY_ERROR");
  }

  return directory;
}

/**
 * Resolves a state root that must already exist.
 *
 * A symlinked root, a foreign owner or a group/other bit is refused rather than
 * repaired: a read of damaged state must not silently become a read of trusted
 * state. Known system aliases are resolved so `/var/...` temporary roots work.
 */
export async function requireStateRoot(stateRoot: string): Promise<string> {
  const { resolved, missing } = await resolveStateRootPath(stateRoot);

  if (missing.length > 0) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  await requireOwnedDirectory(resolved);

  return resolved;
}

/**
 * Resolves a state root, creating it and any missing component with mode 0700.
 *
 * Missing components are created one at a time and re-checked with `lstat`, so
 * a path swapped for a symlink during creation is refused.
 */
export async function ensureStateRoot(stateRoot: string): Promise<string> {
  const { resolved, missing } = await resolveStateRootPath(stateRoot);
  let current = resolved;

  for (const name of missing) {
    const next = path.join(current, name);

    await ensureOwnedDirectory(next);

    current = next;
  }

  if (missing.length === 0) {
    await requireOwnedDirectory(current);
  }

  return current;
}

/** Reads one owned file, or `null` when the file does not exist. */
export async function readOwnedFile(
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

    throw failure("STATE_RECOVERY_REQUIRED");
  }

  try {
    assertOwnedFile(await handle.stat());

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

      if (total > MAX_RECORD_BYTES) {
        fail("STATE_RECOVERY_REQUIRED");
      }

      chunks.push(buffer.subarray(0, bytesRead));
    }

    return Buffer.concat(chunks, total);
  } catch (error) {
    if (isFailure(error)) {
      throw error;
    }

    throw failure("STATE_RECOVERY_REQUIRED");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("STATE_RECOVERY_REQUIRED");
  }
}

/** Syncs a directory so a rename or a new entry is durable. */
export async function syncDirectory(directory: string): Promise<void> {
  let handle;

  try {
    handle = await fs.open(directory, FS.O_RDONLY);
  } catch {
    throw failure("DURABILITY_ERROR");
  }

  try {
    await handle.sync();
  } catch {
    throw failure("DURABILITY_ERROR");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Creates one owned file that must not already exist.
 *
 * Used inside an unpublished generation directory and for secret blobs, where
 * the name is authoritative only once the caller publishes it. An existing name
 * is reported instead of overwritten.
 */
export async function createOwnedFile(
  directory: string,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  assertSupportedRuntime();
  await requireOwnedDirectory(directory);

  const target = path.join(directory, name);
  let handle;

  try {
    handle = await fs.open(
      target,
      FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | FS.O_NOFOLLOW,
      FILE_MODE,
    );
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      fail("STATE_RECOVERY_REQUIRED");
    }

    throw failure("DURABILITY_ERROR");
  }

  try {
    await handle.chmod(FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch {
    throw failure("DURABILITY_ERROR");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Replaces one owned file in a directory, or creates it. */
export async function replaceOwnedFile(
  directory: string,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  assertSupportedRuntime();
  await requireOwnedDirectory(directory);

  const target = path.join(directory, name);
  const existing = await lstatOrNull(target);

  if (existing !== null) {
    assertOwnedFile(existing);
  }

  const temporary = path.join(
    directory,
    `.tmp-${randomBytes(8).toString("hex")}`,
  );

  try {
    await createOwnedFile(directory, path.basename(temporary), bytes);
    await fs.rename(temporary, target);
    await syncDirectory(directory);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);

    if (isFailure(error)) {
      throw error;
    }

    throw failure("DURABILITY_ERROR");
  }
}

/** Lists directory entry names, or nothing when the directory is absent. */
export async function listDirectoryNames(
  directory: string,
): Promise<readonly string[]> {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return [];
    }

    throw failure("STATE_RECOVERY_REQUIRED");
  }
}

/** Removes one directory this runtime owns. Never follows a symlinked root. */
export async function removeOwnedDirectory(directory: string): Promise<void> {
  const stat = await lstatOrNull(directory);

  if (stat === null) {
    return;
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  try {
    await fs.rm(directory, { recursive: true, force: false });
  } catch {
    throw failure("DURABILITY_ERROR");
  }
}

/** Removes one owned file. A symlinked or non-file target is refused. */
export async function removeOwnedFile(filePath: string): Promise<void> {
  const stat = await lstatOrNull(filePath);

  if (stat === null) {
    return;
  }

  assertOwnedFile(stat);

  try {
    await fs.rm(filePath, { force: false });
  } catch {
    throw failure("DURABILITY_ERROR");
  }
}

/**
 * Removes one name this runtime writes for its own temporary data.
 *
 * A temporary file or directory left behind by an interrupted write is
 * provably not authoritative (`CURRENT` never named it), so write-entry
 * recovery may drop it. Anything else is refused.
 */
export async function removeTemporaryName(target: string): Promise<void> {
  const stat = await lstatOrNull(target);

  if (stat === null) {
    return;
  }

  if (stat.isSymbolicLink()) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  if (stat.isDirectory()) {
    await removeOwnedDirectory(target);

    return;
  }

  await removeOwnedFile(target);
}
