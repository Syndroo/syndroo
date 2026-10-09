import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createNodeProviderRuntime } from "../../../src/runtime/providers/index.js";
import { fixture, manifest, metadata } from "./support.js";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() {
  const f = await fixture();
  fixtures.push(f);
  return f;
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });

const approvedAt = "2026-10-09T00:00:00.000Z";
async function approved(f: Awaited<ReturnType<typeof fixture>>) {
  const runtime = createNodeProviderRuntime(f.options);
  const candidate = await runtime.loader.inspect("fake");
  await runtime.loader.approve(candidate, { fingerprint: candidate.artifactFingerprint, approvedAt, source: "interactive" });
  return { ...runtime, candidate };
}

it("inspect, discovery and a trust-required failure do not evaluate the plugin or create state", async () => {
  const f = await setup();
  const { loader, registry } = createNodeProviderRuntime(f.options);
  const candidate = await loader.inspect("fake");
  expect(candidate).toMatchObject({ provider: "fake", version: "1.0.0", resolvedRoot: f.root, provenance: "third_party" });
  expect(await f.count()).toBe(0);
  expect(await registry.describe("fake")).toEqual({ provider: "fake", provenance: "third_party", availability: "untrusted" });
  expect(await registry.list()).toHaveLength(1);
  expect(await f.count()).toBe(0);
  await expect(registry.load("fake")).rejects.toMatchObject({ code: "PROVIDER_TRUST_REQUIRED" });
  await expect(loader.load(candidate)).rejects.toThrow(f.root);
  await expect(loader.load(candidate)).rejects.toThrow("1.0.0");
  expect(await f.count()).toBe(0);
  await expect(fs.stat(f.stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

it("persists explicit approval before import, then saves a catalog that survives a new registry", async () => {
  const f = await setup();
  const { loader, registry, candidate } = await approved(f);
  expect(await f.count()).toBe(0);
  const files = await metadata(f.stateRoot);
  const approvalFile = Object.keys(files).find(name => name.startsWith("providers/approvals/") && name.endsWith(".json"));
  expect(approvalFile).toBeDefined();
  expect(files[approvalFile!]?.mode).toBe(0o600);
  const record = JSON.parse(await fs.readFile(path.join(f.stateRoot, approvalFile!), "utf8"));
  expect(record).toMatchObject({ fingerprint: candidate.artifactFingerprint, providerId: "fake", resolvedRoot: f.root,
    version: "1.0.0", source: "interactive", provenance: "third_party", approvedAt });
  expect(record.dependencySnapshot).toBeDefined();
  expect((await registry.describe("fake")).availability).toBe("unavailable");
  const [loaded, concurrent] = await Promise.all([loader.load(candidate), registry.load("fake")]);
  expect(loaded.implementation).toEqual(concurrent.implementation);
  expect(await f.count()).toBe(1);
  expect(loaded.validators.connectOptions({})).toBe(true);
  expect(loaded.validators.connectOptions({ unrecognized: true })).toBe(false);
  const restarted = createNodeProviderRuntime(f.options);
  expect(await restarted.registry.describe("fake")).toMatchObject({ availability: "available", manifest: manifest() });
  expect(await f.count()).toBe(1);
});

it("status and approved read-only loading leave file contents, mtimes and permissions unchanged", async () => {
  const f = await setup();
  const { registry } = await approved(f);
  await fs.mkdir(path.join(f.stateRoot, "secrets"), { mode: 0o700 });
  await fs.writeFile(path.join(f.stateRoot, "secrets", "canary"), "PRIVATE_SECRET", { mode: 0o000 });
  const before = await metadata(f.stateRoot);
  const opened = vi.spyOn(fs, "open");
  const read = vi.spyOn(fs, "readFile");
  await registry.describe("fake");
  await registry.list();
  expect(await f.count()).toBe(0);
  await registry.load("fake", "read_only");
  expect(await f.count()).toBe(1);
  expect([...opened.mock.calls, ...read.mock.calls].some(call => String(call[0]).includes("/secrets/"))).toBe(false);
  opened.mockRestore();
  read.mockRestore();
  const after = await metadata(f.stateRoot);
  expect(after).toEqual(before);
});

it("source changes revoke approval before evaluation; approving the new artifact permits loading", async () => {
  const f = await setup();
  const { loader, registry, candidate } = await approved(f);
  await fs.writeFile(path.join(f.root, "other.mjs"), "export const changed = true;");
  await expect(loader.load(candidate)).rejects.toMatchObject({ code: "PROVIDER_TRUST_REQUIRED" });
  expect(await f.count()).toBe(0);
  expect((await registry.describe("fake")).availability).toBe("stale");
  const changed = await loader.inspect("fake");
  expect(changed.artifactFingerprint).not.toBe(candidate.artifactFingerprint);
  await loader.approve(changed, { fingerprint: changed.artifactFingerprint, approvedAt, source: "interactive" });
  await loader.load(changed);
  expect(await f.count()).toBe(1);
});

it("fingerprints exactly the declared files set, so a packed install matches the checkout", async () => {
  const f = await setup();
  // Declare a published set the way a real package does: one entrypoint file
  // and one directory. Everything else in the checkout is repository-only.
  await fs.writeFile(
    path.join(f.root, "package.json"),
    JSON.stringify({ ...f.packageJson, files: ["index.mjs", "dist"] }),
  );
  const { loader } = createNodeProviderRuntime(f.options);
  const first = await loader.inspect("fake");
  // Repository-only files are not shipped, so they cannot move the digest.
  // That is the property a packed install depends on.
  await fs.mkdir(path.join(f.root, "tests"));
  await fs.writeFile(path.join(f.root, "tests", "test.js"), "throw Error('never read');");
  await fs.writeFile(path.join(f.root, "README.md"), "documentation");
  await fs.writeFile(path.join(f.root, "LICENSE.txt"), "license");
  await fs.mkdir(path.join(f.root, "src"));
  await fs.writeFile(path.join(f.root, "src", "index.ts"), "export const source = 1;");
  await fs.writeFile(path.join(f.root, "tsconfig.json"), "{}");
  await fs.writeFile(path.join(f.root, "payload.json"), "{}");
  expect((await loader.inspect("fake")).artifactFingerprint).toBe(first.artifactFingerprint);
  // A declared directory expands: a file below `dist` is part of the artifact.
  await fs.mkdir(path.join(f.root, "dist"), { recursive: true });
  await fs.writeFile(path.join(f.root, "dist", "record.json"), "{}");
  expect((await loader.inspect("fake")).artifactFingerprint).not.toBe(first.artifactFingerprint);
  // Without a `files` field the fallback rule applies: every walked file counts.
  await fs.writeFile(path.join(f.root, "package.json"), JSON.stringify(f.packageJson));
  const withoutFiles = await loader.inspect("fake");
  await fs.writeFile(path.join(f.root, "OTHER.md"), "documentation");
  expect((await loader.inspect("fake")).artifactFingerprint).not.toBe(withoutFiles.artifactFingerprint);
  expect(await f.count()).toBe(0);
});

it("binds approval to config/source and refuses fabricated candidates and distribution trust for overrides", async () => {
  const f = await setup();
  const { loader, candidate } = await approved(f);
  await expect(loader.approve({ ...candidate, resolvedRoot: f.base }, {
    fingerprint: candidate.artifactFingerprint, approvedAt, source: "interactive",
  })).rejects.toMatchObject({ code: "PROVIDER_TRUST_REQUIRED" });
  await expect(loader.approve(candidate, { fingerprint: candidate.artifactFingerprint, approvedAt, source: "distribution" }))
    .rejects.toMatchObject({ code: "PROVIDER_APPROVAL_INVALID" });
  await fs.writeFile(f.configFile, JSON.stringify({ providers: { fake: { path: f.root } } }));
  await expect(loader.load(candidate)).rejects.toMatchObject({ code: "PROVIDER_TRUST_REQUIRED" });
  expect(await f.count()).toBe(0);
});

it("refuses unsafe or unavailable approval persistence without evaluating code", async () => {
  const f = await setup();
  await fs.mkdir(f.stateRoot, { mode: 0o755 });
  const { loader } = createNodeProviderRuntime(f.options);
  const candidate = await loader.inspect("fake");
  await expect(loader.approve(candidate, { fingerprint: candidate.artifactFingerprint, approvedAt, source: "interactive" }))
    .rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });
  await expect(loader.load(candidate)).rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });
  expect(await f.count()).toBe(0);
});

