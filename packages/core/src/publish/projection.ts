import type * as T from '../domain/records.js';
import { aggregate, clone } from '../domain/rules.js';
import { canonicalJson } from '../protocol/validation.js';

/**
 * The one shared projection from a persisted operation to the public
 * execution view.
 *
 * Every public path that has to answer "what happened" — direct execute,
 * idempotent replay, and status — goes through here, so a caller never depends
 * on having seen a prepared response in this process.
 *
 * Each delivery's frozen preview and display snapshot come from the frozen
 * target of the round that produced its current state, associated by the
 * stable deliveryId. The round is recorded on the internal record at
 * preparation/admission time (`previewRevision`), never inferred from array
 * position, platform name or the most recent prepared intent. A record written
 * before that marker existed is resolved from persisted evidence only; when it
 * cannot be proven, the snapshot is reported as unavailable rather than
 * guessed, and nothing is written back.
 */
/**
 * Build the public execution view from a stored record alone.
 *
 * It never reads a frozen intent, so it cannot throw on an optional
 * presentation read. The reliability path uses it when a durable write failed
 * and the presentation is not available: the delivery states, attempts and
 * outcomes are still the real, persisted facts.
 */
export function projectRecord(op: T.OperationRecord): T.ExecutionResult {
    return {
        phase: 'execution',
        operationId: op.operationId,
        status: op.status ?? aggregate(op.deliveries),
        deliveries: op.deliveries.map(delivery => ({
            deliveryId: delivery.deliveryId,
            connectionId: delivery.connectionId,
            account: clone(delivery.account),
            attempts: delivery.attempts,
            outcome: clone(delivery.outcome),
            state: delivery.state
        }))
    };
}

export async function projectExecution(
    state: T.OperationStore,
    op: T.OperationRecord,
): Promise<T.ExecutionResult> {
    const intents = new Map<T.Revision, T.FrozenIntent | null>();

    async function intent(revision: T.Revision): Promise<T.FrozenIntent | null> {
        if (!intents.has(revision)) {
            intents.set(revision, await state.getIntent({
                operationId: op.operationId, executionRevision: revision,
            }, op.principalId));
        }

        return intents.get(revision) ?? null;
    }

    async function revisionOf(delivery: T.DeliveryRecord): Promise<T.Revision | undefined> {
        if (delivery.previewRevision !== undefined) {
            return delivery.previewRevision;
        }

        // Legacy record: recover the round only from evidence that proves it.
        // A live claim names its round exactly.
        if (delivery.claim) {
            return delivery.claim.executionRevision;
        }

        // Without a claim the delivery is either waiting in the currently
        // admitted round or already carries the outcome of an earlier one.
        // Membership in the admitted round's frozen targets is proof for the
        // former: a record written before the round marker existed has no other
        // way to tell a retried-but-not-yet-claimed delivery from one whose last
        // completed attempt is history.
        const admitted = await intent(op.executionRevision);

        if (
            admitted !== null &&
            admitted.targets.some(target => target.deliveryId === delivery.deliveryId)
        ) {
            return op.executionRevision;
        }

        // A delivery that is neither claimed nor part of the admitted round can
        // only be attributed to the attempt that really produced its persisted
        // state, and its own outcome is that proof: recording an outcome writes
        // the outcome and its history entry in one step, admission clears the
        // outcome, and a stop that never started writes a synthetic one without
        // touching history. While the two disagree the current state belongs to
        // a round no history entry names — a retry admitted and stopped after
        // the last completed attempt — so the snapshot stays unavailable instead
        // of being guessed from a superseded round.
        const last = delivery.history.at(-1);

        if (
            delivery.state !== 'settled' ||
            delivery.outcome === null ||
            last === undefined ||
            canonicalJson(last.outcome) !== canonicalJson(delivery.outcome)
        ) {
            return undefined;
        }

        return last.claim.executionRevision;
    }

    const deliveries: T.DeliveryResult[] = [];

    for (const delivery of op.deliveries) {
        const revision = await revisionOf(delivery);
        const frozen = revision === undefined
            ? undefined
            : (await intent(revision))?.targets.find(target => target.deliveryId === delivery.deliveryId);

        deliveries.push({
            deliveryId: delivery.deliveryId,
            connectionId: delivery.connectionId,
            account: clone(delivery.account),
            attempts: delivery.attempts,
            outcome: clone(delivery.outcome),
            state: delivery.state,
            ...(frozen === undefined ? {} : {
                preview: clone(frozen.frozen.preview),
                ...(frozen.presentation === undefined ? {} : {
                    presentation: clone(frozen.presentation),
                }),
            }),
        });
    }

    return {
        phase: 'execution',
        operationId: op.operationId,
        status: op.status ?? aggregate(op.deliveries),
        deliveries,
    };
}
