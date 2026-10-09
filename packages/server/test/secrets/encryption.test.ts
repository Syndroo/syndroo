import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createSqliteStorage } from "../../src/state/index.js";
import { fixture, KEY } from "../state/support.js";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
async function setup() { const f = await fixture(); fixtures.push(f); return f; }
const owner = { kind: "credential" as const, ownerId: "conn_one", version: 1 };
const value = { token: "NEVER_PRINT_SECRET_CANARY", nested: { password: "PRIVATE_PASSWORD_CANARY" } };

async function safeFailure(work: Promise<unknown>, code: string) {
  let error: unknown;
  try { await work; } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code, message: code });
  for (const canary of [value.token, value.nested.password, KEY]) {
    expect(String(error)).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(canary);
  }
  expect(error).not.toHaveProperty("cause");
  expect(error).not.toHaveProperty("details");
}

it("round-trips encrypted staging, is idempotent, and never stores plaintext or serializable key material", async () => {
  const f = await setup();
  const stage = await f.credentials.put({ creationId: "secret_one", owner, value });
  expect(await f.credentials.get({ ref: stage.ref, owner })).toEqual(value);
  expect(await f.credentials.put({ creationId: "secret_one", owner, value })).toEqual(stage);
  expect(JSON.stringify(f.credentials)).not.toContain(KEY);
  await safeFailure(f.credentials.put({ creationId: "secret_one", owner, value: { token: "different" } }), "SECRET_STAGE_CONFLICT");
  for (const file of await fs.readdir(f.root)) {
    const bytes = await fs.readFile(`${f.root}/${file}`);
    expect(bytes.includes(Buffer.from(value.token))).toBe(false);
    expect(bytes.includes(Buffer.from(value.nested.password))).toBe(false);
    expect(bytes.includes(Buffer.from(KEY, "hex"))).toBe(false);
  }
});

it("rejects a flipped ciphertext byte with a safe authentication error", async () => {
  const f = await setup();
  const stage = await f.credentials.put({ creationId: "tamper", owner, value });
  const db = new DatabaseSync(f.options.secretsPath);
  try {
    const row = db.prepare("SELECT ciphertext FROM secret_blobs WHERE ref = ?").get(stage.ref)!;
    const ciphertext = Buffer.from(row.ciphertext as Uint8Array);
    ciphertext[0] = ciphertext[0]! ^ 1;
    db.prepare("UPDATE secret_blobs SET ciphertext = ? WHERE ref = ?").run(ciphertext, stage.ref);
  } finally { db.close(); }
  await safeFailure(f.credentials.get({ ref: stage.ref, owner }), "SECRET_AUTHENTICATION_FAILED");
});

it("rejects wrong owner/version AAD without releasing plaintext", async () => {
  const f = await setup();
  const stage = await f.credentials.put({ creationId: "owner", owner, value });
  await safeFailure(f.credentials.get({ ref: stage.ref, owner: { ...owner, version: 2 } }), "SECRET_AUTHENTICATION_FAILED");
  await safeFailure(f.credentials.get({ ref: stage.ref, owner: { ...owner, ownerId: "conn_other" } }), "SECRET_AUTHENTICATION_FAILED");
  await safeFailure(f.credentials.get({ ref: stage.ref, owner: { ...owner, kind: "approval" } }), "SECRET_AUTHENTICATION_FAILED");
});

it("rejects a wrong deployment key at startup", async () => {
  const f = await setup();
  f.close();
  await safeFailure(Promise.resolve().then(() => createSqliteStorage({ ...f.options, key: "08".repeat(32) })), "SECRET_AUTHENTICATION_FAILED");
});

it.each([undefined, "", "short", "zz".repeat(32), new Uint8Array(31)])("rejects missing/short/malformed keys at startup", async key => {
  const f = await setup();
  f.close();
  await safeFailure(Promise.resolve().then(() => createSqliteStorage({ ...f.options, key: key as string })), "SECRET_KEY_INVALID");
});

