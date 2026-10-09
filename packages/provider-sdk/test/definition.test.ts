import { describe, expect, it } from "vitest";

import { DEFINITION_LIMITS, ProviderDefinitionError, defineProvider } from "../src/index.js";
import type { ProviderPlugin } from "../src/index.js";
import { createFakeProvider } from "../../../tests/fixtures/providers/fake.js";

const VALID = createFakeProvider();
const encoder = new TextEncoder();

/** A schema whose serialized form is exactly `target` UTF-8 bytes. */
function schemaWithExactBytes(target: number): Record<string, unknown> {
  const base = { type: "object", description: "" };
  const baseBytes = encoder.encode(JSON.stringify(base)).length;
  return { type: "object", description: "x".repeat(target - baseBytes) };
}

/**
 * A chain whose JSON container nesting is exactly `levels`: each `not` adds one
 * object, so the depth is counted the way the documented bound counts it.
 */
function nestedSchema(levels: number): Record<string, unknown> {
  let node: unknown = true;
  for (let level = 0; level < levels; level += 1) {
    node = { not: node };
  }
  return node as Record<string, unknown>;
}

/** Spread-copy a valid plugin so one field can be replaced under test. */
function withManifest(manifest: unknown): ProviderPlugin {
  return { ...VALID, manifest } as unknown as ProviderPlugin;
}

function expectDefinitionError(definition: unknown, code: string): ProviderDefinitionError {
  try {
    defineProvider(definition as ProviderPlugin);
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderDefinitionError);
    const definitionError = error as ProviderDefinitionError;
    expect(definitionError.code).toBe(code);
    return definitionError;
  }
  throw new Error(`expected defineProvider to reject with ${code}`);
}

