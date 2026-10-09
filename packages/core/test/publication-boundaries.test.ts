import { describe, expect, it } from 'vitest';
import { harness } from '../../../tests/fixtures/state/harness.js';
import type { ConnectionRecord, PreparedResult, PrepareRequest, VerifiedIdentity } from '../src/domain/records.js';
import { fail } from '../src/protocol/validation.js';

/**
 * PUB-02 and PUB-05 of the architecture-v1 acceptance map.
 *
 * PUB-02: every target is preflighted before any social-network content is
 * written, so one illegal target means zero writes.
 * PUB-05: a bad, cross-scope or expired-unconsumed approval token is never
 * admitted, and concurrent `execute` calls admit exactly once.
 *
 * Every assertion is a counter or an exact error code, so dropping the
 * guarantee makes the test fail rather than merely stop throwing.
 */

const origin = 'https://social.example';

const request: PrepareRequest = {
    type: 'prepare', content: {
        text: 'Hello'
    }, targets: [{
            provider: 'fake'
        }]
};

/** Credential the harness `seed()` stores for `conn_alice`. */
const ALICE_TOKEN = 'FAKE_SECRET_CANARY';

/** Add a connection plus the credential its `secretRef` names. */
async function addConnection(
    h: ReturnType<typeof harness>,
    connectionId: string,
    accountId: string,
): Promise<ConnectionRecord> {
    const staged = await h.credentials.put({
        creationId: connectionId,
        owner: {
            kind: 'credential', ownerId: connectionId, version: 1
        },
        value: {
            token: accountId
        }
    });
    const connection: ConnectionRecord = {
        connectionId,
        account: {
            provider: 'fake', accountId, origin
        },
        isDefault: false,
        active: true,
        revision: 1,
        bindingRevision: 1,
        credentialRevision: 1,
        secretRef: staged.ref,
        observations: []
    };
    h.state.connections.set(connectionId, connection);
    return connection;
}

/**
 * Map each stored credential back to the account it belongs to, exactly as a
 * real provider would. `noperm` additionally reports no publishing permission.
 * Returns the number of identity checks performed.
 */
function verifyByToken(h: ReturnType<typeof harness>): () => number {
    let verifies = 0;
    h.plugin.connect.verify = async (credentials) => {
        verifies++;
        const token = String(credentials.token);
        const accountId = token === ALICE_TOKEN ? 'alice' : token;
        return {
            account: {
                provider: 'fake', accountId, origin
            },
            evidence: accountId === 'noperm' ? [{
                    capability: 'publish_permission',
                    value: 'unsupported',
                    source: 'test',
                    verifiedAt: h.deps.clock.now()
            } as VerifiedIdentity['evidence'][number]] : []
        };
    };
    return () => verifies;
}

/**
 * Add the four preflight failure modes: a missing credential, an account that
 * reports no publishing permission, and a provider the registry does not
 * register. Returns the number of times the ghost provider was looked up.
 */
async function addBrokenTargets(h: ReturnType<typeof harness>): Promise<() => number> {
    h.state.connections.set('conn_nocred', {
        connectionId: 'conn_nocred',
        account: {
            provider: 'fake', accountId: 'nocred', origin
        },
        isDefault: false,
        active: true,
        revision: 1,
        bindingRevision: 1,
        credentialRevision: 1,
        secretRef: 'secret_never_stored',
        observations: []
    });
    await addConnection(h, 'conn_noperm', 'noperm');

    const staged = await h.credentials.put({
        creationId: 'ghost',
        owner: {
            kind: 'credential', ownerId: 'conn_ghost', version: 1
        },
        value: {
            token: 'ghost'
        }
    });
    h.state.connections.set('conn_ghost', {
        connectionId: 'conn_ghost',
        account: {
            provider: 'ghost', accountId: 'ghost', origin
        },
        isDefault: false,
        active: true,
        revision: 1,
        bindingRevision: 1,
        credentialRevision: 1,
        secretRef: staged.ref,
        observations: []
    });

    let ghostLoads = 0;
    const load = h.providers.load.bind(h.providers);
    h.providers.load = async (provider, mode) => {
        if (provider === 'ghost') {
            ghostLoads++;
            fail('PROVIDER_UNAVAILABLE');
        }
        return load(provider, mode);
    };

    return () => ghostLoads;
}

