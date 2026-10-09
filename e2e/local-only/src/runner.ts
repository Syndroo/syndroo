#!/usr/bin/env node
/**
 * L1 installed-runtime locality harness for the architecture-v1 CLI.
 *
 * Packs `@syndroo/cli` and the dependency tarballs it needs, installs them
 * offline outside the repository, then drives the real installed `dist/bin.js`
 * through `node --import <preload>` child processes with the default production
 * composition. All instrumentation lives in the preload; no product flag
 * selects it, so what is measured is the artifact a user installs.
 *
 * What it proves: `--version`, `--help`, `status --json` and an offline
 * `publish --dry-run` all run from the installed tarball, list the five official
 * providers, and open no socket at all. A negative control runs one disallowed
 * `fetch` under the same preload and requires the harness to record it, so a
 * "zero network events" result cannot be vacuous.
 *
 * Run with no arguments (the defaults pack and install this checkout):
 *
 *   npm run e2e:local-only
 *
 * Exit codes: 0 = no failed case (blocked cases are reported separately),
 * 1 = at least one case failed, 2 = harness/install precondition failed.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { installCli } from "./install.js";
import { countKinds, networkEvents, type TraceEvent } from "./trace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_IP = "93.184.216.34";

/**
 * Runtime dependencies the published CLI leaves external, plus their transitive
 * closure. They are packed out of the locked `node_modules` so the install is
 * fully offline: nothing is fetched from a registry.
 */
const DEPENDENCY_PACKAGES = [
  "commander",
  "ajv",
  "ajv-formats",
  "fast-deep-equal",
  "fast-uri",
  "json-schema-traverse",
  "require-from-string",
] as const;

const OFFICIAL_PROVIDERS = ["bluesky", "devto", "linkedin", "mastodon", "threads"] as const;

/**
 * Workspace tarballs the consumer must install: the CLI, the provider contract
 * it expects at install time, and the five official providers, so the built-in
 * catalog resolves against installed packages rather than a checkout.
 */
const WORKSPACE_PACKAGES = [
  "@syndroo/cli",
  "@syndroo/provider-sdk",
  ...OFFICIAL_PROVIDERS.map((id) => `@syndroo/provider-${id}`),
] as const;

interface Options {
  readonly tarball?: string;
  readonly report?: string;
  readonly deps?: string;
  readonly root?: string;
}

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Context {
  readonly bin: string;
  readonly consumer: string;
  readonly root: string;
  readonly home: string;
  readonly traces: string;
  readonly version: string;
}

/** The repository root, found the same way in a checkout and a compiled run. */
function repositoryRoot(from: string): string {
  let directory = from;

  for (;;) {
    const manifest = join(directory, "package.json");

    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };

        if (parsed.name === "syndroo") {
          return directory;
        }
      } catch {
        // Keep walking: an unreadable manifest is not the repository root.
      }
    }

    const parent = dirname(directory);

    if (parent === directory) {
      throw new Error("runner: could not locate the repository root");
    }

    directory = parent;
  }
}

function parseArgs(argv: readonly string[]): Options {
  const values: Record<string, string | undefined> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;

    if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "usage: node runner.js [--tarball <abs.tgz>] [--deps <dir>] [--root <dir>] [--report <abs.json>]\n" +
          "  With no --tarball the harness packs and installs this checkout offline.\n",
      );
      process.exit(0);
    }

    if (!["--tarball", "--deps", "--root", "--report"].includes(flag)) {
      throw new Error(`unknown argument ${flag}`);
    }

    const value = argv[index + 1];

    if (value === undefined || value.length === 0) {
      throw new Error(`${flag} needs a value`);
    }

    values[flag.slice(2)] = value;
    index += 1;
  }

  return {
    ...(values["tarball"] === undefined ? {} : { tarball: values["tarball"] }),
    ...(values["deps"] === undefined ? {} : { deps: values["deps"] }),
    ...(values["root"] === undefined ? {} : { root: values["root"] }),
    ...(values["report"] === undefined ? {} : { report: values["report"] }),
  };
}

function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return new Promise((settle) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => settle({ code: null, stdout, stderr: `${stderr}${String(error)}` }));
    child.on("close", (code) => settle({ code, stdout, stderr }));
  });
}

