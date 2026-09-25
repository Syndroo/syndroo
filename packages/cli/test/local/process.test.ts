/**
 * T07 process verification: real OS subprocesses and a real pseudo-terminal.
 *
 * Every case here runs a genuine child process. Two child kinds are used:
 *
 * - `dist/bin.js`, the shipped entry point, for the behaviour that belongs to
 *   the binary itself (the stdin deadline, its own signal controller, and its
 *   closed-pipe handler).
 * - `test/local/support/process-entry.ts`, compiled to a temporary tree, which
 *   imports the public `@syndroo/cli` surface and injects the test-only fake
 *   provider. No production flag, environment variable, or config field can
 *   reach that override.
 *
 * Content calls are counted from the evidence file the fake provider appends to
 * before it can block, so a signalled or killed child still leaves an exact
 * count behind.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ProcessSpec, PublishMode } from "./support/process-entry.js";

const CLI_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPO_ROOT = path.resolve(CLI_ROOT, "..", "..");
const ENTRY_SOURCE = path.join(
  CLI_ROOT,
  "test",
  "local",
  "support",
  "process-entry.ts",
);
const PTY_RUNNER = path.join(CLI_ROOT, "test", "support", "pty-run.py");
const CLI_BIN = path.join(CLI_ROOT, "dist", "bin.js");

/** Explicitly fake material; never a real account or secret. */
const FAKE_IDENTIFIER = "process-fixture.bsky.social";
const FAKE_PASSWORD = "fake-process-password-not-a-real-secret";
const FAKE_TARGET = "did:plc:process-fixture";

/** The natural `--input -` deadline is 15s; the bound is generous but final. */
const STDIN_DEADLINE_BOUND_MS = 30_000;
const STDIN_DEADLINE_FLOOR_MS = 12_000;
const DEFAULT_BOUND_MS = 25_000;

interface ChildRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly elapsedMs: number;
}

interface TrackedChild {
  readonly child: ChildProcess;
  readonly result: Promise<ChildRun>;
  stdout(): string;
  stderr(): string;
}

const openChildren = new Set<ChildProcess>();
const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function makeHome(name: string): string {
  const home = path.join(makeTempRoot(`syndroo-home-${name}-`), "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

function makeControl(name: string): string {
  const control = path.join(makeTempRoot(`syndroo-control-${name}-`), "control");
  mkdirSync(control, { recursive: true });
  return control;
}

/** A minimal environment: no real credentials, no routing variables. */
function childEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    TMPDIR: tmpdir(),
    LANG: process.env["LANG"] ?? "C",
    BLUESKY_IDENTIFIER: FAKE_IDENTIFIER,
    BLUESKY_PASSWORD: FAKE_PASSWORD,
    ...extra,
  };
}

interface SpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  /** Leaves stdin open forever, to prove a bounded read. */
  readonly holdStdin?: boolean;
  /** Closes the read end of stdout immediately, to force EPIPE. */
  readonly closeStdout?: boolean;
}

