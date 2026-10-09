import { describe, expect, it } from 'vitest';
import * as core from '../../src/index.js';
import { assertJson } from '../../src/protocol/validation.js';
describe('strict protocol input', () => {
    it('rejects JS arrays with lossy named properties instead of indexed elements', () => {
        const value = new Array(1);
        Object.defineProperty(value, 'named', {
            value: 'lost', enumerable: true
        });
        expect(() => assertJson(value)).toThrow();
    });
    it('accepts canonical documents without changing whitespace or Unicode', () => {
        expect(core).toHaveProperty('parseStrictJson');
        expect(core.parseStrictJson('{"content":{"text":"  雨\\n"},"targets":[{"provider":"fake"}]}')).toEqual({
            content: {
                text: '  雨\n'
            }, targets: [{
                    provider: 'fake'
                }]
        });
    });
    it.each(['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":9007199254740993}', '{"x":"\\ud800"}', '{"x":1e999}', '{"x":1,}'])('rejects malformed or lossy JSON without echoing values: %s', text => {
        expect(core).toHaveProperty('parseStrictJson');
        expect(() => core.parseStrictJson(text)).toThrow();
    });
    it('rejects invalid UTF8 and body overflow', () => {
        expect(core).toHaveProperty('parseStrictJson');
        expect(() => core.parseStrictJson(new Uint8Array([0xc3, 0x28]))).toThrow();
        expect(() => core.parseStrictJson(' '.repeat(65537))).toThrow();
    });
    it('rejects old documents and extra union fields', () => {
        expect(core).toHaveProperty('validateRequest');
        expect(() => core.validateRequest('publish', {
            type: 'prepare', content: {
                text: 'ok'
            }, targets: [{
                    provider: 'fake'
                }], key: 'legacy'
        })).toThrow();
        expect(() => core.validateRequest('publish', {
            type: 'execute', approvalToken: 'appr_test', targets: []
        })).toThrow();
    });
});
it('separates response parsing budget from request input budget', () => {
    const body = JSON.stringify({
        text: 'x'.repeat(70000)
    });
    expect(() => core.parseStrictJson(body)).toThrow();
    expect(core).toHaveProperty('parseStrictResponseJson');
    expect(core.parseStrictResponseJson(body)).toEqual({
        text: 'x'.repeat(70000)
    });
    expect(() => core.parseStrictResponseJson(JSON.stringify({
        text: 'x'.repeat(1048576)
    }))).toThrow();
    expect(() => core.parseStrictResponseJson('{"a":1,"a":2}')).toThrow();
});
