import { describe, expect, it } from 'vitest';
import type {
    DeliveryRecord,
    ExecutionResult,
    OperationRecord,
    PreparedResult,
    PrepareRequest,
    ProviderWriteOutcome,
} from '../src/domain/records.js';
import { projectExecution } from '../src/publish/projection.js';
import { harness } from '../../../tests/fixtures/state/harness.js';

/**
 * PUB-PROJ: one shared projection turns a persisted operation into the public
 * execution view. It must attach each delivery's own frozen preview and
 * presentation snapshot by stable deliveryId, keep the stored state as the
 * source of truth, and never guess or rewrite historical records.
 */

type H = ReturnType<typeof harness>;

const TARGETS = [
    { connection: 'conn_alice', account: 'alice', text: 'alpha' },
    { connection: 'conn_bob', account: 'bob', text: 'beta' },
    { connection: 'conn_carol', account: 'carol', text: 'gamma' },
] as const;

const RETRYABLE: ProviderWriteOutcome = {
    status: 'failed', disposition: 'not_applied', retryable: true, reason: 'network',
};

const request: PrepareRequest = {
    type: 'prepare',
    content: { text: 'shared' },
    targets: TARGETS.map(target => ({
        provider: 'fake', connection: target.connection, content: { text: target.text },
    })),
};

async function connect(h: H): Promise<void> {
    await h.seed();

    for (const target of TARGETS.slice(1)) {
        await h.seed(target.connection, target.account);
    }

    for (const target of TARGETS) {
        const secret = await h.credentials.put({
            creationId: `${target.connection}-token`,
            owner: { kind: 'credential', ownerId: target.connection, version: 1 },
            value: { token: target.account },
        });

        h.state.connections.get(target.connection)!.secretRef = secret.ref;
    }

    h.plugin.connect.verify = async credentials => ({
        account: {
            provider: 'fake', accountId: String(credentials.token), origin: 'https://social.example',
        },
        evidence: [],
        presentation: {
            accountName: `@${String(credentials.token)}`,
            profileUrl: `https://social.example/@${String(credentials.token)}`,
        },
    });
}

/**
 * Run one admitted round with the real executor. The harness admits through
 * the durable-async path so the test can choose exactly when the executor runs
 * and with which signal.
 */
async function runRound(h: H, operationId: string, executionRevision: number, signal = new AbortController().signal): Promise<void> {
    await h.runtime().executor.run({ operationId, executionRevision }, signal);
}

const texts = (result: ExecutionResult): (string | undefined)[] =>
    result.deliveries.map(delivery => delivery.preview?.content.text);

const names = (result: ExecutionResult): (string | undefined)[] =>
    result.deliveries.map(delivery => delivery.presentation?.accountName);

