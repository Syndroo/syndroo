/**
 * Acceptance rows PLG-03, PLG-04 and SCH-01, driven through the real provider
 * trust loader and the real Core composition (no injected registry, no
 * stand-in registry): every fixture here is a real ESM plugin package on disk
 * that the loader inspects, fingerprints, approves and imports.
 *
 * The rows share one property: the failure has to be *observable*. A broken
 * override must leave the registered official artifact unimported (its module
 * evaluation counter stays put) and must leave every write counter at zero; a
 * hostile schema must produce exactly zero network calls; a validation must
 * leave the caller's request byte-identical.
 *
 * The fixture plugin writes two counters next to (never inside) its own package
 * directory: one line per module evaluation, one line per `publish` call. Both
 * live outside the package so they cannot change the artifact fingerprint the
 * loader reviews.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type * as T from "@syndroo/core";
import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedConfig } from "../../../src/config.js";
import { createLocalRuntime } from "../../../src/runtime/local/composition.js";
import { createNodeProviderRuntime } from "../../../src/runtime/providers/index.js";
import type { BuiltinProviderCatalogEntry } from "../../../src/runtime/providers/index.js";

const APPROVED_AT = "2026-10-09T00:00:00.000Z";
const SLOTS = ["connectOptions", "credentialInput", "content", "publishOptions"] as const;
type Slot = (typeof SLOTS)[number];

const scratchRoots: string[] = [];
let sequence = 0;

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  scratchRoots.push(root);
  return root;
}

/** Lines in a counter file; a missing file is zero, never an error. */
async function count(file: string): Promise<number> {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.length > 0).length;
}

function context(): T.CallContext {
  sequence += 1;
  return { principalId: "owner", idempotencyKey: `acceptance-${sequence}`, signal: new AbortController().signal };
}

const VALID_SCHEMAS: Readonly<Record<Slot, string>> = {
  connectOptions: '{"type":"object","additionalProperties":false}',
  credentialInput:
    '{"type":"object","properties":{"token":{"type":"string","minLength":1}},"required":["token"],"additionalProperties":false}',
  content:
    '{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}',
  publishOptions: '{"type":"object","additionalProperties":false}',
};

/**
 * A manifest literal, with each schema slot injectable as raw JavaScript so a
 * hostile schema (cyclic, over-depth, over-size, remote `$ref`) can be written
 * exactly as a plugin author would write it.
 */
function manifestLiteral(id: string, options: { apiVersion?: number; schemas?: Partial<Record<Slot, string>> } = {}): string {
  const schemas = { ...VALID_SCHEMAS, ...(options.schemas ?? {}) };
  return `{ id: ${JSON.stringify(id)}, name: "Fixture ${id}", version: "1.0.0", apiVersion: ${options.apiVersion ?? 1},\n`
    + `  declaredCapabilities: ["text"], egress: { fixedOrigins: ["https://social.example"] },\n`
    + `  schemas: { connectOptions: ${schemas.connectOptions}, credentialInput: ${schemas.credentialInput},`
    + ` content: ${schemas.content}, publishOptions: ${schemas.publishOptions} } }`;
}

/** The same manifest as a value, for the catalog entry the loader validates. */
function manifestObject(id: string): T.ProviderManifest {
  return {
    id,
    name: `Fixture ${id}`,
    version: "1.0.0",
    apiVersion: 1,
    declaredCapabilities: ["text"],
    egress: { fixedOrigins: ["https://social.example"] },
    schemas: {
      connectOptions: { type: "object", additionalProperties: false },
      credentialInput: {
        type: "object",
        properties: { token: { type: "string", minLength: 1 } },
        required: ["token"],
        additionalProperties: false,
      },
      content: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      publishOptions: { type: "object", additionalProperties: false },
    },
  };
}

function pluginSource(manifest: string, counters: { evaluations: string; writes: string }): string {
  return `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(counters.evaluations)}, "evaluated\\n");
const manifest = ${manifest};
const account = { provider: manifest.id, accountId: "acct_demo", origin: "https://social.example" };
export default {
  manifest,
  connect: {
    async run(input) {
      if (input.type === "start") {
        return { status: "action_required", action: { type: "credential_input", fields: [{ name: "token", label: "Token", secret: true }] }, privateState: {} };
      }
      return { status: "done", credentials: { token: "fixture-token" }, identity: { account, evidence: [] } };
    },
    async verify() { return { account, evidence: [] }; }
  },
  freeze(input) {
    const effectiveContent = { text: input.content.text ?? "" };
    const effectiveOptions = { ...input.options };
    return { payloadVersion: 1, payload: { text: effectiveContent.text }, effectiveContent, effectiveOptions,
      preview: { content: effectiveContent, fields: [] } };
  },
  async publish(input) {
    appendFileSync(${JSON.stringify(counters.writes)}, "publish\\n");
    return { status: "succeeded", remoteId: "remote_" + input.frozen.payload.text };
  }
};
`;
}

