import { describe, expect, it } from 'vitest';

import { harness } from '../../../tests/fixtures/state/harness.js';
import type { Json, PreparedResult } from '../src/domain/records.js';

/**
 * The frozen display snapshot (account presentation) is part of one operation's
 * frozen intent, not part of the stable identity. It must survive later renames,
 * never merge or split targets, and be covered by the intent digest.
 */

const request = {
  type: 'prepare' as const,
  content: { text: 'Hello' },
  targets: [{ provider: 'fake' }],
};

describe('frozen account presentation', () => {
  it('carries presentation while stable identity and binding stay unchanged', async () => {
    const h = harness();
    const connection = await h.seed();
    connection.presentation = {
      accountName: '@alice',
      profileUrl: 'https://social.example/@alice',
    };

    const prepared = (await h.runtime().core.publish(request, h.ctx('p'))) as PreparedResult;

    expect(prepared.preview).toHaveLength(1);
    expect(prepared.preview[0]!.account).toEqual({
      provider: 'fake',
      accountId: 'alice',
      origin: 'https://social.example',
    });
    expect(prepared.preview[0]!.presentation).toEqual({
      accountName: '@alice',
      profileUrl: 'https://social.example/@alice',
    });

    const intent = h.state.intents.get(`${prepared.operationId}:0`)!;
    expect(intent.targets[0]!.binding.account).toEqual({
      provider: 'fake',
      accountId: 'alice',
      origin: 'https://social.example',
    });
    expect(intent.targets[0]!.binding.bindingRevision).toBe(connection.bindingRevision);
    expect(intent.targets[0]!.presentation).toEqual({
      accountName: '@alice',
      profileUrl: 'https://social.example/@alice',
    });
  });

  it('never treats a presentation difference as a distinct target', async () => {
    const h = harness();
    const first = await h.seed('conn_a', 'alice');
    first.presentation = { accountName: '@alice' };
    const second = await h.seed('conn_b', 'alice');
    second.presentation = { accountName: '@someone-else' };

    await expect(
      h.runtime().core.publish(
        {
          type: 'prepare',
          content: { text: 'Hello' },
          targets: [
            { provider: 'fake', connection: 'conn_a' },
            { provider: 'fake', connection: 'conn_b' },
          ],
        },
        h.ctx('p'),
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_TARGET' });
  });

  it('keeps the frozen snapshot when the live connection is renamed later', async () => {
    const h = harness();
    const connection = await h.seed();
    connection.presentation = { accountName: '@alice' };
    connection.label = 'Personal';

    const prepared = (await h.runtime().core.publish(request, h.ctx('p'))) as PreparedResult;
    expect(prepared.preview[0]!.presentation).toEqual({
      accountName: '@alice',
      label: 'Personal',
    });

    // Rename and relabel the live connection after prepare.
    connection.presentation = { accountName: '@renamed' };
    connection.label = 'Work';

    const status = await h.runtime().core.status(
      { type: 'operation', operationId: prepared.operationId },
      h.ctx(),
    );

    expect(status.type).toBe('operation');

    if (status.type !== 'operation') {
      throw new Error(`expected an operation, got ${status.type}`);
    }

    const operation = status.operation;

    expect(operation.phase).toBe('prepared');

    if (operation.phase !== 'prepared') {
      throw new Error(`expected a prepared operation, got ${operation.phase}`);
    }

    expect(operation.preview[0]!.presentation).toEqual({
      accountName: '@alice',
      label: 'Personal',
    });
  });

  it('covers the frozen presentation with the intent digest', async () => {
    const h = harness();
    const connection = await h.seed();
    connection.presentation = { accountName: '@alice' };

    const prepared = (await h.runtime().core.publish(request, h.ctx('p'))) as PreparedResult;
    const intent = h.state.intents.get(`${prepared.operationId}:0`)!;

    const { intentDigest, ...unsigned } = intent;
    expect(unsigned.targets[0]!.presentation).toEqual({ accountName: '@alice' });
    expect(await h.deps.digests.canonical(unsigned as unknown as Json)).toBe(intentDigest);

    const tampered = structuredClone(unsigned);
    tampered.targets[0]!.presentation = { accountName: '@other' };
    expect(await h.deps.digests.canonical(tampered as unknown as Json)).not.toBe(intentDigest);
  });
});
