import type * as T from '../domain/records.js';
import { accountKey, clone, later } from '../domain/rules.js';
import { fail } from '../protocol/validation.js';
import { checkImplementation, checkLoaded, requestIdentity, safeError, validateProvider, validateProviderResult } from '../runtime-helpers.js';
function action(session: T.ConnectSession): T.ConnectResult {
    if (!session.action)
        fail('REQUEST_IN_PROGRESS');
    return {
        status: 'action_required', connectSessionId: session.sessionId, stepRevision: session.stepRevision, expiresAt: session.expiresAt, action: clone(session.action)
    };
}
export async function connect(deps: T.CoreDependencies, request: T.ConnectRequest, ctx: T.CallContext): Promise<T.ConnectResult> {
    if (request.type === 'update' || request.type === 'disconnect') {
        const identity = await requestIdentity(deps, 'connect', request, ctx);
        const connection = await deps.state.getConnection(request.connectionId);
        if (!connection)
            fail('NOT_FOUND');
        const common = {
            request: identity, connectionId: connection.connectionId, expectedRevision: connection.revision, now: deps.clock.now()
        };
        const result = request.type === 'update' ? await deps.state.updateConnection({
            ...common, changes: request.changes
        }) : await deps.state.disconnectConnection(common);
        if (result.type === 'conflict')
            fail('CONNECT_STEP_CONFLICT');
        return result.value;
    }
    let session: T.ConnectSession;
    let input: T.ProviderConnectInput;
    let loaded: T.LoadedProvider;
    let context: T.ProviderContext;
    let inputDigest: string;
    if (request.type === 'start') {
        const identity = await requestIdentity(deps, 'connect', request, ctx);
        const replay = await deps.state.readConnectRequest(identity);
        if (replay)
            return replay;
        loaded = await deps.providers.load(request.provider);
        checkLoaded(request.provider, loaded);
        validateProvider(loaded, 'connectOptions', request.options ?? {});
        const baseline = request.connectionId ? await deps.state.getConnection(request.connectionId) : null;
        if (request.connectionId && (!baseline || baseline.account.provider !== request.provider))
            fail('NOT_FOUND');
        const proposed: T.ConnectSession = {
            sessionId: deps.entropy.id('cs'), principalId: ctx.principalId, implementation: clone(loaded.implementation), provider: request.provider, stepRevision: 0, expiresAt: later(deps.clock.now(), 900000), connectionId: baseline?.connectionId ?? deps.entropy.id('conn'), baselineRevision: baseline?.revision ?? null, ...(request.label ? {
                label: request.label
            } : {}), status: 'awaiting'
        };
        const reserved = await deps.state.reserveConnect({
            request: identity, session: proposed, now: deps.clock.now()
        });
        if (reserved.type === 'conflict')
            fail('CONNECT_STEP_CONFLICT');
        session = reserved.value;
        if (reserved.type === 'replay') {
            const result = await deps.state.readConnectRequest(identity);
            if (result)
                return result;
            fail('REQUEST_IN_PROGRESS');
        }
        context = await deps.providerContext(session.provider, ctx.signal);
        input = {
            type: 'start', options: request.options ?? {}
        };
        inputDigest = identity.digest;
    }
    else {
        const saved = await deps.state.getConnectSession(request.connectSessionId, ctx.principalId);
        if (!saved)
            fail('NOT_FOUND');
        session = saved;
        // Step replay is checked by claimConnectStep before plugin load or TTL.
        inputDigest = await deps.digests.sensitive(request.input as unknown as T.Json);
        const oldStep = await deps.state.replayConnectStep({
            sessionId: session.sessionId, principalId: ctx.principalId, stepRevision: request.stepRevision, inputDigest
        });
        if (oldStep)
            return oldStep;
        if (session.expiresAt <= deps.clock.now())
            fail('CONNECT_SESSION_EXPIRED');
        if (session.stepRevision !== request.stepRevision)
            fail('CONNECT_STEP_CONFLICT');
        if (request.input.type === 'callback_complete' && !session.callbackRef)
            return action(session);
        loaded = await deps.providers.load(session.provider);
        checkImplementation(loaded.implementation, session.implementation);
        const savedState = session.privateStateRef ? await deps.credentials.get({
            ref: session.privateStateRef, owner: {
                kind: 'connect_state', ownerId: session.sessionId, version: session.stepRevision
            }
        }) : {};
        const privateState = (savedState.providerState ?? {}) as T.JsonObject;
        context = {
            ...(await deps.providerContext(session.provider, ctx.signal)), ...(savedState.oauth ? {
                oauth: savedState.oauth as unknown as T.OAuthMaterial
            } : {})
        };
        if (request.input.type === 'credentials') {
            validateProvider(loaded, 'credentialInput', request.input.credentials);
            input = {
                type: 'resume', privateState, input: request.input
            };
        }
        else {
            const evidence = await deps.credentials.get({
                ref: session.callbackRef!, owner: {
                    kind: 'callback', ownerId: session.sessionId, version: session.stepRevision
                }
            }) as unknown as T.CallbackEvidence;
            if (!context.oauth || evidence.state !== context.oauth.state || evidence.redirectUri !== context.oauth.redirectUri)
                fail('CONNECT_STEP_CONFLICT');
            input = {
                type: 'resume', privateState, input: {
                    type: 'callback', evidence
                }
            };
        }
    }
    const claimed = await deps.state.claimConnectStep({
        sessionId: session.sessionId, principalId: ctx.principalId, stepRevision: session.stepRevision, inputDigest, claimId: deps.entropy.id('step'), now: deps.clock.now()
    });
    if (claimed.type === 'replay')
        return claimed.result;
    if (claimed.type === 'busy')
        fail('REQUEST_IN_PROGRESS');
    let providerStarted = false;
    try {
        providerStarted = true;
        let result: T.ProviderConnectResult;
        try {
            result = await loaded.plugin.connect.run(input, context);
        }
        catch {
            return fail('CONNECT_STEP_UNKNOWN');
        }
        validateProviderResult('ProviderConnectResult', result);
        if (result.status === 'action_required') {
            if (!['credential_input', 'open_url', 'wait_for_callback'].includes(result.action.type))
                fail('PROVIDER_INVALID');
            if (result.action.type === 'open_url') {
                const url = new URL(result.action.url);
                if (url.protocol !== 'https:' || url.username || url.password || url.hash)
                    fail('PROVIDER_INVALID');
            }
            const value: T.JsonObject = {
                providerState: result.privateState, ...(context.oauth ? {
                    oauth: context.oauth as unknown as T.Json
                } : {})
            };
            const privateState = await deps.credentials.put({
                creationId: deps.entropy.id('blob'), owner: {
                    kind: 'connect_state', ownerId: session.sessionId, version: session.stepRevision + 1
                }, value
            });
            const saved = await deps.state.saveConnectAction({
                claim: claimed.claim, action: result.action, privateState, now: deps.clock.now()
            });
            if (saved.type === 'conflict')
                fail('CONNECT_STEP_CONFLICT');
            return saved.value;
        }
        if (result.status !== 'done' || result.identity.account.provider !== session.provider)
            fail('PROVIDER_INVALID');
        const origin = new URL(result.identity.account.origin);
        if (origin.protocol !== 'https:' || origin.origin !== result.identity.account.origin)
            fail('PROVIDER_INVALID');
        const existing = (await deps.state.listConnections(session.provider)).find(c => accountKey(c.account) === accountKey(result.identity.account));
        const baseline = await deps.state.getConnection(session.connectionId);
        if (session.baselineRevision !== null && (!baseline || accountKey(baseline.account) !== accountKey(result.identity.account)))
            fail('CONNECTION_IDENTITY_CHANGED');
        const old = baseline ?? existing;
        const id = old?.connectionId ?? session.connectionId;
        const credentialRevision = (old?.credentialRevision ?? 0) + 1;
        const secret = await deps.credentials.put({
            creationId: deps.entropy.id('blob'), owner: {
                kind: 'credential', ownerId: id, version: credentialRevision
            }, value: result.credentials
        });
        const connection: T.ConnectionRecord = {
            connectionId: id, account: clone(result.identity.account), ...(session.label ?? old?.label ? {
                label: (session.label ?? old?.label)!
            } : {}), isDefault: old?.isDefault ?? false, active: true, revision: (old?.revision ?? 0) + 1, bindingRevision: (old?.bindingRevision ?? 0) + 1, credentialRevision, secretRef: secret.ref, observations: result.identity.evidence.map(e => ({
                ...e, account: clone(result.identity.account), credentialRevision, artifactFingerprint: loaded.implementation.artifactFingerprint, schemaFingerprint: loaded.implementation.schemaFingerprint
            }))
        };
        const saved = await deps.state.commitConnection({
            claim: claimed.claim, expectedConnectionRevision: session.baselineRevision ?? old?.revision ?? null, connection, stagedCredential: secret, now: deps.clock.now()
        });
        if (saved.type === 'conflict')
            fail('CONNECT_STEP_CONFLICT');
        return saved.value;
    }
    catch (error) {
        try {
            await deps.state.failConnectStep({
                claim: claimed.claim, error: safeError(error), indeterminate: providerStarted, now: deps.clock.now()
            });
        }
        catch { /* A committed result must not be replaced by error cleanup. */
        }
        throw error;
    }
}
