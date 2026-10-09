import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { defineProvider, ProviderDefinitionError } from "@syndroo/provider-sdk";
import type { ProviderPlugin, ProviderManifest } from "@syndroo/provider-sdk";
import { canonicalJson } from "@syndroo/core";
import type { LoadedProvider, ProviderCandidate } from "@syndroo/core";
import { digest } from "./inspect.js";
import { reject } from "./errors.js";

const SCHEMAS = ["connectOptions", "credentialInput", "content", "publishOptions"] as const;

export function checkedDefinition(value: unknown): ProviderPlugin {
  try { return defineProvider(value as ProviderPlugin); }
  catch (error) {
    if (error instanceof ProviderDefinitionError) {
      if (error.code === "invalid_api_version") return reject("PROVIDER_API_INCOMPATIBLE");
      if (error.code === "invalid_schema") return reject("PROVIDER_SCHEMA_INVALID");
    }
    return reject("PROVIDER_INVALID");
  }
}

/** Same approved-schema policy as Core's build compiler; no asynchronous loading or custom keywords. */
function checkSchemaPolicy(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach(checkSchemaPolicy); return; }
  const object = value as Record<string, unknown>;
  if (object.$ref !== undefined && (typeof object.$ref !== "string" || !object.$ref.startsWith("#/"))) {
    return reject("PROVIDER_SCHEMA_INVALID");
  }
  if (object.$async !== undefined || object.$data !== undefined) return reject("PROVIDER_SCHEMA_INVALID");
  if (typeof object.pattern === "string" && (object.pattern.length > 256
    || /\\[1-9]|\(\?[=!<]|\([^)]*[+*][^)]*\)[+*{]/.test(object.pattern))) return reject("PROVIDER_SCHEMA_INVALID");
  Object.values(object).forEach(checkSchemaPolicy);
}

export function schemaFingerprint(manifest: ProviderManifest): string {
  // Canonicalize schemas individually so the manifest wrapper does not consume their depth budget.
  return digest(JSON.stringify(SCHEMAS.map(key => [key, canonicalJson(manifest.schemas[key])])));
}

export function validatePlugin(value: unknown, candidate: ProviderCandidate): LoadedProvider {
  const plugin = checkedDefinition(value);
  if (plugin.manifest.id !== candidate.provider) return reject("PROVIDER_ID_MISMATCH");
  if (plugin.manifest.version !== candidate.version) return reject("PROVIDER_VERSION_MISMATCH");
  const validators = {} as LoadedProvider["validators"];
  try {
    for (const key of SCHEMAS) {
      const schema = plugin.manifest.schemas[key];
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) return reject("PROVIDER_SCHEMA_INVALID");
      checkSchemaPolicy(schema);
      const ajv = new Ajv2020({ strict: true, strictTypes: false, validateSchema: true,
        allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
      addFormats.default(ajv);
      if (!ajv.validateSchema(schema)) return reject("PROVIDER_SCHEMA_INVALID");
      const validate = ajv.compile(schema);
      validators[key] = (input: unknown) => validate(input) === true;
    }
    return { plugin, validators, implementation: {
      provider: candidate.provider, packageName: candidate.packageName, version: candidate.version,
      apiVersion: 1, artifactFingerprint: candidate.artifactFingerprint, schemaFingerprint: schemaFingerprint(plugin.manifest),
    } };
  } catch { return reject("PROVIDER_SCHEMA_INVALID"); }
}

/** Validate stored/static catalog data without importing a provider or compiling schemas. */
export function checkedManifest(value: unknown): ProviderManifest {
  const unused = () => { throw new Error("Catalog data has no executable operations"); };
  return checkedDefinition({ manifest: value, connect: { run: unused, verify: unused }, freeze: unused, publish: unused }).manifest;
}