it.each([
  ["wrong id", { ...manifest(), id: "wrong" }, "PROVIDER_ID_MISMATCH"],
  ["version drift", { ...manifest(), version: "2.0.0" }, "PROVIDER_VERSION_MISMATCH"],
  ["incompatible API", { ...manifest(), apiVersion: 2 }, "PROVIDER_API_INCOMPATIBLE"],
  ["noninteger API", { ...manifest(), apiVersion: 1.5 }, "PROVIDER_API_INCOMPATIBLE"],
  ["invalid schema", { ...manifest(), schemas: { ...manifest().schemas, content: { type: "string", maxLength: "wrong-type" } } }, "PROVIDER_SCHEMA_INVALID"],
] as const)("rejects %s after approved evaluation", async (_name, definition, code) => {
  const f = await setup();
  await f.source(definition);
  const { loader, candidate } = await approved(f);
  await expect(loader.load(candidate)).rejects.toMatchObject({ code });
  expect(await f.count()).toBe(1);
});

it.each([
  ["missing", { exports: null }, "PROVIDER_ENTRYPOINT_INVALID"],
  ["ambiguous", { exports: { import: "./index.mjs", default: "./another.mjs" } }, "PROVIDER_ENTRYPOINT_INVALID"],
  ["array", { exports: ["./index.mjs", "./another.mjs"] }, "PROVIDER_ENTRYPOINT_INVALID"],
  ["escape", { exports: "../outside.mjs" }, "PROVIDER_ENTRYPOINT_INVALID"],
  ["absent file", { exports: "./missing.mjs" }, "PROVIDER_ENTRYPOINT_INVALID"],
] as const)("rejects %s entrypoint metadata before evaluation", async (_name, patch, code) => {
  const f = await setup();
  await fs.writeFile(path.join(f.root, "package.json"), JSON.stringify({ ...f.packageJson, ...patch }));
  const { loader } = createNodeProviderRuntime(f.options);
  await expect(loader.inspect("fake")).rejects.toMatchObject({ code });
  expect(await f.count()).toBe(0);
});

