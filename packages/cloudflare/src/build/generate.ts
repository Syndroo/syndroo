/** Offline build step: embed the checked CLI catalog and standalone schema validators. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const catalogModule = await import(resolve(root, 'packages/cli/src/runtime/providers/generated/catalog.ts'));
const catalog = catalogModule.BUILTIN_PROVIDER_CATALOG as {
  provider: string; packageName: string; artifactFingerprint: string;
  manifest: { schemas: Record<string, object>; [key: string]: unknown };
}[];
if (catalog.length !== 5) throw Error('OFFICIAL_CATALOG_INVALID');
const ajv = new Ajv2020({ strict: true, strictTypes: false, validateSchema: true,
  code: { source: true, esm: true }, coerceTypes: false, useDefaults: false, removeAdditional: false });
const mapping: Record<string, string> = {};
for (const entry of catalog) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(entry.provider)
    || !/^[0-9a-f]{64}$/.test(entry.artifactFingerprint)) throw Error('OFFICIAL_CATALOG_INVALID');
  for (const [name, schema] of Object.entries(entry.manifest.schemas)) {
    const id = `https://syndroo.invalid/worker/${entry.provider}/${name}`;
    ajv.addSchema({ ...schema, $id: id });
    mapping[`${entry.provider}_${name}`] = id;
  }
}
const raw = standaloneCode.default(ajv, mapping);
const bundled = await build({ stdin: { contents: raw, resolveDir: root, sourcefile: 'validators.js' },
  bundle: true, platform: 'neutral', format: 'esm', write: false, logLevel: 'silent' });
const output = resolve(root, 'packages/cloudflare/src/providers');
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'catalog.ts'),
  '// Generated from the checked official catalog. Do not edit.\nexport const catalog = '
  + JSON.stringify(catalog) + ' as const;\n');
await writeFile(resolve(output, 'validators.ts'),
  '// @ts-nocheck\n// Standalone Ajv2020 output; no runtime schema compiler.\n'
  + bundled.outputFiles[0]!.text);
