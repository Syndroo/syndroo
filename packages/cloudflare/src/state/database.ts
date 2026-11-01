import { canonicalJson, parseStrictResponseJson } from '@syndroo/core';
import type * as T from '@syndroo/core';
import type { OAuthAttemptRecord, OAuthAttemptStore, OAuthClaimResult } from '@syndroo/server/http';
import { primary, type D1Database, type D1Statement, type D1Value } from '../d1.js';
import { fail, randomHex } from '../crypto.js';
import { sanitize } from './errors.js';

/** Core connect sessions last 15 minutes; keep tombstones through that bound. */
const OAUTH_ATTEMPT_RETENTION_MS = 900_000;

export type RequestEntry = { digest: string; operationId?: string; sessionId?: string; result?: T.ConnectResult; error?: T.SafeError };
export type StepEntry = { digest: string; claim?: T.StepClaim; result?: T.ConnectResult; error?: T.SafeError };
type ApprovalEntry = { work: T.WorkRef; admitted: boolean; principalId: string };
type Retirement = { stage: T.SecretStage; proof: string };
type Meta = { sequence: number; fence: number; cursorKey: string };
type Kind = 'operation' | 'intent' | 'connection' | 'session' | 'approval' | 'request' | 'step' | 'creation' | 'retired';
type Cached<Value> = { value: Value; original: string | null; revision: number };

class Rows<Value> {
  readonly cache = new Map<string, Cached<Value>>();
  constructor(readonly db: D1Database, readonly scope: string, readonly kind: Kind) {}
  async get(id: string): Promise<Value | undefined> {
    const cached = this.cache.get(id);
    if (cached) return cached.value;
    const row = await this.db.prepare('SELECT value,revision FROM records WHERE scope=? AND kind=? AND id=?')
      .bind(this.scope, this.kind, id).first<{ value: string; revision: number }>();
    if (!row) return undefined;
    const value = parseStrictResponseJson(row.value) as Value;
    this.cache.set(id, { value, original: row.value, revision: row.revision });
    return value;
  }
  async has(id: string): Promise<boolean> { return (await this.get(id)) !== undefined; }
  async set(id: string, value: Value): Promise<void> {
    await this.get(id);
    const old = this.cache.get(id);
    this.cache.set(id, { value, original: old?.original ?? null, revision: old?.revision ?? 0 });
  }
  async values(): Promise<Value[]> {
    const rows = await this.db.prepare('SELECT id FROM records WHERE scope=? AND kind=? ORDER BY id')
      .bind(this.scope, this.kind).all<{ id: string }>();
    if (!rows.success) fail('DURABILITY_ERROR');
    const ids = new Set([...rows.results.map(row => row.id), ...this.cache.keys()]);
    return Promise.all([...ids].map(async id => (await this.get(id))!));
  }
  async select(where: string, values: D1Value[], order: string, limit: number): Promise<Value[]> {
    // SQL fragments originate only in this adapter's fixed business methods.
    const rows = await this.db.prepare(`SELECT r.id FROM records r WHERE r.scope=? AND r.kind=? AND (${where}) ORDER BY ${order} LIMIT ?`)
      .bind(this.scope, this.kind, ...values, limit).all<{ id: string }>();
    if (!rows.success) fail('DURABILITY_ERROR');
    return Promise.all(rows.results.map(async row => (await this.get(row.id))!));
  }
  statements(marker: string): D1Statement[] {
    const writes: D1Statement[] = [];
    const entries = [...this.cache].sort((a, b) => this.kind === 'connection'
      ? Number((a[1].value as T.ConnectionRecord).isDefault) - Number((b[1].value as T.ConnectionRecord).isDefault) : 0);
    for (const [id, entry] of entries) {
      const value = canonicalJson(entry.value);
      if (this.kind === 'intent' && new TextEncoder().encode(value).byteLength > 262_144) fail('INVALID_INPUT');
      if (value === entry.original) continue;
      if (entry.original === null) {
        writes.push(this.db.prepare(`INSERT INTO records(scope,kind,id,revision,value)
          SELECT ?,?,?,1,? WHERE EXISTS(SELECT 1 FROM mutations WHERE scope=? AND id=?)`)
          .bind(this.scope, this.kind, id, value, this.scope, marker));
      } else {
        if (this.kind === 'intent') fail('DURABILITY_ERROR');
        writes.push(this.db.prepare(`UPDATE records SET value=?,revision=revision+1
          WHERE scope=? AND kind=? AND id=? AND revision=?
          AND EXISTS(SELECT 1 FROM mutations WHERE scope=? AND id=?)`)
          .bind(value, this.scope, this.kind, id, entry.revision, this.scope, marker));
      }
    }
    return writes;
  }
}
export interface Data {
  meta: Meta;
  creation: Rows<number>;
  connections: Rows<T.ConnectionRecord>;
  sessions: Rows<T.ConnectSession>;
  operations: Rows<T.OperationRecord>;
  intents: Rows<T.FrozenIntent>;
  approvals: Rows<ApprovalEntry>;
  requests: Rows<RequestEntry>;
  steps: Rows<StepEntry>;
  retired: Rows<Retirement>;
}
interface WriteSession {
  data: Data;
  assertNotRetired(ref: string): Promise<void>;
  retire(stage: T.SecretStage): Promise<string>;
}