function spawnTracked(
  argv: readonly string[],
  options: SpawnOptions,
): TrackedChild {
  const started = Date.now();
  const child = spawn(argv[0] as string, argv.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: [options.holdStdin === true ? "pipe" : "ignore", "pipe", "pipe"],
  });

  openChildren.add(child);

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", chunk => {
    stdout += chunk as string;
  });
  child.stderr?.on("data", chunk => {
    stderr += chunk as string;
  });

  if (options.closeStdout === true) {
    child.stdout?.destroy();
  }

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs);

  const result = new Promise<ChildRun>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      openChildren.delete(child);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        elapsedMs: Date.now() - started,
      });
    });
  });

  return {
    child,
    result,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function spawnEntry(options: {
  readonly entry: string;
  readonly home: string;
  readonly spec: ProcessSpec;
  readonly timeoutMs?: number;
  readonly holdStdin?: boolean;
  readonly closeStdout?: boolean;
}): TrackedChild {
  mkdirSync(options.spec.controlDir, { recursive: true });
  const specPath = path.join(options.spec.controlDir, "spec.json");
  writeFileSync(specPath, `${JSON.stringify(options.spec, null, 2)}\n`);

  return spawnTracked([process.execPath, options.entry, specPath], {
    cwd: CLI_ROOT,
    env: childEnv(options.home),
    timeoutMs: options.timeoutMs ?? DEFAULT_BOUND_MS,
    ...(options.holdStdin === undefined ? {} : { holdStdin: options.holdStdin }),
    ...(options.closeStdout === undefined
      ? {}
      : { closeStdout: options.closeStdout }),
  });
}

interface Envelope {
  readonly schemaVersion?: unknown;
  readonly command?: unknown;
  readonly mode?: unknown;
  readonly ok?: unknown;
  readonly result?: Record<string, unknown> | null;
  readonly error?: { readonly code?: unknown; readonly message?: unknown } | null;
}

function parseEnvelope(run: ChildRun): Envelope {
  const line = run.stdout.trim().split("\n").filter(part => part.length > 0).pop();

  if (line === undefined) {
    throw new Error(
      `no envelope on stdout (exit ${String(run.code)}): ${run.stderr.slice(0, 400)}`,
    );
  }

  return JSON.parse(line) as Envelope;
}

async function runEntryJson(
  entry: string,
  home: string,
  argv: readonly string[],
  options: {
    readonly publishMode?: PublishMode;
    readonly controlDir?: string;
    readonly timeoutMs?: number;
  } = {},
): Promise<{ readonly run: ChildRun; readonly envelope: Envelope }> {
  const controlDir = options.controlDir ?? makeControl("run");
  const tracked = spawnEntry({
    entry,
    home,
    spec: {
      argv,
      controlDir,
      ...(options.publishMode === undefined
        ? {}
        : { publishMode: options.publishMode }),
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const run = await tracked.result;

  return { run, envelope: parseEnvelope(run) };
}

function contentCalls(controlDir: string): readonly unknown[] {
  const file = path.join(controlDir, "content-calls.jsonl");

  if (!existsSync(file)) {
    return [];
  }

  return readFileSync(file, "utf8")
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as unknown);
}

async function waitForFile(file: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!existsSync(file)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${path.basename(file)}`);
    }

    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function writeDocument(home: string, content: string, key = "process-fixture-1"): string {
  const file = path.join(home, "document.json");
  writeFileSync(
    file,
    `${JSON.stringify({
      schemaVersion: 1,
      key,
      content,
      platforms: ["bluesky"],
    })}\n`,
  );
  return file;
}

/** init → auth set → one dry-run plan, the common setup for execution cases. */
async function seedPlan(
  entry: string,
  home: string,
  content: string,
): Promise<string> {
  const init = await runEntryJson(entry, home, ["init", "--json"]);
  expect(init.run.code).toBe(0);

  const bound = await runEntryJson(entry, home, [
    "auth",
    "set",
    "bluesky",
    "--local",
    "--from-env",
    "--yes",
    "--no-input",
    "--expect-account",
    FAKE_TARGET,
    "--json",
  ]);
  expect(bound.run.code).toBe(0);

  const document = writeDocument(home, content);
  const preview = await runEntryJson(entry, home, [
    "publish",
    "--input",
    document,
    "--dry-run",
    "--json",
  ]);
  expect(preview.run.code).toBe(0);

  return String(preview.envelope.result?.["planId"]);
}

function compileEntry(outDir: string): string {
  const configPath = path.join(path.dirname(outDir), "tsconfig.process-child.json");
  mkdirSync(outDir, { recursive: true });

  const modules = path.join(outDir, "node_modules");

  if (!existsSync(modules)) {
    symlinkSync(path.join(REPO_ROOT, "node_modules"), modules, "dir");
  }

  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          rootDir: CLI_ROOT,
          outDir,
          strict: true,
          skipLibCheck: true,
          typeRoots: [path.join(outDir, "node_modules", "@types")],
          types: ["node"],
          lib: ["ES2022"],
          verbatimModuleSyntax: true,
          declaration: false,
          sourceMap: false,
          noEmitOnError: true,
        },
        files: [ENTRY_SOURCE],
      },
      null,
      2,
    )}\n`,
  );

  const result = spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      configPath,
    ],
    { encoding: "utf8" },
  );
  const emitted = path.join(
    outDir,
    "test",
    "local",
    "support",
    "process-entry.js",
  );

  if (result.status !== 0 || !existsSync(emitted)) {
    throw new Error(
      `the process entry did not compile (exit ${String(result.status)}): ` +
        `${result.stdout}${result.stderr}`,
    );
  }

  return emitted;
}

let ENTRY = "";

