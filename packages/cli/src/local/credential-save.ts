import { constants as fsConstants, promises as fs, type Stats } from "node:fs";
import path from "node:path";

import type { LocalCredentials } from "@syndroo/core";

import { CliError, usageError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import {
  credentialFileBody,
  normalizeTrustedPathPrefix,
} from "./credentials.js";
import { localError } from "./errors.js";

/**
 * Exclusive creation of one new credential file.
 *
 * The file is created with `O_CREAT | O_EXCL | O_NOFOLLOW | O_WRONLY` and mode
 * 0600, written and fsynced through that descriptor, and then checked by
 * descriptor identity: the published path must be the very inode this process
 * created, in the same parent directory it validated.
 *
 * Same-user threat boundary: descriptor and ancestor identity checks protect
 * against another user (or a racing process) substituting a path. They are not
 * an OS ACL against a malicious process already running as this user, and the
 * token is plain text on disk.
 */

/** Longest saved credential file, matching the read-side limit. */
export const MAX_SAVED_CREDENTIAL_BYTES = 65_536;

export interface SaveCredentialFileOptions {
  /** The full path the operator chose. Resolved against `cwd`. */
  readonly file: string;
  readonly cwd: string;
  readonly credentials: LocalCredentials;
  /** Test-only race seam. Never reachable from a command line. */
  readonly fault?: (point: CredentialSaveFaultPoint) => void | Promise<void>;
}

export type CredentialSaveFaultPoint =
  | "after-open"
  | "after-write"
  | "before-publish"
  | "before-directory-sync";

export interface SavedCredentialFile {
  /** The resolved absolute path; internal use only, never printed. */
  readonly path: string;
}

/** One filesystem object's identity, captured before a secret is written. */
interface Identity {
  readonly dev: number;
  readonly ino: number;
}

/** One ancestor directory and the identity it must still have. */
interface AncestorSnapshot {
  readonly path: string;
  readonly identity: Identity;
}

function identityOf(stat: Stats): Identity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unsafePath(): never {
  throw usageError(
    "the credential file path is not usable; choose a full path in a directory you own",
  );
}

/**
 * A file may exist but the save is not durably committed.
 *
 * The message never contains the path or a secret; `credentialFileSaved` is
 * true because a file may be present, and `durable:false` says the process
 * cannot promise it survived.
 */
function partialSave(message: string): CliError {
  return new CliError(`AUTH_SOURCE_UNAVAILABLE: ${message}`, {
    code: "AUTH_SOURCE_UNAVAILABLE",
    exitCode: EXIT_CODE.USAGE,
    details: {
      credentialFileSaved: true,
      bindingChanged: false,
      durable: false,
      nextAction: "inspect_the_file_before_retrying",
    },
  });
}

export async function saveCredentialFile(
  options: SaveCredentialFileOptions,
): Promise<SavedCredentialFile> {
  const raw = options.file;

  if (
    typeof raw !== "string" ||
    raw.trim().length === 0 ||
    raw.includes("\u0000")
  ) {
    unsafePath();
  }

  // The fixed macOS aliases (/tmp, /var, /etc) resolve to /private/*; every
  // component the operator chose after them must still be symlink-free.
  const resolved = normalizeTrustedPathPrefix(path.resolve(options.cwd, raw));
  const parent = path.dirname(resolved);
  const base = path.basename(resolved);

  if (base.length === 0 || parent === resolved) {
    unsafePath();
  }

  // Create only the missing directories the operator selected, each 0700, and
  // never touch an existing directory's mode.
  await ensurePrivateDirectory(parent);

  const ancestors = await snapshotAncestors(parent);
  const parentIdentity = ancestors[ancestors.length - 1]?.identity as Identity;

  await assertTargetFree(resolved);

  const bytes = Buffer.from(
    `${JSON.stringify(credentialFileBody(options.credentials), null, 2)}\n`,
    "utf8",
  );

  if (bytes.byteLength > MAX_SAVED_CREDENTIAL_BYTES) {
    throw usageError("the credential group is too large to save");
  }

  let handle;

  try {
    handle = await fs.open(
      resolved,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      throw usageError(
        "the credential file already exists; choose a new path or use --credential-file to import it",
      );
    }

    throw localError(
      "AUTH_SOURCE_UNAVAILABLE",
      "the credential file could not be created",
    );
  }

  let created: Identity;

  try {
    const before = await handle.stat();

    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 ||
      !ownedByThisUser(before)
    ) {
      await handle.close().catch(() => undefined);

      throw localError(
        "AUTH_SOURCE_UNAVAILABLE",
        "the new credential file is not a private regular file",
      );
    }

    created = identityOf(before);
  } catch (error) {
    await handle.close().catch(() => undefined);

    throw error;
  }

  let written = false;
  let writeError: unknown = null;

  try {
    // Test-only race seam, fired while the descriptor is open and before the
    // parent is re-checked.
    await options.fault?.("after-open");

    // Re-check the parent and every ancestor after the open and before the
    // secret is written: a substituted parent means the bytes would land in a
    // location this process never validated.
    const parentNow = await fs.lstat(parent).catch(() => null);

    if (
      parentNow === null ||
      parentNow.isSymbolicLink() ||
      !parentNow.isDirectory() ||
      !sameIdentity(identityOf(parentNow), parentIdentity) ||
      !(await ancestorsUnchanged(ancestors))
    ) {
      throw localError(
        "AUTH_SOURCE_UNAVAILABLE",
        "the credential file directory changed before the secret was written",
      );
    }

    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();

    const after = await handle.stat();

    if (
      !sameIdentity(identityOf(after), created) ||
      after.nlink !== 1 ||
      (after.mode & 0o777) !== 0o600 ||
      !ownedByThisUser(after)
    ) {
      throw localError(
        "AUTH_SOURCE_UNAVAILABLE",
        "the credential file changed while it was being written",
      );
    }

    // The test-only post-write seam fires before the write is declared
    // complete, so a fault here still runs the guarded cleanup.
    await options.fault?.("after-write");
    written = true;
  } catch (error) {
    writeError = error;
  } finally {
    await handle.close().catch(() => undefined);
  }

  if (!written) {
    // Remove only the exact inode this process created in the parent it
    // validated; anything else is left untouched.
    await removeOwnFile(resolved, created, parentIdentity, ancestors);

    throw writeError instanceof CliError
      ? writeError
      : localError(
          "AUTH_SOURCE_UNAVAILABLE",
          "the credential file could not be written completely",
        );
  }

  // The published path must be the descriptor's own inode, and no ancestor may
  // have been substituted while the secret was being written.
  try {
    await options.fault?.("before-publish");
  } catch {
    throw partialSave(
      "the credential file was written but its location could not be confirmed; inspect it before retrying",
    );
  }

  const published = await fs.lstat(resolved).catch(() => null);

  if (
    published === null ||
    published.isSymbolicLink() ||
    !published.isFile() ||
    !sameIdentity(identityOf(published), created) ||
    published.nlink !== 1 ||
    !(await ancestorsUnchanged(ancestors))
  ) {
    throw partialSave(
      "the credential file was written but its location changed before it could be confirmed; inspect it before retrying",
    );
  }

  try {
    await options.fault?.("before-directory-sync");
  } catch {
    throw partialSave(
      "the credential file was written but its directory entry could not be confirmed durable; inspect it before retrying",
    );
  }

  if (!(await syncDirectory(parent))) {
    throw partialSave(
      "the credential file was written but its directory entry could not be confirmed durable; inspect it before retrying",
    );
  }

  return { path: resolved };
}

