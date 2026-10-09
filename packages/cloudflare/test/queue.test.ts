import { describe, expect, it } from 'vitest';
import type * as T from '@syndroo/core';
import { consumeMessages, scanPending } from '../src/queue.js';
import { createD1Storage } from '../src/secrets.js';
import { FakeD1 } from './fake-d1.js';

const now = '2026-10-08T00:00:00.000Z';
async function fixture() {
  const db = new FakeD1();
  const { state } = await createD1Storage({ db, scope: 'fixture', key: '11'.repeat(32) });
  const operation: T.OperationRecord = {
    operationId: 'op_one', principalId: 'owner', version: 3, createdAt: now,
    canonicalOriginal: { type: 'prepare', content: { text: 'hello' }, targets: [{ provider: 'fake' }] },
    executionRevision: 0, phase: 'execution', status: 'pending',
    deliveries: [{ deliveryId: 'delivery_one', connectionId: 'conn_one',
      account: { provider: 'fake', accountId: 'alice', origin: 'https://social.example' },
      attempts: 0, outcome: null, state: 'ready', history: [] }],
    work: { pending: true, nextWakeAt: now },
  };
  const intent = { operationId: 'op_one', executionRevision: 0, principalId: 'owner' };
  const save = () => db.sqlite.prepare('UPDATE records SET value=?, revision=revision+1 WHERE scope=? AND kind=? AND id=?')
    .run(JSON.stringify(operation), 'fixture', 'operation', 'op_one');
  db.sqlite.prepare('INSERT INTO records(scope,kind,id,revision,value) VALUES(?,?,?,?,?)')
    .run('fixture', 'operation', 'op_one', 1, JSON.stringify(operation));
  db.sqlite.prepare('INSERT INTO records(scope,kind,id,revision,value) VALUES(?,?,?,?,?)')
    .run('fixture', 'intent', 'op_one:0', 1, JSON.stringify(intent));
  return { db, state, operation, save };
}

function message(body: unknown) {
  const calls = { ack: 0, retry: 0 };
  return { body, calls, ack: () => { calls.ack++; }, retry: () => { calls.retry++; } };
}

describe('Queue wakeups and pending scan', () => {
  it('out-of-order, wrong-scope and dead-letter references cannot execute', async () => {
    const { state } = await fixture();
    let runs = 0;
    const executor: T.Executor = { async run() { runs++; throw Error('must not run'); } };
    const messages = [message({ scope: 'other', operationId: 'op_one', executionRevision: 0 }),
      message({ scope: 'fixture', operationId: 'op_one', executionRevision: 1 }),
      message({ scope: 'fixture', operationId: 'op_one', executionRevision: 0, token: 'forbidden' })];
    await consumeMessages({ messages, scope: 'fixture', state, executor, now: () => now,
      signal: new AbortController().signal });
    expect(messages.map(m => m.calls)).toEqual(messages.map(() => ({ ack: 1, retry: 0 })));
    await consumeMessages({ messages: [message({ scope: 'fixture', operationId: 'op_one', executionRevision: 0 })],
      scope: 'fixture', state, executor, now: () => now, signal: new AbortController().signal,
      deadLetter: true });
    expect(runs).toBe(0);
  });

  it('enqueue failure leaves admitted work pending for a later bounded scan', async () => {
    const { state, operation } = await fixture();
    let sends = 0;
    const failed = await scanPending({ scope: 'fixture', state, ownerId: 'cron_a', now, limit: 1,
      sender: { async send() { sends++; throw Error('queue down'); } } });
    expect(failed).toBe(1);
    expect((await state.getOperation('op_one', 'owner'))?.work.pending).toBe(true);
    expect((await state.getOperation('op_one', 'owner'))?.deliveries[0]?.attempts).toBe(0);
    const after = '2026-10-08T00:01:00.000Z';
    expect(await scanPending({ scope: 'fixture', state, ownerId: 'cron_b', now: after, limit: 1,
      sender: { async send(body) { sends++; expect(body).toEqual({
        scope: 'fixture', operationId: operation.operationId, executionRevision: 0 }); } } })).toBe(1);
    expect(sends).toBe(2);
  });

  it('redelivery after an unknown outcome never starts another content write', async () => {
    const { state, operation, save } = await fixture();
    let sends = 0;
    const executor: T.Executor = { async run() {
      sends++;
      operation.deliveries = [{ ...operation.deliveries[0]!, state: 'settled', attempts: 1,
        outcome: { status: 'unknown', disposition: 'unknown', reason: 'network' } }];
      operation.status = 'unknown';
      operation.work.pending = false;
      save();
      return { phase: 'execution', operationId: 'op_one', status: 'unknown', deliveries: [] };
    } };
    const body = { scope: 'fixture', operationId: 'op_one', executionRevision: 0 };
    const messages = [message(body), message(body)];
    await consumeMessages({ messages, scope: 'fixture', state, executor, now: () => now,
      signal: new AbortController().signal });
    expect(sends).toBe(1);
    expect(messages.map(m => m.calls)).toEqual([{ ack: 1, retry: 0 }, { ack: 1, retry: 0 }]);
  });

  it('recovers an expired claim as unknown without loading a provider or starting target two', async () => {
    const { state, operation, save } = await fixture();
    const claim: T.Claim = { operationId: 'op_one', executionRevision: 0,
      deliveryId: 'delivery_one', claimId: 'claim_one', ownerId: 'old',
      submissionId: 'submit_one', attempt: 1, claimedAt: now,
      expiresAt: '2026-10-08T00:15:00.000Z' };
    operation.deliveries = [{ ...operation.deliveries[0]!, attempts: 1, state: 'in_flight', claim },
      { ...operation.deliveries[0]!, deliveryId: 'delivery_two', state: 'ready' }];
    operation.status = 'running';
    save();
    let runs = 0;
    const msg = message({ scope: 'fixture', operationId: 'op_one', executionRevision: 0 });
    await consumeMessages({ messages: [msg], scope: 'fixture', state,
      executor: { async run() { runs++; throw Error('must not call'); } },
      now: () => '2026-10-08T00:16:00.000Z', signal: new AbortController().signal });
    expect(runs).toBe(0);
    expect(msg.calls).toEqual({ ack: 1, retry: 0 });
    const recovered = await state.getOperation('op_one', 'owner');
    expect(recovered?.status).toBe('unknown');
    expect(recovered?.deliveries.map(d => d.outcome?.status))
      .toEqual(['unknown', 'not_started']);
    expect(recovered?.work.pending).toBe(false);
  });

  it('runtime failure retries only the queue reference and does not start target two', async () => {
    const { state } = await fixture();
    let runs = 0;
    const msg = message({ scope: 'fixture', operationId: 'op_one', executionRevision: 0 });
    await consumeMessages({ messages: [msg], scope: 'fixture', state,
      executor: { async run() { runs++; throw Error('storage offline'); } },
      now: () => now, signal: new AbortController().signal });
    expect({ runs, ...msg.calls }).toEqual({ runs: 1, ack: 0, retry: 1 });
  });
});
