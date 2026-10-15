import type * as T from '../domain/records.js';
import { clone, deepFreeze, unknownOutcome } from '../domain/rules.js';
import { fail } from '../protocol/validation.js';
import { checkBinding, checkImplementation, checkLoaded, credential, validateWriteOutcome, verifyIntent } from '../runtime-helpers.js';
import { projectExecution, projectRecord } from './projection.js';
import { emitProgress } from './progress.js';
export function createExecutor(deps: T.CoreDependencies): T.Executor {
    return {
        async run(work, signal, onProgress) {
            // Executor capability is internal and bound to one state scope. Queue ingress
            // must authenticate its routing context before invoking this capability.
            const intent = await deps.state.getExecutionIntent(work);
            if (!intent)
                fail('NOT_FOUND');
            await verifyIntent(deps, intent);
            let op = await deps.state.getOperation(work.operationId, intent.principalId);
            if (!op)
                fail('NOT_FOUND');
            // Progress is reported only from committed state: every event is a
            // fresh read of the stored operation, so it can never announce a
            // state that was not durably recorded.
            // The reliability view for a failed outcome write: read the latest
            // committed record when possible, otherwise reflect the successful claim.
            // Neither path reads a frozen intent, so the warning always survives.
            const durabilityWarning = async (fallback: T.OperationRecord, target: T.FrozenTarget, claim: T.Claim): Promise<T.ExecutionResult> => {
                const claimed: T.OperationRecord = {
                    ...fallback, deliveries: fallback.deliveries.map(d => d.deliveryId === target.deliveryId ? {
                        ...d, state: 'in_flight' as const, claim, attempts: claim.attempt
                    } : d)
                };
                let latest: T.OperationRecord | null = null;
                try {
                    latest = await deps.state.getOperation(fallback.operationId, intent.principalId);
                }
                catch {
                    latest = null;
                }
                const record = latest ?? claimed;
                let view: T.ExecutionResult;
                try {
                    view = await projectExecution(deps.state, record);
                }
                catch {
                    view = projectRecord(record);
                }
                return {
                    ...view, status: 'unknown', durabilityWarning: 'OUTCOME_NOT_DURABLE'
                };
            };
            const finish = async (result: T.ExecutionResult): Promise<T.ExecutionResult> => {
                await emitProgress(deps, onProgress, 'finished', work, intent.principalId, result);
                return result;
            };
            const stop = async (expectedVersion: T.Revision, reason: T.NotStarted['reason']): Promise<T.ExecutionResult> => {
                const stopped = await deps.state.stopUnstarted({
                    work, expectedVersion, outcome: {
                        status: 'not_started', disposition: 'not_applied', reason
                    }, now: deps.clock.now()
                });
                const current = stopped.type === 'conflict' ? op! : stopped.value;
                if (stopped.type !== 'conflict')
                    await emitProgress(deps, onProgress, 'stopped', work, intent.principalId);
                return finish(await projectExecution(deps.state, current));
            };
            if (op.phase !== 'execution')
                fail('STALE_INTENT');
            if (op.executionRevision !== work.executionRevision)
                return finish(await projectExecution(deps.state, op));
            const inFlight = op.deliveries.find(d => d.state === 'in_flight');
            if (inFlight) {
                if (inFlight.claim!.expiresAt <= deps.clock.now()) {
                    const recovered = await deps.state.recoverInterrupted({
                        work, expectedVersion: op.version, now: deps.clock.now()
                    });
                    if (recovered.type !== 'conflict')
                        op = recovered.value;
                }
                return finish(await projectExecution(deps.state, op));
            }
            for (const target of intent.targets) {
                op = await deps.state.getOperation(work.operationId, intent.principalId);
                if (!op)
                    fail('NOT_FOUND');
                if (op.executionRevision !== work.executionRevision || op.deliveries.some(d => d.state === 'in_flight'))
                    return finish(await projectExecution(deps.state, op));
                const delivery = op.deliveries.find(d => d.deliveryId === target.deliveryId);
                if (delivery?.state !== 'ready')
                    continue;
                if (signal.aborted)
                    return stop(op.version, 'cancelled_before_start');
                let loaded: T.LoadedProvider;
                let credentials: T.CredentialBundle;
                try {
                    loaded = await deps.providers.load(target.implementation.provider);
                    checkLoaded(target.implementation.provider, loaded);
                    checkImplementation(loaded.implementation, target.implementation);
                    const connection = await deps.state.getConnection(target.binding.connectionId);
                    checkBinding(connection, target.binding);
                    credentials = await credential(deps, connection);
                }
                catch {
                    return stop(op.version, 'stale_binding');
                }
                if (signal.aborted)
                    return stop(op.version, 'cancelled_before_start');
                const claim = await deps.state.claimDelivery({
                    work, deliveryId: target.deliveryId, expectedVersion: op.version, claimId: deps.entropy.id('claim'), ownerId: deps.entropy.id('executor'), submissionId: deps.entropy.id('submit'), now: deps.clock.now()
                });
                // CAS loss is a competing executor, not permission to skip to target2.
                // It must not produce a "publishing" observation either.
                if (!claim)
                    return finish(await projectExecution(deps.state, (await deps.state.getOperation(work.operationId, intent.principalId))!));
                await emitProgress(deps, onProgress, 'claimed', work, intent.principalId);
                let outcome: T.ProviderWriteOutcome;
                const timeout = AbortSignal.timeout(60000);
                const abort = AbortSignal.any([signal, timeout]);
                let removeAbort: () => void = () => {
                };
                try {
                    const cancelled = new Promise<never>((_resolve, reject) => {
                        const listener = () => reject(new Error('aborted'));
                        abort.addEventListener('abort', listener, {
                            once: true
                        });
                        removeAbort = () => abort.removeEventListener('abort', listener);
                        if (abort.aborted)
                            listener();
                    });
                    const result = await Promise.race([(async () => {
                            const context = {
                                ...(await deps.providerContext(target.implementation.provider, abort)), signal: abort
                            };
                            return loaded.plugin.publish({
                                frozen: deepFreeze(clone(target.frozen)), account: clone(target.binding.account), credentials, submissionId: claim.submissionId, context
                            });
                        })(), cancelled]);
                    outcome = validateWriteOutcome(result);
                }
                catch {
                    outcome = unknownOutcome();
                }
                finally {
                    removeAbort();
                }
                try {
                    const recorded = await deps.state.recordOutcome({
                        claim, outcome, now: deps.clock.now()
                    });
                    if (recorded.type === 'conflict')
                        return finish(await projectExecution(deps.state, (await deps.state.getOperation(work.operationId, intent.principalId))!));
                    op = recorded.value;
                    await emitProgress(deps, onProgress, 'recorded', work, intent.principalId);
                }
                catch {
                    // Do not proceed to another target after the persistence boundary fails.
                    // The round ends with an explicit durability warning and no
                    // "recorded" observation, so a consumer cannot mistake it for a
                    // reliably successful post. The view reflects the latest persisted
                    // record when it can be read (never the stale pre-claim record), and
                    // falls back to the successful claim. It is built without a frozen
                    // intent read, so a failing presentation read cannot replace the
                    // reliability warning with an ordinary durability error.
                    return finish(await durabilityWarning(op, target, claim));
                }
                if (abort.aborted)
                    return stop(op.version, 'execution_interrupted');
            }
            return finish(await projectExecution(deps.state, (await deps.state.getOperation(work.operationId, intent.principalId))!));
        }
    };
}
