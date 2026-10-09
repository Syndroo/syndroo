import { describe, expect, it } from 'vitest';
import { validateWire } from '../../../sdk/src/generated/validators.js';
import { parseStrictJson, parseStrictResponseJson } from '../../../sdk/src/generated/validation.js';
describe('independent generated consumer protocol', () => {
    it('never decodes an unknown delivery as aggregate success', () => {
        const result = {
            phase: 'execution', operationId: 'op_fixture', status: 'succeeded', deliveries: [{
                deliveryId: 'delivery_fixture', connectionId: 'conn_fixture', attempts: 1,
                account: { provider: 'fake', accountId: 'alice', origin: 'https://social.example' },
                outcome: { status: 'unknown', disposition: 'unknown', reason: 'network' }
            }]
        };
        expect(() => validateWire('ExecutionResult', result, true)).toThrow();
        expect(() => validateWire('ExecutionResult', { ...result, status: 'unknown' }, true)).not.toThrow();
    });
    it('matches the envelope operation to its result family', () => {
        const wrong = {
            protocolVersion: 1, operation: 'publish', ok: true, result: {
                type: 'connections', connections: []
            }, error: null
        };
        expect(() => validateWire('Envelope', wrong, true)).toThrow();
    });
    it('accepts bounded larger previews and additive fields, but rejects unknown discriminants', () => {
        const body = JSON.stringify({
            protocolVersion: 1, operation: 'publish', ok: true, error: null, future: 'allowed',
            result: {
                status: 'confirmation_required', operationId: 'op_fixture', approvalToken: 'appr_fixture',
                expiresAt: '2026-10-08T00:15:00.000Z', preview: [{
                        deliveryId: 'delivery_fixture', connectionId: 'conn_fixture', provider: 'fake',
                        account: {
                            provider: 'fake', accountId: 'alice', origin: 'https://social.example'
                        },
                        preview: {
                            content: {
                                text: 'x'.repeat(70000)
                            }, fields: []
                        }
                    }]
            }
        });
        expect(() => parseStrictJson(body)).toThrow();
        expect(() => validateWire('Envelope', parseStrictResponseJson(body), true)).not.toThrow();
        expect(() => validateWire('Envelope', parseStrictResponseJson(body.replace('confirmation_required', 'new_unknown_status')), true)).toThrow();
    });
});
