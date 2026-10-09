import { describe, expect, it } from 'vitest';
import * as core from '../../src/protocol/validation.js';
import * as sdk from '../../../sdk/src/generated/validation.js';

const encoder = new TextEncoder();

describe.each([
    { name: 'Core', parser: core },
    { name: 'generated SDK', parser: sdk }
])('$name JSON decoding budgets', ({ parser }) => {
    it.each([
        { name: 'request', limit: 65_536, parse: parser.parseStrictJson },
        { name: 'response', limit: 1_048_576, parse: parser.parseStrictResponseJson }
    ])('enforces the exact $name UTF-8 byte boundary', ({ limit, parse }) => {
        // Quotes consume two bytes; the multibyte character rules out measuring
        // string.length instead of the actual encoded input size.
        const content = '雨' + 'x'.repeat(limit - 5);
        const atLimit = JSON.stringify(content);
        const overLimit = JSON.stringify(content + 'x');
        expect(encoder.encode(atLimit)).toHaveLength(limit);
        expect(overLimit.length).toBeLessThan(limit);

        for (const input of [atLimit, encoder.encode(atLimit)]) {
            expect(parse(input)).toBe(content);
        }
        for (const input of [overLimit, encoder.encode(overLimit)]) {
            expect(() => parse(input)).toThrowError(
                expect.objectContaining({ code: 'BODY_TOO_LARGE' })
            );
        }
    });

    it('keeps structural rejection identical for the larger response budget', () => {
        const invalidInputs: (string | Uint8Array)[] = [
            '{"a":1,"\\u0061":2}',
            '{"value":"\\ud800"}',
            '{"value":9007199254740993}',
            '['.repeat(33) + '0' + ']'.repeat(33),
            new Uint8Array([0xc3, 0x28])
        ];

        for (const parse of [parser.parseStrictJson, parser.parseStrictResponseJson]) {
            for (const input of invalidInputs) {
                expect(() => parse(input)).toThrowError(
                    expect.objectContaining({ code: 'INVALID_INPUT' })
                );
            }
        }
    });
});
