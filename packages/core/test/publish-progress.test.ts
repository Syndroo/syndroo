import { describe, expect, it } from 'vitest';
import type {
    ExecutionProgress,
    ExecutionResult,
    PreparedResult,
    PrepareRequest,
} from '../src/domain/records.js';
import { harness } from '../../../tests/fixtures/state/harness.js';

/**
 * PUB-PROGRESS: the executor reports lightweight, runtime-agnostic progress.
 * Every event describes committed state, a lost claim never announces
 * "publishing", and a failed outcome write never announces a reliably
 * successful post. A consumer callback is isolated from publishing.
 */

type H = ReturnType<typeof harness>;

const TARGETS = [
    { connection: 'conn_alice', account: 'alice', text: 'alpha' },
    { connection: 'conn_bob', account: 'bob', text: 'beta' },
] as const;

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(resolved => {
        resolve = resolved;
    });

    return { promise, resolve };
}

async function waitFor(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
        if (check()) {
            return;
        }

        await new Promise(resolved => setTimeout(resolved, 1));
    }

    throw new Error('condition was never met');
}

const types = (events: readonly ExecutionProgress[]): string[] => events.map(event => event.type);

const states = (result: ExecutionResult): string[] =>
    result.deliveries.map(delivery => `${delivery.account.accountId}:${delivery.state}`);

