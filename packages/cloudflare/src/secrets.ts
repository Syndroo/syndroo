import { canonicalJson, parseStrictResponseJson } from '@syndroo/core';
import type * as T from '@syndroo/core';
import type { D1Database } from './d1.js';
import { decode64, encode64, fail, keyBytes, randomHex, unhex } from './crypto.js';
import { initializeD1 } from './state/schema.js';
import { D1State } from './state/state.js';

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const FORMAT = 'syndroo-d1-secret-v1';
const CHECK = 'syndroo deployment key check v1';
type SecretRow = {
  creation_id: string; owner: string; nonce: string; ciphertext: string; retired: number;
  business_retired?: string | null;
};

function validOwner(value: unknown): value is T.SecretOwner {
  if (!value || typeof value !== 'object') return false;
  const owner = value as Partial<T.SecretOwner>;
  return ['credential', 'connect_state', 'callback', 'approval'].includes(owner.kind ?? '')
    && typeof owner.ownerId === 'string' && owner.ownerId.length > 0
    && owner.ownerId.length <= 256 && Number.isSafeInteger(owner.version) && owner.version! >= 0;
}

function aad(scope: string, ref: string, creationId: string, owner: T.SecretOwner): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalJson({ format: FORMAT, scope, ref, creationId, owner }));
}

export class D1Credentials implements T.CredentialStore {
  private constructor(
    readonly db: D1Database, readonly scope: string, readonly key: CryptoKey,
  ) {}

  static async open(db: D1Database, scope: string, keyHex: string): Promise<D1Credentials> {
    return this.openWithMode(db, scope, keyHex, true);
  }

  /** Status path: validate the deployed key without creating or repairing state. */
  static async openExisting(db: D1Database, scope: string, keyHex: string): Promise<D1Credentials> {
    return this.openWithMode(db, scope, keyHex, false);
  }

  private static async openWithMode(
    db: D1Database, scope: string, keyHex: string, initialize: boolean,
  ): Promise<D1Credentials> {
    const raw = keyBytes(keyHex);
    if (initialize) await initializeD1(db, scope);
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    raw.fill(0);
    const store = new D1Credentials(db, scope, key);
    let row: { nonce: string; ciphertext: string } | null;
    try {
      row = await db.prepare('SELECT nonce,ciphertext FROM secret_meta WHERE scope=?')
        .bind(scope).first<{ nonce: string; ciphertext: string }>();
    } catch { return fail('DURABILITY_ERROR'); }
    const owner: T.SecretOwner = { kind: 'credential', ownerId: '__deployment_key__', version: 1 };
    if (row) {
      if (await store.decrypt(row.nonce, row.ciphertext, aad(scope, '__deployment_key__', '', owner)) !== CHECK)
        fail('SECRET_AUTHENTICATION_FAILED');
    } else if (!initialize) {
      fail('STATE_RECOVERY_REQUIRED');
    } else {
      const nonce = randomHex(12);
      const ciphertext = await store.encrypt(CHECK, nonce, aad(scope, '__deployment_key__', '', owner));
      try {
        await db.batch([
          db.prepare('INSERT INTO secret_nonces(scope,nonce) VALUES(?,?)').bind(scope, nonce),
          db.prepare('INSERT OR IGNORE INTO secret_meta(scope,nonce,ciphertext) VALUES(?,?,?)')
            .bind(scope, nonce, ciphertext),
        ]);
      } catch { fail('DURABILITY_ERROR'); }
      let winner: { nonce: string; ciphertext: string } | null;
      try {
        winner = await db.prepare('SELECT nonce,ciphertext FROM secret_meta WHERE scope=?')
          .bind(scope).first<{ nonce: string; ciphertext: string }>();
      } catch { return fail('DURABILITY_ERROR'); }
      if (!winner || await store.decrypt(winner.nonce, winner.ciphertext,
        aad(scope, '__deployment_key__', '', owner)) !== CHECK) fail('SECRET_AUTHENTICATION_FAILED');
    }
    return store;
  }

