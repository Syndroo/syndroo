import type * as T from './domain/records.js';
import { accountKey, clone, deepFreeze } from './domain/rules.js';
import { assertJson, canonicalJson, fail, ProtocolError } from './protocol/validation.js';
import { validateWire } from './protocol/generated/validators.js';
import { sanitizeAccountPresentation, sanitizeSafeDiagnostic, sanitizeTargetPresentation } from '@syndroo/provider-sdk';
export function safeError(error: unknown): T.SafeError {
    const code = error instanceof ProtocolError ? error.code : 'DURABILITY_ERROR';
    return {
        code, message: code
    };
}
export async function requestIdentity(deps: T.CoreDependencies, family: 'connect' | 'publish', request: unknown, ctx: T.CallContext): Promise<T.RequestIdentity> {
    if (!ctx.principalId || !ctx.idempotencyKey || !/^[A-Za-z0-9._:-]{1,128}$/.test(ctx.idempotencyKey))
        fail('INVALID_INPUT');
    return {
        principalId: ctx.principalId, family, key: ctx.idempotencyKey, digest: await (family === 'connect' ? deps.digests.sensitive : deps.digests.canonical)(request as T.Json)
    };
}
export function resolveConnection<C extends T.ConnectionView | T.ConnectionRecord>(connections: readonly C[], provider: string, selector?: string): C {
    const choices = connections.filter(c => c.active && c.account.provider === provider);
    if (selector) {
        const matches = choices.filter(c => c.connectionId === selector || c.label === selector);
        if (matches.length === 1)
            return matches[0]!;
        fail(matches.length ? 'TARGET_AMBIGUOUS' : 'NOT_FOUND');
    }
    if (choices.length === 1)
        return choices[0]!;
    const defaults = choices.filter(c => c.isDefault);
    if (defaults.length === 1)
        return defaults[0]!;
    fail(choices.length ? 'TARGET_AMBIGUOUS' : 'NOT_FOUND');
}
export function checkBinding(connection: T.ConnectionRecord | null, binding: T.Binding): asserts connection is T.ConnectionRecord {
    if (!connection?.active || connection.bindingRevision !== binding.bindingRevision || accountKey(connection.account) !== accountKey(binding.account))
        fail('STALE_BINDING');
}
export function checkLoaded(provider: string, loaded: T.LoadedProvider): void {
    if (loaded.plugin.manifest.id !== provider || loaded.plugin.manifest.apiVersion !== 1 || loaded.implementation.provider !== provider || loaded.implementation.apiVersion !== 1 || loaded.plugin.manifest.version !== loaded.implementation.version)
        fail('PROVIDER_INVALID');
}
export function checkImplementation(actual: T.Implementation, frozen: T.Implementation): void {
    if (canonicalJson(actual) !== canonicalJson(frozen))
        fail('STALE_INTENT');
}
export function validateProvider(loaded: T.LoadedProvider, kind: keyof T.ProviderManifest['schemas'], value: unknown): void {
    assertJson(value);
    if (!loaded.validators[kind](value))
        fail('INVALID_INPUT');
}
/**
 * Drop an optional, untrusted field before the strict wire check.
 *
 * Only the named optional field is touched. A record without it, or a
 * non-record value, is returned unchanged, so the later strict check still
 * rejects a malformed identity, evidence or discriminant. A field that does not
 * sanitize is removed rather than repaired; unknown sibling keys survive this
 * step and are still rejected by `additionalProperties: false`.
 */
function dropInvalidOptionalField(value: unknown, key: string, sanitize: (input: unknown) => unknown): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return value;
    const source = value as Record<string, unknown>;
    if (!Object.hasOwn(source, key))
        return source;
    const sanitized = sanitize(source[key]);
    // Copy every own key with its original descriptor. A plain assignment would
    // silently drop a `__proto__` sibling (the prototype setter) and skip
    // non-enumerable or Symbol siblings, letting a record that the strict
    // wire check must reject look valid. `defineProperty` defines real own
    // data properties instead, so `assertJson` still sees — and rejects — every
    // sibling that is not a normal enumerable string-keyed field.
    const cleaned: Record<string, unknown> = {};
    for (const name of Reflect.ownKeys(source)) {
        if (name === key)
            continue;
        Object.defineProperty(cleaned, name, Object.getOwnPropertyDescriptor(source, name)!);
    }
    if (sanitized !== undefined)
        Object.defineProperty(cleaned, key, {
            value: sanitized, enumerable: true, writable: true, configurable: true
        });
    return cleaned;
}
function dropInvalidIdentityPresentation(value: unknown): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return value;
    const source = value as Record<string, unknown>;
    if (source['status'] !== 'done')
        return source;
    return {
        ...source, identity: dropInvalidOptionalField(source['identity'], 'presentation', sanitizeAccountPresentation)
    };
}
/**
 * Strictly validate a provider connect/verify result after dropping an invalid
 * optional `presentation`. Returns the sanitized value so the caller never sees
 * the rejected metadata. Identity and evidence stay strictly validated.
 */