/** Missing directories the operator selected are created 0700, never chmodded. */
async function ensurePrivateDirectory(directory: string): Promise<void> {
  const segments: string[] = [];
  let cursor = directory;

  for (;;) {
    const existing = await fs.lstat(cursor).catch(() => null);

    if (existing !== null) {
      break;
    }

    segments.unshift(path.basename(cursor));
    const next = path.dirname(cursor);

    if (next === cursor) {
      break;
    }

    cursor = next;
  }

  for (const segment of segments) {
    cursor = path.join(cursor, segment);

    try {
      await fs.mkdir(cursor, { mode: 0o700 });
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") {
        throw localError(
          "AUTH_SOURCE_UNAVAILABLE",
          "the credential file directory could not be created",
        );
      }
    }
  }

  let stat;

  try {
    stat = await fs.lstat(directory);
  } catch {
    throw localError(
      "AUTH_SOURCE_UNAVAILABLE",
      "the credential file directory is not usable",
    );
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    unsafePath();
  }

  if (!ownedByThisUser(stat)) {
    unsafePath();
  }

  // The selected directory must already be exactly 0700. A wider mode (0755,
  // 0750, ...) is refused rather than chmodded: this process never changes the
  // mode of a directory it did not create.
  if ((stat.mode & 0o777) !== 0o700) {
    throw usageError(
      "the credential file directory must already be mode 0700; choose a private directory",
    );
  }
}

