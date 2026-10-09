import type * as T from '../domain/records.js';
import { accountKey, clone, executionView, later, retryEligible } from '../domain/rules.js';
import { assertJson, fail } from '../protocol/validation.js';
import { checkLoaded, credential, frozenPayload, preparedResult, requestIdentity, resolveConnection, safeError, validateProviderResult } from '../runtime-helpers.js';
export async function prepare(deps: T.CoreDependencies, request: T.PrepareRequest | T.RetryRequest, ctx: T.CallContext): Promise<T.PublishResult> {
    const identity = await requestIdentity(deps, 'publish', request, ctx);
    const now = deps.clock.now();
    let reservation: T.Reservation;
    let original: T.FrozenIntent | null = null;
    if (request.type === 'prepare') {
        reservation = await deps.state.reservePreparation({
            request: identity, canonical: request, operationId: deps.entropy.id('op'), ownerId: deps.entropy.id('prepare'), now
        });
    }
    else {
        const op = await deps.state.getOperation(request.retryOf, ctx.principalId);
        if (!op)
            fail('NOT_FOUND');
        const selected = request.targets.map(target => {
            const delivery = op.deliveries.find(d => d.connectionId === target.connection && d.account.provider === target.provider);
            if (!delivery)
                fail('RETRY_INELIGIBLE');
            return delivery.deliveryId;
        });
        reservation = await deps.state.prepareRetry({
            request: identity, operationId: op.operationId, expectedVersion: op.version, deliveryIds: selected, ownerId: deps.entropy.id('prepare'), now
        });
        original = await deps.state.getIntent({
            operationId: op.operationId, executionRevision: 0
        }, ctx.principalId);
    }
    if (reservation.type === 'busy')
        fail('REQUEST_IN_PROGRESS');
    if (reservation.type === 'replay') {
        const intent = reservation.intent;
        if (!intent)
            fail('DURABILITY_ERROR');
        const admission = await deps.state.readApproval({
            principalId: ctx.principalId, approvalDigest: intent.approvalDigest
        });
        if (admission?.admitted)
            return executionView(admission.operation);
        return preparedResult(deps, intent);
    }
    const ticket = reservation.ticket;
    try {
        const connections = await deps.state.listConnections();
        const targets = request.type === 'prepare' ? request.targets.map(target => ({
            connection: resolveConnection(connections, target.provider, target.connection),
            content: target.content ?? request.content, options: target.options ?? {}, deliveryId: deps.entropy.id('delivery')
        })) : request.targets.map(target => {
            const old = original?.targets.find(t => t.binding.connectionId === target.connection && t.binding.account.provider === target.provider);
            if (!old)
                fail('RETRY_INELIGIBLE');
            const connection = resolveConnection(connections, target.provider, target.connection);
            if (accountKey(old.binding.account) !== accountKey(connection.account))
                fail('STALE_BINDING');
            return {
                connection, content: old.canonicalContent, options: old.canonicalOptions, deliveryId: old.deliveryId
            };
        });
        if (new Set(targets.map(t => accountKey(t.connection.account))).size !== targets.length)
            fail('DUPLICATE_TARGET');
        if (original) {
            // Retry selects a subset; it cannot change the operation's serial order.
            const order = new Map(original.targets.map((target, index) => [target.deliveryId, index]));
            targets.sort((a, b) => order.get(a.deliveryId)! - order.get(b.deliveryId)!);
        }
        const frozen: T.FrozenTarget[] = [];
        for (const target of targets) {
            if (ctx.signal.aborted)
                fail('CANCELLED');
            const provider = target.connection.account.provider;
            const loaded = await deps.providers.load(provider);
            checkLoaded(provider, loaded);
            const credentials = await credential(deps, target.connection);
            let verified: T.VerifiedIdentity;
            try {
                verified = await loaded.plugin.connect.verify(credentials, await deps.providerContext(provider, ctx.signal));
            }
            catch {
                return fail('PROVIDER_UNAVAILABLE');
            }
            validateProviderResult('VerifiedIdentity', verified);
            if (accountKey(verified.account) !== accountKey(target.connection.account))
                fail('STALE_BINDING');
            if (verified.evidence.some(e => e.capability === 'publish_permission' && e.value === 'unsupported'))
                fail('FORBIDDEN');
            const payload = frozenPayload(loaded, {
                content: target.content, options: target.options, account: target.connection.account, now, seed: ticket.operationId + ':' + target.deliveryId
            });
            frozen.push({
                deliveryId: target.deliveryId, binding: {
                    connectionId: target.connection.connectionId, account: clone(target.connection.account), bindingRevision: target.connection.bindingRevision
                }, implementation: clone(loaded.implementation), canonicalContent: clone(target.content), canonicalOptions: clone(target.options), frozen: payload
            });
        }
        const token = 'appr_' + deps.entropy.token();
        const approvalDigest = await deps.digests.sensitive({
            approvalToken: token
        });
        const expiresAt = later(now, 900000);
        const base = {
            format: 'syndroo-runtime-v1' as const, operationId: ticket.operationId, executionRevision: ticket.executionRevision, principalId: ctx.principalId, request: identity, canonicalRequest: clone(request), targets: frozen, createdAt: now, expiresAt, approvalDigest
        };
        assertJson(base, 262144);
        const secret = await deps.credentials.put({
            creationId: deps.entropy.id('blob'), owner: {
                kind: 'approval', ownerId: ticket.operationId, version: ticket.executionRevision
            }, value: {
                approvalToken: token
            }
        });
        const unsigned = {
            ...base, approvalSecretRef: secret.ref
        };
        const intent: T.FrozenIntent = {
            ...unsigned, intentDigest: await deps.digests.canonical(unsigned as unknown as T.Json)
        };
        assertJson(intent, 262144);
        const saved = await deps.state.savePreparedIntent({
            ticket, intent, now: deps.clock.now()
        });
        if (saved.type === 'conflict')
            fail('REQUEST_IN_PROGRESS');
        return preparedResult(deps, saved.value);
    }
    catch (error) {
        await deps.state.failPreparation({
            ticket, error: safeError(error), now: deps.clock.now()
        });
        throw error;
    }
}