it("rejects duplicate JSON metadata keys before import", async () => {
  const f = await setup();
  await fs.writeFile(path.join(f.root, "package.json"), '{"name":"fixture-plugin","version":"1.0.0","type":"module","exports":"./index.mjs","exports":"./evil.mjs"}');
  await expect(createNodeProviderRuntime(f.options).loader.inspect("fake")).rejects.toMatchObject({ code: "PROVIDER_METADATA_INVALID" });
  expect(await f.count()).toBe(0);
});

it("resolves each explicit config independently of cwd and never falls back from a broken override", async () => {
  const a = await setup();
  const b = await setup();
  const left = createNodeProviderRuntime(a.options);
  const right = createNodeProviderRuntime(b.options);
  expect((await left.loader.inspect("fake")).resolvedRoot).toBe(a.root);
  expect((await right.loader.inspect("fake")).resolvedRoot).toBe(b.root);
  await fs.rm(path.join(a.root, "index.mjs"));
  await expect(left.registry.load("fake")).rejects.toMatchObject({ code: "PROVIDER_ENTRYPOINT_INVALID" });
  expect((await left.registry.describe("fake")).availability).toBe("unavailable");
  expect(await b.count()).toBe(0);
});

it("a configured override never falls back to a registered official artifact", async () => {
  const official = await setup();
  const replacement = await setup();
  const candidate = await createNodeProviderRuntime(official.options).loader.inspect("fake");
  const runtime = createNodeProviderRuntime({ ...replacement.options, catalog: [{
    provider: "fake", packageName: "fixture-plugin", resolvedRoot: official.root,
    artifactFingerprint: candidate.artifactFingerprint, manifest: manifest(),
  }] });
  expect((await runtime.loader.inspect("fake")).provenance).toBe("third_party");
  await expect(runtime.registry.load("fake")).rejects.toMatchObject({ code: "PROVIDER_TRUST_REQUIRED" });
  expect(await official.count()).toBe(0);
  await replacement.source({ ...manifest(), id: "wrong" });
  const override = await runtime.loader.inspect("fake");
  await runtime.loader.approve(override, { fingerprint: override.artifactFingerprint, approvedAt, source: "interactive" });
  await expect(runtime.registry.load("fake")).rejects.toMatchObject({ code: "PROVIDER_ID_MISMATCH" });
  expect(await official.count()).toBe(0);
  expect(await replacement.count()).toBe(1);
  await fs.writeFile(replacement.configFile, '{"providers":{"fake":{"path":"./absent"}}}');
  await expect(runtime.registry.load("fake")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  expect(await official.count()).toBe(0);
  await fs.writeFile(replacement.configFile, '{"providers":{}}');
  expect((await runtime.loader.inspect("fake")).provenance).toBe("official");
  await runtime.registry.load("fake");
  expect(await official.count()).toBe(1);
});

it("catalog discovery never imports even a distribution-approved built-in", async () => {
  const f = await setup();
  const candidate = await createNodeProviderRuntime(f.options).loader.inspect("fake");
  await fs.writeFile(f.configFile, "{}");
  const runtime = createNodeProviderRuntime({ ...f.options, catalog: [{
    provider: "fake", packageName: "fixture-plugin", resolvedRoot: f.root,
    artifactFingerprint: candidate.artifactFingerprint, manifest: manifest(),
  }] });
  expect(await runtime.registry.describe("fake")).toMatchObject({ availability: "available", provenance: "official", manifest: manifest() });
  expect(await runtime.registry.list()).toEqual([expect.objectContaining({ provider: "fake", provenance: "official" })]);
  expect((await runtime.registry.list())[0]).not.toHaveProperty("manifest");
  expect(await f.count()).toBe(0);
  await expect(fs.stat(f.stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

it("missing catalog is an empty build, with no eager official imports", async () => {
  const f = await setup();
  await fs.writeFile(f.configFile, "{}");
  const { registry } = createNodeProviderRuntime(f.options);
  expect(await registry.list()).toEqual([]);
  await expect(registry.load("mastodon")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  expect(await f.count()).toBe(0);
});

it("a failed atomic approval commit cannot enable loading or expose its underlying diagnostic", async () => {
  const f = await setup();
  const { loader } = createNodeProviderRuntime(f.options);
  const candidate = await loader.inspect("fake");
  const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("PRIVATE_SECRET"));
  await expect(loader.approve(candidate, { fingerprint: candidate.artifactFingerprint, approvedAt, source: "interactive" }))
    .rejects.toMatchObject({ code: "PROVIDER_DURABILITY_ERROR", message: "PROVIDER_DURABILITY_ERROR" });
  rename.mockRestore();
  await expect(loader.load(candidate)).rejects.toMatchObject({ code: "PROVIDER_TRUST_REQUIRED" });
  expect(await f.count()).toBe(0);
});

it("rechecks the bytes after reading approval, before import", async () => {
  const f = await setup();
  const { loader, candidate } = await approved(f);
  const original = fs.open;
  let mutated = false;
  const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (!mutated && String(args[0]).includes("/providers/approvals/")) {
      mutated = true;
      await fs.appendFile(path.join(f.root, "index.mjs"), "\n// changed while approval was being read\n");
    }
    return handle;
  });
  await expect(loader.load(candidate)).rejects.toMatchObject({ code: "PROVIDER_TRUST_REQUIRED" });
  spy.mockRestore();
  expect(mutated).toBe(true);
  expect(await f.count()).toBe(0);
});

it("requires a fresh process after a loaded module changes, so cached dependencies cannot mask drift", async () => {
  const f = await setup();
  const { loader, candidate } = await approved(f);
  await loader.load(candidate);
  await fs.appendFile(path.join(f.root, "index.mjs"), "\n// new revision\n");
  const next = await loader.inspect("fake");
  await loader.approve(next, { fingerprint: next.artifactFingerprint, approvedAt, source: "interactive" });
  await expect(loader.load(next)).rejects.toMatchObject({ code: "PROVIDER_RESTART_REQUIRED" });
  expect(await f.count()).toBe(1);
});

it("compiles JSON Schema 2020-12 items:false and $ref siblings accurately without input mutation", async () => {
  const f = await setup();
  await f.source({ ...manifest(), schemas: { ...manifest().schemas,
    content: { type: "array", items: false },
    publishOptions: { $defs: { n: { type: "number" } }, $ref: "#/$defs/n", minimum: 2 },
    connectOptions: { type: "object", properties: { mode: { type: "string", default: "safe" } }, additionalProperties: false },
  } });
  const { loader, candidate } = await approved(f);
  const loaded = await loader.load(candidate);
  expect(loaded.validators.content([])).toBe(true);
  expect(loaded.validators.content([1])).toBe(false);
  expect(loaded.validators.publishOptions(1)).toBe(false);
  expect(loaded.validators.publishOptions(2)).toBe(true);
  const input = {};
  expect(loaded.validators.connectOptions(input)).toBe(true);
  expect(input).toEqual({});
  expect(loaded.validators.publishOptions("2")).toBe(false);
});

it.each([
  { type: "string", maxLength: "wrong-type" },
  { type: "array", minItems: -1 },
  { type: "object", required: "field" },
  { type: "string", pattern: "(a+)+" },
  { $ref: "https://example.invalid/schema" },
  { type: "string", description: "x".repeat(65536) },
])("rejects a malformed or unsafe schema before invoking provider operations", async schema => {
  const f = await setup();
  await f.source({ ...manifest(), schemas: { ...manifest().schemas, content: schema } });
  const { loader, candidate } = await approved(f);
  await expect(loader.load(candidate)).rejects.toMatchObject({ code: "PROVIDER_SCHEMA_INVALID" });
});

it("rejects schemas nested beyond depth 32", async () => {
  const f = await setup();
  let schema: object = { type: "string" };
  for (let depth = 0; depth < 33; depth++) schema = { not: schema };
  await f.source({ ...manifest(), schemas: { ...manifest().schemas, content: schema } });
  const { loader, candidate } = await approved(f);
  await expect(loader.load(candidate)).rejects.toMatchObject({ code: "PROVIDER_SCHEMA_INVALID" });
});

it("package-version drift requires new trust before evaluation, then mismatched manifest version fails", async () => {
  const f = await setup();
  const { loader, candidate } = await approved(f);
  await fs.writeFile(path.join(f.root, "package.json"), JSON.stringify({ ...f.packageJson, version: "2.0.0" }));
  await expect(loader.load(candidate)).rejects.toMatchObject({ code: "PROVIDER_TRUST_REQUIRED" });
  expect(await f.count()).toBe(0);
  const changed = await loader.inspect("fake");
  await loader.approve(changed, { fingerprint: changed.artifactFingerprint, approvedAt, source: "administrator" });
  await expect(loader.load(changed)).rejects.toMatchObject({ code: "PROVIDER_VERSION_MISMATCH" });
  expect(await f.count()).toBe(1);
});

it("rejects a missing default export after approval without treating named exports as a fallback", async () => {
  const f = await setup();
  const file = path.join(f.root, "index.mjs");
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("export default", "export const plugin ="));
  const { loader, candidate } = await approved(f);
  await expect(loader.load(candidate)).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
  expect(await f.count()).toBe(1);
});

it("does not expose a module's thrown exception through loader errors", async () => {
  const f = await setup();
  await f.source(manifest(), 'throw new Error("PRIVATE_SECRET_CANARY");');
  const { loader, candidate } = await approved(f);
  let caught: unknown;
  try { await loader.load(candidate); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ code: "PROVIDER_IMPORT_FAILED", message: "PROVIDER_IMPORT_FAILED" });
  expect(JSON.stringify(caught)).not.toContain("PRIVATE_SECRET_CANARY");
  expect(String(caught)).not.toContain("PRIVATE_SECRET_CANARY");
  expect(caught).not.toHaveProperty("cause");
});

it("saved catalog status remains read-only across registry instances after a successful load", async () => {
  const f = await setup();
  const { loader, candidate } = await approved(f);
  await loader.load(candidate);
  const before = await metadata(f.stateRoot);
  const { registry } = createNodeProviderRuntime(f.options);
  expect((await registry.describe("fake")).availability).toBe("available");
  expect(await registry.list()).toHaveLength(1);
  expect(await f.count()).toBe(1);
  expect(await metadata(f.stateRoot)).toEqual(before);
});

it("does not trust package names or self-declared provenance", async () => {
  const f = await setup();
  await fs.writeFile(path.join(f.root, "package.json"), JSON.stringify({ ...f.packageJson, name: "@syndroo/provider-fake", official: true }));
  const { loader, registry } = createNodeProviderRuntime(f.options);
  expect((await loader.inspect("fake")).provenance).toBe("third_party");
  await expect(registry.load("fake")).rejects.toMatchObject({ code: "PROVIDER_TRUST_REQUIRED" });
  expect(await f.count()).toBe(0);
});

it("rejects symlinked artifact files rather than hashing one file and importing another", async () => {
  const f = await setup();
  await fs.writeFile(path.join(f.base, "outside.mjs"), "throw Error('outside');");
  await fs.symlink(path.join(f.base, "outside.mjs"), path.join(f.root, "hidden.mjs"));
  await expect(createNodeProviderRuntime(f.options).loader.inspect("fake")).rejects.toMatchObject({ code: "PROVIDER_ARTIFACT_INVALID" });
  expect(await f.count()).toBe(0);
});
