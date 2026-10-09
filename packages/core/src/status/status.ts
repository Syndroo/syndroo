import type * as T from '../domain/records.js';
import { clone, executionView } from '../domain/rules.js';
import { fail } from '../protocol/validation.js';
import { preview } from '../runtime-helpers.js';
export async function status<TRequest extends T.StatusRequest>(deps: T.CoreDependencies, request: TRequest, ctx: T.CallContext): Promise<T.StatusResult<TRequest>> {
    async function connectionView(c: T.ConnectionRecord): Promise<T.ConnectionView> {
        const provider = await deps.providers.describe(c.account.provider);
        return {
            connectionId: c.connectionId, account: clone(c.account), ...(c.label ? {
                label: c.label
            } : {}), isDefault: c.isDefault, active: c.active, observations: c.observations.map(o => ({
                ...clone(o), stale: o.credentialRevision !== c.credentialRevision || o.artifactFingerprint !== provider.implementation?.artifactFingerprint || o.schemaFingerprint !== provider.implementation?.schemaFingerprint || !!(o.expiresAt && o.expiresAt <= deps.clock.now())
            }))
        };
    }
    function summary(op: T.OperationRecord): T.OperationSummary {
        return {
            operationId: op.operationId, createdAt: op.createdAt, phase: op.phase === 'execution' ? 'execution' : 'prepared', ...(op.status ? {
                status: op.status
            } : {})
        };
    }
    let result: T.StatusResultMap[keyof T.StatusResultMap];
    switch (request.type) {
        case 'provider':
            result = {
                type: 'provider', provider: await deps.providers.describe(request.provider)
            };
            break;
        case 'connections':
            result = {
                type: 'connections', connections: await Promise.all((await deps.state.listConnections(request.provider)).filter(c => c.active).map(connectionView))
            };
            break;
        case 'operation': {
            const op = await deps.state.getOperation(request.operationId, ctx.principalId);
            if (!op)
                fail('NOT_FOUND');
            if (op.phase === 'preparing')
                fail('REQUEST_IN_PROGRESS');
            if (op.phase === 'execution')
                result = {
                    type: 'operation', operation: executionView(op)
                };
            else {
                const intent = await deps.state.getIntent({
                    operationId: op.operationId, executionRevision: 0
                }, ctx.principalId);
                if (!intent)
                    fail('DURABILITY_ERROR');
                result = {
                    type: 'operation', operation: {
                        phase: 'prepared', operationId: op.operationId, confirmation: intent.expiresAt <= deps.clock.now() ? 'expired' : 'required', expiresAt: intent.expiresAt, preview: preview(intent)
                    }
                };
            }
            break;
        }
        case 'operations': {
            const page = await deps.state.listOperations({
                principalId: ctx.principalId, limit: request.limit ?? 20, ...(request.cursor ? {
                    cursor: request.cursor
                } : {})
            });
            result = {
                type: 'operations', operations: page.operations.map(summary), ...(page.nextCursor ? {
                    nextCursor: page.nextCursor
                } : {})
            };
            break;
        }
        case 'overview': {
            const connections = await deps.state.listConnections();
            const recent = await deps.state.listOperations({
                principalId: ctx.principalId, limit: 5
            });
            result = {
                type: 'overview', initialized: connections.length > 0 || recent.operations.length > 0, connectionCount: connections.filter(c => c.active).length, providers: await deps.providers.list(), recent: recent.operations.map(summary), stateHealth: 'ok'
            };
            break;
        }
    }
    return result as T.StatusResult<TRequest>;
}
