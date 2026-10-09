import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { canonicalJson, parseStrictResponseJson } from "@syndroo/core";
import type * as T from "@syndroo/core";
import { fail } from "./errors.js";
import { openDatabase, STATE_APPLICATION_ID, transaction } from "./sqlite.js";

export type RequestEntry = { digest: string; operationId?: string; sessionId?: string; result?: T.ConnectResult; error?: T.SafeError };
export type StepEntry = { digest: string; claim?: T.StepClaim; result?: T.ConnectResult; error?: T.SafeError };
/**
 * One pending browser OAuth attempt for the callback transport.
 *
 * The OAuth state itself is never stored: `stateDigest` is a keyed digest of
 * the unguessable value the browser carries, so a callback can be resolved
 * without keeping a CSRF token inside the state database.
 */
export type OAuthAttemptRecord = {
  stateDigest: string;
  sessionId: string;
  provider: string;
  stepRevision: number;
  redirectUri: string;
  issuer: string;
  codeChallenge: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
};
type ApprovalEntry = { work: T.WorkRef; admitted: boolean; principalId: string };
type MetaRecord = { sequence: number; fence: number; cursorKey: string };
type Kind = "operation" | "intent" | "connection" | "session" | "approval" | "request" | "step" | "creation" | "meta";
type Cached<Value> = { value: Value; original: string | null; revision: number };

/** A transaction-local identity map; only touched rows are written, guarded by SQL row revisions. */
class Rows<Value> {
  readonly cache = new Map<string, Cached<Value>>();
  constructor(readonly db: DatabaseSync, readonly scope: string, readonly kind: Kind) {}
  get(id: string): Value | undefined {
    const cached = this.cache.get(id);
    if (cached) return cached.value;
    const row = this.db.prepare("SELECT value, revision FROM records WHERE scope = ? AND kind = ? AND id = ?").get(this.scope, this.kind, id);
    if (!row) return undefined;
    if (typeof row.value !== "string" || typeof row.revision !== "number") fail("STATE_RECOVERY_REQUIRED");
    const value = parseStrictResponseJson(row.value) as Value;
    this.cache.set(id, { value, original: row.value, revision: row.revision });
    return value;
  }
  set(id: string, value: Value): void {
    this.get(id);
    const existing = this.cache.get(id);
    this.cache.set(id, { value, original: existing?.original ?? null, revision: existing?.revision ?? 0 });
  }
  has(id: string): boolean { return this.get(id) !== undefined; }
  *values(): IterableIterator<Value> {
    const ids = this.db.prepare("SELECT id FROM records WHERE scope = ? AND kind = ? ORDER BY id").all(this.scope, this.kind);
    const keys = new Set([...ids.map(row => String(row.id)), ...this.cache.keys()]);
    for (const id of keys) yield this.get(id)!;
  }
  select(where: string, parameters: SQLInputValue[], order: string, limit: number): Value[] {
    const rows = this.db.prepare(`SELECT r.id FROM records r WHERE r.scope = ? AND r.kind = ? AND (${where}) ORDER BY ${order} LIMIT ?`)
      .all(this.scope, this.kind, ...parameters, limit);
    return rows.map(row => this.get(String(row.id))!);
  }
  flush(): void {
    // Clear former defaults before setting their replacement; the partial UNIQUE index remains true at every statement.
    const entries = [...this.cache].sort((a, b) => this.kind === "connection"
      ? Number((a[1].value as T.ConnectionRecord).isDefault) - Number((b[1].value as T.ConnectionRecord).isDefault) : 0);
    for (const [id, entry] of entries) {
      const serialized = canonicalJson(entry.value as T.Json);
      if (this.kind === "intent" && Buffer.byteLength(serialized, "utf8") > 262_144) {
        fail("INVALID_INPUT");
      }
      if (serialized === entry.original) continue;
      if (entry.original === null) {
        this.db.prepare("INSERT INTO records(scope,kind,id,revision,value) VALUES(?,?,?,1,?)").run(this.scope, this.kind, id, serialized);
      } else {
        if (this.kind === "intent") fail("DURABILITY_ERROR");
        const result = this.db.prepare("UPDATE records SET value = ?, revision = revision + 1 WHERE scope = ? AND kind = ? AND id = ? AND revision = ?")
          .run(serialized, this.scope, this.kind, id, entry.revision);
        if (result.changes !== 1) fail("DURABILITY_ERROR");
      }
    }
  }
}

export interface Data {
  meta: MetaRecord;
  creation: Rows<number>;
  connections: Rows<T.ConnectionRecord>;
  sessions: Rows<T.ConnectSession>;
  operations: Rows<T.OperationRecord>;
  intents: Rows<T.FrozenIntent>;
  approvals: Rows<ApprovalEntry>;
  requests: Rows<RequestEntry>;
  steps: Rows<StepEntry>;
}
interface WriteSession { data: Data; assertNotRetired(ref: string): void; retire(stage: T.SecretStage): string }

