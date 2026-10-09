import { describe, expect, it } from 'vitest';
import { harness } from '../../../tests/fixtures/state/harness.js';
describe('managed connect lifecycle', () => {
    it('imports credentials once, replays consumed step past TTL, never exposes secret', async () => {
        const h = harness();
        const { core } = h.runtime();
        const start = await core.connect({
            type: 'start', provider: 'fake', label: 'personal'
        }, h.ctx('start'));
        expect(start.status).toBe('action_required');
        if (start.status !== 'action_required')
            throw Error('action');
        const request = {
            type: 'resume' as const, connectSessionId: start.connectSessionId, stepRevision: start.stepRevision, input: {
                type: 'credentials' as const, credentials: {
                    token: 'IMPORT_SECRET_CANARY'
                }
            }
        };
        const done = await core.connect(request, h.ctx());
        expect(done.status).toBe('done');
        expect(JSON.stringify(done)).not.toContain('IMPORT_SECRET_CANARY');
        h.setTime('2026-10-09T00:00:00.000Z');
        h.implementation.artifactFingerprint = 'new';
        expect(await core.connect(request, h.ctx())).toEqual(done);
        expect(await core.connect({
            type: 'start', provider: 'fake', label: 'personal'
        }, h.ctx('start'))).toEqual(start);
        const found = await core.status({
            type: 'connections'
        }, h.ctx());
        expect(found.connections).toHaveLength(1);
        expect(h.state.connections.values().next().value?.secretRef).toMatch(/^secret_/);
    });
    it('one concurrent resume exchanges credentials, other replays or reports busy', async () => {
        const h = harness();
        const core = h.runtime().core;
        const start = await core.connect({
            type: 'start', provider: 'fake'
        }, h.ctx('s'));
        if (start.status !== 'action_required')
            throw Error('action');
        let calls = 0;
        const original = h.plugin.connect.run;
        h.plugin.connect.run = async (...args) => {
            calls++;
            await Promise.resolve();
            return original(...args);
        };
        const resume = {
            type: 'resume' as const, connectSessionId: start.connectSessionId, stepRevision: start.stepRevision, input: {
                type: 'credentials' as const, credentials: {
                    token: 'secret'
                }
            }
        };
        await Promise.allSettled([core.connect(resume, h.ctx()), core.connect(resume, h.ctx())]);
        expect(calls).toBe(1);
        expect(h.state.connections.size).toBe(1);
        await expect(core.connect({
            ...resume, input: {
                type: 'credentials', credentials: {
                    token: 'different'
                }
            }
        }, h.ctx())).rejects.toMatchObject({
            code: 'CONNECT_STEP_CONFLICT'
        });
    });
    it('rejects stale, expired and cross-principal sessions without exchanging', async () => {
        const h = harness();
        const core = h.runtime().core;
        const start = await core.connect({
            type: 'start', provider: 'fake'
        }, h.ctx('s'));
        if (start.status !== 'action_required')
            throw Error('action');
        let calls = 0;
        h.plugin.connect.run = async () => {
            calls++;
            throw Error('must not run');
        };
        const resume = {
            type: 'resume' as const, connectSessionId: start.connectSessionId, stepRevision: start.stepRevision, input: {
                type: 'credentials' as const, credentials: {
                    token: 'secret'
                }
            }
        };
        await expect(core.connect(resume, {
            ...h.ctx(), principalId: 'intruder'
        })).rejects.toMatchObject({
            code: 'NOT_FOUND'
        });
        await expect(core.connect({
            ...resume, stepRevision: 44
        }, h.ctx())).rejects.toMatchObject({
            code: 'CONNECT_STEP_CONFLICT'
        });
        h.setTime('2026-10-08T00:15:00.000Z');
        await expect(core.connect(resume, h.ctx())).rejects.toMatchObject({
            code: 'CONNECT_SESSION_EXPIRED'
        });
        expect(calls).toBe(0);
    });
    it('callback_complete cannot establish OAuth completion or spend a step', async () => {
        const h = harness();
        const core = h.runtime().core;
        const start = await core.connect({
            type: 'start', provider: 'fake'
        }, h.ctx('s'));
        if (start.status !== 'action_required')
            throw Error('action');
        const steps = h.state.steps.size;
        expect((await core.connect({
            type: 'resume', connectSessionId: start.connectSessionId, stepRevision: start.stepRevision, input: {
                type: 'callback_complete'
            }
        }, h.ctx())).status).toBe('action_required');
        expect(h.state.steps.size).toBe(steps);
        expect(h.state.connections.size).toBe(0);
    });
    it('failed credential CAS preserves prior account and secret', async () => {
        let inject = false;
        const h = harness({
            fault: (m, w) => {
                if (inject && m === 'commitConnection' && w === 'before')
                    throw Error('storage');
            }
        });
        const old = await h.seed();
        const core = h.runtime().core;
        const start = await core.connect({
            type: 'start', provider: 'fake', connectionId: old.connectionId
        }, h.ctx('reauth'));
        if (start.status !== 'action_required')
            throw Error('action');
        inject = true;
        await expect(core.connect({
            type: 'resume', connectSessionId: start.connectSessionId, stepRevision: start.stepRevision, input: {
                type: 'credentials', credentials: {
                    token: 'NEW_SECRET'
                }
            }
        }, h.ctx())).rejects.toMatchObject({
            code: 'DURABILITY_ERROR'
        });
        expect(h.state.connections.get(old.connectionId)).toEqual(old);
    });
    it('reauthentication cannot bind old connection to another account', async () => {
        const h = harness();
        await h.seed();
        const core = h.runtime().core;
        const start = await core.connect({
            type: 'start', provider: 'fake', connectionId: 'conn_alice'
        }, h.ctx('reauth'));
        if (start.status !== 'action_required')
            throw Error('action');
        h.plugin.connect.run = async () => ({
            status: 'done', credentials: {
                token: 'new'
            }, identity: {
                account: {
                    provider: 'fake', accountId: 'bob', origin: 'https://social.example'
                }, evidence: []
            }
        });
        await expect(core.connect({
            type: 'resume', connectSessionId: start.connectSessionId, stepRevision: start.stepRevision, input: {
                type: 'credentials', credentials: {
                    token: 'new'
                }
            }
        }, h.ctx())).rejects.toMatchObject({
            code: 'CONNECTION_IDENTITY_CHANGED'
        });
        expect(h.state.connections.get('conn_alice')?.account.accountId).toBe('alice');
    });
});
it.each([true, false])('fresh start retains stable identity for an existing account (active=%s)', async active => {
    const h = harness();
    const old = await h.seed();
    old.active = active;
    old.label = 'personal';
    const core = h.runtime().core;
    const start = await core.connect({
        type: 'start', provider: 'fake'
    }, h.ctx('fresh'));
    if (start.status !== 'action_required')
        throw Error('action');
    const request = {
        type: 'resume' as const, connectSessionId: start.connectSessionId, stepRevision: start.stepRevision, input: {
            type: 'credentials' as const, credentials: {
                token: 'NEW_SECRET'
            }
        }
    };
    const done = await core.connect(request, h.ctx());
    expect(done.status).toBe('done');
    if (done.status !== 'done')
        throw Error('done');
    expect(done.connection).toMatchObject({
        connectionId: old.connectionId,
        account: old.account,
        label: 'personal',
        isDefault: old.isDefault,
        active: true
    });
    expect(h.state.connections.size).toBe(1);
    const saved = h.state.connections.get(old.connectionId)!;
    expect(saved.credentialRevision).toBe(2);
    expect(saved.bindingRevision).toBe(old.bindingRevision + 1);
    expect(saved.secretRef).not.toBe(old.secretRef);
    expect(await h.credentials.get({
        ref: saved.secretRef,
        owner: { kind: 'credential', ownerId: old.connectionId, version: 2 }
    })).toEqual({ token: 'NEW_SECRET' });
    expect(JSON.stringify(done)).not.toContain('NEW_SECRET');

    // Replaying the consumed fresh-connect step after its TTL must neither
    // exchange credentials again nor allocate a different connection identity.
    const loads = h.metrics().loads;
    h.setTime('2026-10-09T00:00:00.000Z');
    expect(await core.connect(request, h.ctx())).toEqual(done);
    expect(h.metrics().loads).toBe(loads);
    expect(h.state.connections.get(old.connectionId)).toEqual(saved);
});