  private async encrypt(text: string, nonce: string, associated: Uint8Array<ArrayBuffer>): Promise<string> {
    const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: unhex(nonce), additionalData: associated },
      this.key, new TextEncoder().encode(text));
    return encode64(new Uint8Array(bytes));
  }
  private async decrypt(nonce: string, ciphertext: string, associated: Uint8Array<ArrayBuffer>): Promise<string> {
    try {
      if (!/^[0-9a-f]{24}$/.test(nonce)) fail('SECRET_AUTHENTICATION_FAILED');
      const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(nonce), additionalData: associated },
        this.key, decode64(ciphertext));
      return new TextDecoder('utf-8', { fatal: true }).decode(clear);
    } catch { return fail('SECRET_AUTHENTICATION_FAILED'); }
  }
  private async read(ref: string): Promise<SecretRow | null> {
    try {
      return await this.db.prepare(`SELECT b.*, r.id AS business_retired FROM secret_blobs b
        LEFT JOIN records r ON r.scope=b.scope AND r.kind='retired' AND r.id=b.ref
        WHERE b.scope=? AND b.ref=?`).bind(this.scope, ref).first<SecretRow>();
    } catch { return fail('DURABILITY_ERROR'); }
  }
  async put(input: Parameters<T.CredentialStore['put']>[0]): Promise<T.SecretStage> {
    if (!ID.test(input.creationId) || !validOwner(input.owner)
      || !input.value || typeof input.value !== 'object' || Array.isArray(input.value)) fail('INVALID_INPUT');
    const ref = `secret_${input.creationId}`;
    const owner = canonicalJson(input.owner);
    const plain = canonicalJson(input.value);
    const nonce = randomHex(12);
    const ciphertext = await this.encrypt(plain, nonce, aad(this.scope, ref, input.creationId, input.owner));
    try {
      await this.db.batch([
        this.db.prepare('INSERT INTO secret_nonces(scope,nonce) VALUES(?,?)').bind(this.scope, nonce),
        this.db.prepare(`INSERT OR IGNORE INTO secret_blobs(scope,ref,creation_id,owner,nonce,ciphertext)
          SELECT ?,?,?,?,?,? WHERE NOT EXISTS
          (SELECT 1 FROM records WHERE scope=? AND kind='retired' AND id=?)`)
          .bind(this.scope, ref, input.creationId, owner, nonce, ciphertext, this.scope, ref),
      ]);
    } catch { fail('DURABILITY_ERROR'); }
    const row = await this.read(ref);
    if (row?.business_retired || row?.retired) fail('SECRET_RETIRED');
    if (!row) fail('DURABILITY_ERROR');
    if (row.creation_id !== input.creationId || row.owner !== owner) fail('SECRET_STAGE_CONFLICT');
    const saved = await this.decrypt(row.nonce, row.ciphertext, aad(this.scope, ref, input.creationId, input.owner));
    if (saved !== plain) fail('SECRET_STAGE_CONFLICT');
    return { ref, creationId: input.creationId, owner: structuredClone(input.owner) };
  }
  async get(input: Parameters<T.CredentialStore['get']>[0]): Promise<T.JsonObject> {
    if (!/^secret_[A-Za-z0-9._:-]{1,128}$/.test(input.ref) || !validOwner(input.owner)) fail('INVALID_INPUT');
    const row = await this.read(input.ref);
    if (!row) fail('SECRET_NOT_FOUND');
    if (row.retired || row.business_retired) fail('SECRET_RETIRED');
    if (row.owner !== canonicalJson(input.owner)) fail('SECRET_AUTHENTICATION_FAILED');
    const clear = await this.decrypt(row.nonce, row.ciphertext,
      aad(this.scope, input.ref, row.creation_id, input.owner));
    try {
      const parsed = parseStrictResponseJson(clear);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('SECRET_AUTHENTICATION_FAILED');
      return parsed as T.JsonObject;
    } catch { return fail('SECRET_AUTHENTICATION_FAILED'); }
  }
  async delete(input: Parameters<T.CredentialStore['delete']>[0]): Promise<void> {
    const { stage, unreferencedProof } = input;
    if (!stage || !validOwner(stage.owner) || !ID.test(stage.creationId)
      || stage.ref !== `secret_${stage.creationId}` || typeof unreferencedProof !== 'string')
      fail('SECRET_PROOF_INVALID');
    const stageJson = canonicalJson(stage);
    let result;
    try {
      result = await this.db.batch([
        this.db.prepare(`UPDATE secret_blobs SET retired=1,ciphertext='' WHERE scope=? AND ref=?
        AND creation_id=? AND owner=? AND EXISTS
        (SELECT 1 FROM records WHERE scope=? AND kind='retired' AND id=?
          AND json_extract(value,'$.proof')=? AND json_extract(value,'$.stage')=json(?))`)
          .bind(this.scope, stage.ref, stage.creationId, canonicalJson(stage.owner),
            this.scope, stage.ref, unreferencedProof, stageJson),
      ]);
    } catch { return fail('DURABILITY_ERROR'); }
    if (result[0]?.meta.changes !== 1) fail('SECRET_PROOF_INVALID');
  }
}

export async function createD1Storage(options: { db: D1Database; scope: string; key: string }): Promise<{
  state: D1State; credentials: D1Credentials;
}> {
  const credentials = await D1Credentials.open(options.db, options.scope, options.key);
  return { state: new D1State(options), credentials };
}
