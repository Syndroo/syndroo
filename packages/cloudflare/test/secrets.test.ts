import { describe, expect, it } from 'vitest';
import { createD1Storage, D1Credentials } from '../src/secrets.js';
import { FakeD1 } from './fake-d1.js';

const KEY = '11'.repeat(32);
const otherKey = '22'.repeat(32);
const owner = { kind: 'credential' as const, ownerId: 'conn_one', version: 1 };

describe('D1 AEAD secrets', () => {
  it('rejects missing and wrong keys before reading protected data', async () => {
    const db = new FakeD1();
    await expect(D1Credentials.open(db, 'fixture', '')).rejects.toMatchObject({ code: 'SECRET_KEY_INVALID' });
    await D1Credentials.open(db, 'fixture', KEY);
    await expect(D1Credentials.open(db, 'fixture', otherKey)).rejects.toMatchObject({
      code: 'SECRET_AUTHENTICATION_FAILED',
    });
  });

  it('binds ciphertext to scope, owner, and nonce, and never exposes the secret in errors', async () => {
    const db = new FakeD1();
    const { credentials } = await createD1Storage({ db, scope: 'fixture', key: KEY });
    const stage = await credentials.put({ creationId: 'one', owner, value: { token: 'canary' } });
    expect(await credentials.get({ ref: stage.ref, owner })).toEqual({ token: 'canary' });
    await expect(credentials.get({ ref: stage.ref, owner: { ...owner, version: 2 } }))
      .rejects.toMatchObject({ code: 'SECRET_AUTHENTICATION_FAILED' });
    const second = await createD1Storage({ db, scope: 'other', key: KEY });
    await expect(second.credentials.get({ ref: stage.ref, owner })).rejects.toMatchObject({
      code: 'SECRET_NOT_FOUND',
    });
    db.sqlite.prepare('UPDATE secret_blobs SET nonce=? WHERE scope=? AND ref=?')
      .run('00'.repeat(12), 'fixture', stage.ref);
    await expect(credentials.get({ ref: stage.ref, owner })).rejects.toMatchObject({
      code: 'SECRET_AUTHENTICATION_FAILED',
    });
    const other = await credentials.put({ creationId: 'two', owner, value: { token: 'other' } });
    db.sqlite.prepare('UPDATE secret_blobs SET ciphertext=? WHERE scope=? AND ref=?')
      .run('AA', 'fixture', other.ref);
    await expect(credentials.get({ ref: other.ref, owner })).rejects.toMatchObject({
      code: 'SECRET_AUTHENTICATION_FAILED',
    });
    try { await credentials.get({ ref: other.ref, owner }); }
    catch (error) { expect(JSON.stringify(error)).not.toContain('canary'); }
  });

  it('retirement proof is exact and permanently fences reads and restaging', async () => {
    const db = new FakeD1();
    const { credentials, state } = await createD1Storage({ db, scope: 'fixture', key: KEY });
    const stage = await credentials.put({ creationId: 'one', owner, value: { token: 'canary' } });
    await expect(credentials.delete({ stage, unreferencedProof: 'wrong' })).rejects.toMatchObject({
      code: 'SECRET_PROOF_INVALID',
    });
    const retired = await state.retireUnreferenced(stage);
    expect(retired).not.toBeNull();
    await expect(credentials.get({ ref: stage.ref, owner })).rejects.toMatchObject({ code: 'SECRET_RETIRED' });
    await credentials.delete({ stage, unreferencedProof: retired!.proof });
    await expect(credentials.put({ creationId: 'one', owner, value: { token: 'new' } }))
      .rejects.toMatchObject({ code: 'SECRET_RETIRED' });
  });
});