describe('PUB-PROGRESS post-commit execution observations', () => {
    it('reports Publishing for the claimed target and Waiting for the rest, in real serial order', async () => {
        const h = harness();

        await connect(h);

        const gate = deferred<void>();
        const order: string[] = [];

        h.setPublish(async input => {
            order.push(input.account.accountId);

            if (input.account.accountId === 'alice') {
                await gate.promise;
            }

            return { status: 'succeeded', remoteId: 'remote' };
        });

        const core = h.runtime().core;
        const prepared = await core.publish(request, h.ctx('p1')) as PreparedResult;
        const events: ExecutionProgress[] = [];
        const running = core.publish({
            type: 'execute', approvalToken: prepared.approvalToken,
        }, { ...h.ctx(), onProgress: event => events.push(event) }) as Promise<ExecutionResult>;

        await waitFor(() => order.includes('alice'));

        // The first target holds its claim while its provider call is blocked;
        // the second has not started. Neither fact is guessed from a timer.
        expect(types(events)).toEqual(['admitted', 'claimed']);
        expect(states(events.at(-1)!.execution)).toEqual(['alice:in_flight', 'bob:ready']);

        gate.resolve();

        const result = await running;

        expect(order).toEqual(['alice', 'bob']);
        expect(result.deliveries.map(delivery => delivery.attempts)).toEqual([1, 1]);
        expect(h.writes).toHaveLength(2);
        expect(types(events)).toEqual([
            'admitted', 'claimed', 'recorded', 'claimed', 'recorded', 'finished',
        ]);
        expect(events.at(-1)!.execution).toEqual(result);
    });

    it('isolates a throwing progress callback from the publish outcome', async () => {
        const h = harness();

        await connect(h);
        h.setPublish(async () => ({ status: 'succeeded', remoteId: 'remote' }));

        const core = h.runtime().core;
        const prepared = await core.publish(request, h.ctx('p1')) as PreparedResult;
        const seen: string[] = [];
        const result = await core.publish({
            type: 'execute', approvalToken: prepared.approvalToken,
        }, {
            ...h.ctx(),
            onProgress: event => {
                seen.push(event.type);
                throw new Error('consumer bug');
            },
        }) as ExecutionResult;

        expect(result.status).toBe('succeeded');
        expect(result.deliveries.every(delivery => delivery.outcome?.status === 'succeeded')).toBe(true);
        expect(h.writes).toHaveLength(2);
        expect(seen).toContain('claimed');
        expect(seen).toContain('recorded');
    });

    it('does not announce Publishing when the claim is lost to a competing executor', async () => {
        const h = harness();

        await connect(h);
        h.setPublish(async () => {
            throw new Error('must not publish');
        });
        h.state.claimDelivery = async () => null;

        const core = h.runtime().core;
        const prepared = await core.publish(request, h.ctx('p1')) as PreparedResult;
        const events: ExecutionProgress[] = [];
        const result = await core.publish({
            type: 'execute', approvalToken: prepared.approvalToken,
        }, { ...h.ctx(), onProgress: event => events.push(event) }) as ExecutionResult;

        expect(types(events)).toEqual(['admitted', 'finished']);
        expect(states(result)).toEqual(['alice:ready', 'bob:ready']);
        expect(result.status).toBe('pending');
        expect(h.writes).toHaveLength(0);
    });

    it('withholds a recorded event and stops the round when the outcome cannot be persisted', async () => {
        const h = harness();

        await connect(h);
        h.setPublish(async () => ({ status: 'succeeded', remoteId: 'remote' }));
        h.state.recordOutcome = async () => {
            throw new Error('disk full');
        };

        const core = h.runtime().core;
        const prepared = await core.publish(request, h.ctx('p1')) as PreparedResult;
        const events: ExecutionProgress[] = [];
        const result = await core.publish({
            type: 'execute', approvalToken: prepared.approvalToken,
        }, { ...h.ctx(), onProgress: event => events.push(event) }) as ExecutionResult;

        expect(types(events)).toEqual(['admitted', 'claimed', 'finished']);
        expect(types(events)).not.toContain('recorded');
        expect(result.durabilityWarning).toBe('OUTCOME_NOT_DURABLE');
        expect(result.status).toBe('unknown');
        expect(events.at(-1)!.execution.durabilityWarning).toBe('OUTCOME_NOT_DURABLE');
        // The round stops at the persistence boundary: bob is never sent.
        expect(h.writes).toHaveLength(1);
    });

    it('reports the real in-flight state when the outcome write fails', async () => {
        const h = harness();

        await connect(h);
        h.setPublish(async () => ({ status: 'succeeded', remoteId: 'remote' }));
        h.state.recordOutcome = async () => {
            throw new Error('disk full');
        };

        const core = h.runtime().core;
        const prepared = await core.publish(request, h.ctx('p1')) as PreparedResult;
        const result = await core.publish({
            type: 'execute', approvalToken: prepared.approvalToken,
        }, h.ctx()) as ExecutionResult;

        expect(result.durabilityWarning).toBe('OUTCOME_NOT_DURABLE');
        expect(result.status).toBe('unknown');
        // The claim succeeded and the store still holds it, so the reliability
        // view must not fall back to the stale pre-claim record.
        expect(result.deliveries.map(delivery => [delivery.connectionId, delivery.state, delivery.attempts]))
            .toEqual([['conn_alice', 'in_flight', 1], ['conn_bob', 'ready', 0]]);
    });

    it('keeps the reliability warning when the presentation read also fails', async () => {
        const h = harness();

        await connect(h);
        h.setPublish(async () => ({ status: 'succeeded', remoteId: 'remote' }));

        // The outcome write fails, and every later read of the freshest record
        // or the frozen intent fails too. The warning must survive: a failing
        // optional presentation read can never become an ordinary durability
        // error or hide that a post may have been sent.
        let broken = false;
        const originalGetOperation = h.state.getOperation.bind(h.state);
        h.state.getOperation = (async (...args: Parameters<H['state']['getOperation']>) => {
            if (broken)
                throw new Error('store offline');
            return originalGetOperation(...args);
        }) as H['state']['getOperation'];
        const originalGetIntent = h.state.getIntent.bind(h.state);
        h.state.getIntent = (async (...args: Parameters<H['state']['getIntent']>) => {
            if (broken)
                throw new Error('store offline');
            return originalGetIntent(...args);
        }) as H['state']['getIntent'];
        h.state.recordOutcome = async () => {
            broken = true;
            throw new Error('disk full');
        };

        const core = h.runtime().core;
        const prepared = await core.publish(request, h.ctx('p1')) as PreparedResult;
        const result = await core.publish({
            type: 'execute', approvalToken: prepared.approvalToken,
        }, h.ctx()) as ExecutionResult;

        expect(result.durabilityWarning).toBe('OUTCOME_NOT_DURABLE');
        expect(result.status).toBe('unknown');
        expect(result.deliveries.map(delivery => [delivery.connectionId, delivery.state, delivery.attempts]))
            .toEqual([['conn_alice', 'in_flight', 1], ['conn_bob', 'ready', 0]]);
        expect(h.writes).toHaveLength(1);
    });

    it('contains an async progress consumer that rejects', async () => {
        const h = harness();

        await connect(h);
        h.setPublish(async () => ({ status: 'succeeded', remoteId: 'remote' }));

        const core = h.runtime().core;
        const prepared = await core.publish(request, h.ctx('p1')) as PreparedResult;
        const events: ExecutionProgress[] = [];
        const result = await core.publish({
            type: 'execute', approvalToken: prepared.approvalToken,
        }, {
            ...h.ctx(),
            onProgress: async event => {
                events.push(event);
                if (event.type === 'recorded') {
                    throw new Error('consumer died');
                }
            },
        }) as ExecutionResult;

        // A rejected consumer promise is contained like a synchronous throw:
        // the post stays succeeded, the round finishes, and nothing is re-sent.
        expect(result.status).toBe('succeeded');
        expect(types(events)).toEqual(['admitted', 'claimed', 'recorded', 'claimed', 'recorded', 'finished']);
        expect(h.writes).toHaveLength(2);
    });

    it('announces a stopped round when the signal aborts after admission', async () => {
        const controller = new AbortController();
        const h = harness({
            fault: (method: string, when: 'before' | 'after') => {
                if (method === 'admitExecution' && when === 'after') {
                    controller.abort();
                }
            },
        });

        await connect(h);
        h.setPublish(async () => ({ status: 'succeeded', remoteId: 'remote' }));

        const core = h.runtime().core;
        const prepared = await core.publish(request, h.ctx('p1')) as PreparedResult;
        const events: ExecutionProgress[] = [];
        const result = await core.publish({
            type: 'execute', approvalToken: prepared.approvalToken,
        }, { ...h.ctx(), signal: controller.signal, onProgress: event => events.push(event) }) as ExecutionResult;

        expect(types(events)).toEqual(['admitted', 'stopped', 'finished']);
        expect(result.deliveries.map(delivery => delivery.outcome?.status))
            .toEqual(['not_started', 'not_started']);
        expect(h.writes).toHaveLength(0);
    });
});
