import { describe, expect, it } from 'vitest';
import { harness } from '../../../tests/fixtures/state/harness.js';
import type { PreparedResult, PrepareRequest } from '../src/domain/records.js';

/**
 * STR-05 of the architecture-v1 acceptance map: a local CLI store and a remote
 * Server store never sync automatically, and an operation created in one
 * deployment is never treated as locally retryable in the other.
 *
 * This lives in `packages/core/test` rather than `packages/server/test/state`
 * because the guarantee is owned by Core's operation semantics: the store only
 * persists what Core asks, and every read is scoped by `principalId` and by the
 * store instance. The fixture gives two independent stores - state, credentials,
 * approvals, intents - which is exactly the local/server split under test.
 */

const request: PrepareRequest = {
    type: 'prepare', content: {
        text: 'Hello'
    }, targets: [{
            provider: 'fake'
        }]
};

describe('STR-05 deployment isolation', () => {
    it('never treats another deployment operation as local work', async () => {
        // Two deployments that happen to declare the same scope name: isolation
        // must come from the store, never from a name they could share.
        const local = harness({
            scope: 'local'
        });
        const remote = harness({
            scope: 'local'
        });
        await local.seed();
        await remote.seed();
        const prepared = await local.runtime().core.publish(request, local.ctx('prepare')) as PreparedResult;

        // 1. The remote deployment does not know the operation id.
        await expect(remote.runtime().core.status({
            type: 'operation', operationId: prepared.operationId
        }, remote.ctx())).rejects.toMatchObject({
            code: 'NOT_FOUND'
        });

        // 2. It cannot retry it either. `NOT_FOUND` is the decisive code: a
        // `RETRY_INELIGIBLE` would mean the remote store had started tracking a
        // foreign operation as its own.
        await expect(remote.runtime().core.publish({
            type: 'retry',
            retryOf: prepared.operationId,
            targets: [{
                    provider: 'fake', connection: 'conn_alice'
                }]
        }, remote.ctx('retry'))).rejects.toMatchObject({
            code: 'NOT_FOUND'
        });

        // 3. The approval token is not admitted across deployments.
        await expect(remote.runtime().core.publish({
            type: 'execute', approvalToken: prepared.approvalToken
        }, remote.ctx())).rejects.toMatchObject({
            code: 'APPROVAL_INVALID'
        });

        // 4. Nothing was created, admitted or submitted anywhere.
        expect(remote.state.operations.size).toBe(0);
        expect(remote.state.intents.size).toBe(0);
        expect(remote.state.approvals.size).toBe(0);
        expect(remote.writes).toHaveLength(0);
        expect(local.writes).toHaveLength(0);
        expect([...local.state.approvals.values()].filter((entry) => entry.admitted)).toHaveLength(0);

        // 5. The owning deployment is unaffected and still works.
        const executed = await local.runtime().core.publish({
            type: 'execute', approvalToken: prepared.approvalToken
        }, local.ctx());
        expect(executed.status).toBe('succeeded');
        expect(local.writes).toHaveLength(1);
    });

    it('keeps a repeated cross-deployment retry at not-found instead of granting it locally', async () => {
        const local = harness({
            scope: 'local'
        });
        const remote = harness({
            scope: 'local'
        });
        await local.seed();
        await remote.seed();
        const prepared = await local.runtime().core.publish(request, local.ctx('prepare')) as PreparedResult;
        const retry = {
            type: 'retry' as const,
            retryOf: prepared.operationId,
            targets: [{
                    provider: 'fake', connection: 'conn_alice'
                }]
        };

        await expect(remote.runtime().core.publish(retry, remote.ctx('retry-1'))).rejects.toMatchObject({
            code: 'NOT_FOUND'
        });
        await expect(remote.runtime().core.publish(retry, remote.ctx('retry-1'))).rejects.toMatchObject({
            code: 'NOT_FOUND'
        });

        expect(remote.state.operations.size).toBe(0);
        expect(remote.writes).toHaveLength(0);
    });
});
