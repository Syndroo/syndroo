import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';
import type { PreparedResult, PrepareRequest, ProviderPublishInput } from '../src/domain/records.js';
import { harness } from '../../../tests/fixtures/state/harness.js';
const request: PrepareRequest = {
    type: 'prepare', content: {
        text: '  Hello 雨\n'
    }, targets: [{
            provider: 'fake'
        }]
};
async function twoTargets(h: ReturnType<typeof harness>): Promise<PrepareRequest> {
    await h.seed();
    const bob = await h.seed('conn_bob', 'bob');
    const secret = await h.credentials.put({
        creationId: 'bob-token',
        owner: {
            kind: 'credential', ownerId: bob.connectionId, version: 1
        },
        value: {
            token: 'bob'
        }
    });
    h.state.connections.get(bob.connectionId)!.secretRef = secret.ref;
    h.plugin.connect.verify = async (credentials) => ({
        account: {
            ...bob.account, accountId: credentials.token === 'bob' ? 'bob' : 'alice'
        },
        evidence: []
    });
    return {
        ...request, targets: [
            {
                provider: 'fake', connection: 'conn_alice'
            },
            {
                provider: 'fake', connection: 'conn_bob'
            }
        ]
    };
}
async function prepared(h: ReturnType<typeof harness>, key = 'prepare'): Promise<PreparedResult> {
    expect(api).toHaveProperty('createCore');
    const p = await h.runtime().core.publish(structuredClone(request), h.ctx(key));
    expect(p.status).toBe('confirmation_required');
    return p as PreparedResult;
}
describe('Core publication safety', () => {
    it('executes reversed retry selection in original target order', async () => {
        const h = harness();
        const multi = await twoTargets(h);
        const core = h.runtime().core;
        h.setPublish(async () => ({
            status: 'failed', disposition: 'not_applied', retryable: true, reason: 'network'
        }));
        const first = await core.publish(multi, h.ctx('first')) as PreparedResult;
        await core.publish({
            type: 'execute', approvalToken: first.approvalToken
        }, h.ctx());
        const retry = await core.publish({
            type: 'retry', retryOf: first.operationId,
            targets: [{
                    provider: 'fake', connection: 'conn_bob'
                }, {
                    provider: 'fake', connection: 'conn_alice'
                }]
        }, h.ctx('retry')) as PreparedResult;
        h.setPublish(async () => ({
            status: 'succeeded'
        }));
        expect((await core.publish({
            type: 'execute', approvalToken: retry.approvalToken
        }, h.ctx())).status).toBe('succeeded');
        expect(h.writes.map(w => w.account.accountId)).toEqual(['alice', 'bob', 'alice', 'bob']);
    });
    it.each(['before', 'after'] as const)('stops target2 after %s-commit outcome durability failure', async (when) => {
        let inject = false;
        const h = harness({
            fault: (method, phase) => {
                if (inject && method === 'recordOutcome' && phase === when) {
                    inject = false;
                    throw Error('outcome persistence response lost');
                }
            }
        });
        const multi = await twoTargets(h);
        const core = h.runtime().core;
        const prepared = await core.publish(multi, h.ctx('first')) as PreparedResult;
        inject = true;
        const result = await core.publish({
            type: 'execute', approvalToken: prepared.approvalToken
        }, h.ctx());
        expect(result).toMatchObject({
            status: 'unknown', durabilityWarning: 'OUTCOME_NOT_DURABLE'
        });
        expect(h.writes.map(w => w.account.accountId)).toEqual(['alice']);
        await core.publish({
            type: 'execute', approvalToken: prepared.approvalToken
        }, h.ctx());
        expect(h.writes).toHaveLength(1);
    });
    it('persists exact payload then executes after reconstruction without rereading input', async () => {
        const h = harness();
        await h.seed();
        const p = await prepared(h);
        expect(h.writes).toHaveLength(0);
        const result = await h.runtime().core.publish({
            type: 'execute', approvalToken: p.approvalToken
        }, h.ctx());
        expect(result.status).toBe('succeeded');
        expect(h.writes[0]?.frozen.payload).toEqual({
            text: '  Hello 雨\n'
        });
        h.setTime('2026-10-09T00:00:00.000Z');
        h.implementation.artifactFingerprint = 'changed';
        expect((await h.runtime().core.publish({
            type: 'execute', approvalToken: p.approvalToken
        }, h.ctx())).status).toBe('succeeded');
        expect(h.writes).toHaveLength(1);
    });
    it('preflights every target before any content submission', async () => {
        const h = harness();
        await h.seed();
        expect(api).toHaveProperty('createCore');
        await expect(h.runtime().core.publish({
            ...request, targets: [{
                    provider: 'fake'
                }, {
                    provider: 'fake', connection: 'missing'
                }]
        }, h.ctx('bad'))).rejects.toMatchObject({
            code: 'NOT_FOUND'
        });
        expect(h.writes).toHaveLength(0);
    });
    it('same key replays despite changed default; changed content conflicts', async () => {
        const h = harness();
        await h.seed();
        const p = await prepared(h);
        await h.seed('conn_bob', 'bob');
        h.state.connections.get('conn_alice')!.isDefault = false;
        h.state.connections.get('conn_bob')!.isDefault = true;
        expect((await prepared(h)).operationId).toBe(p.operationId);
        await expect(h.runtime().core.publish({
            ...request, content: {
                text: 'different'
            }
        }, h.ctx('prepare'))).rejects.toMatchObject({
            code: 'IDEMPOTENCY_CONFLICT'
        });
    });
    it('rejects stale artifacts, stale binding, expired and cross-principal approval', async () => {
        const h = harness();
        await h.seed();
        const p = await prepared(h);
        h.implementation.artifactFingerprint = 'changed';
        await expect(h.runtime().core.publish({
            type: 'execute', approvalToken: p.approvalToken
        }, h.ctx())).rejects.toMatchObject({
            code: 'STALE_INTENT'
        });
        h.implementation.artifactFingerprint = 'artifact-1';
        h.state.connections.get('conn_alice')!.bindingRevision++;
        await expect(h.runtime().core.publish({
            type: 'execute', approvalToken: p.approvalToken
        }, h.ctx())).rejects.toMatchObject({
            code: 'STALE_BINDING'
        });
        await expect(h.runtime().core.publish({
            type: 'execute', approvalToken: p.approvalToken
        }, {
            ...h.ctx(), principalId: 'other'
        })).rejects.toMatchObject({
            code: 'APPROVAL_INVALID'
        });
        h.setTime('2026-10-08T00:15:00.000Z');
        await expect(h.runtime().core.publish({
            type: 'execute', approvalToken: p.approvalToken
        }, h.ctx())).rejects.toMatchObject({
            code: 'APPROVAL_EXPIRED'
        });
        expect(h.writes).toHaveLength(0);
    });
    it('keeps target2 blocked while target1 is in flight across concurrent executors', async () => {
        const h = harness({
            async: true
        });
        await h.seed();
        await h.seed('conn_bob', 'bob');
        h.plugin.connect.verify = async (c) => ({
            account: {
                provider: 'fake', accountId: c.token === 'bob' ? 'bob' : 'alice', origin: 'https://social.example'
            }, evidence: []
        });
        const bob = h.state.connections.get('conn_bob')!;
        const staged = await h.credentials.put({
            creationId: 'bob-token', owner: {
                kind: 'credential', ownerId: 'conn_bob', version: 1
            }, value: {
                token: 'bob'
            }
        });
        bob.secretRef = staged.ref;
        expect(api).toHaveProperty('createCore');
        const p = await h.runtime().core.publish({
            ...request, targets: [{
                    provider: 'fake', connection: 'conn_alice'
                }, {
                    provider: 'fake', connection: 'conn_bob'
                }]
        }, h.ctx('multi')) as PreparedResult;
        await h.runtime().core.publish({
            type: 'execute', approvalToken: p.approvalToken
        }, h.ctx());
        let release!: () => void;
        const blocked = new Promise<void>(r => {
            release = r;
        });
        let started!: () => void;
        const inFlight = new Promise<void>(r => {
            started = r;
        });
        h.setPublish(async () => {
            started();
            await blocked;
            return {
                status: 'succeeded'
            };
        });
        const work = {
            operationId: p.operationId, executionRevision: 0
        };
        const first = h.runtime().executor.run(work, h.ctx().signal);
        await inFlight;
        await h.runtime().executor.run(work, h.ctx().signal);
        expect(h.writes).toHaveLength(1);
        release();
        await first;
        expect(h.writes).toHaveLength(2);
    });
    it('preserves unknown after throw and refuses safe retry', async () => {
        const h = harness();
        await h.seed();
        const p = await prepared(h);
        h.setPublish(async () => {
            throw Error('FAKE_SECRET_CANARY');
        });
        const result = await h.runtime().core.publish({
            type: 'execute', approvalToken: p.approvalToken
        }, h.ctx());
        expect(result.status).toBe('unknown');
        await expect(h.runtime().core.publish({
            type: 'retry', retryOf: p.operationId, targets: [{
                    provider: 'fake', connection: 'conn_alice'
                }]
        }, h.ctx('retry'))).rejects.toMatchObject({
            code: 'RETRY_INELIGIBLE'
        });
        expect(h.writes).toHaveLength(1);
    });
    it('serializes competing retries, caps attempts and old consumed token never admits retry', async () => {
        const h = harness();
        await h.seed();
        h.setPublish(async () => ({
            status: 'failed', disposition: 'not_applied', retryable: true, reason: 'network'
        }));
        const p = await prepared(h);
        await h.runtime().core.publish({
            type: 'execute', approvalToken: p.approvalToken
        }, h.ctx());
        const retry = {
            type: 'retry' as const, retryOf: p.operationId, targets: [{
                    provider: 'fake', connection: 'conn_alice'
                }]
        };
        const races = await Promise.allSettled([h.runtime().core.publish(retry, h.ctx('r1')), h.runtime().core.publish(retry, h.ctx('r2'))]);
        expect(races.filter(x => x.status === 'fulfilled')).toHaveLength(1);
        const r = (races.find(x => x.status === 'fulfilled') as PromiseFulfilledResult<PreparedResult>).value;
        await h.runtime().core.publish({
            type: 'execute', approvalToken: p.approvalToken
        }, h.ctx());
        expect(h.writes).toHaveLength(1);
        await h.runtime().core.publish({
            type: 'execute', approvalToken: r.approvalToken
        }, h.ctx());
        const r3 = await h.runtime().core.publish(retry, h.ctx('r3')) as PreparedResult;
        await h.runtime().core.publish({
            type: 'execute', approvalToken: r3.approvalToken
        }, h.ctx());
        await expect(h.runtime().core.publish(retry, h.ctx('r4'))).rejects.toMatchObject({
            code: 'RETRY_INELIGIBLE'
        });
        expect(h.writes).toHaveLength(3);
    });
    it('records durable pending despite notification failure', async () => {
        const h = harness({
            async: true
        });
        await h.seed();
        const p = await prepared(h);
        const result = await h.runtime().core.publish({
            type: 'execute', approvalToken: p.approvalToken
        }, h.ctx());
        expect(result.status).toBe('pending');
        expect(h.state.operations.get(p.operationId)?.work.pending).toBe(true);
        expect(h.writes).toHaveLength(0);
    });
    it('success followed by failed outcome persistence cannot trigger a second send', async () => {
        let fault = false;
        const h = harness({
            fault: (m, w) => {
                if (fault && m === 'recordOutcome' && w === 'before')
                    throw Error('disk failed');
            }
        });
        await h.seed();
        const p = await prepared(h);
        fault = true;
        const result = await h.runtime().core.publish({
            type: 'execute', approvalToken: p.approvalToken
        }, h.ctx());
        expect(result.durabilityWarning).toBe('OUTCOME_NOT_DURABLE');
        expect(h.writes).toHaveLength(1);
        await h.runtime().core.publish({
            type: 'execute', approvalToken: p.approvalToken
        }, h.ctx());
        expect(h.writes).toHaveLength(1);
        h.setTime('2026-10-08T00:16:00.000Z');
        fault = false;
        await h.runtime().executor.run({
            operationId: p.operationId, executionRevision: 0
        }, h.ctx().signal);
        expect(h.state.operations.get(p.operationId)?.status).toBe('unknown');
        expect(h.writes).toHaveLength(1);
    });
    it('status is read-only, secret-free and performs no provider load', async () => {
        const h = harness();
        await h.seed();
        const p = await prepared(h);
        const before = h.metrics();
        const reads = h.credentials.reads;
        const version = h.state.operations.get(p.operationId)!.version;
        const result = await h.runtime().core.status({
            type: 'operation', operationId: p.operationId
        }, h.ctx());
        expect(JSON.stringify(result)).not.toContain('approvalToken');
        expect(h.metrics()).toEqual(before);
        expect(h.credentials.reads).toBe(reads);
        expect(h.state.operations.get(p.operationId)!.version).toBe(version);
    });
});
