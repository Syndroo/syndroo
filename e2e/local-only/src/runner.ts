#!/usr/bin/env node
/**
 * L1 installed-runtime locality harness.
 *
 * Installs the candidate tarball outside the repository, then drives the real
 * installed `dist/bin.js` through `node --import <preload>` child processes with
 * the default production composition. All instrumentation lives in the preload;
 * no product flag selects it.
 *
 * Exit codes: 0 = no failed case (blocked cases are reported separately),
 * 1 = at least one case failed, 2 = harness/install precondition failed.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startFixture, type FixtureServer } from "./fixture.js";
import { installCli } from "./install.js";
import { countKinds, networkEvents, type TraceEvent } from "./trace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PRELOAD = join(HERE, "preload.js");
const FIXTURE_DIR = join(REPO, "e2e", "local-only", "fixtures");
const SYNTHETIC_IP = "93.184.216.34";
const ALLOWED_HOSTS = ["dev.to", "mastodon.test", "bsky.social", "graph.threads.net", "api.linkedin.com"];
const COMMAND_TIMEOUT_MS = 30_000;

interface Options {
  readonly tarball: string;
  readonly report: string;
  readonly deps: string;
  readonly root: string;
}

interface CommandRecord {
  readonly args: readonly string[];
  readonly code: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly events: Record<string, number>;
  readonly stdoutTail: string;
  /** True only when the trace contains the bootstrap and end markers. */
  readonly traceOk: boolean;
}

interface CaseResult {
  readonly id: string;
  readonly status: "pass" | "fail" | "blocked";
  /** A required case that is blocked fails the gate; optional ones do not. */
  readonly required: boolean;
  readonly detail: string;
  readonly assertions: readonly string[];
  readonly commands: readonly CommandRecord[];
}

class Case {
  readonly failures: string[] = [];
  readonly assertions: string[] = [];
  readonly commands: CommandRecord[] = [];

  check(ok: boolean, label: string): void {
    this.assertions.push(`${ok ? "ok" : "FAIL"}: ${label}`);

    if (!ok) {
      this.failures.push(label);
    }
  }

  result(id: string, detail: string): CaseResult {
    return {
      id,
      status: this.failures.length === 0 ? "pass" : "fail",
      required: true,
      detail,
      assertions: this.assertions,
      commands: this.commands,
    };
  }
}

interface Context {
  readonly options: Options;
  readonly bin: string;
  readonly fixture: FixtureServer;
  readonly home: string;
  readonly stateRoot: string;
  readonly traceFile: string;
  readonly consumer: string;
}

let traceCounter = 0;

