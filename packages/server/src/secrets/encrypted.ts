import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, parseStrictResponseJson } from '@syndroo/core';
import type * as T from '@syndroo/core';
import { fail } from '../state/errors.js';
import { openDatabase, SECRETS_APPLICATION_ID, transaction } from '../state/sqlite.js';

const CREATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const FORMAT = 'syndroo-secret-v1';
const CHECK_TEXT = 'syndroo deployment key check v1';

type BlobRow = {
  creation_id: string;
  owner_kind: string;
  owner_id: string;
  owner_version: number;
  nonce: Uint8Array;
  tag: Uint8Array;
  ciphertext: Uint8Array;
  retired: number;
};

type SecretState = {
  verifyRetirement(stage: T.SecretStage, proof: string): boolean;
  isRetired(ref: string): boolean;
};

export function deploymentKey(value: string | Uint8Array): Buffer {
  if (typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }
  if (value instanceof Uint8Array && value.byteLength === 32) {
    return Buffer.from(value);
  }
  return fail('SECRET_KEY_INVALID');
}

function ownerIsValid(owner: unknown): owner is T.SecretOwner {
  if (!owner || typeof owner !== 'object') return false;
  const candidate = owner as Partial<T.SecretOwner>;
  return ['credential', 'connect_state', 'callback', 'approval'].includes(candidate.kind ?? '')
    && typeof candidate.ownerId === 'string' && candidate.ownerId.length > 0
    && candidate.ownerId.length <= 256 && Number.isSafeInteger(candidate.version)
    && candidate.version! >= 0;
}

/** Separate protected store. Business state contains opaque refs and retirement proofs. */
export class EncryptedCredentials implements T.CredentialStore {
  readonly #db: DatabaseSync;
  readonly #key: Buffer;
  readonly #scope: string;
  readonly #state: SecretState;