/** A prepare request whose first targets are valid and whose last is illegal. */
function mixed(...targets: PrepareRequest['targets'][number][]): PrepareRequest {
    return {
        ...request, targets
    };
}

/** Everything a failed multi-target preflight must never leave behind. */
function expectNoWrite(h: ReturnType<typeof harness>): void {
    expect(h.writes).toHaveLength(0);
    expect(h.state.intents.size).toBe(0);
}

describe('PUB-02 preflight before any content write', () => {
    it('writes nothing when a valid target is mixed with an unregistered provider', async () => {
        const h = harness();
        await h.seed();
        const ghostLoads = await addBrokenTargets(h);

        await expect(h.runtime().core.publish(mixed({
            provider: 'fake', connection: 'conn_alice'
        }, {
            provider: 'ghost', connection: 'conn_ghost'
        }), h.ctx('mixed-no-plugin'))).rejects.toMatchObject({
            code: 'PROVIDER_UNAVAILABLE'
        });

        expectNoWrite(h);
        // The valid target was verified and the illegal one was reached, so the
        // request was fully preflighted rather than rejected up front.
        expect(h.metrics().verifies).toBe(1);
        expect(ghostLoads()).toBe(1);
    });

    it('writes nothing when a valid target is mixed with a target whose credential is missing', async () => {
        const h = harness();
        await h.seed();
        await addBrokenTargets(h);

        await expect(h.runtime().core.publish(mixed({
            provider: 'fake', connection: 'conn_alice'
        }, {
            provider: 'fake', connection: 'conn_nocred'
        }), h.ctx('mixed-no-credential'))).rejects.toMatchObject({
            code: 'DURABILITY_ERROR'
        });

        expectNoWrite(h);
        // Only the valid target could be verified; the missing credential stops
        // the preflight before any submission.
        expect(h.metrics().verifies).toBe(1);
    });

    it('writes nothing when a valid target is mixed with a target that reports no publish permission', async () => {
        const h = harness();
        await h.seed();
        await addBrokenTargets(h);
        const verifies = verifyByToken(h);

        await expect(h.runtime().core.publish(mixed({
            provider: 'fake', connection: 'conn_alice'
        }, {
            provider: 'fake', connection: 'conn_noperm'
        }), h.ctx('mixed-no-permission'))).rejects.toMatchObject({
            code: 'FORBIDDEN'
        });

        expectNoWrite(h);
        expect(verifies()).toBe(2);
    });

    it('writes nothing for the whole valid / no-credential / no-permission / no-plugin set', async () => {
        const h = harness();
        await h.seed();
        const ghostLoads = await addBrokenTargets(h);
        verifyByToken(h);

        const problem = await h.runtime().core.publish(mixed({
            provider: 'fake', connection: 'conn_alice'
        }, {
            provider: 'fake', connection: 'conn_nocred'
        }, {
            provider: 'fake', connection: 'conn_noperm'
        }, {
            provider: 'ghost', connection: 'conn_ghost'
        }), h.ctx('mixed-all')).catch((error: unknown) => error);

        expect(problem).toMatchObject({
            code: 'DURABILITY_ERROR'
        });
        expectNoWrite(h);
        expect(ghostLoads()).toBe(0);
        expect(h.state.operations.size).toBe(1);
        expect([...h.state.operations.values()][0]?.phase).toBe('preparing');
    });
});