export class Database {
  readonly #db: DatabaseSync;
  constructor(filename: string, readonly scope: string, busyTimeoutMs?: number) {
    if (!scope || scope.length > 128 || /[\x00-\x1f]/.test(scope)) fail("STORAGE_CONFIG_INVALID");
    this.#db = openDatabase(filename, STATE_APPLICATION_ID, busyTimeoutMs);
    try {
      transaction(this.#db, true, () => {
        this.#db.exec(`CREATE TABLE IF NOT EXISTS records (
          scope TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
          value TEXT NOT NULL CHECK(json_valid(value)),
          parent_kind TEXT GENERATED ALWAYS AS (CASE WHEN kind IN ('intent','approval') THEN 'operation' END) VIRTUAL,
          parent_id TEXT GENERATED ALWAYS AS (CASE WHEN kind='intent' THEN json_extract(value,'$.operationId')
            WHEN kind='approval' THEN json_extract(value,'$.work.operationId') END) VIRTUAL,
          PRIMARY KEY(scope,kind,id),
          FOREIGN KEY(scope,parent_kind,parent_id) REFERENCES records(scope,kind,id) DEFERRABLE INITIALLY DEFERRED
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS connection_identity ON records(scope,json_extract(value,'$.account.provider'),
          json_extract(value,'$.account.origin'),json_extract(value,'$.account.accountId')) WHERE kind='connection';
        CREATE UNIQUE INDEX IF NOT EXISTS connection_label ON records(scope,json_extract(value,'$.account.provider'),json_extract(value,'$.label'))
          WHERE kind='connection' AND json_extract(value,'$.label') IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS connection_default ON records(scope,json_extract(value,'$.account.provider'))
          WHERE kind='connection' AND json_extract(value,'$.isDefault')=1;
        CREATE INDEX IF NOT EXISTS operation_listing ON records(scope,kind,json_extract(value,'$.principalId'),json_extract(value,'$.createdAt'),id);
        CREATE INDEX IF NOT EXISTS operation_work ON records(scope,kind,json_extract(value,'$.work.pending'),json_extract(value,'$.work.nextWakeAt'));
        CREATE TABLE IF NOT EXISTS retired_secrets(scope TEXT NOT NULL,ref TEXT NOT NULL,stage TEXT NOT NULL,proof TEXT NOT NULL,
          PRIMARY KEY(scope,ref)) STRICT;`);
        this.#db.exec(`CREATE TABLE IF NOT EXISTS oauth_attempts (
          scope TEXT NOT NULL, state_digest TEXT NOT NULL, session_id TEXT NOT NULL, provider TEXT NOT NULL,
          step_revision INTEGER NOT NULL CHECK(step_revision >= 0), redirect_uri TEXT NOT NULL, issuer TEXT NOT NULL,
          code_challenge TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT,
          PRIMARY KEY(scope,state_digest)) STRICT;`);
        const meta = this.#db.prepare("SELECT scope FROM records WHERE kind='meta'").get();
        if (meta && meta.scope !== scope) fail("STATE_SCOPE_MISMATCH");
        this.#db.prepare("INSERT OR IGNORE INTO records(scope,kind,id,revision,value) VALUES(?,'meta','runtime',1,?)")
          .run(scope, JSON.stringify({ sequence: 0, fence: 0, cursorKey: randomBytes(32).toString("base64url") }));
        this.#db.exec(`PRAGMA application_id=${STATE_APPLICATION_ID}; PRAGMA user_version=1;`);
      });
    } catch (error) { this.close(); throw error; }
  }
  close(): void { if (this.#db.isOpen) this.#db.close(); }
  #data(): { data: Data; flush(): void } {
    const rows = <V>(kind: Kind) => new Rows<V>(this.#db, this.scope, kind);
    const meta = rows<MetaRecord>("meta");
    const value = meta.get("runtime");
    if (!value || !Number.isSafeInteger(value.sequence) || !Number.isSafeInteger(value.fence)
      || typeof value.cursorKey !== "string") fail("STATE_RECOVERY_REQUIRED");
    const data: Data = { meta: value, creation: rows("creation"), connections: rows("connection"), sessions: rows("session"),
      operations: rows("operation"), intents: rows("intent"), approvals: rows("approval"), requests: rows("request"), steps: rows("step") };
    return { data, flush: () => {
      meta.flush(); data.creation.flush(); data.operations.flush(); data.intents.flush(); data.approvals.flush();
      data.connections.flush(); data.sessions.flush(); data.requests.flush(); data.steps.flush();
    } };
  }
  read<Value>(work: (data: Data) => Value): Value {
    return transaction(this.#db, false, () => work(this.#data().data));
  }
  write<Value>(_action: string, work: (session: WriteSession) => Value): Value {
    return transaction(this.#db, true, () => {
      const loaded = this.#data();
      const result = work({ data: loaded.data, assertNotRetired: ref => {
        if (this.#db.prepare("SELECT 1 FROM retired_secrets WHERE scope=? AND ref=?").get(this.scope, ref)) fail("STALE_BINDING");
      }, retire: stage => {
        const previous = this.#db.prepare("SELECT stage,proof FROM retired_secrets WHERE scope=? AND ref=?").get(this.scope, stage.ref);
        const serialized = canonicalJson(stage);
        if (previous) {
          if (previous.stage !== serialized) fail("DURABILITY_ERROR");
          return String(previous.proof);
        }
        const proof = randomBytes(32).toString("hex");
        this.#db.prepare("INSERT INTO retired_secrets(scope,ref,stage,proof) VALUES(?,?,?,?)").run(this.scope, stage.ref, serialized, proof);
        return proof;
      } });
      if (result instanceof Promise) fail("DURABILITY_ERROR");
      loaded.flush();
      return result;
    });
  }
  verifyRetirement(stage: T.SecretStage, proof: string): boolean {
    return transaction(this.#db, false, () => {
      const row = this.#db.prepare("SELECT stage,proof FROM retired_secrets WHERE scope=? AND ref=?").get(this.scope, stage.ref);
      return !!row && row.stage === canonicalJson(stage) && typeof proof === "string" && /^[0-9a-f]{64}$/.test(proof)
        && timingSafeEqual(Buffer.from(String(row.proof)), Buffer.from(proof));
    });
  }
  isRetired(ref: string): boolean {
    return transaction(this.#db, false, () => !!this.#db.prepare(
      "SELECT 1 FROM retired_secrets WHERE scope=? AND ref=?",
    ).get(this.scope, ref));
  }

  /**
   * Durable browser-callback attempts.
   *
   * These rows are transport bookkeeping, never business state: they hold no
   * authorization code, no PKCE verifier, and no raw OAuth state. Only the
   * adapter that owns the callback route reads or writes them.
   */
  readonly oauthAttempts = {
    /** Insert one attempt and drop this scope's already-expired rows. */
    insert: (record: OAuthAttemptRecord): void => {
      transaction(this.#db, true, () => {
        this.#db.prepare("DELETE FROM oauth_attempts WHERE scope = ? AND expires_at <= ?")
          .run(this.scope, record.createdAt);
        this.#db.prepare(`INSERT INTO oauth_attempts(scope,state_digest,session_id,provider,step_revision,
          redirect_uri,issuer,code_challenge,created_at,expires_at,used_at) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`).run(
          this.scope, record.stateDigest, record.sessionId, record.provider, record.stepRevision,
          record.redirectUri, record.issuer, record.codeChallenge, record.createdAt, record.expiresAt,
        );
      });
    },
    read: (stateDigest: string): OAuthAttemptRecord | null => transaction(this.#db, false, () => {
      const row = this.#db.prepare(`SELECT state_digest,session_id,provider,step_revision,redirect_uri,issuer,
        code_challenge,created_at,expires_at,used_at FROM oauth_attempts WHERE scope = ? AND state_digest = ?`)
        .get(this.scope, stateDigest);
      if (!row) return null;
      return {
        stateDigest: String(row.state_digest), sessionId: String(row.session_id), provider: String(row.provider),
        stepRevision: Number(row.step_revision), redirectUri: String(row.redirect_uri), issuer: String(row.issuer),
        codeChallenge: String(row.code_challenge), createdAt: String(row.created_at),
        expiresAt: String(row.expires_at), usedAt: row.used_at === null ? null : String(row.used_at),
      };
    }),
    /**
     * Single-use claim: exactly one caller can win a state digest, and an
     * expired attempt can never be claimed.
     */
    claim: (stateDigest: string, now: string): "claimed" | "missing" | "used" | "expired" =>
      transaction(this.#db, true, () => {
        const changed = this.#db.prepare(`UPDATE oauth_attempts SET used_at = ?
          WHERE scope = ? AND state_digest = ? AND used_at IS NULL AND expires_at > ?`)
          .run(now, this.scope, stateDigest, now).changes;
        if (changed === 1) return "claimed" as const;
        const row = this.#db.prepare("SELECT used_at FROM oauth_attempts WHERE scope = ? AND state_digest = ?")
          .get(this.scope, stateDigest);
        if (!row) return "missing" as const;
        return row.used_at === null ? "expired" as const : "used" as const;
      }),
    /** Compensating action: a claim is released only after a failed accept. */
    release: (stateDigest: string, now: string): void => {
      transaction(this.#db, true, () => {
        this.#db.prepare("UPDATE oauth_attempts SET used_at = NULL WHERE scope = ? AND state_digest = ? AND used_at = ?")
          .run(this.scope, stateDigest, now);
      });
    },
  };
}

export function cursorSignature(key: string, bytes: Uint8Array): Uint8Array {
  return createHmac("sha256", Buffer.from(key, "base64url")).update(bytes).digest();
}