/** Pack the workspace and dependency tarballs into `destination`. */
async function packAll(repository: string, destination: string, cache: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, NPM_CONFIG_CACHE: cache };

  for (const workspace of WORKSPACE_PACKAGES) {
    const result = await run("npm", ["pack", "--workspace", workspace, "--pack-destination", destination], {
      cwd: repository,
      env,
    });

    if (result.code !== 0) {
      throw new Error(`npm pack ${workspace} failed (${String(result.code)}): ${result.stderr.slice(0, 2_000)}`);
    }
  }

  for (const name of DEPENDENCY_PACKAGES) {
    const result = await run(
      "npm",
      ["pack", join(repository, "node_modules", name), "--pack-destination", destination],
      { cwd: repository, env },
    );

    if (result.code !== 0) {
      throw new Error(`npm pack ${name} failed (${String(result.code)}): ${result.stderr.slice(0, 2_000)}`);
    }
  }
}

async function readTrace(file: string): Promise<readonly TraceEvent[]> {
  const text = await readFile(file, "utf8").catch(() => "");

  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TraceEvent);
}

function cliEnv(context: Context, name: string, trace: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: context.home,
    XDG_CONFIG_HOME: join(context.home, "config"),
    XDG_STATE_HOME: join(context.home, "state"),
    NO_COLOR: "1",
    SYNDROO_L1_TRACE: trace,
    SYNDROO_L1_ROOT: context.root,
    SYNDROO_L1_SYNTHETIC_IP: SYNTHETIC_IP,
    // The v1 CLI declares no egress origin yet, so no host is allowed.
    SYNDROO_L1_ALLOW: "",
    SYNDROO_L1_CASE: name,
  };
}

async function runCli(
  context: Context,
  options: { readonly name: string; readonly args: readonly string[] },
): Promise<RunResult & { readonly events: readonly TraceEvent[] }> {
  const trace = join(context.traces, `${options.name}.jsonl`);
  const result = await run(
    process.execPath,
    ["--import", pathToFileURL(join(HERE, "preload.js")).href, context.bin, ...options.args],
    { cwd: context.consumer, env: cliEnv(context, options.name, trace) },
  );

  return { ...result, events: await readTrace(trace) };
}

type CaseResult = { readonly name: string; readonly ok: boolean; readonly detail: string };