beforeAll(() => {
  ENTRY = compileEntry(path.join(makeTempRoot("syndroo-entry-"), "build"));
});

afterAll(() => {
  for (const child of openChildren) {
    child.kill("SIGKILL");
  }

  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("shipped bin: held-open stdin", () => {
  it("exits with 2 after the natural deadline and never hangs on the pipe", async () => {
    const tracked = spawnTracked(
      [process.execPath, CLI_BIN, "publish", "--input", "-", "--dry-run", "--json"],
      {
        cwd: CLI_ROOT,
        env: childEnv(makeHome("stdin")),
        timeoutMs: STDIN_DEADLINE_BOUND_MS,
        holdStdin: true,
      },
    );
    const run = await tracked.result;

    // The pipe is still open: a bounded read must still end the process. A
    // killed child here means the deadline reported but never released stdin.
    expect({
      timedOut: run.timedOut,
      signal: run.signal,
      stdout: run.stdout.slice(0, 200),
    }).toEqual({ timedOut: false, signal: null, stdout: run.stdout.slice(0, 200) });
    expect(run.code).toBe(2);
    expect(run.elapsedMs).toBeGreaterThanOrEqual(STDIN_DEADLINE_FLOOR_MS);
    expect(run.elapsedMs).toBeLessThan(STDIN_DEADLINE_BOUND_MS);

    const envelope = parseEnvelope(run);
    expect(envelope.command).toBe("publish");
    expect(envelope.mode).toBe("local");
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("INVALID_DOCUMENT");
  });

  it("stops on SIGINT while it is still waiting for stdin", async () => {
    const tracked = spawnTracked(
      [process.execPath, CLI_BIN, "publish", "--input", "-", "--dry-run", "--json"],
      {
        cwd: CLI_ROOT,
        env: childEnv(makeHome("stdin-sigint")),
        timeoutMs: DEFAULT_BOUND_MS,
        holdStdin: true,
      },
    );

    await new Promise(resolve => setTimeout(resolve, 1_000));
    tracked.child.kill("SIGINT");
    const run = await tracked.result;

    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(130);
    expect(parseEnvelope(run).error?.code).toBe("INTERRUPTED");
  });

  it("leaves a safe non-zero exit and no stack when stdout is already closed", async () => {
    // `version` answers immediately on stdout, so the closed read end is hit
    // by the shipped entry point rather than by the argument parser.
    const tracked = spawnTracked([process.execPath, CLI_BIN, "version"], {
      cwd: CLI_ROOT,
      env: childEnv(makeHome("epipe")),
      timeoutMs: DEFAULT_BOUND_MS,
      closeStdout: true,
    });
    const run = await tracked.result;

    expect(run.timedOut).toBe(false);
    expect(run.code).not.toBe(0);
    expect(run.code).toBe(1);
    expect(run.stderr.includes("Error:")).toBe(false);
    expect(run.stderr.includes("    at ")).toBe(false);
  });
});

describe("process entry: safe output", () => {
  it("escapes control characters and never prints the credential", async () => {
    const home = makeHome("safe");
    const control = makeControl("safe");
    const init = await runEntryJson(ENTRY, home, ["init", "--json"], {
      controlDir: control,
    });
    expect(init.run.code).toBe(0);

    const bound = await runEntryJson(
      ENTRY,
      home,
      [
        "auth",
        "set",
        "bluesky",
        "--local",
        "--from-env",
        "--yes",
        "--no-input",
        "--expect-account",
        FAKE_TARGET,
        "--json",
      ],
      { controlDir: makeControl("safe-auth") },
    );
    expect(bound.run.code).toBe(0);

    // Human mode renders the frozen content, which is where escaping matters.
    const document = writeDocument(
      home,
      "before\u001b[31mred\u0007after",
      "process-fixture-control",
    );
    const tracked = spawnEntry({
      entry: ENTRY,
      home,
      spec: {
        argv: ["publish", "--input", document, "--dry-run"],
        controlDir: makeControl("safe-preview"),
      },
    });
    const run = await tracked.result;

    expect(run.code).toBe(0);
    expect(run.stdout.includes("\\u001b")).toBe(true);
    expect(run.stdout.includes("\u001b")).toBe(false);
    expect(run.stderr.includes("\u001b")).toBe(false);
    expect(run.stdout.includes(FAKE_PASSWORD)).toBe(false);
    expect(run.stderr.includes(FAKE_PASSWORD)).toBe(false);
  });
});

describe("process entry: closed stdout after a successful publish", () => {
  it("does not resend, keeps the persisted success, and reports no stack", async () => {
    const home = makeHome("epipe-publish");
    const planId = await seedPlan(ENTRY, home, "closed pipe content");
    const control = makeControl("epipe-publish-run");
    const tracked = spawnEntry({
      entry: ENTRY,
      home,
      spec: {
        argv: [
          "publish",
          "--plan",
          planId,
          "--yes",
          "--no-input",
          "--json",
        ],
        controlDir: control,
      },
      closeStdout: true,
    });
    const run = await tracked.result;

    expect(run.timedOut).toBe(false);
    expect(run.code).not.toBe(0);
    expect(run.stderr.includes("Error:")).toBe(false);
    expect(run.stderr.includes("    at ")).toBe(false);

    // The content request happened exactly once, and the persisted receipt is
    // the successful result rather than a resend.
    expect(contentCalls(control)).toHaveLength(1);

    const receipt = await runEntryJson(
      ENTRY,
      home,
      ["receipts", "show", await latestOperationId(ENTRY, home), "--json"],
      { controlDir: makeControl("epipe-publish-receipt") },
    );
    expect(receipt.run.code).toBe(0);
    expect(receipt.envelope.result?.["operation"]).toMatchObject({
      status: "succeeded",
    });
  });
});

async function latestOperationId(entry: string, home: string): Promise<string> {
  const list = await runEntryJson(entry, home, ["receipts", "list", "--json"], {
    controlDir: makeControl("receipts-list"),
  });
  expect(list.run.code).toBe(0);
  const operations = list.envelope.result?.["operations"] as
    | readonly { readonly operationId?: unknown }[]
    | undefined;

  return String(operations?.[0]?.operationId);
}

describe("process entry: a real signal during a content request", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`stops with 130 on ${signal} and records the true receipt`, async () => {
      const home = makeHome(`signal-${signal}`);
      const planId = await seedPlan(ENTRY, home, `slow provider under ${signal}`);
      const control = makeControl(`signal-${signal}-run`);
      const tracked = spawnEntry({
        entry: ENTRY,
        home,
        spec: {
          argv: [
            "publish",
            "--plan",
            planId,
            "--yes",
            "--no-input",
            "--json",
          ],
          controlDir: control,
          publishMode: "abort",
        },
      });

      await waitForFile(path.join(control, "publish-started"));
      tracked.child.kill(signal);
      const run = await tracked.result;

      expect(run.timedOut).toBe(false);
      expect(run.code).toBe(130);
      expect(contentCalls(control)).toHaveLength(1);

      const receipt = await runEntryJson(
        ENTRY,
        home,
        ["receipts", "show", await latestOperationId(ENTRY, home), "--json"],
        { controlDir: makeControl(`signal-${signal}-receipt`) },
      );
      expect(receipt.run.code).toBe(0);
      expect(receipt.envelope.result?.["operation"]).toMatchObject({
        status: "unknown",
        interrupted: true,
      });
      const results = receipt.envelope.result?.["results"] as
        | readonly { readonly attempts?: unknown; readonly status?: unknown }[]
        | undefined;
      expect(results?.[0]?.attempts).toBe(1);
      expect(results?.[0]?.status).toBe("unknown");
    });
  }
});