/** Private implementation detail, never a Core transaction callback port. */
export class Database {
  constructor(readonly binding: D1Database, readonly scope: string) {}
  readonly oauthAttempts: OAuthAttemptStore = {
    insert: async (record: OAuthAttemptRecord): Promise<void> => {
      const db = primary(this.binding);
      const retentionCutoff = new Date(
        Date.parse(record.createdAt) - OAUTH_ATTEMPT_RETENTION_MS,
      ).toISOString();
      let results;
      try {
        results = await db.batch([
          db.prepare(`DELETE FROM oauth_attempts
            WHERE scope=? AND expires_at<=? AND created_at<=?`)
            .bind(this.scope, record.createdAt, retentionCutoff),
          db.prepare(`INSERT OR IGNORE INTO oauth_attempts(scope,state_digest,session_id,provider,
            step_revision,redirect_uri,issuer,code_challenge,created_at,expires_at,used_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`).bind(
            this.scope, record.stateDigest, record.sessionId, record.provider, record.stepRevision,
            record.redirectUri, record.issuer, record.codeChallenge, record.createdAt, record.expiresAt,
          ),
          db.prepare(`SELECT session_id,provider,step_revision,redirect_uri,issuer,code_challenge
            FROM oauth_attempts WHERE scope=? AND state_digest=?`)
            .bind(this.scope, record.stateDigest),
        ]);
      } catch { return fail('DURABILITY_ERROR'); }
      if (results.some(result => !result.success)) fail('DURABILITY_ERROR');
      const existing = results[2]?.results[0] as Record<string, unknown> | undefined;
      if (!existing
        || String(existing.session_id) !== record.sessionId
        || String(existing.provider) !== record.provider
        || Number(existing.step_revision) !== record.stepRevision
        || String(existing.redirect_uri) !== record.redirectUri
        || String(existing.issuer) !== record.issuer
        || String(existing.code_challenge) !== record.codeChallenge) {
        fail('DURABILITY_ERROR');
      }
    },
    read: async (stateDigest: string): Promise<OAuthAttemptRecord | null> => {
      let row: Record<string, unknown> | null;
      try {
        row = await primary(this.binding).prepare(`SELECT state_digest,session_id,provider,step_revision,
          redirect_uri,issuer,code_challenge,created_at,expires_at,used_at
          FROM oauth_attempts WHERE scope=? AND state_digest=?`)
          .bind(this.scope, stateDigest).first<Record<string, unknown>>();
      } catch { return fail('DURABILITY_ERROR'); }
      if (!row) return null;
      return {
        stateDigest: String(row.state_digest),
        sessionId: String(row.session_id),
        provider: String(row.provider),
        stepRevision: Number(row.step_revision),
        redirectUri: String(row.redirect_uri),
        issuer: String(row.issuer),
        codeChallenge: String(row.code_challenge),
        createdAt: String(row.created_at),
        expiresAt: String(row.expires_at),
        usedAt: row.used_at === null ? null : String(row.used_at),
      };
    },
    claim: async (stateDigest: string, now: string): Promise<OAuthClaimResult> => {
      const db = primary(this.binding);
      let results;
      try {
        results = await db.batch([
          db.prepare(`UPDATE oauth_attempts SET used_at=?
            WHERE scope=? AND state_digest=? AND used_at IS NULL AND expires_at>?`)
            .bind(now, this.scope, stateDigest, now),
          db.prepare('SELECT used_at,expires_at FROM oauth_attempts WHERE scope=? AND state_digest=?')
            .bind(this.scope, stateDigest),
        ]);
      } catch { return fail('DURABILITY_ERROR'); }
      if (results.some(result => !result.success)) fail('DURABILITY_ERROR');
      if ((results[0]?.meta.changes ?? 0) === 1) return 'claimed';
      const row = results[1]?.results[0] as { used_at?: unknown; expires_at?: unknown } | undefined;
      if (!row) return 'missing';
      if (row.used_at !== null) return 'used';
      return String(row.expires_at) <= now ? 'expired' : 'missing';
    },
    release: async (stateDigest: string, now: string): Promise<void> => {
      let result;
      try {
        result = await primary(this.binding).prepare(`UPDATE oauth_attempts SET used_at=NULL
          WHERE scope=? AND state_digest=? AND used_at=?`).bind(this.scope, stateDigest, now).run();
      } catch { return fail('DURABILITY_ERROR'); }
      if (!result.success) fail('DURABILITY_ERROR');
    },
  };
  async #load(db: D1Database) {
    const row = await db.prepare('SELECT epoch,value FROM scope_meta WHERE scope=?').bind(this.scope)
      .first<{ epoch: number; value: string }>();
    if (!row || !Number.isSafeInteger(row.epoch)) fail('STATE_RECOVERY_REQUIRED');
    const meta = parseStrictResponseJson(row.value) as Meta;
    if (!meta || !Number.isSafeInteger(meta.sequence) || !Number.isSafeInteger(meta.fence)
      || typeof meta.cursorKey !== 'string') fail('STATE_RECOVERY_REQUIRED');
    const rows = <V>(kind: Kind) => new Rows<V>(db, this.scope, kind);
    const data: Data = {
      meta, creation: rows('creation'), connections: rows('connection'), sessions: rows('session'),
      operations: rows('operation'), intents: rows('intent'), approvals: rows('approval'),
      requests: rows('request'), steps: rows('step'), retired: rows('retired'),
    };
    return { epoch: row.epoch, original: row.value, data };
  }
  async #epoch(db: D1Database): Promise<number> {
    const row = await db.prepare('SELECT epoch FROM scope_meta WHERE scope=?').bind(this.scope).first<{ epoch: number }>();
    if (!row) fail('STATE_RECOVERY_REQUIRED');
    return row.epoch;
  }
  async read<Value>(work: (data: Data) => Promise<Value>): Promise<Value> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const db = primary(this.binding);
      try {
        const loaded = await this.#load(db);
        let result: Value;
        try { result = await work(loaded.data); }
        catch (error) {
          if (await this.#epoch(db) !== loaded.epoch) continue;
          return sanitize(error);
        }
        if (await this.#epoch(db) === loaded.epoch) return result;
      } catch (error) { return sanitize(error); }
    }
    return fail('REQUEST_IN_PROGRESS');
  }
  async write<Value>(_action: string, work: (session: WriteSession) => Promise<Value>): Promise<Value> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const db = primary(this.binding);
      try {
        const loaded = await this.#load(db);
        let result: Value;
        try {
          result = await work({
            data: loaded.data,
            assertNotRetired: async ref => {
              if (await loaded.data.retired.has(ref)) fail('STALE_BINDING');
            },
            retire: async stage => {
              const previous = await loaded.data.retired.get(stage.ref);
              if (previous) {
                if (canonicalJson(previous.stage) !== canonicalJson(stage)) fail('DURABILITY_ERROR');
                return previous.proof;
              }
              const proof = randomHex();
              await loaded.data.retired.set(stage.ref, { stage, proof });
              return proof;
            },
          });
        } catch (error) {
          if (await this.#epoch(db) !== loaded.epoch) continue;
          return sanitize(error);
        }
        const marker = randomHex();
        const writes = [loaded.data.creation, loaded.data.operations, loaded.data.intents,
          loaded.data.approvals, loaded.data.connections, loaded.data.sessions,
          loaded.data.requests, loaded.data.steps, loaded.data.retired].flatMap(rows => rows.statements(marker));
        const meta = canonicalJson(loaded.data.meta);
        if (!writes.length && meta === loaded.original) {
          if (await this.#epoch(db) === loaded.epoch) return result;
          continue;
        }
        const receipt = canonicalJson({ value: result === undefined ? null : result, isVoid: result === undefined });
        const batch = await db.batch([
          db.prepare(`INSERT INTO mutations(scope,id,result) SELECT ?,?,?
            WHERE EXISTS(SELECT 1 FROM scope_meta WHERE scope=? AND epoch=?)`)
            .bind(this.scope, marker, receipt, this.scope, loaded.epoch),
          ...writes,
          db.prepare(`UPDATE scope_meta SET epoch=epoch+1,value=? WHERE scope=? AND epoch=?
            AND EXISTS(SELECT 1 FROM mutations WHERE scope=? AND id=?)`)
            .bind(meta, this.scope, loaded.epoch, this.scope, marker),
          db.prepare('SELECT result FROM mutations WHERE scope=? AND id=?').bind(this.scope, marker),
          db.prepare('DELETE FROM mutations WHERE scope=? AND id=?').bind(this.scope, marker),
        ]);
        if (batch.some(item => !item.success)) fail('DURABILITY_ERROR');
        const winner = batch.at(-2)?.results[0]?.result;
        if (typeof winner === 'string') {
          const saved = parseStrictResponseJson(winner) as { value: Value; isVoid: boolean };
          return saved.isVoid ? undefined as Value : saved.value;
        }
        // CAS lost: every dependent statement was guarded by the absent marker.
        // Reread the winning state; never retry a batch that threw or was uncertain.
      } catch (error) { return sanitize(error); }
    }
    return fail('REQUEST_IN_PROGRESS');
  }
  async verifyRetirement(stage: T.SecretStage, proof: string): Promise<boolean> {
    return this.read(async data => {
      const row = await data.retired.get(stage.ref);
      return !!row && row.proof === proof && canonicalJson(row.stage) === canonicalJson(stage);
    });
  }
  async isRetired(ref: string): Promise<boolean> {
    return this.read(async data => data.retired.has(ref));
  }
}
