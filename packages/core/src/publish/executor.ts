import type * as T from '../domain/records.js';
import { clone, deepFreeze, executionView, unknownOutcome } from '../domain/rules.js';
import { fail } from '../protocol/validation.js';
import { validateWire } from '../protocol/generated/validators.js';
import { checkBinding, checkImplementation, checkLoaded, credential, verifyIntent } from '../runtime-helpers.js';
export function createExecutor(deps: T.CoreDependencies): T.Executor {
    return {
        async run(work, signal) {
            // Executor capability is internal and bound to one state scope. Queue ingress
            // must authenticate its routing context before invoking this capability.
            const intent = await deps.state.getExecutionIntent(work);
            if (!intent)
                fail('NOT_FOUND');
            await verifyIntent(deps, intent);
            let op = await deps.state.getOperation(work.operationId, intent.principalId);
            if (!op)
                fail('NOT_FOUND');
            if (op.phase !== 'execution')
                fail('STALE_INTENT');
            if (op.executionRevision !== work.executionRevision)
                return executionView(op);
            const inFlight = op.deliveries.find(d => d.state === 'in_flight');
            if (inFlight) {
                if (inFlight.claim!.expiresAt <= deps.clock.now()) {
                    const recovered = await deps.state.recoverInterrupted({
                        work, expectedVersion: op.version, now: deps.clock.now()
                    });
                    if (recovered.type !== 'conflict')
                        op = recovered.value;
                }
                return executionView(op);
            }
            for (const target of intent.targets) {
                op = await deps.state.getOperation(work.operationId, intent.principalId);
                if (!op)
                    fail('NOT_FOUND');
                if (op.executionRevision !== work.executionRevision || op.deliveries.some(d => d.state === 'in_flight'))
                    return executionView(op);
                const delivery = op.deliveries.find(d => d.deliveryId === target.deliveryId);
                if (delivery?.state !== 'ready')
                    continue;
                if (signal.aborted) {
                    const stopped = await deps.state.stopUnstarted({
                        work, expectedVersion: op.version, outcome: {
                            status: 'not_started', disposition: 'not_applied', reason: 'cancelled_before_start'
                        }, now: deps.clock.now()
                    });
                    return executionView(stopped.type === 'conflict' ? op : stopped.value);
                }
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
                    const stopped = await deps.state.stopUnstarted({
                        work, expectedVersion: op.version, outcome: {
                            status: 'not_started', disposition: 'not_applied', reason: 'stale_binding'
                        }, now: deps.clock.now()
                    });
                    return executionView(stopped.type === 'conflict' ? op : stopped.value);
                }
                if (signal.aborted) {
                    const stopped = await deps.state.stopUnstarted({
                        work, expectedVersion: op.version, outcome: {
                            status: 'not_started', disposition: 'not_applied', reason: 'cancelled_before_start'
                        }, now: deps.clock.now()
                    });
                    return executionView(stopped.type === 'conflict' ? op : stopped.value);
                }
                const claim = await deps.state.claimDelivery({
                    work, deliveryId: target.deliveryId, expectedVersion: op.version, claimId: deps.entropy.id('claim'), ownerId: deps.entropy.id('executor'), submissionId: deps.entropy.id('submit'), now: deps.clock.now()
                });
                // CAS loss is a competing executor, not permission to skip to target2.
                if (!claim)
                    return executionView((await deps.state.getOperation(work.operationId, intent.principalId))!);
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
                    validateWire('ProviderWriteOutcome', result);
                    outcome = result;
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
                        return executionView((await deps.state.getOperation(work.operationId, intent.principalId))!);
                    op = recorded.value;
                }
                catch {
                    // Do not proceed to another target after the persistence boundary fails.
                    return {
                        ...executionView(op), status: 'unknown', durabilityWarning: 'OUTCOME_NOT_DURABLE'
                    };
                }
                if (abort.aborted) {
                    const stopped = await deps.state.stopUnstarted({
                        work, expectedVersion: op.version, outcome: {
                            status: 'not_started', disposition: 'not_applied', reason: 'execution_interrupted'
                        }, now: deps.clock.now()
                    });
                    return executionView(stopped.type === 'conflict' ? op : stopped.value);
                }
            }
            return executionView((await deps.state.getOperation(work.operationId, intent.principalId))!);
        }
    };
}
