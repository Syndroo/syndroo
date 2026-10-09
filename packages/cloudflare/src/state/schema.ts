import type { D1Database } from '../d1.js';
import { fail, randomHex } from '../crypto.js';

/** Fresh architecture-v1 schema. It does not migrate or read legacy tables. */
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS runtime_schema (name TEXT PRIMARY KEY, version INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS scope_meta (scope TEXT PRIMARY KEY, epoch INTEGER NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)))`,
  `CREATE TABLE IF NOT EXISTS records (scope TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0), value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(scope,kind,id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS connection_identity ON records(scope,json_extract(value,'$.account.provider'),
    json_extract(value,'$.account.origin'),json_extract(value,'$.account.accountId')) WHERE kind='connection'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS connection_label ON records(scope,json_extract(value,'$.account.provider'),json_extract(value,'$.label'))
    WHERE kind='connection' AND json_extract(value,'$.label') IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS connection_default ON records(scope,json_extract(value,'$.account.provider'))
    WHERE kind='connection' AND json_extract(value,'$.isDefault')=1`,
  `CREATE INDEX IF NOT EXISTS operation_listing ON records(scope,kind,json_extract(value,'$.principalId'),json_extract(value,'$.createdAt'),id)`,
  `CREATE INDEX IF NOT EXISTS operation_work ON records(scope,kind,json_extract(value,'$.work.pending'),json_extract(value,'$.work.nextWakeAt'))`,
  `CREATE TABLE IF NOT EXISTS mutations (scope TEXT NOT NULL,id TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,id))`,
  `CREATE TABLE IF NOT EXISTS secret_nonces (scope TEXT NOT NULL,nonce TEXT NOT NULL,PRIMARY KEY(scope,nonce))`,
  `CREATE TABLE IF NOT EXISTS secret_blobs (scope TEXT NOT NULL,ref TEXT NOT NULL,creation_id TEXT NOT NULL,
    owner TEXT NOT NULL,nonce TEXT NOT NULL,ciphertext TEXT NOT NULL,retired INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(scope,ref),UNIQUE(scope,nonce))`,
  `CREATE TABLE IF NOT EXISTS secret_meta (scope TEXT PRIMARY KEY,nonce TEXT NOT NULL,ciphertext TEXT NOT NULL)`,
];
export async function initializeD1(db: D1Database, scope: string): Promise<void> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(scope)) fail('STORAGE_CONFIG_INVALID');
  let results;
  try {
    results = await db.batch([
      ...SCHEMA.map(sql => db.prepare(sql)),
      db.prepare("INSERT OR IGNORE INTO runtime_schema(name,version) VALUES('architecture-v1',1)"),
      db.prepare('INSERT OR IGNORE INTO scope_meta(scope,epoch,value) VALUES(?,0,?)').bind(scope,
        JSON.stringify({ sequence: 0, fence: 0, cursorKey: randomHex() })),
      db.prepare("SELECT version FROM runtime_schema WHERE name='architecture-v1'"),
    ]);
  } catch { fail('DURABILITY_ERROR'); }
  if (results.some(result => !result.success) || results.at(-1)?.results[0]?.version !== 1)
    fail('STATE_FORMAT_INVALID');
}
