/**
 * `defineProvider` — bounded structural validation for a Provider definition.
 *
 * What this does: check that the supplied definition is a plain object with the
 * shape `ProviderPlugin` promises, using a fixed budget for depth, node count,
 * key count and string length. A manifest that is too large or too deep is
 * rejected before anything reads it.
 *
 * What this deliberately does not do:
 *
 * - it never compiles or evaluates a schema, never resolves `$ref`, and never
 *   calls a user-supplied function during validation;
 * - it never authenticates, never imports a provider module, and never touches
 *   the filesystem, the network or the clock on load or on call;
 * - it never reads a property through a getter. Own-property descriptors are
 *   inspected instead, so validation cannot run attacker-supplied code;
 * - it does not copy or wrap the definition. The same object is returned, so a
 *   provider package's default export stays the object the author wrote.
 *
 * Error messages carry a static path and a rule description only. They never
 * echo a value from the definition, because manifest values can be derived from
 * secrets and error text travels to logs.
 */

import type { ProviderPlugin } from "./types.js";

/**
 * Fixed budgets for structural validation. Changing one is an API decision.
 *
 * The two schema budgets are the architecture's, not this module's choice: a
 * declared schema is at most 65,536 bytes (64 KiB) and nests at most 32 levels
 * deep, with local references only. There is deliberately no separate key-count,
 * item-count or string-length cap, because those are not the reviewed bound and
 * a tighter invented limit would silently reject an accepted schema.
 *
 * The identifier budgets are SDK guards for the manifest's own identity fields
 * (not for schemas). They bound a string that reaches logs and fingerprints;
 * they are recorded here so the choice is visible rather than silent.
 */
export const DEFINITION_LIMITS = Object.freeze({
  /** Documented schema size bound: 64 KiB of UTF-8 JSON per schema. */
  maxSchemaBytes: 65536,
  /** Documented schema nesting bound. */
  maxSchemaDepth: 32,
  /** Longest accepted `manifest.id`. */
  maxProviderIdLength: 64,
  /** Longest accepted `manifest.name`. */
  maxNameLength: 128,
  /** Longest accepted `manifest.version`. */
  maxVersionLength: 64,
  /** Distinct declared capabilities a manifest may list. */
  maxDeclaredCapabilities: 8,
  /** Distinct canonical origins a manifest's egress declaration may list. */
  maxEgressOrigins: 20,
});

/** Stable, static failure reasons. Callers may branch on `code`. */
export type ProviderDefinitionErrorCode =
  | "invalid_definition"
  | "invalid_manifest"
  | "invalid_api_version"
  | "invalid_capability"
  | "duplicate_capability"
  | "invalid_schema"
  | "invalid_egress"
  | "unsafe_property"
  | "missing_operation";

/**
 * Raised when a definition fails bounded structural validation.
 *
 * `path` is a static property path such as `definition.manifest.schemas.content`.
 * `rule` is a static sentence. Neither contains a value from the definition.
 */
export class ProviderDefinitionError extends Error {
  readonly code: ProviderDefinitionErrorCode;
  readonly path: string;
  readonly rule: string;

  constructor(code: ProviderDefinitionErrorCode, path: string, rule: string) {
    super(`provider definition rejected at ${path}: ${rule}`);
    this.name = "ProviderDefinitionError";
    this.code = code;
    this.path = path;
    this.rule = rule;
  }
}

const CAPABILITIES: ReadonlySet<string> = new Set(["text", "article"]);
const SCHEMA_KEYS = ["connectOptions", "credentialInput", "content", "publishOptions"] as const;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Read an own data property without ever invoking a getter. */
function readDataProperty(
  owner: Record<string, unknown>,
  key: string,
  path: string,
  code: ProviderDefinitionErrorCode,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined) {
    return undefined;
  }
  if (!("value" in descriptor)) {
    throw new ProviderDefinitionError(code, `${path}.${key}`, "accessor properties are not allowed");
  }
  return descriptor.value;
}