  constructor(options: {
    databasePath: string;
    scope: string;
    key: Buffer;
    state: SecretState;
    busyTimeoutMs?: number;
  }) {
    this.#key = Buffer.from(options.key);
    this.#scope = options.scope;
    this.#state = options.state;
    this.#db = openDatabase(options.databasePath, SECRETS_APPLICATION_ID, options.busyTimeoutMs);
    try {
      transaction(this.#db, true, () => {
        this.#db.exec(`CREATE TABLE IF NOT EXISTS secret_nonces (
          nonce BLOB PRIMARY KEY NOT NULL CHECK(length(nonce)=12)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS secret_meta (
          id TEXT PRIMARY KEY NOT NULL, nonce BLOB NOT NULL,
          tag BLOB NOT NULL, ciphertext BLOB NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS secret_blobs (
          ref TEXT PRIMARY KEY NOT NULL, creation_id TEXT NOT NULL,
          owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
          owner_version INTEGER NOT NULL, nonce BLOB NOT NULL,
          tag BLOB NOT NULL, ciphertext BLOB NOT NULL,
          retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1))
        ) STRICT;`);
        const marker = this.#db.prepare(
          "SELECT nonce,tag,ciphertext FROM secret_meta WHERE id='deployment_key'",
        ).get();
        const checkOwner: T.SecretOwner = {
          kind: 'credential', ownerId: '__deployment_key__', version: 1,
        };
        const aad = this.#aad('__deployment_key__', '', checkOwner);
        if (marker) {
          const decrypted = this.#decrypt(
            marker.nonce as Uint8Array, marker.tag as Uint8Array,
            marker.ciphertext as Uint8Array, aad,
          );
          try {
            if (decrypted.toString('utf8') !== CHECK_TEXT) fail('SECRET_AUTHENTICATION_FAILED');
          } finally { decrypted.fill(0); }
        } else {
          const nonce = this.#nonce();
          const plaintext = Buffer.from(CHECK_TEXT, 'utf8');
          let encrypted: { ciphertext: Buffer; tag: Buffer };
          try { encrypted = this.#encrypt(plaintext, nonce, aad); }
          finally { plaintext.fill(0); }
          this.#db.prepare(
            "INSERT INTO secret_meta(id,nonce,tag,ciphertext) VALUES('deployment_key',?,?,?)",
          ).run(nonce, encrypted.tag, encrypted.ciphertext);
        }
        this.#db.exec(`PRAGMA application_id=${SECRETS_APPLICATION_ID}; PRAGMA user_version=1;`);
      });
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void { if (this.#db.isOpen) this.#db.close(); }

  #aad(ref: string, creationId: string, owner: T.SecretOwner): Buffer {
    return Buffer.from(canonicalJson({ format: FORMAT, scope: this.#scope, ref, creationId, owner }), 'utf8');
  }

  #nonce(): Buffer {
    for (let attempt = 0; attempt < 8; attempt++) {
      const nonce = randomBytes(12);
      const inserted = this.#db.prepare(
        'INSERT INTO secret_nonces(nonce) VALUES(?) ON CONFLICT DO NOTHING',
      ).run(nonce);
      if (inserted.changes === 1) return nonce;
    }
    return fail('DURABILITY_ERROR');
  }

  #encrypt(plaintext: Buffer, nonce: Buffer, aad: Buffer): { ciphertext: Buffer; tag: Buffer } {
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(aad);
    return {
      ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
      tag: cipher.getAuthTag(),
    };
  }

  #decrypt(nonce: Uint8Array, tag: Uint8Array, ciphertext: Uint8Array, aad: Buffer): Buffer {
    try {
      if (nonce.byteLength !== 12 || tag.byteLength !== 16) fail('SECRET_AUTHENTICATION_FAILED');
      const decipher = createDecipheriv('aes-256-gcm', this.#key, nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch { return fail('SECRET_AUTHENTICATION_FAILED'); }
  }

  #row(ref: string): BlobRow | undefined {
    return this.#db.prepare('SELECT * FROM secret_blobs WHERE ref=?').get(ref) as BlobRow | undefined;
  }

  #read(row: BlobRow, ref: string, owner: T.SecretOwner): T.JsonObject {
    if (row.owner_kind !== owner.kind || row.owner_id !== owner.ownerId
      || row.owner_version !== owner.version) fail('SECRET_AUTHENTICATION_FAILED');
    const plaintext = this.#decrypt(
      row.nonce, row.tag, row.ciphertext, this.#aad(ref, row.creation_id, owner),
    );
    try {
      const parsed = parseStrictResponseJson(plaintext);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('SECRET_AUTHENTICATION_FAILED');
      }
      return parsed as T.JsonObject;
    } catch { return fail('SECRET_AUTHENTICATION_FAILED'); }
    finally { plaintext.fill(0); }
  }

  async put(input: Parameters<T.CredentialStore['put']>[0]): Promise<T.SecretStage> {
    if (typeof input.creationId !== 'string' || !CREATION_ID.test(input.creationId)
      || !ownerIsValid(input.owner) || !input.value || typeof input.value !== 'object'
      || Array.isArray(input.value)) fail('INVALID_INPUT');
    const ref = `secret_${input.creationId}`;
    const serialized = canonicalJson(input.value);
    return transaction(this.#db, true, () => {
      if (this.#state.isRetired(ref)) fail('SECRET_RETIRED');
      const old = this.#row(ref);
      if (old?.retired) fail('SECRET_RETIRED');
      if (old) {
        if (old.creation_id !== input.creationId || old.owner_kind !== input.owner.kind
          || old.owner_id !== input.owner.ownerId || old.owner_version !== input.owner.version
          || canonicalJson(this.#read(old, ref, input.owner)) !== serialized) fail('SECRET_STAGE_CONFLICT');
      } else {
        const nonce = this.#nonce();
        const plaintext = Buffer.from(serialized, 'utf8');
        let encrypted: { ciphertext: Buffer; tag: Buffer };
        try { encrypted = this.#encrypt(plaintext, nonce, this.#aad(ref, input.creationId, input.owner)); }
        finally { plaintext.fill(0); }
        this.#db.prepare(`INSERT INTO secret_blobs(ref,creation_id,owner_kind,owner_id,owner_version,
          nonce,tag,ciphertext,retired) VALUES(?,?,?,?,?,?,?,?,0)`).run(
          ref, input.creationId, input.owner.kind, input.owner.ownerId,
          input.owner.version, nonce, encrypted.tag, encrypted.ciphertext,
        );
      }
      return { ref, creationId: input.creationId, owner: structuredClone(input.owner) };
    });
  }

  async get(input: Parameters<T.CredentialStore['get']>[0]): Promise<T.JsonObject> {
    if (typeof input.ref !== 'string' || !/^secret_[A-Za-z0-9._:-]{1,128}$/.test(input.ref)
      || !ownerIsValid(input.owner)) fail('INVALID_INPUT');
    return transaction(this.#db, false, () => {
      if (this.#state.isRetired(input.ref)) fail('SECRET_RETIRED');
      const row = this.#row(input.ref);
      if (!row) fail('SECRET_NOT_FOUND');
      if (row.retired) fail('SECRET_RETIRED');
      return this.#read(row, input.ref, input.owner);
    });
  }

  async delete(input: Parameters<T.CredentialStore['delete']>[0]): Promise<void> {
    if (!input.stage || !ownerIsValid(input.stage.owner)
      || !this.#state.verifyRetirement(input.stage, input.unreferencedProof)) {
      fail('SECRET_PROOF_INVALID');
    }
    transaction(this.#db, true, () => {
      const row = this.#row(input.stage.ref);
      if (!row) fail('SECRET_NOT_FOUND');
      if (row.creation_id !== input.stage.creationId || row.owner_kind !== input.stage.owner.kind
        || row.owner_id !== input.stage.owner.ownerId || row.owner_version !== input.stage.owner.version) {
        fail('SECRET_PROOF_INVALID');
      }
      this.#db.prepare(`UPDATE secret_blobs SET retired=1, ciphertext=X'', tag=X''
        WHERE ref=? AND retired=0`).run(input.stage.ref);
    });
  }
}