describe("process entry: real pty confirmation", () => {
  async function runPty(
    home: string,
    spec: ProcessSpec,
    trigger: string,
    answer: string,
  ): Promise<{ readonly code: number; readonly output: string }> {
    const specPath = path.join(spec.controlDir, "spec.json");
    mkdirSync(spec.controlDir, { recursive: true });
    writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);

    const encoded = Buffer.from(
      JSON.stringify({
        argv: [process.execPath, ENTRY, specPath],
        cwd: CLI_ROOT,
        env: childEnv(home),
        trigger,
        timeoutMs: 30_000,
      }),
      "utf8",
    ).toString("base64");

    const child = spawn("python3", [PTY_RUNNER, encoded], {
      cwd: CLI_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    openChildren.add(child);

    let stdout = "";
    let stderr = "";
    let answered = false;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", chunk => {
      stdout += chunk as string;
    });
    child.stderr?.on("data", chunk => {
      stderr += chunk as string;

      if (!answered && (chunk as string).includes("@@READY")) {
        answered = true;
        child.stdin?.write(answer);
      }
    });

    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`pty run did not finish: ${stderr}`));
      }, 40_000);

      child.on("error", reject);
      child.on("close", () => {
        clearTimeout(timer);
        openChildren.delete(child);
        resolve(0);
      });
    });

    void code;
    const parsed = JSON.parse(stdout) as { code: number; output: string };

    if (!answered) {
      throw new Error(`the pty run never reached its prompt: ${parsed.output}`);
    }

    return parsed;
  }

  it("declines on a real terminal with exit 5 and no content request", async () => {
    const home = makeHome("pty-decline");
    const planId = await seedPlan(ENTRY, home, "pty decline content");
    const control = makeControl("pty-decline-run");
    const result = await runPty(
      home,
      { argv: ["publish", "--plan", planId, "--json"], controlDir: control },
      "Continue?",
      "n\n",
    );

    expect(result.code).toBe(5);
    expect(contentCalls(control)).toHaveLength(0);
  });

  it("accepts on a real terminal, publishes once, and reports ok", async () => {
    const home = makeHome("pty-accept");
    const planId = await seedPlan(ENTRY, home, "pty accept content");
    const control = makeControl("pty-accept-run");
    const result = await runPty(
      home,
      { argv: ["publish", "--plan", planId, "--json"], controlDir: control },
      "Continue?",
      "y\n",
    );

    expect(result.code).toBe(0);
    expect(contentCalls(control)).toHaveLength(1);
    expect(result.output.includes('"command":"publish"')).toBe(true);
    expect(result.output.includes('"ok":true')).toBe(true);
  });
});

