import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import { run } from "../../../src/index.js";
import type { CliIo } from "../../../src/io.js";
import type { LocalRuntimeOverrides } from "../../../src/runtime/local/composition.js";

/**
 * A private home/config/state tree for one test.
 *
 * Nothing here touches the real user profile: `HOME`, `XDG_CONFIG_HOME` and
 * `XDG_STATE_HOME` all point inside the scratch directory, so the default
 * config file and the default state root resolve inside it. `realpath` is
 * applied because macOS exposes `mkdtemp` results through the `/var` alias.
 */
export type Sandbox = {
  readonly root: string;
  readonly home: string;
  readonly configRoot: string;
  readonly stateHome: string;
  /** `<XDG_STATE_HOME>/syndroo/runtime-v1`, the architecture-v1 state root. */
  readonly stateRoot: string;
  readonly env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
};

export async function sandbox(prefix = "syndroo-cli-v1-"): Promise<Sandbox> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  const home = path.join(root, "home");
  const configRoot = path.join(root, "config");
  const stateHome = path.join(root, "state");
  await fs.mkdir(home, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: configRoot,
    XDG_STATE_HOME: stateHome,
    NO_COLOR: "1",
    ...(process.env["PATH"] === undefined ? {} : { PATH: process.env["PATH"] }),
  };

  return {
    root,
    home,
    configRoot,
    stateHome,
    stateRoot: path.join(stateHome, "syndroo", "runtime-v1"),
    env,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

/** The state root exists on disk (a write, or a journal record, happened). */
export function stateRootExists(box: Sandbox): boolean {
  return existsSync(box.stateRoot);
}

/**
 * Every path below the state root, with a short content hash for files.
 *
 * Comparing two snapshots detects a write that changes bytes even when the file
 * name is unchanged, so "read-only" is a byte-level observation.
 */
export async function stateTree(box: Sandbox): Promise<string[]> {
  if (!existsSync(box.stateRoot)) {
    return [];
  }

  const found: string[] = [];

  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const relative = path.relative(box.stateRoot, child);

      if (entry.isDirectory()) {
        found.push(`${relative}/`);
        await visit(child);
      } else {
        const bytes = await fs.readFile(child);
        const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);

        found.push(`${relative}:${digest}`);
      }
    }
  }

  await visit(box.stateRoot);

  return found.sort();
}

type Capture = {
  readonly io: CliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
};

function sink(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, done): void {
      chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf8"));
      done();
    },
  });

  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

export type RunOptions = {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Standard input bytes; omitted means empty, never a terminal. */
  readonly stdin?: string;
  readonly stdinIsTty?: boolean;
  readonly stdoutIsTty?: boolean;
  readonly signal?: AbortSignal;
  /** Test-only seam; never reachable from a CLI flag. */
  readonly overrides?: LocalRuntimeOverrides;
  /** Fake controlling terminal: presence, scripted answers, and read counters. */
  readonly tty?: TtyDouble;
};

/**
 * A scripted controlling terminal for the interactive paths.
 *
 * `lines` feeds `readTtyLine` in order (confirmations), `hiddenLines` feeds
 * `readHiddenTtyLine` (secret fields). A reader past the end returns
 * `undefined`, which is how "the human supplied nothing" is modelled. `calls`
 * records how many times each reader was invoked, so a test can prove a prompt
 * did not happen rather than only that its text is absent.
 */
export type TtyDouble = {
  readonly hasTty?: boolean;
  readonly lines?: readonly string[];
  readonly hiddenLines?: readonly string[];
  readonly calls?: { tty: number; hidden: number };
};

export type RunResult = {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
};

function capture(options: RunOptions): { io: CliIo; out: () => string; err: () => string } {
  const out = sink();
  const err = sink();
  const stdin = Readable.from(
    options.stdin === undefined ? [] : [Buffer.from(options.stdin, "utf8")],
  );
  const tty = options.tty ?? {};
  const ttyLines = [...(tty.lines ?? [])];
  const hiddenLines = [...(tty.hiddenLines ?? [])];

  const io: CliIo = {
    stdin,
    stdout: out.stream,
    stderr: err.stream,
    env: options.env,
    cwd: options.cwd,
    stdinIsTty: options.stdinIsTty ?? false,
    stdoutIsTty: options.stdoutIsTty ?? false,
    hasTty: () => tty.hasTty ?? false,
    readTtyLine: () => {
      if (tty.calls !== undefined) {
        tty.calls.tty += 1;
      }

      return ttyLines.shift();
    },
    ...(tty.hiddenLines === undefined
      ? {}
      : {
          readHiddenTtyLine: async (
            _limitMs: number,
            _signal?: AbortSignal,
            onReady?: () => void,
          ) => {
            if (tty.calls !== undefined) {
              tty.calls.hidden += 1;
            }

            onReady?.();

            return hiddenLines.shift();
          },
        }),
    signal: options.signal ?? new AbortController().signal,
  };

  return { io, out: out.text, err: err.text };
}

/** Drive one invocation in-process and capture its streams. Never throws. */
export async function runCli(
  argv: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const streams = capture(options);
  const exit = await run(argv, streams.io, options.overrides ?? {});

  return { exit, stdout: streams.out(), stderr: streams.err() };
}

/** Parse a single-line JSON stdout stream, or fail with the raw text. */
export function parseEnvelope(result: RunResult): Record<string, any> {
  const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);

  if (lines.length !== 1) {
    throw new Error(`expected exactly one stdout line, got ${lines.length}: ${result.stdout}`);
  }

  return JSON.parse(lines[0] as string) as Record<string, any>;
}
