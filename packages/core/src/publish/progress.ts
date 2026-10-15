import type * as T from '../domain/records.js';
import { clone } from '../domain/rules.js';
import { projectExecution } from './projection.js';

export type { ExecutionProgress, ProgressSink } from '../domain/records.js';

/**
 * Emit one post-commit execution observation.
 *
 * The event always carries a real projection of the stored operation, read back
 * after the write it describes, so a consumer can never be shown a state that
 * was not durably recorded. Emission is isolated from publishing: a consumer
 * callback that throws must not turn a delivered post into an unknown outcome,
 * must not trigger a second send, and must not enter the provider catch branch
 * that classifies provider failures.
 */
export async function emitProgress(
    deps: T.CoreDependencies,
    sink: T.ProgressSink | undefined,
    type: T.ExecutionProgress['type'],
    work: T.WorkRef,
    principalId: string,
    override?: T.ExecutionResult,
): Promise<void> {
    if (!sink) {
        return;
    }

    let execution = override;

    if (execution === undefined) {
        try {
            const op = await deps.state.getOperation(work.operationId, principalId);

            if (!op) {
                return;
            }

            execution = await projectExecution(deps.state, op);
        } catch {
            return;
        }
    }

    try {
        // The sink is typed as `void`, but a caller can pass an async function:
        // awaiting the returned value here would also let a slow consumer stall
        // publication. Attach a rejection handler instead, so an async callback
        // that throws is contained exactly like a synchronous one and can never
        // crash the process or change the publish outcome.
        const outcome: unknown = (sink as (event: T.ExecutionProgress) => unknown)({
            type, execution: clone(execution)
        });
        void Promise.resolve(outcome).catch(() => {
        });
    } catch {
        // A progress consumer must never change the publish outcome.
    }
}
