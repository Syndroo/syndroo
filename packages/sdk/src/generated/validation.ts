// GENERATED from core/src/protocol/protocol.schema.json. Do not edit.
/** Bounded JSON validation shared with generated HTTP consumers. No evaluation or I/O. */
export class ProtocolError extends Error {
    readonly code: string;
    readonly details?: { operationId: string };
    constructor(code = 'INVALID_INPUT', details?: { operationId: string }) {
        super(code);
        this.name = 'ProtocolError';
        this.code = code;
        if (details)
            this.details = { operationId: details.operationId };
    }
}
export function fail(code: string, details?: { operationId: string }): never {
    throw new ProtocolError(code, details);
}
export function assertJson(value: unknown, maxBytes = 65536): void {
    const seen = new Set<object>();
    function visit(v: unknown, depth: number): void {
        if (depth > 32)
            fail('INVALID_INPUT');
        if (typeof v === 'string') {
            if (!v.isWellFormed())
                fail('INVALID_INPUT');
            return;
        }
        if (v === null || typeof v === 'boolean')
            return;
        if (typeof v === 'number') {
            if (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v)))
                fail('INVALID_INPUT');
            return;
        }
        if (typeof v !== 'object' || seen.has(v))
            fail('INVALID_INPUT');
        const proto = Object.getPrototypeOf(v);
        if (!Array.isArray(v) && proto !== Object.prototype && proto !== null)
            fail('INVALID_INPUT');
        seen.add(v);
        for (const key of Reflect.ownKeys(v)) {
            if (Array.isArray(v) && key === 'length')
                continue;
            if (typeof key !== 'string' || !key.isWellFormed())
                fail('INVALID_INPUT');
            if (Array.isArray(v) && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length))
                fail('INVALID_INPUT');
            const d = Object.getOwnPropertyDescriptor(v, key)!;
            if (!('value' in d) || !d.enumerable)
                fail('INVALID_INPUT');
            visit(d.value, depth + 1);
        }
        if (Array.isArray(v) && Object.keys(v).length !== v.length)
            fail('INVALID_INPUT');
        seen.delete(v);
    }
    visit(value, 0);
    if (new TextEncoder().encode(JSON.stringify(value)).length > maxBytes)
        fail('BODY_TOO_LARGE');
}
export function canonicalJson(value: unknown): string {
    assertJson(value, 1048576);
    const encode = (v: null | boolean | number | string | unknown[] | Record<string, unknown>): string => v !== null && typeof v === 'object'
        ? Array.isArray(v) ? '[' + v.map(item => encode(item as Parameters<typeof encode>[0])).join(',') + ']'
            : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + encode(v[k] as Parameters<typeof encode>[0])).join(',') + '}'
        : JSON.stringify(v);
    return encode(value as Parameters<typeof encode>[0]);
}
function parseBoundedJson(input: string | Uint8Array, maxBytes: number): unknown {
    if ((typeof input === 'string' ? input.length : input.byteLength) > maxBytes)
        fail('BODY_TOO_LARGE');
    let text: string;
    try {
        text = typeof input === 'string' ? input : new TextDecoder('utf-8', {
            fatal: true
        }).decode(input);
    }
    catch {
        return fail('INVALID_INPUT');
    }
    if (new TextEncoder().encode(text).length > maxBytes)
        fail('BODY_TOO_LARGE');
    let i = 0;
    const space = () => {
        while (/[\x20\t\r\n]/.test(text[i] ?? '\0'))
            i++;
    };
    function string(): string {
        const start = i++;
        while (i < text.length) {
            const c = text[i++];
            if (c === '\\')
                i++;
            else if (c === '"') {
                try {
                    const v = JSON.parse(text.slice(start, i));
                    if (!v.isWellFormed())
                        fail('INVALID_INPUT');
                    return v;
                }
                catch {
                    return fail('INVALID_INPUT');
                }
            }
        }
        return fail('INVALID_INPUT');
    }
    function value(depth: number): unknown {
        if (depth > 32)
            fail('INVALID_INPUT');
        space();
        if (text[i] === '"')
            return string();
        if (text[i] === '{') {
            i++;
            space();
            const out: Record<string, unknown> = Object.create(null);
            const keys = new Set<string>();
            if (text[i] === '}') {
                i++;
                return out;
            }
            while (true) {
                space();
                if (text[i] !== '"')
                    fail('INVALID_INPUT');
                const key = string();
                if (keys.has(key))
                    fail('INVALID_INPUT');
                keys.add(key);
                space();
                if (text[i++] !== ':')
                    fail('INVALID_INPUT');
                out[key] = value(depth + 1);
                space();
                if (text[i] === '}') {
                    i++;
                    return out;
                }
                if (text[i++] !== ',')
                    fail('INVALID_INPUT');
            }
        }
        if (text[i] === '[') {
            i++;
            space();
            const out: unknown[] = [];
            if (text[i] === ']') {
                i++;
                return out;
            }
            while (true) {
                out.push(value(depth + 1));
                space();
                if (text[i] === ']') {
                    i++;
                    return out;
                }
                if (text[i++] !== ',')
                    fail('INVALID_INPUT');
            }
        }
        const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
        if (!match)
            fail('INVALID_INPUT');
        i += match[0].length;
        const v: unknown = JSON.parse(match[0]);
        if (typeof v === 'number' && (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v))))
            fail('INVALID_INPUT');
        return v;
    }
    const result = value(0);
    space();
    if (i !== text.length)
        fail('INVALID_INPUT');
    assertJson(result, maxBytes);
    return result;
}
export function parseStrictJson(input: string | Uint8Array): unknown {
    return parseBoundedJson(input, 65536);
}
export function parseStrictResponseJson(input: string | Uint8Array): unknown {
    return parseBoundedJson(input, 1048576);
}