function assertOwnPropertiesAreData(
  owner: object,
  path: string,
  code: ProviderDefinitionErrorCode,
): void {
  if (Object.getOwnPropertySymbols(owner).length > 0) {
    throw new ProviderDefinitionError(code, path, "symbol keys are not allowed");
  }
  for (const name of Object.getOwnPropertyNames(owner)) {
    if (FORBIDDEN_KEYS.has(name)) {
      throw new ProviderDefinitionError(code, `${path}.${name}`, "prototype-affecting key is not allowed");
    }
    if (!("value" in (Object.getOwnPropertyDescriptor(owner, name) ?? {}))) {
      throw new ProviderDefinitionError(code, `${path}.${name}`, "accessor properties are not allowed");
    }
  }
}

/** UTF-8 byte length of a string, computed without a Node-only Buffer. */
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

type SchemaWalkState = { stack: Set<object>; depth: number; bytes: number };

/**
 * Charge the walk with a lower bound on the serialized size of what it has
 * seen, and stop as soon as the documented bound is certainly exceeded. The
 * accounting only ever adds bytes JSON would have to contain, so it can never
 * reject a schema that fits.
 */
function chargeSchemaBytes(state: SchemaWalkState, bytes: number, slot: string): void {
  state.bytes += bytes;
  if (state.bytes > DEFINITION_LIMITS.maxSchemaBytes) {
    throw new ProviderDefinitionError(
      "invalid_schema",
      slot,
      `exceeds the documented ${DEFINITION_LIMITS.maxSchemaBytes}-byte schema bound`,
    );
  }
}

/**
 * Walk one declared schema and enforce the reviewed bounds.
 *
 * The walk is a plain descriptor read. Nothing is compiled, resolved or called,
 * so a hostile schema can only be rejected or accepted, never executed.
 *
 * Diagnostics stay static. `slot` names the manifest field under test and the
 * walk appends only numeric array positions it produced itself; a schema key or
 * value is never copied into an error path or message, because a schema key can
 * be derived from a secret and error text travels to logs.
 */
function walkSchema(value: unknown, slot: string, state: SchemaWalkState): void {
  if (value === null) {
    chargeSchemaBytes(state, 4, slot);
    return;
  }
  if (typeof value === "boolean") {
    chargeSchemaBytes(state, 4, slot);
    return;
  }
  if (typeof value === "string") {
    chargeSchemaBytes(state, utf8Bytes(value) + 2, slot);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ProviderDefinitionError("invalid_schema", slot, "non-finite numbers are not JSON");
    }
    chargeSchemaBytes(state, 1, slot);
    return;
  }
  if (typeof value !== "object") {
    throw new ProviderDefinitionError("invalid_schema", slot, `a schema cannot contain a ${typeof value} value`);
  }
  if (state.depth >= DEFINITION_LIMITS.maxSchemaDepth) {
    throw new ProviderDefinitionError(
      "invalid_schema",
      slot,
      `nested deeper than the documented ${DEFINITION_LIMITS.maxSchemaDepth}-level schema bound`,
    );
  }
  if (state.stack.has(value)) {
    throw new ProviderDefinitionError("invalid_schema", slot, "a schema cannot contain a reference cycle");
  }
  state.stack.add(value);

  if (Array.isArray(value)) {
    assertOwnPropertiesAreData(value, slot, "invalid_schema");
    state.depth += 1;
    for (let index = 0; index < value.length; index += 1) {
      chargeSchemaBytes(state, 2, slot);
      walkSchema(Object.getOwnPropertyDescriptor(value, String(index))?.value, `${slot}[${index}]`, state);
    }
    state.depth -= 1;
    state.stack.delete(value);
    return;
  }

  if (!isPlainObject(value)) {
    throw new ProviderDefinitionError("invalid_schema", slot, "a schema must be a plain JSON object");
  }

  for (const name of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_KEYS.has(name)) {
      throw new ProviderDefinitionError("unsafe_property", slot, "prototype-affecting key is not allowed");
    }
    chargeSchemaBytes(state, utf8Bytes(name) + 3, slot);
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new ProviderDefinitionError("unsafe_property", slot, "accessor properties are not allowed");
    }
    // Local references only; a remote or file reference is not retrievable here
    // and must not be resolved later.
    if (name === "$ref" && (typeof descriptor.value !== "string" || !descriptor.value.startsWith("#"))) {
      throw new ProviderDefinitionError("invalid_schema", slot, "only local # references are allowed");
    }
    state.depth += 1;
    walkSchema(descriptor.value, slot, state);
    state.depth -= 1;
  }
  state.stack.delete(value);
}