describe('PUB-05 approval admission', () => {
    it('refuses a malformed token without admitting anything', async () => {
        const h = harness();
        await h.seed();

        await expect(h.runtime().core.publish({
            type: 'execute', approvalToken: 'not-a-token'
        }, h.ctx())).rejects.toMatchObject({
            code: 'APPROVAL_INVALID'
        });

        expect(h.writes).toHaveLength(0);
        expect([...h.state.approvals.values()].filter((entry) => entry.admitted)).toHaveLength(0);
    });

    it('refuses a token issued to another principal', async () => {
        const h = harness();
        await h.seed();
        const core = h.runtime().core;
        const prepared = await core.publish(request, h.ctx('prepare')) as PreparedResult;

        await expect(core.publish({
            type: 'execute', approvalToken: prepared.approvalToken
        }, {
            ...h.ctx(), principalId: 'someone-else'
        })).rejects.toMatchObject({
            code: 'APPROVAL_INVALID'
        });

        expect(h.writes).toHaveLength(0);
        expect([...h.state.approvals.values()].filter((entry) => entry.admitted)).toHaveLength(0);
    });

    it('refuses a token from another deployment that declares the same scope', async () => {
        // Two stores, one scope name: isolation must come from the store, never
        // from a name two deployments could share.
        const local = harness({
            scope: 'local'
        });
        const remote = harness({
            scope: 'local'
        });
        await local.seed();
        const prepared = await local.runtime().core.publish(request, local.ctx('prepare')) as PreparedResult;

        await expect(remote.runtime().core.publish({
            type: 'execute', approvalToken: prepared.approvalToken
        }, remote.ctx())).rejects.toMatchObject({
            code: 'APPROVAL_INVALID'
        });

        expect(remote.writes).toHaveLength(0);
        expect(local.writes).toHaveLength(0);
        expect([...local.state.approvals.values()].filter((entry) => entry.admitted)).toHaveLength(0);
    });

    it('refuses an expired token that was never consumed', async () => {
        const h = harness();
        await h.seed();
        const core = h.runtime().core;
        const prepared = await core.publish(request, h.ctx('prepare')) as PreparedResult;
        const digest = await h.deps.digests.sensitive({
            approvalToken: prepared.approvalToken
        });
        h.setTime('2026-10-08T00:16:00.000Z');

        await expect(core.publish({
            type: 'execute', approvalToken: prepared.approvalToken
        }, h.ctx())).rejects.toMatchObject({
            code: 'APPROVAL_EXPIRED'
        });

        expect(h.state.approvals.get(digest)?.admitted).toBe(false);
        expect(h.writes).toHaveLength(0);
    });

    it('admits exactly once when two executors race on the same token', async () => {
        const h = harness();
        await h.seed();
        await addConnection(h, 'conn_bob', 'bob');
        verifyByToken(h);
        const core = h.runtime().core;
        const prepared = await core.publish(mixed({
            provider: 'fake', connection: 'conn_alice'
        }, {
            provider: 'fake', connection: 'conn_bob'
        }), h.ctx('prepare')) as PreparedResult;

        let submissions = 0;
        let admissions = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        h.setPublish(async () => {
            submissions++;
            if (submissions === 1) {
                entered();
                await gate;
            }
            return {
                status: 'succeeded'
            };
        });
        const admit = h.state.admitExecution.bind(h.state);
        h.state.admitExecution = async (input) => {
            const result = await admit(input);
            if (result.type === 'applied') {
                admissions++;
            }
            return result;
        };

        const first = core.publish({
            type: 'execute', approvalToken: prepared.approvalToken
        }, h.ctx());
        await started;
        const second = await core.publish({
            type: 'execute', approvalToken: prepared.approvalToken
        }, h.ctx());
        const duringSecond = {
            admissions, submissions
        };
        release();
        const firstResult = await first;

        expect(second.status).toBeDefined();
        // The racing call admitted nothing and submitted nothing.
        expect(duringSecond).toEqual({
            admissions: 1, submissions: 1
        });
        expect(firstResult.status).toBe('succeeded');
        expect(admissions).toBe(1);
        expect(submissions).toBe(2);
        // Per-target submission counts: each target exactly once.
        expect(h.writes.map((write) => write.account.accountId)).toEqual(['alice', 'bob']);
    });
});