describe("defineProvider", () => {
  it("returns the same definition object it was given", () => {
    const accepted = defineProvider(VALID);

    expect(accepted).toBe(VALID);
    expect(accepted.manifest.apiVersion).toBe(1);
  });

  it("rejects any apiVersion other than 1", () => {
    expectDefinitionError(withManifest({ ...VALID.manifest, apiVersion: 2 }), "invalid_api_version");
    expectDefinitionError(withManifest({ ...VALID.manifest, apiVersion: "1" }), "invalid_api_version");
  });

  it("rejects an unknown or duplicated declared capability", () => {
    expectDefinitionError(
      withManifest({ ...VALID.manifest, declaredCapabilities: ["video"] }),
      "invalid_capability",
    );
    expectDefinitionError(
      withManifest({ ...VALID.manifest, declaredCapabilities: ["text", "text"] }),
      "duplicate_capability",
    );
  });

  it("requires an egress declaration a host could turn into a policy", () => {
    const missing = { ...VALID.manifest } as Record<string, unknown>;
    delete missing.egress;
    expect(expectDefinitionError(withManifest(missing), "invalid_egress").path)
      .toBe("definition.manifest.egress");

    const rejected: unknown[] = [
      { fixedOrigins: [] },
      { fixedOrigins: [], federated: false },
      { fixedOrigins: ["http://bsky.social"] },
      { fixedOrigins: ["https://bsky.social/"] },
      { fixedOrigins: ["https://bsky.social:8443"] },
      { fixedOrigins: ["https://user:pass@bsky.social"] },
      { fixedOrigins: ["https://bsky.social/xrpc"] },
      { fixedOrigins: ["https://bsky.social?x=1"] },
      { fixedOrigins: ["https://127.0.0.1"] },
      { fixedOrigins: ["https://localhost"] },
      { fixedOrigins: ["https://BSKY.social"] },
      { fixedOrigins: ["https://bsky.social", "https://bsky.social"] },
      { fixedOrigins: "https://bsky.social" },
      {
        fixedOrigins: Array.from({ length: DEFINITION_LIMITS.maxEgressOrigins + 1 }, (_unused, index) =>
          `https://host-${index}.example`),
      },
    ];
    for (const egress of rejected) {
      expectDefinitionError(withManifest({ ...VALID.manifest, egress }), "invalid_egress");
    }

    // The rule text is static: a rejected origin never travels into the error.
    const error = expectDefinitionError(
      withManifest({ ...VALID.manifest, egress: { fixedOrigins: ["https://canary.example"], federated: false } }),
      "invalid_egress",
    );
    expect(JSON.stringify(error)).not.toContain("canary.example");
  });

  it("accepts a fixed declaration and a federated one", () => {
    expect(defineProvider(
      withManifest({ ...VALID.manifest, egress: { fixedOrigins: ["https://bsky.social"] } }),
    ).manifest.egress).toEqual({ fixedOrigins: ["https://bsky.social"] });

    expect(defineProvider(
      withManifest({ ...VALID.manifest, egress: { fixedOrigins: [], federated: true } }),
    ).manifest.egress).toEqual({ fixedOrigins: [], federated: true });

    expect(defineProvider(
      withManifest({
        ...VALID.manifest,
        egress: { fixedOrigins: ["https://www.threads.net"], federated: true },
      }),
    ).manifest.egress).toEqual({ fixedOrigins: ["https://www.threads.net"], federated: true });
  });

  it("requires the four declared schemas", () => {
    const schemas = { ...VALID.manifest.schemas } as Record<string, unknown>;
    delete schemas.publishOptions;

    const error = expectDefinitionError(withManifest({ ...VALID.manifest, schemas }), "invalid_schema");

    expect(error.path).toBe("definition.manifest.schemas.publishOptions");
  });

  it("accepts a schema exactly at the documented size and depth bounds", () => {
    const schema = schemaWithExactBytes(DEFINITION_LIMITS.maxSchemaBytes);
    const deep = nestedSchema(DEFINITION_LIMITS.maxSchemaDepth);

    expect(encoder.encode(JSON.stringify(schema)).length).toBe(DEFINITION_LIMITS.maxSchemaBytes);
    expect(
      defineProvider(
        withManifest({
          ...VALID.manifest,
          schemas: { ...VALID.manifest.schemas, content: schema, publishOptions: deep },
        }),
      ).manifest.schemas.content,
    ).toBe(schema);
  });

  it("rejects a schema one byte over the documented size bound", () => {
    const oversized = schemaWithExactBytes(DEFINITION_LIMITS.maxSchemaBytes + 1);

    const error = expectDefinitionError(
      withManifest({ ...VALID.manifest, schemas: { ...VALID.manifest.schemas, content: oversized } }),
      "invalid_schema",
    );

    expect(error.path).toBe("definition.manifest.schemas.content");
    expect(error.message).toContain(String(DEFINITION_LIMITS.maxSchemaBytes));
  });

  it("rejects a schema one level past the documented depth bound", () => {
    expectDefinitionError(
      withManifest({
        ...VALID.manifest,
        schemas: { ...VALID.manifest.schemas, content: nestedSchema(DEFINITION_LIMITS.maxSchemaDepth + 1) },
      }),
      "invalid_schema",
    );
  });

  it("accepts only local schema references", () => {
    expectDefinitionError(
      withManifest({
        ...VALID.manifest,
        schemas: { ...VALID.manifest.schemas, content: { $ref: "https://example.test/schema.json" } },
      }),
      "invalid_schema",
    );
    expectDefinitionError(
      withManifest({
        ...VALID.manifest,
        schemas: { ...VALID.manifest.schemas, content: { $ref: "./local.json" } },
      }),
      "invalid_schema",
    );
    expect(
      defineProvider(
        withManifest({
          ...VALID.manifest,
          schemas: { ...VALID.manifest.schemas, content: { $ref: "#/$defs/text" } },
        }),
      ),
    ).toBeDefined();
  });

  it("rejects a schema that references itself", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.properties = { self: cyclic };

    expectDefinitionError(
      withManifest({ ...VALID.manifest, schemas: { ...VALID.manifest.schemas, content: cyclic } }),
      "invalid_schema",
    );
  });

  it("rejects non-JSON schema values without compiling the schema", () => {
    expectDefinitionError(
      withManifest({
        ...VALID.manifest,
        schemas: { ...VALID.manifest.schemas, content: { type: "object", validate: (): boolean => true } },
      }),
      "invalid_schema",
    );
    expectDefinitionError(
      withManifest({
        ...VALID.manifest,
        schemas: { ...VALID.manifest.schemas, content: { type: "object", maximum: Number.POSITIVE_INFINITY } },
      }),
      "invalid_schema",
    );
    expectDefinitionError(
      withManifest({
        ...VALID.manifest,
        schemas: { ...VALID.manifest.schemas, content: { type: "object", note: undefined } },
      }),
      "invalid_schema",
    );
  });

  it("rejects prototype-affecting keys", () => {
    const hostile = JSON.parse('{"type":"object","__proto__":{"polluted":true}}') as object;

    expectDefinitionError(
      withManifest({ ...VALID.manifest, schemas: { ...VALID.manifest.schemas, content: hostile } }),
      "unsafe_property",
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("never invokes a getter while validating a definition", () => {
    let reads = 0;
    const definition: Record<string, unknown> = { ...VALID };
    Object.defineProperty(definition, "manifest", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return VALID.manifest;
      },
    });

    expectDefinitionError(definition, "unsafe_property");
    expect(reads).toBe(0);
  });

  it("rejects symbol keys and non-object definitions", () => {
    const withSymbol: Record<string, unknown> = { ...VALID };
    Object.defineProperty(withSymbol, Symbol("hidden"), { enumerable: true, value: "x" });

    expectDefinitionError(withSymbol, "unsafe_property");
    expectDefinitionError(null, "invalid_definition");
    expectDefinitionError("not a provider", "invalid_definition");
  });

  it("requires freeze, publish and both connect operations", () => {
    const { freeze: _freeze, ...withoutFreeze } = VALID;
    const { publish: _publish, ...withoutPublish } = VALID;

    expectDefinitionError(withoutFreeze, "missing_operation");
    expectDefinitionError(withoutPublish, "missing_operation");
    expectDefinitionError({ ...VALID, connect: { run: VALID.connect.run } }, "missing_operation");
    expectDefinitionError({ ...VALID, connect: {} }, "missing_operation");
  });

  it("reports a static path and rule without echoing definition values", () => {
    const oversizedId = `secret-${"A".repeat(200)}`;

    const error = expectDefinitionError(withManifest({ ...VALID.manifest, id: oversizedId }), "invalid_manifest");

    expect(error.path).toBe("definition.manifest.id");
    expect(error.message).toContain("definition.manifest.id");
    expect(error.message).not.toContain("secret-");
    expect(error.message).not.toContain("AAAA");
  });

  it("never echoes a schema key or a schema value in a diagnostic", () => {
    const canary = "sk_live_FAKE_canary_value_for_diagnostics";

    const oversized = schemaWithExactBytes(DEFINITION_LIMITS.maxSchemaBytes + 1) as Record<string, unknown>;
    oversized[`secretKey-${canary}`] = { description: canary };
    const sizeError = expectDefinitionError(
      withManifest({ ...VALID.manifest, schemas: { ...VALID.manifest.schemas, content: oversized } }),
      "invalid_schema",
    );
    expect(JSON.stringify({ message: sizeError.message, path: sizeError.path, rule: sizeError.rule })).not.toContain(
      canary,
    );

    const tooDeep = nestedSchema(DEFINITION_LIMITS.maxSchemaDepth + 1) as Record<string, unknown>;
    tooDeep[`secretKey-${canary}`] = canary;
    const depthError = expectDefinitionError(
      withManifest({ ...VALID.manifest, schemas: { ...VALID.manifest.schemas, content: tooDeep } }),
      "invalid_schema",
    );
    expect(JSON.stringify({ message: depthError.message, path: depthError.path, rule: depthError.rule })).not.toContain(
      canary,
    );
    expect(depthError.path).toBe("definition.manifest.schemas.content");
  });

  it("does not touch the clock, the network or the filesystem while validating", () => {
    // The fake definition holds no I/O capability, so a successful validation of
    // it is only possible if nothing here performs I/O.
    const accepted = defineProvider(createFakeProvider({ declaredCapabilities: ["text", "article"] }));

    expect(accepted.manifest.declaredCapabilities).toEqual(["text", "article"]);
  });
});