describe('PUB-PROJ shared execution projection', () => {
    it('exposes each delivery state and its own frozen snapshot by deliveryId', async () => {
        const h = harness();

        await connect(h);
        h.setPublish(async () => RETRYABLE);

        const core = h.runtime().core;
        const prepared = await core.publish(request, h.ctx('p1')) as PreparedResult;
        const result = await core.publish({
            type: 'execute', approvalToken: prepared.approvalToken,
        }, h.ctx()) as ExecutionResult;

        expect(result.status).toBe('failed');
        expect(result.deliveries.map(d => `${d.account.accountId}:${d.state}`))
            .toEqual(['alice:settled', 'bob:settled', 'carol:settled']);
        expect(texts(result)).toEqual(['alpha', 'beta', 'gamma']);
        expect(names(result)).toEqual(['@alice', '@bob', '@carol']);
    });

    it('associates a retry subset with its own round and keeps untried deliveries', async () => {
        const h = harness();

        await connect(h);

        const core = h.runtime().core;

        h.setPublish(async () => RETRYABLE);

        const first = await core.publish(request, h.ctx('p1')) as PreparedResult;

        await core.publish({ type: 'execute', approvalToken: first.approvalToken }, h.ctx());

        const retry = await core.publish({
            type: 'retry', retryOf: first.operationId,
            targets: [{ provider: 'fake', connection: 'conn_bob' }],
        }, h.ctx('p2')) as PreparedResult;

        h.setPublish(async () => ({ status: 'succeeded', remoteId: 'remote' }));

        const result = await core.publish({
            type: 'execute', approvalToken: retry.approvalToken,
        }, h.ctx()) as ExecutionResult;

        // The retried subset keeps the original serial order, untried targets
        // keep their earlier outcome and snapshot.
        expect(result.deliveries.map(d => d.account.accountId)).toEqual(['alice', 'bob', 'carol']);
        expect(result.deliveries.map(d => d.outcome?.status)).toEqual(['failed', 'succeeded', 'failed']);
        expect(result.deliveries.map(d => d.attempts)).toEqual([1, 2, 1]);
        expect(texts(result)).toEqual(['alpha', 'beta', 'gamma']);
        expect(names(result)).toEqual(['@alice', '@bob', '@carol']);
    });

    it('associates each retried delivery with its own round presentation across two retries', async () => {
        const h = harness();

        await connect(h);

        const core = h.runtime().core;

        const verifyWith = (suffix: Readonly<Record<string, string>>) =>
            async (credentials: { token?: string }) => {
                const accountId = String(credentials.token);

                return {
                    account: { provider: 'fake', accountId, origin: 'https://social.example' },
                    evidence: [] as const,
                    presentation: {
                        accountName: `@${accountId}${suffix[accountId] ?? ''}`,
                        profileUrl: `https://social.example/@${accountId}${suffix[accountId] ?? ''}`,
                    },
                };
            };

        // Round 0 freezes the original names for all three deliveries.
        h.plugin.connect.verify = verifyWith({}) as typeof h.plugin.connect.verify;
        h.setPublish(async () => RETRYABLE);
        const first = await core.publish(request, h.ctx('p1')) as PreparedResult;
        await core.publish({ type: 'execute', approvalToken: first.approvalToken }, h.ctx());

        // Round 1 renames only bob, so only bob's delivery may carry `-r2`.
        h.plugin.connect.verify = verifyWith({ bob: '-r2' }) as typeof h.plugin.connect.verify;
        const second = await core.publish({
            type: 'retry', retryOf: first.operationId,
            targets: [{ provider: 'fake', connection: 'conn_bob' }],
        }, h.ctx('p2')) as PreparedResult;
        h.setPublish(async () => ({ status: 'succeeded', remoteId: 'remote' }));
        await core.publish({ type: 'execute', approvalToken: second.approvalToken }, h.ctx());

        // Round 2 renames only carol, so only carol's delivery may carry `-r3`.
        h.plugin.connect.verify = verifyWith({ carol: '-r3' }) as typeof h.plugin.connect.verify;
        const third = await core.publish({
            type: 'retry', retryOf: first.operationId,
            targets: [{ provider: 'fake', connection: 'conn_carol' }],
        }, h.ctx('p3')) as PreparedResult;

        const result = await core.publish({
            type: 'execute', approvalToken: third.approvalToken,
        }, h.ctx()) as ExecutionResult;

        // A wrong-round association (round 0 for every delivery, or the newest
        // round for every delivery) fails these three names.
        expect(names(result)).toEqual(['@alice', '@bob-r2', '@carol-r3']);
        expect(result.deliveries.map(d => d.outcome?.status))
            .toEqual(['failed', 'succeeded', 'succeeded']);
        // The frozen content still comes from the immutable round-0 freeze.
        expect(texts(result)).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('keeps a stopped round on its own frozen snapshot for every delivery', async () => {
        // The abort lands after bob's outcome is durable, so bob succeeds and
        // carol is stopped before it is ever claimed.
        let armed = false;
        let recorded = 0;
        const controller = new AbortController();
        const h = harness({
            fault: (method, when) => {
                if (armed && method === 'recordOutcome' && when === 'after') {
                    recorded += 1;

                    if (recorded === 1) {
                        controller.abort();
                    }
                }
            },
        });

        await connect(h);

        const core = h.runtime().core;

        h.setPublish(async () => RETRYABLE);

        const first = await core.publish(request, h.ctx('p1')) as PreparedResult;

        await core.publish({ type: 'execute', approvalToken: first.approvalToken }, h.ctx());

        // The retry picks a reversed subset; bob finishes first and the round
        // then stops before carol is claimed.
        const retry = await core.publish({
            type: 'retry', retryOf: first.operationId,
            targets: [
                { provider: 'fake', connection: 'conn_carol' },
                { provider: 'fake', connection: 'conn_bob' },
            ],
        }, h.ctx('p2')) as PreparedResult;

        h.setPublish(async () => ({ status: 'succeeded', remoteId: 'remote' }));
        armed = true;

        const result = await core.publish({
            type: 'execute', approvalToken: retry.approvalToken,
        }, { ...h.ctx(), signal: controller.signal }) as ExecutionResult;

        expect(result.deliveries.map(d => `${d.account.accountId}:${d.outcome?.status}`))
            .toEqual(['alice:failed', 'bob:succeeded', 'carol:not_started']);
        expect(texts(result)).toEqual(['alpha', 'beta', 'gamma']);
        expect(names(result)).toEqual(['@alice', '@bob', '@carol']);
    });

    it('never projects a prepared-but-unadmitted retry as if it ran', async () => {
        const h = harness();

        await connect(h);

        const core = h.runtime().core;

        h.setPublish(async () => RETRYABLE);

        const first = await core.publish(request, h.ctx('p1')) as PreparedResult;

        await core.publish({ type: 'execute', approvalToken: first.approvalToken }, h.ctx());
        await core.publish({
            type: 'retry', retryOf: first.operationId,
            targets: [{ provider: 'fake', connection: 'conn_alice' }],
        }, h.ctx('p2'));

        const op = h.state.operations.get(first.operationId) as OperationRecord;

        expect(op.preparedRetry).toBeDefined();

        const projected = await projectExecution(h.state, op);

        expect(projected.deliveries.map(d => d.outcome?.status)).toEqual(['failed', 'failed', 'failed']);
        expect(texts(projected)).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('recovers a legacy snapshot from its only round without rewriting the record', async () => {
        const h = harness();

        await connect(h);
        h.setPublish(async () => ({ status: 'succeeded', remoteId: 'remote' }));

        const core = h.runtime().core;
        const prepared = await core.publish(request, h.ctx('p1')) as PreparedResult;

        await core.publish({ type: 'execute', approvalToken: prepared.approvalToken }, h.ctx());

        const op = h.state.operations.get(prepared.operationId) as OperationRecord;

        // Simulate a record written before the round marker existed.
        for (const delivery of op.deliveries) {
            delete delivery.previewRevision;
        }

        const before = JSON.stringify(op);
        const projected = await projectExecution(h.state, op);

        expect(texts(projected)).toEqual(['alpha', 'beta', 'gamma']);
        expect(names(projected)).toEqual(['@alice', '@bob', '@carol']);
        // The projection is read-only: the stored record is byte-identical.
        expect(JSON.stringify(h.state.operations.get(prepared.operationId))).toBe(before);
    });

    it('shows an unavailable preview when a legacy round cannot be proven', async () => {
        // Round 0 records bob's failure and then stops carol unclaimed, so a
        // later retry of bob leaves carol's round unprovable once the record
        // predates the round marker.
        let recorded = 0;
        const controller = new AbortController();
        const h = harness({
            fault: (method, when) => {
                if (method === 'recordOutcome' && when === 'after') {
                    recorded += 1;

                    if (recorded === 2) {
                        controller.abort();
                    }
                }
            },
        });

        await connect(h);

        const core = h.runtime().core;

        h.setPublish(async () => RETRYABLE);

        const first = await core.publish(request, h.ctx('p1')) as PreparedResult;

        await core.publish({
            type: 'execute', approvalToken: first.approvalToken,
        }, { ...h.ctx(), signal: controller.signal });

        // Bob is retried in round 1; carol was stopped in round 0 without a
        // claim, so its round is no longer provable from persisted evidence.
        const retry = await core.publish({
            type: 'retry', retryOf: first.operationId,
            targets: [{ provider: 'fake', connection: 'conn_bob' }],
        }, h.ctx('p2')) as PreparedResult;

        h.setPublish(async () => ({ status: 'succeeded', remoteId: 'remote' }));

        await core.publish({ type: 'execute', approvalToken: retry.approvalToken }, h.ctx());

        const op = h.state.operations.get(first.operationId) as OperationRecord;

        for (const delivery of op.deliveries) {
            delete delivery.previewRevision;
        }

        const projected = await projectExecution(h.state, op);
        const [alice, bob, carol] = projected.deliveries;

        expect(bob?.preview?.content.text).toBe('beta');
        expect(bob?.presentation?.accountName).toBe('@bob');
        // The outcome and identity survive even when the snapshot cannot.
        expect(carol?.outcome?.status).toBe('not_started');
        expect(carol?.preview).toBeUndefined();
        expect(carol?.presentation).toBeUndefined();
        expect(alice?.preview?.content.text).toBe('alpha');
    });

    it('never attributes a legacy retried delivery to a superseded round before its claim', async () => {
        // A retry admission resets the selected delivery to ready with no
        // claim. A record written before the round marker existed has history
        // from the earlier attempt, but the delivery now belongs to the newly
        // admitted round, so the projection must show that round's snapshot.
        const h = harness({ async: true });
        const core = h.runtime().core;

        await connect(h);
        h.setPublish(async () => RETRYABLE);

        const first = await core.publish(request, h.ctx('p1')) as PreparedResult;

        // Admit round 0 without running it, then run it explicitly.
        await core.publish({ type: 'execute', approvalToken: first.approvalToken }, h.ctx());
        await runRound(h, first.operationId, 0);

        // Only bob is retried, with a distinguishable presentation, so a wrong
        // round association is visible in the projected account name.
        h.plugin.connect.verify = async credentials => ({
            account: {
                provider: 'fake', accountId: String(credentials.token), origin: 'https://social.example',
            },
            evidence: [],
            presentation: {
                accountName: `@${String(credentials.token)}-round1`,
                profileUrl: `https://social.example/@${String(credentials.token)}-round1`,
            },
        });

        const retry = await core.publish({
            type: 'retry', retryOf: first.operationId,
            targets: [{ provider: 'fake', connection: 'conn_bob' }],
        }, h.ctx('p2')) as PreparedResult;

        // The durable-async admit commits round 1 and returns before the
        // executor runs, leaving bob ready with no claim.
        await core.publish({ type: 'execute', approvalToken: retry.approvalToken }, h.ctx());

        const op = h.state.operations.get(first.operationId) as OperationRecord;

        expect(op.executionRevision).toBe(1);

        for (const delivery of op.deliveries) {
            delete delivery.previewRevision;
        }

        const before = JSON.stringify(op);
        const projected = await projectExecution(h.state, op);

        // Alice and carol keep their round-0 snapshots; bob shows round 1, not
        // the last completed attempt's round-0 history.
        expect(names(projected)).toEqual(['@alice', '@bob-round1', '@carol']);
        expect(JSON.stringify(h.state.operations.get(first.operationId))).toBe(before);
    });

    it('never uses a superseded attempt as proof for a legacy delivery stopped before its retry claim', async () => {
        const h = harness({ async: true });
        const core = h.runtime().core;

        await connect(h);
        h.setPublish(async () => RETRYABLE);

        const first = await core.publish(request, h.ctx('p1')) as PreparedResult;

        // Admit round 0 without running it, then run it explicitly.
        await core.publish({ type: 'execute', approvalToken: first.approvalToken }, h.ctx());
        await runRound(h, first.operationId, 0);

        h.plugin.connect.verify = async credentials => ({
            account: {
                provider: 'fake', accountId: String(credentials.token), origin: 'https://social.example',
            },
            evidence: [],
            presentation: {
                accountName: `@${String(credentials.token)}-round1`,
                profileUrl: `https://social.example/@${String(credentials.token)}-round1`,
            },
        });

        const retry = await core.publish({
            type: 'retry', retryOf: first.operationId,
            targets: [{ provider: 'fake', connection: 'conn_bob' }],
        }, h.ctx('p2')) as PreparedResult;

        await core.publish({ type: 'execute', approvalToken: retry.approvalToken }, h.ctx());

        // Round 1 stops before bob is claimed, so bob becomes settled/not_started
        // and history still holds only the round-0 failure. The old history must
        // not be mistaken for the current round.
        const aborted = new AbortController();

        aborted.abort();
        await runRound(h, first.operationId, 1, aborted.signal);

        const op = h.state.operations.get(first.operationId) as OperationRecord;
        const bobLegacy = op.deliveries.find(delivery => delivery.connectionId === 'conn_bob') as DeliveryRecord;

        expect(bobLegacy.state).toBe('settled');
        expect(bobLegacy.outcome?.status).toBe('not_started');
        expect(bobLegacy.history).toHaveLength(1);

        for (const delivery of op.deliveries) {
            delete delivery.previewRevision;
        }

        const before = JSON.stringify(op);
        const projected = await projectExecution(h.state, op);

        expect(names(projected)).toEqual(['@alice', '@bob-round1', '@carol']);
        expect(JSON.stringify(h.state.operations.get(first.operationId))).toBe(before);
    });

    it('never guesses a legacy snapshot for a delivery a later round stopped but never named', async () => {
        const h = harness({ async: true });
        const core = h.runtime().core;

        await connect(h);
        h.setPublish(async () => RETRYABLE);

        const first = await core.publish(request, h.ctx('p1')) as PreparedResult;

        await core.publish({ type: 'execute', approvalToken: first.approvalToken }, h.ctx());
        await runRound(h, first.operationId, 0);

        // Round 1 retries carol only, then stops before carol is ever claimed.
        const carolRetry = await core.publish({
            type: 'retry', retryOf: first.operationId,
            targets: [{ provider: 'fake', connection: 'conn_carol' }],
        }, h.ctx('p2')) as PreparedResult;

        await core.publish({ type: 'execute', approvalToken: carolRetry.approvalToken }, h.ctx());

        const stopped = new AbortController();

        stopped.abort();
        await runRound(h, first.operationId, 1, stopped.signal);

        // Round 2 retries bob only, so the stopped carol is not a member of the
        // admitted round and its history still names round 0.
        const bobRetry = await core.publish({
            type: 'retry', retryOf: first.operationId,
            targets: [{ provider: 'fake', connection: 'conn_bob' }],
        }, h.ctx('p3')) as PreparedResult;

        await core.publish({ type: 'execute', approvalToken: bobRetry.approvalToken }, h.ctx());

        const op = h.state.operations.get(first.operationId) as OperationRecord;
        const carol = op.deliveries.find(delivery => delivery.connectionId === 'conn_carol') as DeliveryRecord;

        expect(op.executionRevision).toBe(2);
        expect(carol.state).toBe('settled');
        expect(carol.outcome?.status).toBe('not_started');
        expect(carol.history.map(item => item.claim.executionRevision)).toEqual([0]);

        for (const delivery of op.deliveries) {
            delete delivery.previewRevision;
        }

        const before = JSON.stringify(op);
        const projected = await projectExecution(h.state, op);

        // Round 0 cannot stand in for carol's stopped round, so carol reports no
        // snapshot at all. Alice's own outcome still proves her round-0 attempt,
        // and bob is a member of the round that is still admitted.
        expect(texts(projected)).toEqual(['alpha', 'beta', undefined]);
        expect(projected.deliveries[2]?.presentation).toBeUndefined();
        expect(JSON.stringify(h.state.operations.get(first.operationId))).toBe(before);
    });

    it('never guesses a legacy snapshot when the admitted round has no stored intent', async () => {
        const h = harness({ async: true });
        const core = h.runtime().core;

        await connect(h);
        h.setPublish(async () => RETRYABLE);

        const first = await core.publish(request, h.ctx('p1')) as PreparedResult;

        await core.publish({ type: 'execute', approvalToken: first.approvalToken }, h.ctx());
        await runRound(h, first.operationId, 0);

        const op = h.state.operations.get(first.operationId) as OperationRecord;

        for (const delivery of op.deliveries) {
            delete delivery.previewRevision;
        }

        // A waiting delivery whose admitted round cannot be read at all: the
        // store has no intent for this revision. Its own state carries no
        // outcome, so only a guess could produce a snapshot.
        const carol = op.deliveries.find(delivery => delivery.connectionId === 'conn_carol') as DeliveryRecord;

        carol.state = 'ready';
        carol.outcome = null;
        op.executionRevision = 7;

        const before = JSON.stringify(op);
        const projected = await projectExecution(h.state, op);

        // The two settled failures are still proven by their own outcome plus
        // the round-0 history entry; the waiting delivery reports nothing.
        expect(texts(projected)).toEqual(['alpha', 'beta', undefined]);
        expect(projected.deliveries[2]?.presentation).toBeUndefined();
        expect(JSON.stringify(h.state.operations.get(first.operationId))).toBe(before);
    });

    it('never guesses a legacy snapshot for a stopped delivery when the admitted round has no stored intent', async () => {
        const h = harness({ async: true });
        const core = h.runtime().core;

        await connect(h);
        h.setPublish(async () => RETRYABLE);

        const first = await core.publish(request, h.ctx('p1')) as PreparedResult;

        await core.publish({ type: 'execute', approvalToken: first.approvalToken }, h.ctx());
        await runRound(h, first.operationId, 0);

        const op = h.state.operations.get(first.operationId) as OperationRecord;

        for (const delivery of op.deliveries) {
            delete delivery.previewRevision;
        }

        // A delivery the admitted round stopped before claiming: settled with a
        // synthetic not_started outcome whose history still holds only the
        // round-0 failure, and no readable intent for the admitted revision.
        const carol = op.deliveries.find(delivery => delivery.connectionId === 'conn_carol') as DeliveryRecord;

        carol.state = 'settled';
        carol.outcome = { status: 'not_started', disposition: 'not_applied', reason: 'cancelled_before_start' };
        op.executionRevision = 7;

        const before = JSON.stringify(op);
        const projected = await projectExecution(h.state, op);

        // The not_started outcome was written without a matching history entry,
        // so the superseded round-0 attempt cannot stand in for it.
        expect(texts(projected)).toEqual(['alpha', 'beta', undefined]);
        expect(projected.deliveries[2]?.presentation).toBeUndefined();
        expect(JSON.stringify(h.state.operations.get(first.operationId))).toBe(before);
    });

    it('never guesses a legacy snapshot for a waiting non-member of the admitted round', async () => {
        const h = harness({ async: true });
        const core = h.runtime().core;

        await connect(h);
        h.setPublish(async () => RETRYABLE);

        const first = await core.publish(request, h.ctx('p1')) as PreparedResult;

        await core.publish({ type: 'execute', approvalToken: first.approvalToken }, h.ctx());
        await runRound(h, first.operationId, 0);

        // Round 1 retries bob only, so carol is not a member of the admitted
        // round even though the intent for that revision exists.
        const bobRetry = await core.publish({
            type: 'retry', retryOf: first.operationId,
            targets: [{ provider: 'fake', connection: 'conn_bob' }],
        }, h.ctx('p2')) as PreparedResult;

        await core.publish({ type: 'execute', approvalToken: bobRetry.approvalToken }, h.ctx());

        const op = h.state.operations.get(first.operationId) as OperationRecord;

        for (const delivery of op.deliveries) {
            delete delivery.previewRevision;
        }

        const carol = op.deliveries.find(delivery => delivery.connectionId === 'conn_carol') as DeliveryRecord;

        carol.state = 'ready';
        carol.outcome = null;

        const before = JSON.stringify(op);
        const projected = await projectExecution(h.state, op);

        // carol is neither claimed nor admitted in the current round, and it
        // carries no outcome, so nothing proves a snapshot for it.
        expect(texts(projected)).toEqual(['alpha', 'beta', undefined]);
        expect(projected.deliveries[2]?.presentation).toBeUndefined();
        expect(JSON.stringify(h.state.operations.get(first.operationId))).toBe(before);
    });

    it('projects execute, replay and status identically without extra provider calls', async () => {
        const h = harness();

        await connect(h);
        h.setPublish(async () => ({ status: 'succeeded', remoteId: 'remote' }));

        const core = h.runtime().core;
        const prepared = await core.publish(request, h.ctx('p1')) as PreparedResult;
        const first = await core.publish({
            type: 'execute', approvalToken: prepared.approvalToken,
        }, h.ctx()) as ExecutionResult;
        const writes = h.writes.length;
        const metrics = h.metrics();

        const replay = await core.publish({
            type: 'execute', approvalToken: prepared.approvalToken,
        }, h.ctx()) as ExecutionResult;
        const reprepare = await core.publish(request, h.ctx('p1')) as ExecutionResult;
        const status = await core.status({ type: 'operation', operationId: prepared.operationId }, h.ctx());

        expect(replay.deliveries).toEqual(first.deliveries);
        expect(reprepare.deliveries).toEqual(first.deliveries);
        expect(status.operation).toEqual(first);
        expect(h.writes).toHaveLength(writes);
        expect(h.metrics()).toEqual(metrics);
    });
});