export function validateProviderResult<S>(kind: 'ProviderConnectResult' | 'VerifiedIdentity', value: unknown): S {
    const normalized = kind === 'VerifiedIdentity'
        ? dropInvalidOptionalField(value, 'presentation', sanitizeAccountPresentation)
        : dropInvalidIdentityPresentation(value);
    try {
        validateWire(kind, normalized);
    }
    catch {
        fail('PROVIDER_INVALID');
    }
    return normalized as S;
}
/**
 * Strictly validate a provider write outcome after dropping an invalid optional
 * `diagnostic`. A provider's raw error text never reaches storage: only a valid,
 * bounded, reviewed value survives.
 */
export function validateWriteOutcome(value: unknown): T.ProviderWriteOutcome {
    const normalized = dropInvalidOptionalField(value, 'diagnostic', sanitizeSafeDiagnostic);
    validateWire('ProviderWriteOutcome', normalized);
    return normalized as T.ProviderWriteOutcome;
}
export async function credential(deps: T.CoreDependencies, c: T.ConnectionRecord): Promise<T.CredentialBundle> {
    return deps.credentials.get({
        ref: c.secretRef, owner: {
            kind: 'credential', ownerId: c.connectionId, version: c.credentialRevision
        }
    });
}
export function frozenPayload(loaded: T.LoadedProvider, input: T.FreezeInput): T.FrozenProviderPayload {
    validateProvider(loaded, 'content', input.content);
    validateProvider(loaded, 'publishOptions', input.options);
    let result: T.FrozenProviderPayload;
    try {
        result = loaded.plugin.freeze(deepFreeze(clone(input)));
    }
    catch {
        return fail('INVALID_INPUT');
    }
    validateWire('FrozenProviderPayload', result);
    validateProvider(loaded, 'content', result.effectiveContent);
    validateProvider(loaded, 'publishOptions', result.effectiveOptions);
    if (canonicalJson(result.effectiveContent) !== canonicalJson(input.content) || canonicalJson(result.preview.content) !== canonicalJson(result.effectiveContent))
        fail('PROVIDER_INVALID');
    function secrets(value: T.Json): void {
        if (!value || typeof value !== 'object')
            return;
        for (const [key, child] of Object.entries(value)) {
            if (/^(?:access_?token|refresh_?token|authorization|cookie|password|appPassword|headers|method|requestUrl)$/i.test(key))
                fail('PROVIDER_INVALID');
            secrets(child);
        }
    }
    secrets(result.payload);
    return deepFreeze(clone(result));
}
export function preview(intent: T.FrozenIntent): T.TargetPreview[] {
    return intent.targets.map(t => ({
        deliveryId: t.deliveryId, connectionId: t.binding.connectionId, account: clone(t.binding.account), provider: t.implementation.provider, preview: clone(t.frozen.preview), ...(t.presentation === undefined ? {} : {
            presentation: clone(t.presentation)
        })
    }));
}
/**
 * The display snapshot frozen into one target.
 *
 * The identity just verified at prepare time wins; the presentation saved on
 * the connection is the fallback when the current check returned none; the
 * connection label of this prepare is captured beside them. Every field is
 * normalized and an invalid field is dropped, so a tampered value can never
 * reach the digest. When nothing survives the result is `undefined` and no
 * empty record is frozen.
 */
export function frozenPresentation(verified: T.AccountPresentation | undefined, saved: T.AccountPresentation | undefined, label: string | undefined): T.TargetPresentation | undefined {
    return sanitizeTargetPresentation({
        accountName: verified?.accountName ?? saved?.accountName, profileUrl: verified?.profileUrl ?? saved?.profileUrl, label
    });
}
export async function preparedResult(deps: T.CoreDependencies, intent: T.FrozenIntent): Promise<T.PreparedResult> {
    if (intent.expiresAt <= deps.clock.now())
        fail('APPROVAL_EXPIRED', { operationId: intent.operationId });
    const blob = await deps.credentials.get({
        ref: intent.approvalSecretRef, owner: {
            kind: 'approval', ownerId: intent.operationId, version: intent.executionRevision
        }
    });
    if (typeof blob.approvalToken !== 'string')
        fail('DURABILITY_ERROR');
    return {
        status: 'confirmation_required', operationId: intent.operationId, approvalToken: blob.approvalToken, expiresAt: intent.expiresAt, preview: preview(intent)
    };
}
export async function verifyIntent(deps: T.CoreDependencies, intent: T.FrozenIntent): Promise<void> {
    const { intentDigest, ...unsigned } = intent;
    if (await deps.digests.canonical(unsigned as unknown as T.Json) !== intentDigest)
        fail('STALE_INTENT');
}
