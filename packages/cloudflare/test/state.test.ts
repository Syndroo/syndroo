import { describe, expect, it } from 'vitest';
import { stateStoreContract } from '../../../tests/contracts/state-store.js';
import { createD1Storage } from '../src/secrets.js';
import { FakeD1 } from './fake-d1.js';

const KEY = '11'.repeat(32);
async function fixture() {
  const db = new FakeD1();
  const storage = await createD1Storage({ db, scope: 'fixture', key: KEY });
  return { db, ...storage };
}

stateStoreContract('D1 offline SQLite', fixture);

describe('D1 conditional batches', () => {
  it('rolls back dependent business rows when a later statement fails', async () => {
    const { db, state } = await fixture();
    const before = db.sqlite.prepare('SELECT epoch FROM scope_meta WHERE scope=?').get('fixture');
    db.failAt = 2;
    await expect(state.reservePreparation({
      request: { principalId: 'owner', family: 'publish', key: 'one', digest: 'same' },
      canonical: { type: 'prepare', content: { text: 'hello' }, targets: [{ provider: 'fake' }] },
      operationId: 'op_one', ownerId: 'owner', now: '2026-10-08T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'DURABILITY_ERROR' });
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM records').get()).toMatchObject({ n: 0 });
    expect(db.sqlite.prepare('SELECT epoch FROM scope_meta WHERE scope=?').get('fixture')).toEqual(before);
  });

  it('does not retry an uncertain committed batch', async () => {
    const { db, state } = await fixture();
    db.failAfterCommit = true;
    const before = db.batches;
    await expect(state.reservePreparation({
      request: { principalId: 'owner', family: 'publish', key: 'one', digest: 'same' },
      canonical: { type: 'prepare', content: { text: 'hello' }, targets: [{ provider: 'fake' }] },
      operationId: 'op_one', ownerId: 'owner', now: '2026-10-08T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'DURABILITY_ERROR' });
    expect(db.batches).toBe(before + 1);
    expect(await state.getOperation('op_one', 'owner')).not.toBeNull();
  });
});