/** One dev/ino snapshot per ancestor, root first. */
async function snapshotAncestors(
  target: string,
): Promise<readonly AncestorSnapshot[]> {
  const chain: string[] = [];
  let cursor = target;

  for (;;) {
    chain.unshift(cursor);
    const next = path.dirname(cursor);

    if (next === cursor) {
      break;
    }

    cursor = next;
  }

  const snapshots: AncestorSnapshot[] = [];

  for (const directory of chain) {
    const stat = await fs.lstat(directory);

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      unsafePath();
    }

    // Any ancestor another user can write to could be used to substitute the
    // parent entry; ownership itself is only required for the chosen parent.
    if ((stat.mode & 0o022) !== 0) {
      throw usageError(
        "the credential file path crosses a directory other users can write to; choose a private location",
      );
    }

    snapshots.push({ path: directory, identity: identityOf(stat) });
  }

  return snapshots;
}

async function ancestorsUnchanged(
  ancestors: readonly AncestorSnapshot[],
): Promise<boolean> {
  for (const ancestor of ancestors) {
    const stat = await fs.lstat(ancestor.path).catch(() => null);

    if (
      stat === null ||
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      !sameIdentity(identityOf(stat), ancestor.identity)
    ) {
      return false;
    }
  }

  return true;
}

async function assertTargetFree(target: string): Promise<void> {
  try {
    await fs.lstat(target);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return;
    }

    unsafePath();
  }

  throw usageError(
    "the credential file already exists; choose a new path or use --credential-file to import it",
  );
}

/**
 * Removes only this process's own fresh inode.
 *
 * A replaced path, a changed parent, or an unreadable path is left exactly as
 * it is; the caller reports a partial result instead of deleting anything.
 */
async function removeOwnFile(
  target: string,
  created: Identity,
  parentIdentity: Identity,
  ancestors: readonly AncestorSnapshot[],
): Promise<void> {
  const current = await fs.lstat(target).catch(() => null);
  const parent = await fs.lstat(path.dirname(target)).catch(() => null);

  if (
    current === null ||
    !current.isFile() ||
    !sameIdentity(identityOf(current), created) ||
    parent === null ||
    !sameIdentity(identityOf(parent), parentIdentity) ||
    !(await ancestorsUnchanged(ancestors))
  ) {
    return;
  }

  await fs.rm(target, { force: true }).catch(() => undefined);
}

function ownedByThisUser(stat: Stats): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;

  return uid === null || stat.uid === uid;
}

/** True when the directory entry was confirmed durable. */
async function syncDirectory(directory: string): Promise<boolean> {
  let handle;

  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();

    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
