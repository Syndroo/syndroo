import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_MESSAGES } from '@syndroo/provider-sdk';
import { validateProviderResult, validateWriteOutcome } from '../src/runtime-helpers.js';
import type { ProviderWriteOutcome, VerifiedIdentity } from '../src/domain/records.js';

const account = { provider: 'fake', accountId: 'alice', origin: 'https://social.example' };
const evidence = [{
    capability: 'identity' as const, value: 'supported' as const, source: 'fixture', verifiedAt: '2026-10-14T00:00:00.000Z'
}];

function codeOf(run: () => unknown): string {
    try {
        run();
    }
    catch (error) {
        return (error as { code?: string }).code ?? 'NO_CODE';
    }
    return 'NO_ERROR';
}

describe('provider result sanitization before strict validation', () => {
    it('keeps a valid optional presentation unchanged', () => {
        const value = {
            account, evidence, presentation: {
                accountName: 'syndroo', profileUrl: 'https://social.example/@syndroo'
            }
        };
        const result = validateProviderResult<VerifiedIdentity>('VerifiedIdentity', value);
        expect(result.presentation).toEqual({
            accountName: 'syndroo', profileUrl: 'https://social.example/@syndroo'
        });
        expect(result.account).toEqual(account);
    });

    it('drops an invalid presentation field without failing the identity', () => {
        const result = validateProviderResult<VerifiedIdentity>('VerifiedIdentity', {
            account, evidence, presentation: {
                accountName: '\u001b[2Jforged', profileUrl: 'https://user:pass@social.example/a'
            }
        });
        expect(result).toEqual({ account, evidence });
    });

    it('drops a non-record presentation entirely', () => {
        for (const presentation of [null, 'syndroo', 42, [], {
            accountName: 42
        }])
            expect(validateProviderResult<VerifiedIdentity>('VerifiedIdentity', {
                account, evidence, presentation
            })).toEqual({ account, evidence });
    });

    it('still rejects invalid identity, evidence and unknown keys', () => {
        expect(codeOf(() => validateProviderResult('VerifiedIdentity', {
            account: {
                provider: 'fake', accountId: 42, origin: 'https://social.example'
            }, evidence
        }))).toBe('PROVIDER_INVALID');
        expect(codeOf(() => validateProviderResult('VerifiedIdentity', {
            account, evidence: [{
                capability: 'identity', value: 'maybe', source: 'fixture', verifiedAt: '2026-10-14T00:00:00.000Z'
            }]
        }))).toBe('PROVIDER_INVALID');
        expect(codeOf(() => validateProviderResult('VerifiedIdentity', {
            account, evidence, presentation: {
                accountName: 'ok'
            }, injected: true
        }))).toBe('PROVIDER_INVALID');
        expect(codeOf(() => validateProviderResult('VerifiedIdentity', null))).toBe('PROVIDER_INVALID');
    });

    it('sanitizes a nested connect result identity without relaxing the result', () => {
        const done = {
            status: 'done' as const, credentials: {
                kind: 'fixture' as const
            }, identity: {
                account, evidence, presentation: {
                    accountName: 'ok', profileUrl: 'http://insecure.example/a'
                }
            }
        };
        const cleaned = validateProviderResult<{ status: 'done'; identity: VerifiedIdentity }>('ProviderConnectResult', done);
        expect(cleaned.identity.presentation).toEqual({ accountName: 'ok' });
        expect(codeOf(() => validateProviderResult('ProviderConnectResult', {
            status: 'action_required', action: {
                type: 'nope'
            }, privateState: {}
        }))).toBe('PROVIDER_INVALID');
    });

    it('keeps a __proto__, non-enumerable or Symbol sibling strictly rejected', () => {
        // The optional-field sanitizer must copy every own key with its real
        // descriptor; a plain assignment would drop a `__proto__` sibling and
        // skip hidden or Symbol keys, letting an invalid record look valid.
        const withProto = JSON.parse(
            '{"account":{"provider":"fake","accountId":"a","origin":"https://social.example"},"evidence":[],"presentation":{},"__proto__":null}',
        ) as Record<string, unknown>;
        expect(codeOf(() => validateProviderResult('VerifiedIdentity', withProto))).toBe('PROVIDER_INVALID');

        const withHidden = { account, evidence, presentation: {} } as Record<string, unknown>;
        Object.defineProperty(withHidden, 'injected', { value: true, enumerable: false });
        expect(codeOf(() => validateProviderResult('VerifiedIdentity', withHidden))).toBe('PROVIDER_INVALID');

        const withSymbol = { account, evidence, presentation: {} } as Record<string | symbol, unknown>;
        withSymbol[Symbol('injected')] = true;
        expect(codeOf(() => validateProviderResult('VerifiedIdentity', withSymbol))).toBe('PROVIDER_INVALID');
    });
});

describe('provider write outcome sanitization', () => {
    it('keeps a valid reviewed diagnostic', () => {
        const outcome = validateWriteOutcome({
            status: 'failed', disposition: 'not_applied', retryable: true, reason: 'rate_limited', retryAfter: '2026-10-14T00:01:00.000Z', diagnostic: {
                providerCode: 'rate.limited', httpStatus: 429, message: DIAGNOSTIC_MESSAGES.rate_limited
            }
        }) as ProviderWriteOutcome;
        expect((outcome as { diagnostic?: unknown }).diagnostic).toEqual({
            providerCode: 'rate.limited', httpStatus: 429, message: DIAGNOSTIC_MESSAGES.rate_limited
        });
    });

    it('drops a raw error message or provider body instead of storing it', () => {
        const outcome = validateWriteOutcome({
            status: 'unknown', disposition: 'unknown', reason: 'network', diagnostic: {
                message: 'Error: connect ECONNREFUSED\n    at Socket.emit', httpStatus: 999, providerCode: 'bad code'
            }
        }) as ProviderWriteOutcome;
        expect(outcome).toEqual({ status: 'unknown', disposition: 'unknown', reason: 'network' });
    });

    it('drops a single-line secret that is not a reviewed template', () => {
        // A short, control-free credential is not a reviewed message; the
        // sanitizer must drop it rather than persist or display it.
        for (const message of [
            'Authorization: Bearer FAKE_SECRET_FOR_REVIEW',
            'Cookie: session=FAKE_SECRET_FOR_REVIEW'
        ]) {
            const outcome = validateWriteOutcome({
                status: 'failed', disposition: 'not_applied', retryable: true, reason: 'auth', diagnostic: { message }
            }) as ProviderWriteOutcome;
            expect(outcome).toEqual({
                status: 'failed', disposition: 'not_applied', retryable: true, reason: 'auth'
            });
        }
    });

    it('keeps the outcome strict for invalid discriminants and shapes', () => {
        // The strict wire check rejects a malformed outcome; the executor turns
        // any throw here into an `unknown` outcome, exactly as before.
        expect(codeOf(() => validateWriteOutcome({
            status: 'succeeded', remoteId: 'x', disposition: 'not_applied'
        }))).toBe('INVALID_INPUT');
        expect(codeOf(() => validateWriteOutcome({
            status: 'failed', disposition: 'applied', retryable: true, reason: 'auth'
        }))).toBe('INVALID_INPUT');
        expect(codeOf(() => validateWriteOutcome(undefined))).toBe('INVALID_INPUT');
        expect(codeOf(() => validateWriteOutcome({
            status: 'succeeded', remoteId: 'x', injected: true
        }))).toBe('INVALID_INPUT');
    });
});