type Package = {
  /** Absolute package directory the loader inspects. */
  readonly root: string;
  /** One line per module evaluation. */
  readonly evaluations: string;
  /** One line per `publish` call. */
  readonly writes: string;
};

/** Write a plugin package plus its two counters, outside the package directory. */
async function makePackage(root: string, name: string, manifest: string): Promise<Package> {
  const directory = path.join(root, "packages", name);
  const evaluations = path.join(root, `evaluations-${name}.txt`);
  const writes = path.join(root, `writes-${name}.txt`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify({ name: `fixture-${name}`, version: "1.0.0", type: "module", exports: "./index.mjs", files: ["index.mjs"] }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(directory, "index.mjs"), pluginSource(manifest, { evaluations, writes }));
  return { root: directory, evaluations, writes };
}

async function writeConfig(root: string, providers: Readonly<Record<string, string>>): Promise<string> {
  const configFile = path.join(root, "config.json");
  await fs.writeFile(
    configFile,
    `${JSON.stringify({ providers: Object.fromEntries(Object.entries(providers).map(([id, where]) => [id, { path: where }])) })}\n`,
  );
  return configFile;
}

function catalogEntry(provider: string, root: string, fingerprint: string): BuiltinProviderCatalogEntry {
  return {
    provider,
    packageName: `@syndroo/provider-${provider}`,
    resolvedRoot: root,
    artifactFingerprint: fingerprint,
    manifest: manifestObject(provider),
  };
}

const noNetworkTransport: T.ProviderTransport = {
  async request(): Promise<T.ProviderHttpResult> {
    throw new Error("the acceptance fixtures never issue a request");
  },
};

function resolvedConfig(configFile: string, stateRoot: string): ResolvedConfig {
  return {
    configFile,
    configDirectory: path.dirname(configFile),
    exists: true,
    stateRoot,
    providers: {},
  };
}

type Runtime = {
  readonly loader: ReturnType<typeof createNodeProviderRuntime>["loader"];
  readonly registry: ReturnType<typeof createNodeProviderRuntime>["registry"];
  readonly core: T.Core;
};

function runtime(root: string, configFile: string, catalog: readonly BuiltinProviderCatalogEntry[] = []): Runtime {
  const providers = createNodeProviderRuntime({
    configFile,
    stateRoot: path.join(root, "provider-state"),
    catalog,
  });
  const local = createLocalRuntime(resolvedConfig(configFile, path.join(root, "state")), {
    catalog,
    providers: providers.registry,
    transport: noNetworkTransport,
  });
  return { loader: providers.loader, registry: providers.registry, core: local.core };
}

async function approve(runtime: Runtime, provider: string): Promise<T.ProviderCandidate> {
  const candidate = await runtime.loader.inspect(provider);
  await runtime.loader.approve(candidate, {
    fingerprint: candidate.artifactFingerprint,
    approvedAt: APPROVED_AT,
    source: "interactive",
  });
  return candidate;
}

/** Inspect and approve without a full composition (the loader-only cases). */
async function approveWith(loader: Runtime["loader"], provider: string): Promise<T.ProviderCandidate> {
  const candidate = await loader.inspect(provider);
  await loader.approve(candidate, {
    fingerprint: candidate.artifactFingerprint,
    approvedAt: APPROVED_AT,
    source: "interactive",
  });
  return candidate;
}

async function connect(core: T.Core, provider: string): Promise<void> {
  const started = await core.connect({ type: "start", provider }, context());
  if (started.status !== "action_required") {
    throw new Error(`expected an action for ${provider}`);
  }
  const done = await core.connect(
    {
      type: "resume",
      connectSessionId: started.connectSessionId,
      stepRevision: started.stepRevision,
      input: { type: "credentials", credentials: { token: "fixture-token" } },
    },
    context(),
  );
  if (done.status !== "done") {
    throw new Error(`expected a completed connection for ${provider}`);
  }
}

async function prepare(core: T.Core, providers: readonly string[]): Promise<T.PreparedResult> {
  const result = await core.publish(
    { type: "prepare", content: { text: "hello" }, targets: providers.map((provider) => ({ provider })) },
    context(),
  );
  if (!("approvalToken" in result)) {
    throw new Error(`expected confirmation_required, got ${JSON.stringify(result)}`);
  }
  return result;
}

/** The fingerprint a catalog entry needs to match the inspected artifact. */
async function artifactFingerprint(root: string, provider: string, catalog: readonly BuiltinProviderCatalogEntry[]): Promise<string> {
  const probe = createNodeProviderRuntime({
    configFile: path.join(root, "probe-config.json"),
    stateRoot: path.join(root, "probe-state"),
    catalog,
  });
  const candidate = await probe.loader.inspect(provider);
  expect(candidate.artifactFingerprint).toMatch(/^[0-9a-f]{64}$/);
  return candidate.artifactFingerprint;
}

describe("PLG-03 provider override refusal", () => {
  it("refuses a broken override and never falls back to the registered official artifact", async () => {
    const root = await scratch("syndroo-plg03-");
    const official = await makePackage(root, "alpha-official", manifestLiteral("alpha"));
    await makePackage(root, "alpha-wrong-id", manifestLiteral("other"));
    await makePackage(root, "alpha-wrong-api", manifestLiteral("alpha", { apiVersion: 2 }));
    await makePackage(root, "alpha-wrong-schema", manifestLiteral("alpha", {
      schemas: { content: '{"type":"object","$ref":"https://evil.example/schema.json"}' },
    }));

    // Establish that the registered official artifact really is reachable on its
    // own: without this, "no fallback" would be unfalsifiable.
    const emptyConfig = await writeConfig(root, {});
    const placeholder = [catalogEntry("alpha", official.root, "0".repeat(64))];
    const fingerprint = await artifactFingerprint(root, "alpha", placeholder);
    const catalog = [catalogEntry("alpha", official.root, fingerprint)];
    const officialRuntime = runtime(root, emptyConfig, catalog);

    expect(await officialRuntime.registry.describe("alpha")).toMatchObject({
      provider: "alpha",
      provenance: "official",
      availability: "available",
    });
    await officialRuntime.registry.load("alpha");
    expect(await count(official.evaluations)).toBe(1);

    // Each broken override is a fresh configuration, never a mutated one.
    const cases: readonly {
      readonly name: string;
      readonly override: string;
      readonly root: string;
      readonly code: string;
      readonly inspected: boolean;
    }[] = [
      { name: "absent", override: "./packages/absent", root: path.join(root, "packages", "absent"), code: "PROVIDER_UNAVAILABLE", inspected: false },
      { name: "wrong-id", override: "./packages/alpha-wrong-id", root: path.join(root, "packages", "alpha-wrong-id"), code: "PROVIDER_ID_MISMATCH", inspected: true },
      { name: "wrong-api", override: "./packages/alpha-wrong-api", root: path.join(root, "packages", "alpha-wrong-api"), code: "PROVIDER_API_INCOMPATIBLE", inspected: true },
      { name: "wrong-schema", override: "./packages/alpha-wrong-schema", root: path.join(root, "packages", "alpha-wrong-schema"), code: "PROVIDER_SCHEMA_INVALID", inspected: true },
    ];

    for (const entry of cases) {
      const configFile = await writeConfig(root, { alpha: entry.override });
      const broken = createNodeProviderRuntime({
        configFile,
        stateRoot: path.join(root, `state-${entry.name}`),
        catalog,
      });

      // One availability value, whatever the failure: never "available".
      expect((await broken.registry.describe("alpha")).availability).not.toBe("available");

      if (!entry.inspected) {
        await expect(broken.loader.inspect("alpha")).rejects.toMatchObject({ code: entry.code });
      } else {
        // The override replaces the catalog entry before inspection: the root
        // the loader reviews is the override, never the official package.
        const candidate = await approveWith(broken.loader, "alpha");
        expect(candidate.resolvedRoot).toBe(entry.root);
        // Approval precedes import, so this reaches the plugin's own definition
        // and is refused there.
        await expect(broken.loader.load(candidate)).rejects.toMatchObject({ code: entry.code });
      }

      // The no-fallback assertion: the official package was never imported again.
      expect(await count(official.evaluations)).toBe(1);
    }
  });

  it("writes nothing when a prepare mixes a broken override with two valid targets", async () => {
    const root = await scratch("syndroo-plg03-mixed-");
    const official = await makePackage(root, "alpha-official", manifestLiteral("alpha"));
    const alpha = await makePackage(root, "alpha", manifestLiteral("alpha"));
    const beta = await makePackage(root, "beta", manifestLiteral("beta"));
    const gamma = await makePackage(root, "gamma", manifestLiteral("gamma"));

    const placeholder = [catalogEntry("alpha", official.root, "0".repeat(64))];
    const fingerprint = await artifactFingerprint(root, "alpha", placeholder);
    const catalog = [
      catalogEntry("alpha", official.root, fingerprint),
      catalogEntry("beta", beta.root, "1".repeat(64)),
      catalogEntry("gamma", gamma.root, "2".repeat(64)),
    ];

    const configFile = await writeConfig(root, {
      alpha: "./packages/alpha",
      beta: "./packages/beta",
      gamma: "./packages/gamma",
    });
    const subject = runtime(root, configFile, catalog);

    for (const provider of ["alpha", "beta", "gamma"]) {
      await approve(subject, provider);
      await connect(subject.core, provider);
    }

    expect(await count(alpha.evaluations)).toBe(1);
    expect(await count(beta.evaluations)).toBe(1);
    expect(await count(gamma.evaluations)).toBe(1);
    expect(await count(alpha.writes)).toBe(0);
    expect(await count(beta.writes)).toBe(0);
    expect(await count(gamma.writes)).toBe(0);

    // Control: the two valid targets really do publish when nothing is broken,
    // so a zero below is evidence about the broken target, not about the fixture.
    const control = await prepare(subject.core, ["beta"]);
    const controlResult = await subject.core.publish(
      { type: "execute", approvalToken: control.approvalToken },
      context(),
    );
    expect(controlResult).toMatchObject({ phase: "execution", status: "succeeded" });
    expect(await count(beta.writes)).toBe(1);

    // Break the alpha override by rewriting the artifact it points at.
    await fs.writeFile(
      path.join(alpha.root, "index.mjs"),
      pluginSource(manifestLiteral("other"), { evaluations: alpha.evaluations, writes: alpha.writes }),
    );

    await expect(prepare(subject.core, ["alpha", "beta", "gamma"])).rejects.toMatchObject({
      code: "PROVIDER_TRUST_REQUIRED",
    });

    // Every write count: unchanged by the refused prepare.
    expect(await count(alpha.writes)).toBe(0);
    expect(await count(beta.writes)).toBe(1);
    expect(await count(gamma.writes)).toBe(0);
    // And the registered official alpha artifact was never imported as a stand-in.
    expect(await count(official.evaluations)).toBe(0);
    expect(await count(alpha.evaluations)).toBe(1);
  });
});

describe("PLG-04 approval lifetime", () => {
  it("does not reuse an approval after the artifact bytes change", async () => {
    const root = await scratch("syndroo-plg04-fingerprint-");
    const plugin = await makePackage(root, "alpha", manifestLiteral("alpha"));
    const configFile = await writeConfig(root, { alpha: "./packages/alpha" });
    const subject = runtime(root, configFile);
    const candidate = await approve(subject, "alpha");
    await subject.loader.load(candidate);
    expect(await count(plugin.evaluations)).toBe(1);

    await fs.appendFile(path.join(plugin.root, "index.mjs"), "\n// a byte changed since the review\n");

    const changed = await subject.loader.inspect("alpha");
    expect(changed.artifactFingerprint).not.toBe(candidate.artifactFingerprint);
    expect(await subject.registry.describe("alpha")).toMatchObject({ availability: "stale" });

    // The old approval is refused, and the new revision is never imported implicitly.
    await expect(subject.loader.load(candidate)).rejects.toMatchObject({ code: "PROVIDER_TRUST_REQUIRED" });
    expect(await count(plugin.evaluations)).toBe(1);
  });

  it("deleting an override affects only new operations and refuses the old approval token", async () => {
    const root = await scratch("syndroo-plg04-override-");
    const official = await makePackage(root, "alpha-official", manifestLiteral("alpha"));
    const override = await makePackage(root, "alpha", manifestLiteral("alpha"));

    const placeholder = [catalogEntry("alpha", official.root, "0".repeat(64))];
    const fingerprint = await artifactFingerprint(root, "alpha", placeholder);
    const catalog = [catalogEntry("alpha", official.root, fingerprint)];

    const overrideConfig = await writeConfig(root, { alpha: "./packages/alpha" });
    const subject = runtime(root, overrideConfig, catalog);
    const candidate = await approve(subject, "alpha");
    expect(candidate.provenance).toBe("third_party");
    await connect(subject.core, "alpha");
    expect(await count(override.evaluations)).toBe(1);

    const prepared = await prepare(subject.core, ["alpha"]);
    expect(prepared.approvalToken).toMatch(/^appr_/);

    // Deleting the override is a new decision, and only new operations see it.
    await writeConfig(root, {});
    const replacement = await subject.loader.inspect("alpha");
    expect(replacement.provenance).toBe("official");
    expect(replacement.artifactFingerprint).toBe(fingerprint);
    await subject.loader.approve(replacement, {
      fingerprint: replacement.artifactFingerprint,
      approvedAt: APPROVED_AT,
      source: "interactive",
    });
    await subject.loader.load(replacement);
    expect(await count(official.evaluations)).toBe(1);

    // The token frozen against the override must be refused, not quietly
    // re-pointed at the artifact the catalog now selects.
    await expect(
      subject.core.publish({ type: "execute", approvalToken: prepared.approvalToken }, context()),
    ).rejects.toMatchObject({ code: "STALE_INTENT" });
    expect(await count(official.writes)).toBe(0);
    expect(await count(override.writes)).toBe(0);
  });
});

describe("SCH-01 schema layer", () => {
  it("never fetches a $ref, never mutates the request, and rejects hostile schemas", async () => {
    const root = await scratch("syndroo-sch01-");
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;

    // A fake network counter that would *succeed*: resolving
    // `https://evil.example/schema.json` would have to leave through fetch, and
    // a layer that quietly resolved it would accept this document and never
    // reach the explicit refusal asserted below.
    globalThis.fetch = ((input: unknown) => {
      calls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ type: "object", additionalProperties: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    try {
      let deep = '{"type":"object","additionalProperties":true}';
      for (let level = 0; level < 40; level += 1) {
        deep = `{"type":"object","properties":{"p":${deep}},"additionalProperties":true}`;
      }

      const cases: readonly { readonly name: string; readonly schemas: Partial<Record<Slot, string>> }[] = [
        { name: "remote-ref", schemas: { content: '{"type":"object","$ref":"https://evil.example/schema.json"}' } },
        {
          name: "cyclic",
          schemas: {
            content:
              '(() => { const cyclic = { type: "object" }; cyclic.properties = { self: cyclic }; return cyclic; })()',
          },
        },
        { name: "over-depth", schemas: { content: deep } },
        { name: "over-size", schemas: { content: `{"type":"object","description":"${"x".repeat(70000)}"}` } },
        { name: "unsupported-dialect", schemas: { content: '{"$schema":"http://json-schema.org/draft-04/schema#","type":"object"}' } },
      ];

      for (const entry of cases) {
        const plugin = await makePackage(root, `hostile-${entry.name}`, manifestLiteral("alpha", { schemas: entry.schemas }));
        const configFile = await writeConfig(root, { alpha: `./packages/hostile-${entry.name}` });
        const subject = runtime(root, configFile);
        const candidate = await approve(subject, "alpha");
        const failure = await subject.loader.load(candidate).then(
          () => undefined,
          (error: unknown) => error as { code: string; message: string },
        );

        expect(failure?.code, `${entry.name} must fail explicitly`).toBe("PROVIDER_SCHEMA_INVALID");
        // The rejection is static: no schema value and no URL is echoed back.
        expect(failure?.message).toBe("PROVIDER_SCHEMA_INVALID");
        expect(failure?.message ?? "").not.toContain("evil.example");
        expect(await count(plugin.evaluations)).toBe(1);
        expect(calls).toEqual([]);
      }

      // A conforming schema, so the mutation checks run against the real loader.
      const valid = await makePackage(root, "valid", manifestLiteral("alpha"));
      const configFile = await writeConfig(root, { alpha: "./packages/valid" });
      const subject = runtime(root, configFile);
      const candidate = await approve(subject, "alpha");
      const loaded = await subject.loader.load(candidate);

      const content = { text: "hello" };
      const contentBefore = structuredClone(content);
      expect(loaded.validators.content(content)).toBe(true);
      expect(content).toEqual(contentBefore);

      const options: Record<string, unknown> = {};
      expect(loaded.validators.publishOptions(options)).toBe(true);
      expect(options).toEqual({});

      // No coercion, and no removal of unknown keys: both would rewrite the input.
      const coerced = { text: 5 as unknown as string };
      expect(loaded.validators.content(coerced)).toBe(false);
      expect(coerced.text).toBe(5);

      const extra = { text: "x", extra: true };
      const extraBefore = structuredClone(extra);
      expect(loaded.validators.content(extra)).toBe(false);
      expect(extra).toEqual(extraBefore);

      // The same property end to end: the request handed to Core is unchanged.
      await connect(subject.core, "alpha");
      const request: T.PublishRequest = { type: "prepare", content: { text: "hello" }, targets: [{ provider: "alpha" }] };
      const requestBefore = structuredClone(request);
      const result = await subject.core.publish(request, context());
      expect(result).toMatchObject({ status: "confirmation_required" });
      expect(request).toEqual(requestBefore);
      expect(calls).toEqual([]);
      expect(await count(valid.writes)).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
