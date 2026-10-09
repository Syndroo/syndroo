import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { build } from 'esbuild';
type Schema = {
    $ref?: string;
    anyOf?: Schema[];
    allOf?: Schema[];
    const?: unknown;
    enum?: unknown[];
    type?: string;
    items?: Schema;
    properties?: Record<string, Schema>;
    required?: string[];
    additionalProperties?: boolean | Schema;
    [key: string]: unknown;
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(await readFile(resolve(root, 'packages/core/src/protocol/protocol.schema.json'), 'utf8')) as {
    $defs: Record<string, Schema>;
    $schema: string;
};
function type(schema: Schema): string {
    if (schema.$ref)
        return schema.$ref.split('/').at(-1)!;
    if (schema.anyOf)
        return schema.anyOf.map(type).join(' | ');
    if (schema.allOf)
        return schema.allOf.map(type).join(' & ');
    if ('const' in schema)
        return JSON.stringify(schema.const);
    if (schema.enum)
        return schema.enum.map(v => JSON.stringify(v)).join(' | ');
    if (schema.type === 'array')
        return `readonly (${type(schema.items ?? {})})[]`;
    if (schema.type === 'object') {
        const fields = Object.entries(schema.properties ?? {}).map(([key, value]) => `${JSON.stringify(key)}${schema.required?.includes(key) ? '' : '?'}: ${type(value)};`);
        if (schema.additionalProperties !== false)
            fields.push(`[key: string]: ${typeof schema.additionalProperties === 'object' ? type(schema.additionalProperties) : 'unknown'};`);
        return `{ ${fields.join(' ')} }`;
    }
    return schema.type === 'integer' ? 'number' : schema.type ?? 'unknown';
}
function relaxed(value: unknown): unknown {
    if (Array.isArray(value))
        return value.map(relaxed);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).filter(([k, v]) => !(k === 'additionalProperties' && v === false)).map(([k, v]) => [k, relaxed(v)]));
    return value;
}
const ajv = new Ajv2020({
    strict: true, strictTypes: false, validateSchema: true, code: {
        source: true, esm: true
    }, coerceTypes: false, useDefaults: false, removeAdditional: false
});
addFormats.default(ajv);
const ids = {
    request: 'https://syndroo.invalid/protocol/request', response: 'https://syndroo.invalid/protocol/response'
};
ajv.addSchema({
    ...source, $id: ids.request
});
ajv.addSchema({
    ...relaxed(source) as object, $id: ids.response
});
const roots = ['PostDocument', 'PublishRequest', 'ConnectRequest', 'StatusRequest', 'ConnectResult', 'PreparedResult', 'ExecutionResult', 'OperationView', 'StatusResultMap', 'ProviderWriteOutcome', 'FrozenProviderPayload', 'Envelope', 'StatusResult', 'ProviderConnectResult', 'VerifiedIdentity'] as const;
const mapping = Object.fromEntries(roots.flatMap(name => [['request' + name, ids.request + '#/$defs/' + name], ['response' + name, ids.response + '#/$defs/' + name]]));
const raw = standaloneCode.default(ajv, mapping);
const bundled = await build({
    stdin: {
        contents: raw, resolveDir: root, sourcefile: 'validators.js'
    }, bundle: true, platform: 'neutral', format: 'esm', write: false, logLevel: 'silent'
});
const header = '// GENERATED from core/src/protocol/protocol.schema.json. Do not edit.\n';
const declarations = header + Object.entries(source.$defs).map(([key, value]) => `export type ${key} = ${key === 'Json' ? 'null | boolean | number | string | Json[] | { [key: string]: Json }' : key === 'JsonObject' || key === 'Schema' ? '{ [key: string]: Json }' : type(value)};`).join('\n') + '\n';
const compiled = '// @ts-nocheck\n' + header + bundled.outputFiles[0]!.text;
const wrapper = header + `import * as validators from './compiled.js';\nimport { assertJson, ProtocolError } from './validation.js';\nexport type WireName = ${roots.map(x => JSON.stringify(x)).join(' | ')};\nexport function validateWire(name:WireName,value:unknown,response=false):void {\n assertJson(value,response?1048576:name==='FrozenProviderPayload'?262144:65536);\n const validate=validators[(response?'response':'request')+name as keyof typeof validators];\n if(!validate(value))throw new ProtocolError('INVALID_INPUT');\n}\n`;
for (const dest of ['packages/core/src/protocol/generated', 'packages/sdk/src/generated']) {
    await mkdir(resolve(root, dest), {
        recursive: true
    });
    for (const [name, body] of [['types.ts', declarations], ['compiled.ts', compiled], ['validators.ts', wrapper], ['validation.ts', header + await readFile(resolve(root, 'packages/core/src/protocol/validation.ts'), 'utf8')]])
        await writeFile(resolve(root, dest, name!), name === 'validators.ts' && dest.startsWith('packages/core/') ? body!.replace("from './validation.js'", "from '../validation.js'") : body!);
}
await mkdir(resolve(root, 'docs/generated/protocol'), {
    recursive: true
});
await writeFile(resolve(root, 'docs/generated/protocol/protocol.schema.json'), JSON.stringify(source, null, 2) + '\n');
console.log('Generated standalone Ajv2020 validators, wire types and reference.');