async function main(): Promise<number> {
  let options: Options;

  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const repository = repositoryRoot(HERE);
  const root = options.root === undefined ? await mkdtemp(join(tmpdir(), "syndroo-l1-")) : resolve(options.root);
  const cases: CaseResult[] = [];
  const notes: string[] = [];

  // The trace files must NOT live under `SYNDROO_L1_ROOT`. The preload records
  // every write beneath that root and writes a line for each record, so a trace
  // file inside it would recurse through the patched `fs` until the stack blew.
  const traces = await mkdtemp(join(tmpdir(), "syndroo-l1-traces-"));

  const record = (name: string, ok: boolean, detail: string): void => {
    cases.push({ name, ok, detail });
    notes.push(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
  };

  try {
    await mkdir(root, { recursive: true });

    let tarball = options.tarball;
    let deps = options.deps;

    if (tarball === undefined || deps === undefined) {
      const packDirectory = join(root, "pack");
      const cache = join(root, "npm-cache");
      await mkdir(packDirectory, { recursive: true });
      await packAll(repository, packDirectory, cache);
      const packed = (await readdir(packDirectory)).filter((name) => name.endsWith(".tgz")).map((name) => join(packDirectory, name));
      const cli = packed.find((name) => /syndroo-cli-.*\.tgz$/.test(name));

      if (cli === undefined) {
        throw new Error(`no @syndroo/cli tarball was produced in ${packDirectory}`);
      }

      tarball = cli;
      deps = packDirectory;
    }

    if (!existsSync(tarball)) {
      throw new Error(`tarball not found: ${tarball}`);
    }

    const install = await installCli({ tarball, depsDir: deps, root });
    const consumerManifest = JSON.parse(
      await readFile(join(install.consumer, "node_modules", "@syndroo", "cli", "package.json"), "utf8"),
    ) as { version: string };

    const context: Context = {
      bin: install.bin,
      consumer: install.consumer,
      root,
      home: join(root, "home"),
      traces,
      version: consumerManifest.version,
    };

    await mkdir(context.home, { recursive: true });

    // Negative control first: prove the instrumentation records a network
    // attempt, so "zero events" below means something.
    const probeScript = join(root, "probe.mjs");
    const probeTrace = join(traces, "probe.jsonl");
    await writeFile(
      probeScript,
      [
        "// Instrumentation self-check, never a product path.",
        "try {",
        '  await fetch("https://evil.example/probe");',
        "} catch {",
        "  // Expected: the preload rejects the disallowed destination.",
        "}",
        "",
      ].join("\n"),
    );
    const probe = await run(process.execPath, ["--import", pathToFileURL(join(HERE, "preload.js")).href, probeScript], {
      cwd: context.consumer,
      env: cliEnv(context, "probe", probeTrace),
    });
    const probeEvents = await readTrace(probeTrace);
    record(
      "probe",
      networkEvents(probeEvents).length > 0,
      `instrumentation observed ${networkEvents(probeEvents).length} network event(s)`,
    );

    const version = await runCli(context, { name: "version", args: ["--version"] });
    record(
      "version",
      version.code === 0 && version.stdout.includes(context.version) && version.stderr === "",
      `exit ${String(version.code)}, stdout ${JSON.stringify(version.stdout.trim())}`,
    );

    const help = await runCli(context, { name: "help", args: ["--help"] });
    record(
      "help",
      help.code === 0 && ["connect", "publish", "status"].every((command) => help.stdout.includes(command)),
      `exit ${String(help.code)}`,
    );

    const status = await runCli(context, { name: "status", args: ["status", "--json"] });
    const statusLines = status.stdout.split("\n").filter((line) => line.trim().length > 0);
    let statusOk = status.code === 0 && statusLines.length === 1;
    let statusDetail = `exit ${String(status.code)}, ${statusLines.length} line(s)`;

    if (statusOk) {
      const envelope = JSON.parse(statusLines[0] as string) as {
        operation: string;
        result: { type: string; providers: { provider: string; availability: string }[] };
      };
      const ids = envelope.result.providers.map((view) => view.provider);
      statusOk =
        envelope.operation === "status" &&
        envelope.result.type === "overview" &&
        ids.join(",") === OFFICIAL_PROVIDERS.join(",") &&
        envelope.result.providers.every((view) => view.availability === "available");
      statusDetail = `exit ${String(status.code)}, providers ${ids.join(",")}`;
    }

    record("status", statusOk, statusDetail);

    const document = join(root, "document.json");
    await writeFile(
      document,
      JSON.stringify({ content: { text: "Locality fixture." }, targets: [{ provider: "bluesky" }] }),
    );
    const preview = await runCli(context, {
      name: "preview",
      args: ["publish", "--input", document, "--dry-run", "--json"],
    });
    // No account is bound and the default transport is fail-closed, so this must
    // fail cleanly rather than reach a provider. What matters is the absence of
    // any socket and a stable, non-zero answer.
    record(
      "preview",
      preview.code !== 0 && preview.code !== null,
      `exit ${String(preview.code)} without a bound account`,
    );

    for (const result of [version, help, status, preview]) {
      const events = networkEvents(result.events);

      if (events.length > 0) {
        record("no-network", false, `a CLI case produced ${events.length} network event(s)`);
      }
    }

    const kinds = countKinds([...version.events, ...help.events, ...status.events, ...preview.events]);
    notes.push(`trace kinds across CLI cases: ${JSON.stringify(kinds)}`);
    notes.push("Fixture responses are synthetic; a passing case is fixture-tested, never live.");
  } catch (error) {
    record("harness", false, error instanceof Error ? error.message : String(error));
  } finally {
    if (options.root === undefined) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }

    await rm(traces, { recursive: true, force: true }).catch(() => undefined);
  }

  const failed = cases.filter((entry) => !entry.ok);
  const output = { ok: failed.length === 0, cases, notes };

  if (options.report !== undefined) {
    await writeFile(options.report, `${JSON.stringify(output, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

  return failed.length === 0 ? 0 : 1;
}

process.exitCode = await main();
