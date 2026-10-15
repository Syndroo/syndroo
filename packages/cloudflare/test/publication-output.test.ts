import { expect, it } from 'vitest';
import { createCore } from '@syndroo/core';
import type * as T from '@syndroo/core';
import { harness } from '../../../tests/fixtures/state/harness.js';
import { createD1Storage } from '../src/secrets.js';
import { D1State } from '../src/state/state.js';
import { FakeD1 } from './fake-d1.js';

/**
 * PUB-D1: the publication output reaches the Worker's durable store.
 *
 * The design keeps the frozen preview and the account presentation display
 * metadata (design section 3/5). This fixture proves they survive a real D1
 * round trip - it re-reads the operation through a *fresh* `D1State` over the
 * same database, so nothing here can be satisfied by an in-memory cache - and
 * that an admitted round stays an admission: the enqueue failure of the offline
 * harness leaves the execution pending, never "published".
 */

const NOW = '2026-10-08T00:00:00.000Z';
const KEY = '11'.repeat(32);
const SCOPE = 'fixture';
const PRESENTATION = {
  accountName: '@alice',
  profileUrl: 'https://social.example/@alice',
} as const;

type H = ReturnType<typeof harness>;

/** Commit one connection with an account presentation, the way connect does. */
async function connectWithPresentation(state: T.StateStore, credentials: T.CredentialStore, h: H): Promise<string> {
  const connectionId = 'conn_alice';
  const session: T.ConnectSession = {
    sessionId: 'cs_alice', principalId: 'owner', provider: 'fake', implementation: h.implementation,
    stepRevision: 0, expiresAt: '2026-10-08T00:15:00.000Z', connectionId,
    baselineRevision: null, status: 'awaiting',
  };
  await state.reserveConnect({
    request: { principalId: 'owner', family: 'connect', key: 'cs_alice', digest: 'cs_alice' },
    session, now: NOW,
  });
  const step = await state.claimConnectStep({
    sessionId: 'cs_alice', principalId: 'owner', stepRevision: 0,
    inputDigest: 'cs_alice', claimId: 'claim_alice', now: NOW,
  });
  if (step.type !== 'claimed') throw Error('connect step missing');
  const secret = await credentials.put({
    creationId: 'credential_alice',
    owner: { kind: 'credential', ownerId: connectionId, version: 1 },
    value: { token: 'alice' },
  });
  const saved = await state.commitConnection({
    claim: step.claim, expectedConnectionRevision: null, stagedCredential: secret, now: NOW,
    connection: {
      connectionId, account: { provider: 'fake', accountId: 'alice', origin: 'https://social.example' },
      active: true, isDefault: true, revision: 1, bindingRevision: 1, credentialRevision: 1,
      secretRef: secret.ref, observations: [], presentation: { ...PRESENTATION },
    },
  });
  expect(saved.type).toBe('applied');
  return connectionId;
}

it('keeps the frozen preview and presentation across a real D1 round trip', async () => {
  const h = harness({ async: true });
  const db = new FakeD1();
  const { state, credentials } = await createD1Storage({ db, scope: SCOPE, key: KEY });
  const connectionId = await connectWithPresentation(state, credentials, h);

  // The identity just verified at prepare time wins over the stored snapshot.
  h.plugin.connect.verify = async () => ({
    account: { provider: 'fake', accountId: 'alice', origin: 'https://social.example' },
    evidence: [],
    presentation: { ...PRESENTATION },
  });
  const { core } = createCore({ ...h.deps, state, credentials });
  const prepared = await core.publish({
    type: 'prepare',
    content: { text: 'hello' },
    targets: [{ provider: 'fake', connection: connectionId }],
  }, h.ctx('d1-prepare')) as T.PreparedResult;
  expect(prepared.status).toBe('confirmation_required');
  expect(prepared.preview[0]?.preview).toEqual({ content: { text: 'hello' }, fields: [] });
  expect(prepared.preview[0]?.presentation).toEqual(PRESENTATION);

  // A second Core over freshly constructed D1-backed adapters: everything read
  // below comes out of the database, not out of the preparing process.
  const fresh = new D1State({ db, scope: SCOPE });
  const freshCore = createCore({ ...h.deps, state: fresh, credentials }).core;

  const preparedView = await freshCore.status(
    { type: 'operation', operationId: prepared.operationId }, h.ctx('d1-status-prepared'));
  if (preparedView.type !== 'operation' || preparedView.operation.phase !== 'prepared') {
    throw Error('expected a prepared operation view');
  }
  expect(preparedView.operation.preview[0]?.preview).toEqual({ content: { text: 'hello' }, fields: [] });
  expect(preparedView.operation.preview[0]?.presentation).toEqual(PRESENTATION);

  // The persisted record carries the round marker, and the frozen intent it
  // points at still carries the snapshot; both were read back from D1.
  const record = await fresh.getOperation(prepared.operationId, 'owner');
  expect(record?.phase).toBe('prepared');
  expect(record?.deliveries[0]?.previewRevision).toBe(0);
  const intent = await fresh.getIntent({ operationId: prepared.operationId, executionRevision: 0 }, 'owner');
  expect(intent?.targets[0]?.frozen.preview).toEqual({ content: { text: 'hello' }, fields: [] });
  expect(intent?.targets[0]?.presentation).toEqual(PRESENTATION);
  expect((await fresh.getConnection(connectionId))?.presentation).toEqual(PRESENTATION);

  // Admission only. The offline harness cannot enqueue, so the execution stays
  // pending and no delivery reports a provider outcome.
  const execution = await freshCore.publish({
    type: 'execute', approvalToken: prepared.approvalToken,
  }, h.ctx('d1-execute')) as T.ExecutionResult;
  expect(execution.phase).toBe('execution');
  expect(execution.status).toBe('pending');
  expect(execution.deliveries.every(delivery => !delivery.outcome)).toBe(true);
  expect(JSON.stringify(execution)).not.toContain('succeeded');

  // A further read-only Core still sees a pending round with the same frozen
  // snapshot, so the display metadata is durable, not process state.
  const admittedView = await createCore({ ...h.deps, state: new D1State({ db, scope: SCOPE }), credentials })
    .core.status({ type: 'operation', operationId: prepared.operationId }, h.ctx('d1-status-admitted'));
  if (admittedView.type !== 'operation' || admittedView.operation.phase !== 'execution') {
    throw Error('expected an execution view');
  }
  expect(admittedView.operation.status).toBe('pending');
  expect(admittedView.operation.deliveries[0]?.preview)
    .toEqual({ content: { text: 'hello' }, fields: [] });
  expect(admittedView.operation.deliveries[0]?.presentation).toEqual(PRESENTATION);
  expect(admittedView.operation.deliveries[0]?.outcome).toBeNull();
  expect(db.batches).toBeGreaterThan(0);
});