describe("process entry: global write lock across a real content request", () => {
  it("refuses an auth writer while a publish holds the lock, then allows it", async () => {
    const home = makeHome("lock");
    const planId = await seedPlan(ENTRY, home, "lock holder content");
    const holderControl = makeControl("lock-holder");
    const holder = spawnEntry({
      entry: ENTRY,
      home,
      spec: {
        argv: [
          "publish",
          "--plan",
          planId,
          "--yes",
          "--no-input",
          "--json",
        ],
        controlDir: holderControl,
        publishMode: "hold",
      },
    });

    await waitForFile(path.join(holderControl, "publish-started"));

    const busySet = await runEntryJson(
      ENTRY,
      home,
      [
        "auth",
        "set",
        "bluesky",
        "--local",
        "--from-env",
        "--yes",
        "--no-input",
        "--expect-account",
        FAKE_TARGET,
        "--json",
      ],
      { controlDir: makeControl("lock-set") },
    );
    expect(busySet.run.code).toBe(2);
    expect(busySet.envelope.error?.code).toBe("STATE_BUSY");

    const busyRemove = await runEntryJson(
      ENTRY,
      home,
      [
        "auth",
        "remove",
        "bluesky",
        "--local",
        "--yes",
        "--no-input",
        "--expect-account",
        FAKE_TARGET,
        "--json",
      ],
      { controlDir: makeControl("lock-remove") },
    );
    expect(busyRemove.run.code).toBe(2);
    expect(busyRemove.envelope.error?.code).toBe("STATE_BUSY");

    // The refused writers changed nothing and started no content request.
    expect(contentCalls(holderControl)).toHaveLength(1);

    writeFileSync(path.join(holderControl, "release"), "go");
    const holderRun = await holder.result;
    expect(holderRun.timedOut).toBe(false);
    expect(holderRun.code).toBe(0);
    expect(contentCalls(holderControl)).toHaveLength(1);

    const status = await runEntryJson(
      ENTRY,
      home,
      ["auth", "status", "bluesky", "--local", "--json"],
      { controlDir: makeControl("lock-status") },
    );
    const bindings = status.envelope.result?.["bindings"] as
      | readonly { readonly bindingRevision?: unknown }[]
      | undefined;
    expect(bindings?.[0]?.bindingRevision).toBe(1);

    const allowed = await runEntryJson(
      ENTRY,
      home,
      [
        "auth",
        "set",
        "bluesky",
        "--local",
        "--from-env",
        "--yes",
        "--no-input",
        "--expect-account",
        FAKE_TARGET,
        "--json",
      ],
      { controlDir: makeControl("lock-set-after") },
    );
    expect(allowed.run.code).toBe(0);
    expect(allowed.envelope.result?.["bindingRevision"]).toBe(2);
  });
});
