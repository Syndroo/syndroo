import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { createSqliteStorage } from '../../src/state/index.js';
import { fixture } from './support.js';

it.each([
  { name: 'before', commitFirst: false },
  { name: 'after', commitFirst: true },
])('reports an uncertain $name-COMMIT result as DURABILITY_ERROR', async ({ commitFirst }) => {
  const f = await fixture();
  try {
    await f.connect();
    const prepared = await f.prepared('durability');
    const admitted = await f.state.admitExecution(prepared.admission);
    expect(admitted.type).toBe('applied');
    const operation = await f.state.getOperation(prepared.result.operationId, 'owner');
    expect(operation).not.toBeNull();
    const work = { operationId: prepared.result.operationId, executionRevision: 0 };
    const claim = await f.state.claimDelivery({
      work, deliveryId: prepared.intent.targets[0]!.deliveryId,
      expectedVersion: operation!.version, claimId: 'claim_durable',
      ownerId: 'owner', submissionId: 'submit_durable',
      now: '2026-10-08T00:00:00.000Z',
    });
    expect(claim).not.toBeNull();

    const original = DatabaseSync.prototype.exec;
    let injected = false;
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (!injected && sql === 'COMMIT') {
        injected = true;
        if (commitFirst) original.call(this, sql);
        throw Error('simulated disk acknowledgement failure');
      }
      return original.call(this, sql);
    });
    try {
      await expect(f.state.recordOutcome({
        claim: claim!, outcome: { status: 'succeeded', remoteId: 'remote-durable' },
        now: '2026-10-08T00:00:01.000Z',
      })).rejects.toMatchObject({ code: 'DURABILITY_ERROR', message: 'DURABILITY_ERROR' });
      expect(injected).toBe(true);
    } finally { spy.mockRestore(); }

    // The adapter does not return a success from a commit whose acknowledgement
    // was lost. A fresh handle observes whichever side of COMMIT actually won.
    const reopened = createSqliteStorage(f.options);
    try {
      const persisted = await reopened.state.getOperation(prepared.result.operationId, 'owner');
      expect(persisted?.deliveries[0]?.state).toBe(commitFirst ? 'settled' : 'in_flight');
      expect(persisted?.deliveries[0]?.attempts).toBe(1);
      expect(await reopened.state.claimDelivery({
        work, deliveryId: prepared.intent.targets[0]!.deliveryId,
        expectedVersion: persisted!.version, claimId: 'claim_duplicate',
        ownerId: 'later', submissionId: 'submit_duplicate',
        now: '2026-10-08T00:00:02.000Z',
      })).toBeNull();
    } finally { reopened.close(); }
  } finally { await f.cleanup(); }
});
