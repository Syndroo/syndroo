import { expect, it } from 'vitest';
import { createCore } from '@syndroo/core';
import type * as T from '@syndroo/core';
import { harness } from '../../../tests/fixtures/state/harness.js';
import { createD1Storage } from '../src/secrets.js';
import { FakeD1 } from './fake-d1.js';

const now = '2026-10-08T00:00:00.000Z';

it('serializes two concurrent Core executors across D1 target claims', async () => {
  const h = harness({ async: true });
  const db = new FakeD1();
  const { state, credentials } = await createD1Storage({ db, scope: 'fixture', key: '11'.repeat(32) });
  const runtime = () => createCore({ ...h.deps, state, credentials });

  async function connected(accountId: string) {
    const sessionId = `cs_${accountId}`;
    const connectionId = `conn_${accountId}`;
    const session: T.ConnectSession = {
      sessionId, principalId: 'owner', provider: 'fake', implementation: h.implementation,
      stepRevision: 0, expiresAt: '2026-10-08T00:15:00.000Z', connectionId,
      baselineRevision: null, status: 'awaiting',
    };
    await state.reserveConnect({ request: { principalId: 'owner', family: 'connect',
      key: sessionId, digest: sessionId }, session, now });
    const step = await state.claimConnectStep({ sessionId, principalId: 'owner',
      stepRevision: 0, inputDigest: sessionId, claimId: `claim_${accountId}`, now });
    if (step.type !== 'claimed') throw Error('step missing');
    const secret = await credentials.put({ creationId: `credential_${accountId}`,
      owner: { kind: 'credential', ownerId: connectionId, version: 1 }, value: { token: accountId } });
    const account = { provider: 'fake', accountId, origin: 'https://social.example' };
    const saved = await state.commitConnection({ claim: step.claim, expectedConnectionRevision: null,
      stagedCredential: secret, now, connection: {
        connectionId, account, active: true, isDefault: accountId === 'alice', revision: 1,
        bindingRevision: 1, credentialRevision: 1, secretRef: secret.ref, observations: [],
      } });
    expect(saved.type).toBe('applied');
    return connectionId;
  }

  const alice = await connected('alice');
  const bob = await connected('bob');
  h.plugin.connect.verify = async value => ({ account: {
    provider: 'fake', accountId: value.token as string, origin: 'https://social.example',
  }, evidence: [] });
  const prepared = await runtime().core.publish({ type: 'prepare', content: { text: 'hello' },
    targets: [{ provider: 'fake', connection: alice }, { provider: 'fake', connection: bob }] },
  h.ctx('multi')) as T.PreparedResult;
  expect(prepared.status).toBe('confirmation_required');
  await runtime().core.publish({ type: 'execute', approvalToken: prepared.approvalToken }, h.ctx());

  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const firstWrite = new Promise<void>(resolve => { started = resolve; });
  h.setPublish(async () => {
    started();
    await blocked;
    return { status: 'succeeded' };
  });
  const work = { operationId: prepared.operationId, executionRevision: 0 };
  const first = runtime().executor.run(work, h.ctx().signal);
  await firstWrite;
  await runtime().executor.run(work, h.ctx().signal);
  expect(h.writes).toHaveLength(1);
  release();
  await first;
  expect(h.writes).toHaveLength(2);
});
