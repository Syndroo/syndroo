import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createNodeProviderRuntime } from "../../../src/runtime/providers/index.js";
import { fixture, manifest } from "./support.js";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() { const f = await fixture(); fixtures.push(f); return f; }
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });
const approvedAt = "2026-10-09T00:00:00.000Z";

async function dependency(f: Awaited<ReturnType<typeof fixture>>, directory = f.base) {
  const root = path.join(directory, "node_modules", "fixture-dep");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture-dep", version: "1.0.0", type: "module", exports: "./index.mjs" }));
  const counter = path.join(f.base, "dependency-evaluations.txt");
  async function source(version: string) {
    await fs.writeFile(path.join(root, "index.mjs"), `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(counter)}, ${JSON.stringify(version)}); export const marker = ${JSON.stringify(version)};`);
  }
  await source("v1");
  await fs.writeFile(path.join(f.root, "package.json"), JSON.stringify({ ...f.packageJson, dependencies: { "fixture-dep": "1.0.0" } }));
  await f.source(manifest(), 'import { marker } from "fixture-dep"; if (!marker) throw Error("fixture");');
  return { root, counter, source };
}

it("binds actual declared dependency bytes, even though node_modules is excluded from the root walk", async () => {
  const f = await setup();
  const dep = await dependency(f);
  const { loader, registry } = createNodeProviderRuntime(f.options);
  const first = await loader.inspect("fake");
  await loader.approve(first, { fingerprint: first.artifactFingerprint, approvedAt, source: "interactive" });
  expect(await f.count()).toBe(0);
  await expect(fs.stat(dep.counter)).rejects.toMatchObject({ code: "ENOENT" });
  await dep.source("v2");
  expect((await registry.describe("fake")).availability).toBe("stale");
  await expect(loader.load(first)).rejects.toMatchObject({ code: "PROVIDER_TRUST_REQUIRED" });
  await expect(fs.stat(dep.counter)).rejects.toMatchObject({ code: "ENOENT" });
  const changed = await loader.inspect("fake");
  expect(changed.artifactFingerprint).not.toBe(first.artifactFingerprint);
  await loader.approve(changed, { fingerprint: changed.artifactFingerprint, approvedAt, source: "interactive" });
  await loader.load(changed);
  expect(await fs.readFile(dep.counter, "utf8")).toBe("v2");
  expect(await f.count()).toBe(1);
});

it("binds the reviewed lockfile independently from package version", async () => {
  const f = await setup();
  const { loader } = createNodeProviderRuntime(f.options);
  await fs.writeFile(path.join(f.base, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
  const candidate = await loader.inspect("fake");
  await loader.approve(candidate, { fingerprint: candidate.artifactFingerprint, approvedAt, source: "interactive" });
  await fs.writeFile(path.join(f.base, "package-lock.json"), '{"lockfileVersion":3,"packages":{"changed":{}}}');
  await expect(loader.load(candidate)).rejects.toMatchObject({ code: "PROVIDER_TRUST_REQUIRED" });
  expect(await f.count()).toBe(0);
});

it("rejects an unresolved declared dependency without importing or scanning unrelated packages", async () => {
  const f = await setup();
  await fs.writeFile(path.join(f.root, "package.json"), JSON.stringify({ ...f.packageJson, dependencies: { "fixture-missing": "1.0.0" } }));
  const unrelated = path.join(f.base, "node_modules", "unrelated");
  await fs.mkdir(unrelated, { recursive: true });
  await fs.symlink("/does-not-exist", path.join(unrelated, "package.json"));
  await expect(createNodeProviderRuntime(f.options).loader.inspect("fake")).rejects.toMatchObject({ code: "PROVIDER_DEPENDENCY_INVALID" });
  expect(await f.count()).toBe(0);
});

it("hashes the dependency Node will resolve for an absolute provider outside the config directory", async () => {
  const external = await setup();
  const config = await setup();
  const actual = await dependency(external);
  await fs.writeFile(config.configFile, JSON.stringify({ providers: { fake: { path: external.root } } }));
  // A decoy in the config directory must not substitute for the source's actual dependency tree.
  await dependency(config);
  const { loader } = createNodeProviderRuntime(config.options);
  const first = await loader.inspect("fake");
  await loader.approve(first, { fingerprint: first.artifactFingerprint, approvedAt, source: "interactive" });
  await actual.source("changed-actual-dependency");
  await expect(loader.load(first)).rejects.toMatchObject({ code: "PROVIDER_TRUST_REQUIRED" });
  expect(await external.count()).toBe(0);
});

it("records an absent optional dependency, including npm's optional override of dependencies", async () => {
  const f = await setup();
  await fs.writeFile(path.join(f.root, "package.json"), JSON.stringify({ ...f.packageJson,
    dependencies: { "fixture-optional": "1.0.0" }, optionalDependencies: { "fixture-optional": "1.0.0" },
  }));
  const { loader } = createNodeProviderRuntime(f.options);
  const candidate = await loader.inspect("fake");
  await loader.approve(candidate, { fingerprint: candidate.artifactFingerprint, approvedAt, source: "interactive" });
  await loader.load(candidate);
  expect(await f.count()).toBe(1);
});

it("bounds directory nesting even when directories contain no files", async () => {
  const f = await setup();
  let nested = f.root;
  for (let index = 0; index < 34; index++) { nested = path.join(nested, "d"); await fs.mkdir(nested); }
  await expect(createNodeProviderRuntime(f.options).loader.inspect("fake")).rejects.toMatchObject({ code: "PROVIDER_ARTIFACT_INVALID" });
  expect(await f.count()).toBe(0);
});
