import { describe, expect, it } from 'vitest';
import { harness } from '../../../tests/fixtures/state/harness.js';
import { previewDocument } from '../src/runtime.js';
import type { PreparedResult, ProviderWriteOutcome, ProviderConnectResult, VerifiedIdentity } from '../src/domain/records.js';
const request = {
    type: 'prepare' as const, content: {
        text: 'Hello'
    }, targets: [{
            provider: 'fake'
        }]
};
describe('publication boundaries', () => {
    it('expired same-key prepare retains the operation identity for recovery', async () => {
        const h = harness();
        await h.seed();
        const core = h.runtime().core;
        const first = await core.publish(request, h.ctx('same'));
        h.setTime('2026-10-09T00:00:00.000Z');
        await expect(core.publish(request, h.ctx('same'))).rejects.toMatchObject({
            code: 'APPROVAL_EXPIRED', details: { operationId: first.operationId }
        });
        expect(h.state.operations.size).toBe(1);
    });
    it('refuses internal execution before approval admission', async () => {
        const h = harness();
        await h.seed();
        const { core, executor } = h.runtime();
        const prepared = await core.publish(request, h.ctx('prepare'));
        await expect(executor.run({
            operationId: prepared.operationId, executionRevision: 0
        }, h.ctx().signal))
            .rejects.toMatchObject({
            code: 'STALE_INTENT'
        });
        expect(h.writes).toHaveLength(0);
    });
    it('rejects malformed connect actions before saving or returning them', async () => {
        const h = harness();
        h.plugin.connect.run = async () => ({
            status: 'action_required',
            action: {
                type: 'wait_for_callback', credentials: 'SECRET_CANARY'
            },
            privateState: {}
        }) as unknown as ProviderConnectResult;
        await expect(h.runtime().core.connect({
            type: 'start', provider: 'fake'
        }, h.ctx('start')))
            .rejects.toMatchObject({
            code: 'PROVIDER_INVALID'
        });
        expect(h.state.connections.size).toBe(0);
        expect(JSON.stringify([...h.state.sessions])).not.toContain('SECRET_CANARY');
    });
    it('rejects malformed identity evidence during all-target preflight', async () => {
        const h = harness();
        const connection = await h.seed();
        h.plugin.connect.verify = async () => ({
            account: connection.account,
            evidence: [{
                    capability: 'publish_permission', value: 'maybe', source: 'test', verifiedAt: h.deps.clock.now()
                }]
        }) as unknown as VerifiedIdentity;
        await expect(h.runtime().core.publish(request, h.ctx('prepare')))
            .rejects.toMatchObject({
            code: 'PROVIDER_INVALID'
        });
        expect(h.state.intents.size).toBe(0);
        expect(h.writes).toHaveLength(0);
    });
    it('reports invalid requests as input errors rather than durability errors', async () => {
        const h = harness();
        await expect(h.runtime().core.publish({
            ...request, targets: []
        }, h.ctx('bad'))).rejects.toMatchObject({
            code: 'INVALID_INPUT'
        });
    });
    it('admission is single-use across concurrent execute requests', async () => {
        const h = harness();
        await h.seed();
        const core = h.runtime().core;
        const p = await core.publish(request, h.ctx('p')) as PreparedResult;
        await Promise.all([core.publish({
                type: 'execute', approvalToken: p.approvalToken
            }, h.ctx()), core.publish({
                type: 'execute', approvalToken: p.approvalToken
            }, h.ctx())]);
        expect(h.writes).toHaveLength(1);
        expect(h.state.operations.get(p.operationId)?.deliveries[0]?.attempts).toBe(1);
    });
    it('malformed outcome is unknown and never retried', async () => {
        const h = harness();
        await h.seed();
        h.setPublish(async () => ({
            status: 'succeeded', unexpected: 'secret'
        }) as ProviderWriteOutcome);
        const core = h.runtime().core;
        const p = await core.publish(request, h.ctx('p')) as PreparedResult;
        expect((await core.publish({
            type: 'execute', approvalToken: p.approvalToken
        }, h.ctx())).status).toBe('unknown');
    });
    it('cancel during submission records unknown; never marks it not_applied', async () => {
        const h = harness();
        await h.seed();
        const core = h.runtime().core;
        const p = await core.publish(request, h.ctx('p')) as PreparedResult;
        const controller = new AbortController();
        h.setPublish(async () => {
            controller.abort();
            return new Promise(() => {
            });
        });
        expect((await core.publish({
            type: 'execute', approvalToken: p.approvalToken
        }, {
            ...h.ctx(), signal: controller.signal
        })).status).toBe('unknown');
        expect(h.writes).toHaveLength(1);
    });
    it('dry-run has no secret/state writes or identity verification', async () => {
        const h = harness();
        await h.seed();
        const connections = await h.runtime().core.status({
            type: 'connections'
        }, h.ctx());
        const reads = h.credentials.reads;
        const result = await previewDocument({
            content: request.content, targets: request.targets
        }, {
            providers: h.providers, connections: connections.connections, now: h.deps.clock.now(), seed: 'fixed'
        });
        expect(result.status).toBe('preview');
        expect(h.credentials.reads).toBe(reads);
        expect(h.metrics().verifies).toBe(0);
        expect(h.state.operations.size).toBe(0);
        expect(h.writes).toHaveLength(0);
    });
    it('same-content new explicit key creates a different operation', async () => {
        const h = harness();
        await h.seed();
        const core = h.runtime().core;
        const p = await core.publish(request, h.ctx('one'));
        const p2 = await core.publish(request, h.ctx('two'));
        expect(p.operationId).not.toBe(p2.operationId);
    });
    it('post-commit prepare response loss recovers existing intent', async () => {
        let inject = true;
        const h = harness({
            fault: (m, w) => {
                if (inject && m === 'savePreparedIntent' && w === 'after') {
                    inject = false;
                    throw Error('lost response');
                }
            }
        });
        await h.seed();
        const core = h.runtime().core;
        await expect(core.publish(request, h.ctx('one'))).rejects.toThrow();
        const recovered = await core.publish(request, h.ctx('one'));
        expect(recovered.status).toBe('confirmation_required');
        expect(h.state.operations.size).toBe(1);
    });
});
describe('corruption and protocol generation', () => {
    it('refuses a mutated persisted intent before admission', async () => {
        const h = harness();
        await h.seed();
        const core = h.runtime().core;
        const p = await core.publish(request, h.ctx('p')) as PreparedResult;
        h.state.intents.get(p.operationId + ':0')!.targets[0]!.frozen.payload.text = 'changed after approval';
        await expect(core.publish({
            type: 'execute', approvalToken: p.approvalToken
        }, h.ctx())).rejects.toMatchObject({
            code: 'STALE_INTENT'
        });
        expect(h.writes).toHaveLength(0);
    });
    it('rejects invalid connection maintenance labels before a write', async () => {
        const h = harness();
        await h.seed();
        await expect(h.runtime().core.connect({
            type: 'update', connectionId: 'conn_alice', changes: {
                label: 'conn_reserved'
            }
        }, h.ctx('u'))).rejects.toMatchObject({
            code: 'INVALID_INPUT'
        });
        expect(h.state.connections.get('conn_alice')?.label).toBeUndefined();
    });
    it('status pagination does not alter persisted state and rejects another scope cursor', async () => {
        const h = harness();
        await h.seed();
        for (let n = 0; n < 3; n++)
            await h.runtime().core.publish(request, h.ctx('p' + n));
        const before = JSON.stringify([...h.state.operations]);
        const first = await h.runtime().core.status({
            type: 'operations', limit: 1
        }, h.ctx());
        expect(first.nextCursor).toBeTruthy();
        const next = await h.runtime().core.status({
            type: 'operations', limit: 1, cursor: first.nextCursor!
        }, h.ctx());
        expect(next.operations[0]?.operationId).not.toBe(first.operations[0]?.operationId);
        expect(JSON.stringify([...h.state.operations])).toBe(before);
        const other = harness({
            scope: 'other'
        });
        await expect(other.runtime().core.status({
            type: 'operations', cursor: first.nextCursor!
        }, other.ctx())).rejects.toMatchObject({
            code: 'INVALID_INPUT'
        });
    });
});
