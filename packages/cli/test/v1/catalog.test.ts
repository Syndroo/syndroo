import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ResolvedConfig } from "../../src/config.js";
import { createLocalRuntime } from "../../src/runtime/local/composition.js";
import type { BuiltinProviderCatalogEntry } from "../../src/runtime/providers/index.js";
import { createNodeProviderRuntime } from "../../src/runtime/providers/index.js";
import { BUILTIN_PROVIDER_CATALOG } from "../../src/runtime/providers/generated/catalog.js";

/**
 * The built-in provider catalog and its wiring (C3-6).
 *
 * Two kinds of evidence live here:
 *
 * 1. the committed artifact itself, which must contain exactly the official
 *    providers, sorted, with repository-relative roots and no absolute path;
 * 2. the generator and the composition wiring, exercised against a throwaway
 *    repository whose `packages/provider-*` trees are the *real* provider
 *    sources built in-test with esbuild. That keeps the resolution evidence
 *    honest without requiring `npm run build` before `npm test`, which the v1
 *    gate deliberately does not do.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const GENERATOR = path.join(REPO_ROOT, "scripts", "generate-provider-catalog.ts");
const CATALOG_MODULE = path.join(
  REPO_ROOT,
  "packages",
  "cli",
  "src",
  "runtime",
  "providers",
  "generated",
  "catalog.ts",
);
const OFFICIAL_IDS = ["bluesky", "devto", "linkedin", "mastodon", "threads"] as const;

type GeneratorRun = { readonly code: number; readonly stdout: string; readonly stderr: string };

/** Run the real generator as a child process and capture everything. */
function runGenerator(args: readonly string[]): Promise<GeneratorRun> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [GENERATOR, ...args],
      { cwd: REPO_ROOT, encoding: "utf8" },
      (error, stdout, stderr) => {
        const exit =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : 1;

        resolve({ code: exit, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

/**
 * Build the real provider sources into a throwaway repository.
 *
 * Each package keeps the official name and version but is produced here, so the
 * catalog entry is generated from a package this process knows how to build.
 * `omit` leaves one package unbuilt, which is how the missing-package failure is
 * provoked without touching the real tree.
 */
async function buildRepository(root: string, omit?: string): Promise<void> {
  for (const id of OFFICIAL_IDS) {
    if (id === omit) {
      continue;
    }

    const source = path.join(REPO_ROOT, "packages", `provider-${id}`);
    const manifest = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    const target = path.join(root, "packages", `provider-${id}`);

    await fs.mkdir(path.join(target, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(target, "package.json"),
      `${JSON.stringify(
        {
          name: manifest.name,
          version: manifest.version,
          type: "module",
          exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
        },
        null,
        2,
      )}\n`,
    );
    await build({
      entryPoints: [path.join(source, "src", "index.ts")],
      outfile: path.join(target, "dist", "index.js"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      logLevel: "silent",
    });
  }
}

async function readCatalog(root: string): Promise<readonly BuiltinProviderCatalogEntry[]> {
  const file = path.join(root, "catalog.json");
  const run = await runGenerator(["--root", root, "--out", file, "--format", "json"]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(0);
  const entries = JSON.parse(
    await fs.readFile(file, "utf8"),
  ) as readonly BuiltinProviderCatalogEntry[];

  return entries.map((entry) => ({
    ...entry,
    resolvedRoot: path.resolve(root, entry.resolvedRoot),
  }));
}

function configFor(root: string, providers: Readonly<Record<string, { path: string }>>): ResolvedConfig {
  return {
    configFile: path.join(root, "config.json"),
    configDirectory: root,
    exists: true,
    stateRoot: path.join(root, "state"),
    providers: Object.fromEntries(
      Object.entries(providers).map(([id, entry]) => [id, path.resolve(root, entry.path)]),
    ),
  };
}

let workDir: string;

beforeAll(async () => {
  workDir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "syndroo-catalog-")));
});

afterAll(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe("committed provider catalog", () => {
  it("holds exactly the five official providers, sorted, with matching package versions", async () => {
    const providers = BUILTIN_PROVIDER_CATALOG.map((entry) => entry.provider);

    expect(providers).toEqual([...OFFICIAL_IDS]);

    for (const entry of BUILTIN_PROVIDER_CATALOG) {
      const manifest = await fs.readFile(
        path.join(REPO_ROOT, entry.resolvedRoot, "package.json"),
        "utf8",
      );

      expect(entry.manifest.id).toBe(entry.provider);
      expect(entry.manifest.apiVersion).toBe(1);
      expect(entry.manifest.version).toBe((JSON.parse(manifest) as { version: string }).version);
      expect(entry.artifactFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("stores repository-relative roots and embeds no absolute path", async () => {
    const text = await fs.readFile(CATALOG_MODULE, "utf8");

    expect(text).toContain("GENERATED FILE - DO NOT EDIT BY HAND");
    expect(text).not.toContain(REPO_ROOT);

    for (const entry of BUILTIN_PROVIDER_CATALOG) {
      expect(entry.resolvedRoot).toBe(`packages/provider-${entry.provider}`);
      expect(path.isAbsolute(entry.resolvedRoot)).toBe(false);
    }
  });

  it("registers the official providers without any config provider entry", async () => {
    const root = path.join(workDir, "committed");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "config.json"), "{}\n");
    const config: ResolvedConfig = {
      configFile: path.join(root, "config.json"),
      configDirectory: root,
      exists: true,
      stateRoot: path.join(root, "state"),
      providers: {},
    };

    const runtime = createLocalRuntime(config);
    const views = await runtime.providers.list();

    // The ids can only come from the generated catalog: the config declares no
    // provider at all. Whether the artifact is built yet only changes whether an
    // entry is `available` or `unavailable`; the official registration is fixed.
    expect(views.map((view) => view.provider)).toEqual([...OFFICIAL_IDS]);
    expect(views.every((view) => view.provenance === "official")).toBe(true);
    expect((await runtime.providers.describe("bluesky")).provenance).toBe("official");
  });
});

describe("provider catalog generator", () => {
  it("is deterministic and emits the official providers in sorted order", async () => {
    const root = path.join(workDir, "determinism");
    await buildRepository(root);
    const first = path.join(root, "first.ts");
    const second = path.join(workDir, "determinism-second.ts");

    const a = await runGenerator(["--root", root, "--out", first]);
    const b = await runGenerator(["--root", root, "--out", second]);

    expect(a.stderr).toBe("");
    expect(b.stderr).toBe("");
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.stdout).toContain([...OFFICIAL_IDS].join(", "));
    expect(await sha256(first)).toBe(await sha256(second));

    const text = await fs.readFile(first, "utf8");
    expect(text).not.toContain(root);
    expect(text.indexOf('"provider": "bluesky"')).toBeLessThan(text.indexOf('"provider": "threads"'));
  });

  it("detects drift against a committed catalog and passes when it matches", async () => {
    const root = path.join(workDir, "drift");
    await buildRepository(root);
    const committed = path.join(root, "catalog.ts");

    expect((await runGenerator(["--root", root, "--out", committed])).code).toBe(0);
    const matching = await runGenerator(["--root", root, "--out", committed, "--check"]);
    expect(matching.code).toBe(0);
    expect(matching.stdout).toContain("up to date");

    await fs.appendFile(path.join(root, "packages", "provider-bluesky", "dist", "index.js"), "\n");
    const drifted = await runGenerator(["--root", root, "--out", committed, "--check"]);
    expect(drifted.code).toBe(1);
    expect(drifted.stderr).toContain("drift");
  });

  it("fails listing the missing packages instead of emitting a partial catalog", async () => {
    const root = path.join(workDir, "missing");
    await buildRepository(root, "devto");
    const out = path.join(root, "catalog.ts");

    const run = await runGenerator(["--root", root, "--out", out]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("@syndroo/provider-devto");
    expect(run.stderr).toContain("build these packages first");
    await expect(fs.readFile(out, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("official provider resolution", () => {
  let root: string;
  let catalog: readonly BuiltinProviderCatalogEntry[];

  beforeAll(async () => {
    root = path.join(workDir, "resolution");
    await buildRepository(root);
    catalog = await readCatalog(root);
    await fs.mkdir(path.join(root, "override"), { recursive: true });
    // A second, independent build of the same official source: enough for the
    // override cases, which never need it to be approved.
    await buildRepository(path.join(root, "override-repo"));
    await fs.cp(
      path.join(root, "override-repo", "packages", "provider-bluesky"),
      path.join(root, "override"),
      { recursive: true },
    );
  });

  it("resolves an official provider through the catalog with no config entry", async () => {
    await fs.writeFile(path.join(root, "config.json"), "{}\n");
    const runtime = createNodeProviderRuntime({
      configFile: path.join(root, "config.json"),
      stateRoot: path.join(root, "state-catalog"),
      catalog,
    });

    expect(await runtime.registry.describe("bluesky")).toMatchObject({
      provider: "bluesky",
      provenance: "official",
      availability: "available",
    });
    // Loading is the proof the artifact is real and carries distribution trust.
    const loaded = await runtime.registry.load("bluesky");
    expect(loaded.implementation).toMatchObject({ provider: "bluesky", apiVersion: 1 });
    expect(loaded.plugin.manifest.id).toBe("bluesky");
  });

  it("still reaches the official provider through the CLI composition layer", async () => {
    const config: ResolvedConfig = configFor(root, {});
    await fs.writeFile(config.configFile, "{}\n");
    const runtime = createLocalRuntime(config, { catalog });

    expect(await runtime.providers.describe("bluesky")).toMatchObject({
      provenance: "official",
      availability: "available",
    });
  });

  it("lists the official providers when the default config file is absent", async () => {
    // F3a: the packed CLI must answer `status` on a machine that never wrote a
    // config file. The provider selector treats the missing file as "no
    // overrides" rather than invalid configuration, so the catalog still
    // decides - and its repository-relative roots resolve against the checkout.
    const config: ResolvedConfig = {
      configFile: path.join(root, "absent", "config.json"),
      configDirectory: path.join(root, "absent"),
      exists: false,
      stateRoot: path.join(root, "state-absent"),
      providers: {},
    };

    const runtime = createLocalRuntime(config, { catalog });
    const views = await runtime.providers.list();

    expect(views.map((view) => view.provider)).toEqual([...OFFICIAL_IDS]);
    expect(views.every((view) => view.provenance === "official")).toBe(true);
    expect(await runtime.providers.describe("bluesky")).toMatchObject({
      provenance: "official",
      availability: "available",
    });
  });

  it("lets an explicit config override replace the catalog entry", async () => {
    const config = configFor(root, { bluesky: { path: "override" } });
    await fs.writeFile(config.configFile, `${JSON.stringify({ providers: { bluesky: { path: "./override" } } })}\n`);

    const runtime = createNodeProviderRuntime({
      configFile: config.configFile,
      stateRoot: path.join(root, "state-override"),
      catalog,
    });

    expect((await runtime.loader.inspect("bluesky")).provenance).toBe("third_party");
    expect((await runtime.registry.describe("bluesky")).provenance).toBe("third_party");
    // The distribution approval does not carry over to the override.
    await expect(runtime.registry.load("bluesky")).rejects.toMatchObject({
      code: "PROVIDER_TRUST_REQUIRED",
    });
  });

  it("fails a broken override without falling back to the catalog", async () => {
    const config = configFor(root, { bluesky: { path: "absent" } });
    await fs.writeFile(config.configFile, `${JSON.stringify({ providers: { bluesky: { path: "./absent" } } })}\n`);

    const runtime = createNodeProviderRuntime({
      configFile: config.configFile,
      stateRoot: path.join(root, "state-broken"),
      catalog,
    });

    expect((await runtime.registry.describe("bluesky")).availability).toBe("unavailable");
    await expect(runtime.registry.load("bluesky")).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });

    // Removing the override restores the official catalog entry.
    await fs.writeFile(config.configFile, "{}\n");
    expect((await runtime.registry.describe("bluesky")).provenance).toBe("official");
  });
});