/** A fresh trace file per command: concurrent children never mingle events. */
function nextTraceFile(context: Context): string {
  traceCounter += 1;

  return `${context.traceFile}.${process.pid}.${traceCounter}`;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (options === null) {
    process.stderr.write(
      "usage: node runner.js --tarball <abs.tgz> --report <abs.json> [--deps <dir>] [--root <dir>]\n",
    );
    return 2;
  }

  const tarball = resolve(options.tarball);

  if (!existsSync(tarball)) {
    process.stderr.write(`tarball not found: ${tarball}\n`);
    return 2;
  }

  const root = options.root === "" ? await mkdtemp(join(tmpdir(), "syndroo-l1-")) : options.root;

  await mkdir(root, { recursive: true, mode: 0o700 });

  // The CLI refuses to save credentials under a group/world-writable ancestor
  // (including `/tmp`), so credential cases need a secure scratch root, e.g.
  // Docker `--tmpfs /home/node/work:rw,mode=700,uid=1000,gid=1000`.
  const secureRoot = await hasNoWritableAncestor(root);
  const home = join(root, "home");
  const stateRoot = join(home, ".local", "state");
  const traceFile = join(root, "trace.jsonl");

  await mkdir(home, { recursive: true });
  await mkdir(stateRoot, { recursive: true });

  const install = await installCli({ tarball, depsDir: options.deps, root });
  const fixture = await startFixture({
    cert: await readFile(join(FIXTURE_DIR, "server.pem"), "utf8"),
    key: await readFile(join(FIXTURE_DIR, "server-key.pem"), "utf8"),
  });
  const context: Context = {
    options: { ...options, tarball, root },
    bin: install.bin,
    fixture,
    home,
    stateRoot,
    traceFile,
    consumer: install.consumer,
  };

  const version = await probeVersion(context);
  const cases: CaseResult[] = [];

  try {
    cases.push(await instrumentationSelfCheck(context));
    cases.push(await instrumentationNegativeControl(context));
    cases.push(await offlineMatrix(context));
    cases.push(await routingIsolation(context));

    for (const provider of ["mastodon", "devto"]) {
      cases.push(await providerFlow(context, provider));
    }

    cases.push(await writerContention(context));
    cases.push(await oauthPointer(context));
  } finally {
    await fixture.close();
  }

  // Required-but-blocked cases fail the gate: "blocked" is never a pass.
  const report = {
    ok: cases.every(
      entry => entry.status === "pass" || (entry.status === "blocked" && !entry.required),
    ),
    tarball,
    sha256: createHash("sha256").update(await readFile(tarball)).digest("hex"),
    version,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    fixture: `${fixture.host}:${fixture.port}`,
    secureRoot,
    allowedHosts: ALLOWED_HOSTS,
    cases,
    limits: [
      "Destination substitution happens at the Node API layer in the preload; OS-level isolation is supplied separately by the Linux --network none run and the macOS sandbox run.",
      "The preload is test-only and is never part of the tarball or the production bundle.",
      "Fixture responses are synthetic; a passing case is fixture-tested, never live-validated.",
      "Blocked cases are reported as blocked, never as pass.",
    ],
  };

  await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${cases.map(entry => `${entry.status.toUpperCase()} ${entry.id}`).join("\n")}\n` +
      `report: ${options.report}\n`,
  );

  return report.ok ? 0 : 1;
}

function parseArgs(args: readonly string[]): Options | null {
  const values: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;

    if (!key.startsWith("--")) {
      continue;
    }

    values[key.slice(2)] = args[index + 1] ?? "";
    index += 1;
  }

  const tarball = values["tarball"];
  const report = values["report"];

  if (tarball === undefined || report === undefined) {
    return null;
  }

  return {
    tarball,
    report: resolve(report),
    deps: resolve(values["deps"] ?? join(REPO, "..", "linux-install-inputs")),
    root: values["root"] ?? "",
  };
}

async function probeVersion(context: Context): Promise<string> {
  const result = await runCli(context, { args: ["version", "--json"], allow: [] });

  const match = /"version"\s*:\s*"([^"]+)"/.exec(result.stdoutTail);

  return match?.[1] ?? "unknown";
}

async function runCli(
  context: Context,
  input: {
    readonly args: readonly string[];
    readonly allow: readonly string[];
    readonly env?: Record<string, string>;
    readonly timeoutMs?: number;
  },
): Promise<CommandRecord & { readonly events_: readonly TraceEvent[] }> {
  const commandTrace = nextTraceFile(context);
  const started = Date.now();
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: context.home,
    XDG_CONFIG_HOME: join(context.home, ".config"),
    XDG_STATE_HOME: join(context.home, ".local", "state"),
    SYNDROO_L1_TRACE: commandTrace,
    SYNDROO_L1_ROOT: context.stateRoot,
    SYNDROO_L1_FIXTURE: `${context.fixture.host}:${context.fixture.port}`,
    SYNDROO_L1_SYNTHETIC_IP: SYNTHETIC_IP,
    SYNDROO_L1_ALLOW: input.allow.join(","),
    SYNDROO_L1_CA: join(FIXTURE_DIR, "ca.pem"),
    ...(input.env ?? {}),
  };
  const outcome = await spawnCli(context, input.args, env, input.timeoutMs ?? COMMAND_TIMEOUT_MS);
  const events = await readTrace(commandTrace);

  return {
    args: input.args,
    code: outcome.code,
    signal: outcome.signal,
    durationMs: Date.now() - started,
    events: countKinds(events),
    stdoutTail: outcome.stdout.slice(0, 2_000),
    traceOk:
      events.some(event => event.kind === "bootstrap") && events.some(event => event.kind === "end"),
    events_: events,
  };
}

function spawnCli(
  context: Context,
  args: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly signal: string | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--import", PRELOAD, context.bin, ...args], {
      cwd: context.consumer,
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk as string;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk as string;
    });
    child.on("error", error => {
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.on("close", (code, signal) => {
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function readTrace(path: string): Promise<readonly TraceEvent[]> {
  if (!existsSync(path)) {
    return [];
  }

  const raw = await readFile(path, "utf8");

  return raw
    .split("\n")
    .filter(line => line.trim().length > 0)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as TraceEvent];
      } catch {
        return [];
      }
    });
}

async function snapshotTree(root: string): Promise<readonly string[]> {
  return snapshotTreeInner(root);
}

/** True when the root and every ancestor are free of group/world write bits. */
async function hasNoWritableAncestor(start: string): Promise<boolean> {
  let current = resolve(start);

  for (;;) {
    try {
      const info = await stat(current);

      if ((info.mode & 0o022) !== 0) {
        return false;
      }
    } catch {
      return false;
    }

    const parent = dirname(current);

    if (parent === current) {
      return true;
    }

    current = parent;
  }
}

async function snapshotTreeInner(root: string): Promise<readonly string[]> {
  if (!existsSync(root)) {
    return [];
  }

  const entries: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const info = await stat(full);
        entries.push(`${full}:${info.size}:${Math.trunc(info.mtimeMs)}`);
      }
    }
  };

  await walk(root);

  return entries.sort();
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/**
 * Proves the harness itself is not vacuously green: a `fetch` call and a
 * production-style pinned `node:https` call both reach the real loopback TLS
 * fixture, and the pinned lookup is executed and asserted first.
 */
async function instrumentationSelfCheck(context: Context): Promise<CaseResult> {
  const test = new Case();
  const before = context.fixture.requests.length;
  const record = await runProbe(context);
  const requests = context.fixture.requests.slice(before);
  const pinned = record.events_.filter(event => event.kind === "pinned-lookup");

  test.commands.push(record);
  test.check(record.code === 0, "probe exited 0");
  test.check(
    pinned.some(event => event.kind === "pinned-lookup" && event.addresses.includes(SYNTHETIC_IP)),
    "production pinned lookup executed and returned the synthetic public address",
  );
  test.check(
    record.events_.some(event => event.kind === "tls" && event.host === "dev.to"),
    "fetch path was redirected through the real TLS fixture with the original hostname",
  );
  test.check(
    record.events_.some(event => event.kind === "tls" && event.host === "mastodon.test"),
    "pinned https path kept the original hostname",
  );
  test.check(
    requests.some(entry => entry.path === "/api/users/me"),
    "fixture served the fetch path over real TLS",
  );
  test.check(
    requests.some(entry => entry.path === "/api/v2/instance"),
    "fixture served the pinned https path over real TLS",
  );

  return test.result(
    "instrumentation-self-check",
    "fetch + pinned https both reached the loopback TLS fixture",
  );
}

/**
 * Negative control: a disallowed destination must be recorded and rejected, so
 * a "zero network events" result in the other cases is meaningful rather than a
 * silently broken instrumentation.
 */
async function instrumentationNegativeControl(context: Context): Promise<CaseResult> {
  const test = new Case();
  const record = await runProbe(context, { SYNDROO_L1_PROBE_DENY: "1" });
  const rejects = record.events_.filter(event => event.kind === "reject");

  test.commands.push(record);
  test.check(record.code === 0, "deny probe exited 0 (the instrumentation rejected the attempt)");
  test.check(record.traceOk, "deny probe trace has bootstrap and end markers");
  test.check(
    rejects.some(event => event.kind === "reject" && event.what === "fetch"),
    "disallowed fetch was recorded as a reject event",
  );
  test.check(
    record.events_.some(event => event.kind === "http" && event.host === "evil.example"),
    "disallowed destination host was recorded before rejection",
  );

  return test.result(
    "instrumentation-negative-control",
    "disallowed destination is recorded and rejected, never invisible",
  );
}

async function runProbe(
  context: Context,
  extraEnv: Record<string, string> = {},
): Promise<CommandRecord & { readonly events_: readonly TraceEvent[] }> {
  const commandTrace = nextTraceFile(context);
  const started = Date.now();
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: context.home,
    XDG_CONFIG_HOME: join(context.home, ".config"),
    XDG_STATE_HOME: join(context.home, ".local", "state"),
    SYNDROO_L1_TRACE: commandTrace,
    SYNDROO_L1_ROOT: context.stateRoot,
    SYNDROO_L1_FIXTURE: `${context.fixture.host}:${context.fixture.port}`,
    SYNDROO_L1_SYNTHETIC_IP: SYNTHETIC_IP,
    SYNDROO_L1_ALLOW: ALLOWED_HOSTS.join(","),
    SYNDROO_L1_CA: join(FIXTURE_DIR, "ca.pem"),
    ...extraEnv,
  };
  const outcome = await spawnScript(join(HERE, "probe.js"), env, context.consumer, COMMAND_TIMEOUT_MS);
  const events = await readTrace(commandTrace);

  return {
    args: ["probe.js"],
    code: outcome.code,
    signal: outcome.signal,
    durationMs: Date.now() - started,
    events: countKinds(events),
    stdoutTail: `${outcome.stdout}${outcome.stderr}`.slice(0, 2_000),
    traceOk:
      events.some(event => event.kind === "bootstrap") && events.some(event => event.kind === "end"),
    events_: events,
  };
}

function spawnScript(
  script: string,
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly signal: string | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--import", PRELOAD, script], { cwd, env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk as string;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk as string;
    });
    child.on("error", error => {
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.on("close", (code, signal) => {
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function offlineMatrix(context: Context): Promise<CaseResult> {
  const test = new Case();
  const commands: readonly (readonly string[])[] = [
    ["help"],
    ["version"],
    ["providers", "list", "--json"],
    ["skill", "path"],
    ["auth", "status", "--local", "--json"],
    ["receipts", "list", "--json"],
    ["state", "inspect", "--json"],
    ["doctor", "--local", "--json"],
    ["publish", "--data", '{"key":"l1-offline","content":"hello","platforms":["bluesky"]}', "--dry-run", "--json"],
    ["auth", "status", "--verify", "--local", "--json"],
  ];

  for (const args of commands) {
    const before = await snapshotTree(context.stateRoot);
    const record = await runCli(context, { args, allow: [] });
    const after = await snapshotTree(context.stateRoot);
    const network = networkEvents(record.events_);
    const writes = record.events_.filter(event => event.kind === "fswrite");
    const children = record.events_.filter(event => event.kind === "child");
    const envReads = record.events_.filter(event => event.kind === "env");
    const label = args.join(" ");

    test.commands.push(record);
    test.check(network.length === 0, `${label}: zero DNS/HTTP/socket events`);
    test.check(children.length === 0, `${label}: zero child launches`);
    test.check(writes.length === 0, `${label}: zero state writes`);
    test.check(before.join("\n") === after.join("\n"), `${label}: state tree unchanged`);
    test.check(record.traceOk, `${label}: trace has bootstrap and end markers`);
    test.check(
      envReads.filter(event => event.kind === "env" && event.credential).length === 0,
      `${label}: zero credential env reads`,
    );
    test.check(record.signal === null, `${label}: process exited normally`);
    test.check(record.durationMs < COMMAND_TIMEOUT_MS, `${label}: bounded exit`);

    if (label.startsWith("auth status --verify")) {
      test.check(!/"ready"/.test(record.stdoutTail), `${label}: never reports cached ready`);
    }
  }

  return test.result("offline-readonly-matrix", "10 read-only commands with an empty allow-list");
}

async function routingIsolation(context: Context): Promise<CaseResult> {
  const test = new Case();
  const poison = {
    SYNDROO_BASE_URL: "https://capture.invalid",
    SYNDROO_API_KEY: "l1-poison-key",
  };

  for (const args of [
    ["providers", "list", "--json"],
    ["publish", "--data", '{"key":"l1-route","content":"hello","platforms":["bluesky"]}', "--dry-run", "--json"],
    ["connect", "bluesky", "--managed"],
  ] as const) {
    const record = await runCli(context, { args, allow: [], env: poison });
    const label = args.join(" ");

    test.commands.push(record);
    test.check(networkEvents(record.events_).length === 0, `${label}: zero network with poisoned remote env`);
    test.check(record.traceOk, `${label}: trace has bootstrap and end markers`);
    test.check(
      record.events_.filter(event => event.kind === "fswrite").length === 0,
      `${label}: zero state writes`,
    );
  }

  return test.result("routing-isolation", "poisoned SYNDROO_BASE_URL/API_KEY; --managed rejection");
}

async function providerFlow(context: Context, provider: string): Promise<CaseResult> {
  const test = new Case();
  const probe = await runCli(context, { args: ["providers", "list", "--json"], allow: [] });

  test.commands.push(probe);

  if (!new RegExp(`"${provider}"`).test(probe.stdoutTail)) {
  return {
    id: `provider-flow-${provider}`,
    status: "blocked",
    required: true,
      detail: `the installed bundle does not advertise ${provider}; G2 wires it before this case can run`,
      assertions: [`blocked: ${provider} absent from providers list`],
      commands: test.commands,
    };
  }

  // Full installed flow against the public CLI contract. It executes only when
  // G2 advertises the provider; every step asserts real evidence, and each
  // target invocation must produce at most one content POST.
  const credentialEnv =
    provider === "mastodon"
      ? { MASTODON_INSTANCE: "https://mastodon.test", MASTODON_ACCESS_TOKEN: "l1-fixture-mastodon-token" }
      : { DEVTO_API_KEY: "l1-fixture-devto-key" };
  const expectedAccount =
    provider === "mastodon"
      ? `mastodon:${Buffer.from("https://mastodon.test", "utf8").toString("base64url")}:109412345678901234`
      : "devto:1234567";
  const document =
    provider === "mastodon"
      ? { key: "l1-mastodon-1", content: "l1 fixture status", platforms: ["mastodon"] }
      : {
          schemaVersion: 2,
          key: "l1-devto-1",
          content: "l1 fixture summary",
          platforms: ["devto"],
          overrides: { devto: { content: "# L1 fixture\n\nBody.", article: { title: "L1 fixture" } } },
        };

  const step = async (
    label: string,
    args: readonly string[],
    env: Record<string, string> = credentialEnv,
  ): Promise<CommandRecord & { readonly events_: readonly TraceEvent[] }> => {
    const record = await runCli(context, { args, allow: ALLOWED_HOSTS, env });
    test.commands.push(record);
    test.check(record.traceOk, `${label}: trace has bootstrap and end markers`);

    return record;
  };

  const init = await step("init", ["init", "--namespace", "default", "--json"]);
  test.check(init.code === 0, "init exits 0");

  const beforeConnect = context.fixture.contentPosts();
  const connect = await step("connect", [
    "connect",
    provider,
    "--from-env",
    "--expect-account",
    expectedAccount,
    "--yes",
    "--no-input",
    "--json",
  ]);
  test.check(connect.code === 0, "connect exits 0");
  test.check(
    context.fixture.contentPosts() === beforeConnect,
    "connect performs no content POST",
  );

  const beforePublish = context.fixture.contentPosts();
  const publish = await step("publish", [
    "publish",
    "--data",
    JSON.stringify(document),
    "--yes",
    "--no-input",
    "--json",
  ]);
  test.check(publish.code === 0, "publish exits 0");
  test.check(context.fixture.contentPosts() === beforePublish + 1, "publish sends exactly one content POST");
  const operation = /"operationId"\s*:\s*"([^"]+)"/.exec(publish.stdoutTail)?.[1];

  if (operation !== undefined) {
    const receipts = await step("receipts", ["receipts", "show", operation, "--json"]);
    test.check(receipts.code === 0, "receipt is readable");
  }

  const beforeReplay = context.fixture.contentPosts();
  const replay = await step("replay", [
    "publish",
    "--data",
    JSON.stringify(document),
    "--yes",
    "--no-input",
    "--json",
  ]);
  test.check(replay.code === 0, "replayed success exits 0");
  test.check(context.fixture.contentPosts() === beforeReplay, "replayed success sends zero content POSTs");

  context.fixture.setMode("rate-limit");
  const beforeRateLimit = context.fixture.contentPosts();
  const limited = await step("rate-limit", [
    "publish",
    "--data",
    JSON.stringify({ ...document, key: `${document.key}-rl` }),
    "--yes",
    "--no-input",
    "--json",
  ]);
  test.check(context.fixture.contentPosts() === beforeRateLimit + 1, "rate-limited publish sends one content POST");
  test.check(limited.code !== null, "rate-limited publish returns a bounded exit");

  context.fixture.setMode("success");
  const limitedOperation = /"operationId"\s*:\s*"([^"]+)"/.exec(limited.stdoutTail)?.[1];

  if (limitedOperation !== undefined) {
    const beforeRetry = context.fixture.contentPosts();
    const retry = await step("retry", [
      "retry",
      limitedOperation,
      "--to",
      provider,
      "--yes",
      "--no-input",
      "--json",
    ]);
    test.check(retry.code === 0, "explicit retry exits 0");
    test.check(context.fixture.contentPosts() === beforeRetry + 1, "explicit retry sends one content POST");
  }

  return test.result(`provider-flow-${provider}`, "installed init/connect/publish/receipt/replay/retry flow");
}

async function writerContention(context: Context): Promise<CaseResult> {
  return {
    id: "writer-contention",
    status: "blocked",
    required: true,
    detail:
      "requires the G2-wired local credential path plus a barrier-held first publish; the fixture hold/release mode exists, the case is not driven",
    assertions: ["blocked: barrier case not driven in this attempt"],
    commands: [],
  };
}

async function oauthPointer(context: Context): Promise<CaseResult> {
  return {
    id: "oauth-integration",
    status: "blocked",
    required: false,
    detail:
      "packaged browser/OAuth flow is not driven here; see packages/cli/test/local/mastodon-oauth.test.ts (57 tests, real loopback callback and SIGINT subprocess)",
    assertions: ["blocked: engine evidence referenced, packaged flow not claimed"],
    commands: [],
  };
}

const exitCode = await main();

if (exitCode !== 0) {
  process.exitCode = exitCode;
}