/** Enforce the documented per-schema size bound on the exact serialized form. */
function assertExactSchemaSize(value: unknown, slot: string): void {
  const serialized = JSON.stringify(value);
  if (utf8Bytes(serialized) > DEFINITION_LIMITS.maxSchemaBytes) {
    throw new ProviderDefinitionError(
      "invalid_schema",
      slot,
      `exceeds the documented ${DEFINITION_LIMITS.maxSchemaBytes}-byte schema bound`,
    );
  }
}

function assertStringProperty(
  owner: Record<string, unknown>,
  key: string,
  path: string,
  maxLength: number,
): string {
  const value = readDataProperty(owner, key, path, "invalid_manifest");
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderDefinitionError("invalid_manifest", `${path}.${key}`, "expected a non-empty string");
  }
  if (value.length > maxLength) {
    throw new ProviderDefinitionError(
      "invalid_manifest",
      `${path}.${key}`,
      `longer than the ${maxLength}-character budget`,
    );
  }
  return value;
}

/**
 * A canonical origin is exactly `https://` + a DNS hostname, with no userinfo,
 * no port, no path, no query and no fragment, in the canonical lowercase form
 * `URL#origin` produces. Anything else cannot be compared against a request
 * URL safely, so it is rejected before a host builds an allowlist from it.
 */
function isCanonicalHttpsOrigin(value: string): boolean {
  if (value.length === 0 || value.length > 255) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:"
    && url.username === ""
    && url.password === ""
    && url.port === ""
    && url.pathname === "/"
    && url.search === ""
    && url.hash === ""
    && url.origin === value
    && url.hostname.includes(".")
    && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)
    && !url.hostname.includes(":")
  );
}

/**
 * The manifest's declared network scope. The host transport is built from this
 * data, so a declaration the host could not turn into a policy is rejected
 * here. Diagnostics stay static: no declared origin is echoed in an error.
 */
function assertEgress(manifest: Record<string, unknown>, path: string): void {
  const slot = `${path}.egress`;
  const egress = readDataProperty(manifest, "egress", path, "invalid_egress");
  if (!isPlainObject(egress)) {
    throw new ProviderDefinitionError("invalid_egress", slot, "expected a plain object egress declaration");
  }
  assertOwnPropertiesAreData(egress, slot, "invalid_egress");

  const federated = readDataProperty(egress, "federated", slot, "invalid_egress");
  if (federated !== undefined && federated !== true) {
    throw new ProviderDefinitionError("invalid_egress", `${slot}.federated`, "expected true when present");
  }

  const fixed = readDataProperty(egress, "fixedOrigins", slot, "invalid_egress");
  if (!Array.isArray(fixed)) {
    throw new ProviderDefinitionError("invalid_egress", `${slot}.fixedOrigins`, "expected an array of origins");
  }
  if (fixed.length > DEFINITION_LIMITS.maxEgressOrigins) {
    throw new ProviderDefinitionError(
      "invalid_egress",
      `${slot}.fixedOrigins`,
      `lists more than the ${DEFINITION_LIMITS.maxEgressOrigins}-origin budget`,
    );
  }
  if (fixed.length === 0 && federated !== true) {
    throw new ProviderDefinitionError(
      "invalid_egress",
      `${slot}.fixedOrigins`,
      "expected at least one origin unless the manifest declares federated: true",
    );
  }
  const seen = new Set<string>();
  for (let index = 0; index < fixed.length; index += 1) {
    const origin = fixed[index];
    const item = `${slot}.fixedOrigins[${index}]`;
    if (typeof origin !== "string" || !isCanonicalHttpsOrigin(origin)) {
      throw new ProviderDefinitionError(
        "invalid_egress",
        item,
        "expected a canonical https origin with a DNS host and no port, path, query or fragment",
      );
    }
    if (seen.has(origin)) {
      throw new ProviderDefinitionError("invalid_egress", item, "an origin may be declared once");
    }
    seen.add(origin);
  }
}

