/** Build/approved Node-loader entry only. Never import from Core runtime or Worker. */
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { AnySchema, ValidateFunction } from 'ajv';
import { assertJson, fail } from './validation.js';
export function compileProviderSchema(schema: unknown): ValidateFunction {
    assertJson(schema);
    function check(value: unknown): void {
        if (!value || typeof value !== 'object')
            return;
        if (Array.isArray(value)) {
            value.forEach(check);
            return;
        }
        const object = value as Record<string, unknown>;
        if (typeof object.$ref === 'string' && !object.$ref.startsWith('#/'))
            fail('PROVIDER_INVALID');
        if (object.$async !== undefined || object.$data !== undefined)
            fail('PROVIDER_INVALID');
        if (typeof object.pattern === 'string' && (object.pattern.length > 256 || /\\[1-9]|\(\?[=!<]|\([^)]*[+*][^)]*\)[+*{]/.test(object.pattern)))
            fail('PROVIDER_INVALID');
        Object.values(object).forEach(check);
    }
    check(schema);
    try {
        const ajv = new Ajv2020({
            strict: true, strictTypes: false, validateSchema: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false
        });
        addFormats.default(ajv);
        if (!ajv.validateSchema(schema as AnySchema))
            fail('PROVIDER_INVALID');
        return ajv.compile(schema as AnySchema);
    }
    catch {
        return fail('PROVIDER_INVALID');
    }
}
