import { describe, expect, it } from 'vitest';
import { compileProviderSchema } from '../../src/protocol/compiler.js';
describe('JSON Schema 2020-12 regressions', () => {
    it('honors false items schemas', () => {
        const schema = {
            type: 'array', items: false
        };
        const validate = compileProviderSchema(schema);
        expect(validate([1])).toBe(false);
    });
    it('honors siblings of local references', () => {
        const schema = {
            $defs: {
                n: {
                    type: 'number'
                }
            }, $ref: '#/$defs/n', minimum: 2
        };
        const validate = compileProviderSchema(schema);
        expect(validate(1)).toBe(false);
    });
    it.each([{
            type: 'string', maxLength: 'wrong-type'
        }, {
            type: 'array', minItems: -1
        }, {
            type: 'object', required: 'bad'
        }, {
            type: 'array', items: 4
        }])('rejects malformed keyword values', schema => {
        expect(() => compileProviderSchema(schema)).toThrow();
    });
});
