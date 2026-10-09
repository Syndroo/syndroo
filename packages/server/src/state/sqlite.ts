import { DatabaseSync } from "node:sqlite";
import { constants, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { ProtocolError } from "@syndroo/core";
import { fail, sanitize } from "./errors.js";

export const STATE_APPLICATION_ID = 0x53594431;
export const SECRETS_APPLICATION_ID = 0x53595331;

function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Explicit POSIX storage paths. Existing unsafe files/directories are rejected, never chmodded. */
function preparePath(filename: string): string {
  if (typeof filename !== "string" || !path.isAbsolute(filename)
    || !["darwin", "linux"].includes(process.platform) || process.getuid === undefined) fail("STORAGE_CONFIG_INVALID");
  function directory(name: string): string {
    if (!existsSync(name)) {
      const parent = directory(path.dirname(name));
      const target = path.join(parent, path.basename(name));
      try { mkdirSync(target, { mode: 0o700 }); } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      }
      syncDirectory(parent);
    }
    return realpathSync(name);
  }
  const parent = directory(path.dirname(filename));
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) fail("STORAGE_CONFIG_INVALID");
  const resolved = path.join(parent, path.basename(filename));
  try {
    const fd = openSync(resolved, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      if ((fstatSync(fd).mode & 0o777) !== 0o600) fail("STORAGE_CONFIG_INVALID");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    syncDirectory(parent);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  for (const candidate of [resolved, `${resolved}-wal`, `${resolved}-shm`, `${resolved}-journal`]) {
    let info;
    try { info = lstatSync(candidate); } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT" && candidate !== resolved) continue;
      throw error;
    }
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) fail("STORAGE_CONFIG_INVALID");
  }
  return resolved;
}

export function openDatabase(filename: string, applicationId: number, busyTimeoutMs = 5000): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 30000) fail("STORAGE_CONFIG_INVALID");
    db = new DatabaseSync(preparePath(filename), { timeout: busyTimeoutMs, enableForeignKeyConstraints: true,
      allowExtension: false, enableDoubleQuotedStringLiterals: false, defensive: true });
    const existingId = db.prepare("PRAGMA application_id").get()!.application_id;
    const version = db.prepare("PRAGMA user_version").get()!.user_version;
    const tables = db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()!.count;
    if ((existingId !== 0 && existingId !== applicationId) || (existingId === 0 && tables !== 0)
      || (existingId === applicationId && version !== 1)) fail("STATE_FORMAT_INVALID");
    db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF; PRAGMA secure_delete = ON;`);
    return db;
  } catch (error) {
    try { db?.close(); } catch { /* Never replace a safe error with SQLite diagnostics. */ }
    return sanitize(error);
  }
}

/** A synchronous boundary: no promise, network request, or event-loop yield may hold the lock. */
export function transaction<T>(db: DatabaseSync, write: boolean, work: () => T): T {
  let began = false;
  try {
    db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    began = true;
    const result = work();
    if (result instanceof Promise) fail("DURABILITY_ERROR");
    db.exec("COMMIT");
    return result;
  } catch (error) {
    let rolledBack = false;
    if (began && db.isTransaction) {
      try { db.exec("ROLLBACK"); rolledBack = true; } catch { /* Outcome is indeterminate. */ }
    }
    if (began && !rolledBack) {
      try { db.close(); } catch { /* Poison the handle after an uncertain commit/rollback. */ }
      return fail("DURABILITY_ERROR");
    }
    if (error instanceof ProtocolError) return sanitize(error);
    return fail("DURABILITY_ERROR");
  }
}
