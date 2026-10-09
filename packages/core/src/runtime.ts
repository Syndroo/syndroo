import type * as T from './domain/records.js';
import { clone, executionView } from './domain/rules.js';
import { validateRequest } from './protocol/input.js';
import { assertJson, fail, ProtocolError } from './protocol/validation.js';
import { validateWire } from './protocol/generated/validators.js';
import { connect } from './connect/connect.js';
import { prepare } from './publish/prepare.js';
import { createExecutor } from './publish/executor.js';
import { status } from './status/status.js';
import { checkBinding, checkImplementation, checkLoaded, frozenPayload, resolveConnection, verifyIntent } from './runtime-helpers.js';
export function createCore(deps: T.CoreDependencies): {
    core: T.Core;
    executor: T.Executor;
} {
    const executor = createExecutor(deps);
    async function boundary<R>(work: () => Promise<R>): Promise<R> {
        try {
            return await work();
        }
        catch (error) {
            if (error instanceof ProtocolError)
                throw error;
            return fail('DURABILITY_ERROR');
        }
    }
    async function publish(request: T.PublishRequest, ctx: T.CallContext): Promise<T.PublishResult> {
        validateRequest('publish', request);
        if (!ctx.principalId)
            fail('FORBIDDEN');
        if (request.type !== 'execute')
            return prepare(deps, clone(request), ctx);
        const approvalDigest = await deps.digests.sensitive({
            approvalToken: request.approvalToken
        });
        const saved = await deps.state.readApproval({
            principalId: ctx.principalId, approvalDigest
        });
        if (!saved)
            fail('APPROVAL_INVALID');
        // Consumed approval is an observation, even if a newer retry exists.
        if (saved.admitted)
            return executionView(saved.operation);
        if (saved.intent.expiresAt <= deps.clock.now())
            fail('APPROVAL_EXPIRED');
        await verifyIntent(deps, saved.intent);
        if (ctx.signal.aborted)
            fail('CANCELLED');
        for (const target of saved.intent.targets) {
            const loaded = await deps.providers.load(target.implementation.provider);
            checkLoaded(target.implementation.provider, loaded);
            checkImplementation(loaded.implementation, target.implementation);
            checkBinding(await deps.state.getConnection(target.binding.connectionId), target.binding);
        }
        const admitted = await deps.state.admitExecution({
            principalId: ctx.principalId, approvalDigest, intentDigest: saved.intent.intentDigest, expectedVersion: saved.operation.version, bindings: saved.intent.targets.map(t => t.binding), now: deps.clock.now()
        });
        if (admitted.type === 'conflict') {
            const replay = await deps.state.readApproval({
                principalId: ctx.principalId, approvalDigest
            });
            if (replay?.admitted)
                return executionView(replay.operation);
            fail('STALE_INTENT');
        }
        if (admitted.type === 'replay')
            return executionView(admitted.value);
        const work = {
            operationId: admitted.value.operationId, executionRevision: admitted.value.executionRevision
        };
        if (deps.execution.type === 'durable_async') {
            try {
                await deps.execution.notifier.notify(work);
            }
            catch { /* Durable pending work remains authoritative. */
            }
            return executionView(admitted.value);
        }
        return executor.run(work, ctx.signal);
    }
    const core: T.Core = {
        connect: (request, ctx) => boundary(() => {
            validateRequest('connect', request);
            if (!ctx.principalId)
                fail('FORBIDDEN');
            return connect(deps, clone(request), ctx);
        }),
        publish: ((request: T.PublishRequest, ctx: T.CallContext) => boundary(() => publish(request, ctx))) as T.Core['publish'],
        status: <R extends T.StatusRequest>(request: R, ctx: T.CallContext) => boundary(() => {
            validateRequest('status', request);
            if (!ctx.principalId)
                fail('FORBIDDEN');
            return status(deps, request, ctx);
        })
    };
    return {
        core, executor
    };
}
export async function previewDocument(input: T.PostDocument, deps: {
    providers: T.ProviderRegistry;
    connections: readonly T.ConnectionView[];
    now: T.IsoTime;
    seed: string;
}): Promise<T.DryRunResult> {
    validateWire('PostDocument', input);
    const preview: T.TargetPreview[] = [];
    for (const [index, target] of input.targets.entries()) {
        const connection = resolveConnection(deps.connections, target.provider, target.connection);
        const loaded = await deps.providers.load(target.provider, 'read_only');
        checkLoaded(target.provider, loaded);
        const frozen = frozenPayload(loaded, {
            content: target.content ?? input.content, options: target.options ?? {}, account: connection.account, now: deps.now, seed: deps.seed + ':' + index
        });
        preview.push({
            deliveryId: 'preview_' + index, connectionId: connection.connectionId, account: clone(connection.account), provider: target.provider, preview: frozen.preview
        });
    }
    return {
        status: 'preview', preview, unverified: ['credentials', 'current_identity', 'publish_permission']
    };
}
