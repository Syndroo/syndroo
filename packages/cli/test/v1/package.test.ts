import { spawnSync } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * F3a: the packed `@syndroo/cli` is a real, standalone artifact.
 *
 * Everything here is produced the way a consumer would produce it: `npm pack`
 * writes the tarballs (running each package's `prepack` build), `npm install
 * --offline` installs them into a throwaway project with only local file
 * arguments, and every proof then runs that installed CLI. No registry is
 * contacted and no real credential is used.
 *
 * Two claims are separated deliberately:
 *
 * - the tarball must ship the bundle and the Skill, and no source, tests,
 *   `node_modules` or absolute build path;
 * - the installed CLI must answer `--version`, `--help` and `status --json`
 *   with no config and no state, list the five official providers from the
 *   built-in catalog, and still run a scripted prepare.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const OFFICIAL_IDS = ["bluesky", "devto", "linkedin", "mastodon", "threads"] as const;

/** Workspaces that must be packed for the consumer to install offline. */
const WORKSPACES = [
  "@syndroo/provider-sdk",
  ...OFFICIAL_IDS.map((id) => `@syndroo/provider-${id}`),
  "@syndroo/cli",
] as const;

/**
 * The CLI's external dependencies and their transitive closure, packed out of
 * this repository's `node_modules` so `npm install --offline` never needs the
 * registry. `commander`, `ajv` and `ajv-formats` are the declared runtime
 * dependencies the bundle leaves bare.
 */
const EXTERNAL_PACKAGES = [
  "commander",
  "ajv",
  "ajv-formats",
  "fast-deep-equal",
  "fast-uri",
  "json-schema-traverse",
  "require-from-string",
] as const;

type Run = { readonly code: number; readonly stdout: string; readonly stderr: string };

let workDir: string;
let packDir: string;
let consumerDir: string;
let cliBin: string;
let tarballs: readonly string[];
let tarEntries: readonly string[];

function npm(args: readonly string[], cwd: string, cache: string): Run {
  const result = spawnSync("npm", args, {
    cwd,
    encoding: "utf8",
    timeout: 600_000,
    env: { ...process.env, NPM_CONFIG_CACHE: cache },
  });

  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** The consumer environment: every home is inside the throwaway project. */
function consumerEnv(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_STATE_HOME: path.join(home, "state"),
    NO_COLOR: "1",
    ...(process.env["PATH"] === undefined ? {} : { PATH: process.env["PATH"] }),
  };
}

beforeAll(async () => {
  workDir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "syndroo-cli-package-")));
  packDir = path.join(workDir, "pack");
  consumerDir = path.join(workDir, "consumer");
  const cache = path.join(workDir, "npm-cache");

  await fs.mkdir(packDir, { recursive: true });
  await fs.mkdir(consumerDir, { recursive: true });

  for (const workspace of WORKSPACES) {
    const run = npm(["pack", "--workspace", workspace, "--pack-destination", packDir], REPO_ROOT, cache);

    expect(run.code, `npm pack ${workspace}\n${run.stdout}${run.stderr}`).toBe(0);
  }

  for (const name of EXTERNAL_PACKAGES) {
    const run = npm(
      ["pack", path.join(REPO_ROOT, "node_modules", name), "--pack-destination", packDir],
      REPO_ROOT,
      cache,
    );

    expect(run.code, `npm pack ${name}\n${run.stdout}${run.stderr}`).toBe(0);
  }

  tarballs = (await fs.readdir(packDir))
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => path.join(packDir, name))
    .sort();

  await fs.writeFile(
    path.join(consumerDir, "package.json"),
    `${JSON.stringify({ name: "syndroo-cli-consumer", version: "1.0.0", private: true }, null, 2)}\n`,
  );

  const installed = npm(
    [
      "install",
      "--offline",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      ...tarballs,
    ],
    consumerDir,
    cache,
  );

  expect(installed.code, `npm install\n${installed.stdout}${installed.stderr}`).toBe(0);

  cliBin = path.join(consumerDir, "node_modules", "@syndroo", "cli", "dist", "bin.js");
  expect(existsSync(cliBin)).toBe(true);

  const listing = spawnSync("tar", ["-tzf", path.join(packDir, "syndroo-cli-0.7.0-rc.1.tgz")], {
    encoding: "utf8",
  });

  expect(listing.status).toBe(0);
  tarEntries = (listing.stdout ?? "").split("\n").filter((line) => line.length > 0);
}, 600_000);

afterAll(async () => {
  if (workDir !== undefined) {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

describe("@syndroo/cli packed tarball", () => {
  it("ships only dist, the Skill, README, LICENSE, NOTICE and the manifest", () => {
    const allowed = (entry: string): boolean =>
      entry.startsWith("package/dist/") ||
      entry.startsWith("package/skills/") ||
      ["package/package.json", "package/README.md", "package/LICENSE", "package/NOTICE"].includes(entry);

    expect(tarEntries.length).toBeGreaterThan(0);
    expect(tarEntries.filter((entry) => !allowed(entry))).toEqual([]);
    // Explicit absences, stated rather than implied by the allowlist.
    expect(tarEntries.some((entry) => entry.includes("node_modules"))).toBe(false);
    expect(tarEntries.some((entry) => /(^|\/)src\//.test(entry))).toBe(false);
    expect(tarEntries.some((entry) => /(^|\/)tests?\//.test(entry))).toBe(false);
    expect(tarEntries.some((entry) => entry.includes(REPO_ROOT))).toBe(false);
  });

  it("inlines private @syndroo/core instead of depending on it", async () => {
    const installed = path.join(consumerDir, "node_modules", "@syndroo", "cli");
    const manifest = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const record = JSON.parse(await fs.readFile(path.join(installed, "dist", "bundle.json"), "utf8")) as {
      inlinedWorkspacePackages?: readonly string[];
      external?: readonly string[];
    };

    expect(manifest.dependencies?.["@syndroo/core"]).toBeUndefined();
    expect(record.inlinedWorkspacePackages).toContain("@syndroo/core");
    expect(record.external).toEqual(["ajv", "ajv-formats", "commander"]);

    // The private package is not shipped anywhere in the tarball.
    expect(existsSync(path.join(consumerDir, "node_modules", "@syndroo", "core"))).toBe(false);
  });

  it("embeds no absolute build path", async () => {
    const installed = path.join(consumerDir, "node_modules", "@syndroo", "cli");

    async function scan(directory: string): Promise<string[]> {
      const hits: string[] = [];

      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const child = path.join(directory, entry.name);

        if (entry.isDirectory()) {
          hits.push(...(await scan(child)));
        } else {
          const text = await fs.readFile(child, "utf8");

          if (text.includes(REPO_ROOT)) {
            hits.push(path.relative(installed, child));
          }
        }
      }

      return hits;
    }

    expect(await scan(installed)).toEqual([]);
  });
});

describe("packaged consumer", () => {
  it("answers --version and --help with no config and no state", () => {
    const home = path.join(workDir, "version-home");
    const env = consumerEnv(home);

    const version = spawnSync(process.execPath, [cliBin, "--version"], { cwd: consumerDir, encoding: "utf8", env });

    expect(version.status).toBe(0);
    expect(version.stdout).toContain("0.7.0-rc.1");
    expect(version.stderr).toBe("");

    const help = spawnSync(process.execPath, [cliBin, "--help"], { cwd: consumerDir, encoding: "utf8", env });

    expect(help.status).toBe(0);
    for (const command of ["connect", "publish", "status"]) {
      expect(help.stdout).toContain(command);
    }

    expect(existsSync(path.join(home, "state"))).toBe(false);
    expect(existsSync(path.join(home, "config"))).toBe(false);
  });

  it("status --json lists the five official providers from the built-in catalog", () => {
    const home = path.join(workDir, "status-home");
    const env = consumerEnv(home);
    const result = spawnSync(process.execPath, [cliBin, "status", "--json"], {
      cwd: consumerDir,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);

    expect(lines).toHaveLength(1);
    const envelope = JSON.parse(lines[0] as string) as {
      operation: string;
      ok: boolean;
      error: unknown;
      result: { type: string; initialized: boolean; providers: { provider: string; provenance: string; availability: string }[] };
    };

    expect(envelope).toMatchObject({ operation: "status", ok: true, error: null });
    expect(envelope.result.type).toBe("overview");
    expect(envelope.result.initialized).toBe(false);
    expect(envelope.result.providers.map((view) => view.provider)).toEqual([...OFFICIAL_IDS]);
    // The roots resolved to the installed packages: a packed consumer has no
    // `packages/provider-*` checkout for the repository-relative fallback.
    expect(envelope.result.providers.every((view) => view.provenance === "official")).toBe(true);
    // F3b: the catalog fingerprint covers exactly the shipped artifact set, so
    // the installed package's fingerprint equals the catalog's and the
    // distribution-approval path is reachable.
    expect(envelope.result.providers.every((view) => view.availability === "available")).toBe(true);

    // Read-only: an empty state stays empty.
    expect(existsSync(path.join(home, "state"))).toBe(false);
  });

  it("an installed official provider reaches official/available with no approval record", async () => {
    const home = path.join(workDir, "resolution-home");
    const env = consumerEnv(home);
    const script = path.join(consumerDir, "resolution.mjs");

    await fs.writeFile(
      script,
      [
        'import { createLocalRuntime } from "@syndroo/cli/runtime";',
        "const home = process.argv[2];",
        "const runtime = createLocalRuntime({",
        '  configFile: `${home}/config/syndroo/config.json`,',
        '  configDirectory: `${home}/config/syndroo`,',
        "  exists: false,",
        '  stateRoot: `${home}/state/syndroo/runtime-v1`,',
        "  providers: {},",
        "});",
        "const views = await runtime.providers.list();",
        'console.log(JSON.stringify(views.map((view) => ({ id: view.provider, provenance: view.provenance, availability: view.availability }))));',
        "",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [script, home], { cwd: consumerDir, encoding: "utf8", env });

    expect(result.status, result.stderr).toBe(0);
    const views = JSON.parse(result.stdout.trim()) as { id: string; provenance: string; availability: string }[];

    expect(views.map((view) => view.id)).toEqual([...OFFICIAL_IDS]);
    expect(views.every((view) => view.provenance === "official")).toBe(true);
    // `unavailable` would mean neither the installed package nor the checkout
    // was found; `stale` would mean the fingerprint rule disagrees with the
    // packed bytes; `untrusted` would mean no approval record matched. The
    // result must be `available` exactly.
    expect(views.every((view) => view.availability === "available")).toBe(true);
    expect(views.every((view) => view.availability !== "stale")).toBe(true);
    expect(views.every((view) => view.availability !== "untrusted")).toBe(true);

    // ...and it reached that state without any approval record on disk.
    expect(existsSync(path.join(home, "state"))).toBe(false);
  });

  it("still runs a scripted prepare through the packaged runtime", async () => {
    const home = path.join(workDir, "prepare-home");
    const env = consumerEnv(home);
    const fakeBundle = path.join(consumerDir, "fake-provider.mjs");
    const script = path.join(consumerDir, "prepare.mjs");

    await build({
      entryPoints: [path.join(REPO_ROOT, "tests", "fixtures", "providers", "fake.ts")],
      outfile: fakeBundle,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      logLevel: "silent",
    });

    await fs.writeFile(
      script,
      [
        'import { promises as fs } from "node:fs";',
        'import path from "node:path";',
        'import { Readable, Writable } from "node:stream";',
        'import { run } from "@syndroo/cli";',
        'import { createFakeProvider, createFakeTransport } from "./fake-provider.mjs";',
        "",
        "const home = process.argv[2];",
        'const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), XDG_STATE_HOME: path.join(home, "state"), NO_COLOR: "1", PATH: process.env.PATH };',
        "const plugin = createFakeProvider();",
        "const implementation = { provider: \"fake\", packageName: \"@syndroo/provider-fake\", version: plugin.manifest.version, apiVersion: 1, artifactFingerprint: \"a\".repeat(64), schemaFingerprint: \"b\".repeat(64) };",
        "const isRecord = (value) => typeof value === \"object\" && value !== null && !Array.isArray(value);",
        "const validators = {",
        "  connectOptions: (value) => isRecord(value) && Object.keys(value).length === 0,",
        "  credentialInput: (value) => isRecord(value) && typeof value.canary === \"string\",",
        "  content: (value) => isRecord(value) && (value.text === undefined || typeof value.text === \"string\"),",
        "  publishOptions: (value) => isRecord(value),",
        "};",
        "const view = { provider: \"fake\", availability: \"available\", provenance: \"third_party\", implementation, manifest: plugin.manifest };",
        "const registry = {",
        "  async describe(provider) { return provider === \"fake\" ? structuredClone(view) : { provider, availability: \"unavailable\", provenance: \"third_party\" }; },",
        "  async list() { const { manifest: _manifest, ...rest } = view; return [rest]; },",
        "  async load(provider) { if (provider !== \"fake\") throw new Error(\"PROVIDER_UNAVAILABLE\"); return { plugin, implementation, validators }; },",
        "};",
        "const overrides = { providers: registry, transport: createFakeTransport({ type: \"response\", status: 200, headers: {}, body: \"{}\" }) };",
        "function sink() {",
        "  const chunks = [];",
        "  const stream = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });",
        "  return { stream, text: () => Buffer.concat(chunks).toString(\"utf8\") };",
        "}",
        "function ioFor() {",
        "  const out = sink();",
        "  const err = sink();",
        "  return { io: { stdin: Readable.from([]), stdout: out.stream, stderr: err.stream, env, cwd: home, stdinIsTty: false, stdoutIsTty: false, hasTty: () => false, readTtyLine: () => undefined, signal: new AbortController().signal }, out, err };",
        "}",
        "await fs.mkdir(home, { recursive: true });",
        "const credential = path.join(home, \"credential.json\");",
        "await fs.writeFile(credential, JSON.stringify({ canary: \"packed-consumer-canary\" }));",
        "const connect = ioFor();",
        "const connectExit = await run([\"connect\", \"fake\", \"--credential-file\", credential, \"--json\"], connect.io, overrides);",
        "const document = path.join(home, \"document.json\");",
        "await fs.writeFile(document, JSON.stringify({ content: { text: \"Packed consumer prepare.\" }, targets: [{ provider: \"fake\" }] }));",
        "const prepare = ioFor();",
        "const prepareExit = await run([\"publish\", \"--input\", document, \"--dry-run\", \"--json\"], prepare.io, overrides);",
        "console.log(JSON.stringify({ connectExit, connect: connect.out.text(), prepareExit, prepare: prepare.out.text(), stderr: `${connect.err.text()}${prepare.err.text()}` }));",
        "",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [script, home], { cwd: consumerDir, encoding: "utf8", env });

    expect(result.status, result.stderr).toBe(0);
    const outcome = JSON.parse(result.stdout.trim()) as {
      connectExit: number;
      connect: string;
      prepareExit: number;
      prepare: string;
      stderr: string;
    };

    expect(outcome.connectExit).toBe(0);
    expect(JSON.parse(outcome.connect)).toMatchObject({ operation: "connect", ok: true });
    expect(outcome.prepareExit).toBe(0);
    expect(JSON.parse(outcome.prepare)).toMatchObject({
      operation: "publish",
      ok: true,
      result: { status: "preview" },
    });
    expect(outcome.stderr).toBe("");
  }, 120_000);
});