it("requires an exact durable retirement proof and never resurrects retired staging", async () => {
  const f = await setup();
  const stage = await f.credentials.put({ creationId: "retire", owner, value });
  await safeFailure(f.credentials.delete({ stage, unreferencedProof: "invented" }), "SECRET_PROOF_INVALID");
  const retirement = await f.state.retireUnreferenced(stage);
  expect(retirement).not.toBeNull();
  await safeFailure(f.credentials.delete({ stage: { ...stage, owner: { ...owner, version: 2 } }, unreferencedProof: retirement!.proof }), "SECRET_PROOF_INVALID");
  await f.credentials.delete({ stage, unreferencedProof: retirement!.proof });
  await f.credentials.delete({ stage, unreferencedProof: retirement!.proof });
  await safeFailure(f.credentials.put({ creationId: "retire", owner, value }), "SECRET_RETIRED");
  await safeFailure(f.credentials.get({ ref: stage.ref, owner }), "SECRET_RETIRED");
});

it("cannot retire a committed credential, and secret and business databases must differ", async () => {
  const f = await setup();
  const view = await f.connect();
  const connection = await f.state.getConnection(view.connectionId);
  expect(connection).not.toBeNull();
  const db = new DatabaseSync(f.options.secretsPath);
  let creationId: string;
  try { creationId = db.prepare("SELECT creation_id FROM secret_blobs WHERE ref = ?").get(connection!.secretRef)!.creation_id as string; }
  finally { db.close(); }
  expect(await f.state.retireUnreferenced({ ref: connection!.secretRef, creationId,
    owner: { kind: "credential", ownerId: connection!.connectionId, version: connection!.credentialRevision } })).toBeNull();
  await safeFailure(Promise.resolve().then(() => createSqliteStorage({ ...f.options, secretsPath: f.options.statePath })), "STORAGE_CONFIG_INVALID");
});

it('rejects a missing key before creating either database', async () => {
  const f = await setup();
  const statePath = `${f.root}/new-state.db`;
  const secretsPath = `${f.root}/new-secrets.db`;
  await safeFailure(Promise.resolve().then(() => createSqliteStorage({
    statePath, secretsPath, scope: 'new', key: undefined as unknown as string,
  })), 'SECRET_KEY_INVALID');
  await expect(fs.stat(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(secretsPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('uses distinct persisted nonces and rejects altered owner metadata', async () => {
  const f = await setup();
  const first = await f.credentials.put({ creationId: 'first', owner, value });
  const second = await f.credentials.put({ creationId: 'second', owner, value });
  const db = new DatabaseSync(f.options.secretsPath);
  try {
    const rows = db.prepare('SELECT nonce FROM secret_blobs ORDER BY ref').all();
    expect(rows).toHaveLength(2);
    expect(Buffer.from(rows[0]!.nonce as Uint8Array)).toHaveLength(12);
    expect(Buffer.from(rows[0]!.nonce as Uint8Array)).not.toEqual(Buffer.from(rows[1]!.nonce as Uint8Array));
    db.prepare('UPDATE secret_blobs SET owner_version=2 WHERE ref=?').run(first.ref);
  } finally { db.close(); }
  await safeFailure(f.credentials.get({ ref: first.ref, owner }), 'SECRET_AUTHENTICATION_FAILED');
  expect(await f.credentials.get({ ref: second.ref, owner })).toEqual(value);
});

it('persists retirement across restart and never exposes the retired value', async () => {
  const f = await setup();
  const stage = await f.credentials.put({ creationId: 'retired-restart', owner, value });
  const retirement = await f.state.retireUnreferenced(stage);
  expect(retirement).not.toBeNull();
  f.close();
  const reopened = createSqliteStorage(f.options);
  try {
    await safeFailure(reopened.credentials.get({ ref: stage.ref, owner }), 'SECRET_RETIRED');
    await reopened.credentials.delete({ stage, unreferencedProof: retirement!.proof });
    await safeFailure(reopened.credentials.put({ creationId: stage.creationId, owner, value }), 'SECRET_RETIRED');
    const db = new DatabaseSync(f.options.secretsPath);
    try {
      const row = db.prepare('SELECT retired,length(ciphertext) AS bytes FROM secret_blobs WHERE ref=?').get(stage.ref)!;
      expect(row.retired).toBe(1);
      expect(row.bytes).toBe(0);
    } finally { db.close(); }
  } finally { reopened.close(); }
});