function assertManifest(manifest: unknown): void {
  const path = "definition.manifest";
  if (!isPlainObject(manifest)) {
    throw new ProviderDefinitionError("invalid_manifest", path, "expected a plain object");
  }
  assertOwnPropertiesAreData(manifest, path, "unsafe_property");

  assertStringProperty(manifest, "id", path, DEFINITION_LIMITS.maxProviderIdLength);
  assertStringProperty(manifest, "name", path, DEFINITION_LIMITS.maxNameLength);
  assertStringProperty(manifest, "version", path, DEFINITION_LIMITS.maxVersionLength);

  const apiVersion = readDataProperty(manifest, "apiVersion", path, "invalid_manifest");
  if (apiVersion !== 1) {
    throw new ProviderDefinitionError(
      "invalid_api_version",
      `${path}.apiVersion`,
      "this SDK implements provider API version 1 only",
    );
  }

  const declared = readDataProperty(manifest, "declaredCapabilities", path, "invalid_manifest");
  if (!Array.isArray(declared)) {
    throw new ProviderDefinitionError("invalid_manifest", `${path}.declaredCapabilities`, "expected an array");
  }
  if (declared.length > DEFINITION_LIMITS.maxDeclaredCapabilities) {
    throw new ProviderDefinitionError(
      "invalid_capability",
      `${path}.declaredCapabilities`,
      `lists more than the ${DEFINITION_LIMITS.maxDeclaredCapabilities}-capability budget`,
    );
  }
  const seen = new Set<string>();
  for (let index = 0; index < declared.length; index += 1) {
    const entry = declared[index];
    if (typeof entry !== "string" || !CAPABILITIES.has(entry)) {
      throw new ProviderDefinitionError(
        "invalid_capability",
        `${path}.declaredCapabilities[${index}]`,
        'expected "text" or "article"',
      );
    }
    if (seen.has(entry)) {
      throw new ProviderDefinitionError(
        "duplicate_capability",
        `${path}.declaredCapabilities[${index}]`,
        "a capability may be declared once",
      );
    }
    seen.add(entry);
  }

  assertEgress(manifest, path);

  const schemas = readDataProperty(manifest, "schemas", path, "invalid_manifest");
  if (!isPlainObject(schemas)) {
    throw new ProviderDefinitionError("invalid_schema", `${path}.schemas`, "expected a plain object");
  }
  assertOwnPropertiesAreData(schemas, `${path}.schemas`, "unsafe_property");

  for (const key of SCHEMA_KEYS) {
    const schema = readDataProperty(schemas, key, `${path}.schemas`, "invalid_schema");
    const slot = `${path}.schemas.${key}`;
    if (schema === undefined) {
      throw new ProviderDefinitionError("invalid_schema", slot, "schema is required");
    }
    walkSchema(schema, slot, { stack: new Set<object>(), depth: 0, bytes: 0 });
    assertExactSchemaSize(schema, slot);
  }
}

function assertOperation(owner: Record<string, unknown>, key: string, path: string): void {
  const value = readDataProperty(owner, key, path, "missing_operation");
  if (typeof value !== "function") {
    throw new ProviderDefinitionError("missing_operation", `${path}.${key}`, "expected a function");
  }
}

/**
 * Validate a Provider definition and return it unchanged.
 *
 * The returned value is the same object identity that was supplied, so a
 * provider package can use `export default defineProvider({...})` and callers
 * can still compare identity. No runtime schema compilation, import or I/O
 * happens here; schemas are only size-checked.
 */
export function defineProvider<T extends ProviderPlugin>(definition: T): T {
  if (!isPlainObject(definition)) {
    throw new ProviderDefinitionError("invalid_definition", "definition", "expected a plain object");
  }
  assertOwnPropertiesAreData(definition, "definition", "unsafe_property");
  assertManifest(readDataProperty(definition, "manifest", "definition", "invalid_manifest"));

  const connect = readDataProperty(definition, "connect", "definition", "missing_operation");
  if (!isPlainObject(connect)) {
    throw new ProviderDefinitionError("missing_operation", "definition.connect", "expected an object");
  }
  assertOwnPropertiesAreData(connect, "definition.connect", "unsafe_property");
  assertOperation(connect, "run", "definition.connect");
  assertOperation(connect, "verify", "definition.connect");

  assertOperation(definition, "freeze", "definition");
  assertOperation(definition, "publish", "definition");

  return definition;
}
