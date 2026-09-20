import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLI_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** The built entry point, exactly as `bin` points at it. */
export const CLI_BIN = path.join(CLI_ROOT, "dist", "bin.js");

const PTY_RUNNER = path.join(CLI_ROOT, "test", "support", "pty-run.py");

/** Syndroo variables are stripped so a developer's shell cannot change a result. */
function cleanEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  delete env["SYNDROO_BASE_URL"];
  delete env["SYNDROO_API_KEY"];

  return { ...env, ...overrides };
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface RunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/**
 * Runs the built CLI as a real subprocess with no shell in between.
 *
 * `spawn` is used without `shell: true`, which is the mechanism that keeps post
 * content out of a command line: the document travels on stdin or in a file.
 */
export function runCli(
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: options.cwd ?? CLI_ROOT,
      env: cleanEnv(options.env ?? {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 20_000);

    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

export interface PtyRunResult {
  readonly code: number;
  /** Merged terminal output: under a pty, stdout and stderr share one stream. */
  readonly output: string;
}

export interface PtyRunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** Text that must appear before the run counts as ready for an answer. */
  readonly trigger: string;
  /** Bytes written to the terminal once the trigger appears. */
  readonly answer: string;
  /** Runs between the trigger and the answer. This is where a test edits files. */
  readonly beforeAnswer?: () => void | Promise<void>;
  readonly timeoutMs?: number;
}

/**
 * Runs the CLI on a real pseudo-terminal.
 *
 * `isTTY` cannot be faked by piping, and the TTY path is exactly the code that
 * waits for a human, so the test drives a genuine pty through `pty-run.py`.
 */
export function runCliPty(
  args: readonly string[],
  options: PtyRunOptions,
): Promise<PtyRunResult> {
  return new Promise((resolve, reject) => {
    const spec = Buffer.from(
      JSON.stringify({
        argv: [process.execPath, CLI_BIN, ...args],
        cwd: options.cwd ?? CLI_ROOT,
        env: cleanEnv(options.env ?? {}),
        trigger: options.trigger,
        timeoutMs: options.timeoutMs ?? 30_000,
      }),
      "utf8",
    ).toString("base64");
    const child = spawn("python3", [PTY_RUNNER, spec], {
      cwd: options.cwd ?? CLI_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let answering = false;
    let settled = false;

    const fail = (error: unknown): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    child.stderr.on("data", chunk => {
      const text = chunk.toString("utf8");
      stderr += text;

      if (!answering && text.includes("@@READY")) {
        answering = true;
        void Promise.resolve()
          .then(() => options.beforeAnswer?.())
          .then(() => {
            child.stdin.end(options.answer);
          })
          .catch(fail);
      }
    });
    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => {
      if (settled) {
        return;
      }

      settled = true;

      try {
        const parsed = JSON.parse(stdout) as { code?: unknown; output?: unknown };
        resolve({
          code: typeof parsed.code === "number" ? parsed.code : -1,
          output: typeof parsed.output === "string" ? parsed.output : "",
        });
      } catch {
        reject(
          new Error(
            `pty runner produced no JSON result (stderr: ${stderr.slice(0, 500)}) stdout: ${stdout.slice(0, 500)}`,
          ),
        );
      }
    });
  });
}

/** A disposable directory outside the repository for document fixtures. */
export function withTempDir<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(path.join(tmpdir(), "syndroo-cli-"));

  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function parseJsonObject(stdout: string): Record<string, unknown> {
  const value = JSON.parse(stdout) as unknown;

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected a JSON object on stdout, received ${stdout.slice(0, 200)}`);
  }

  return value as Record<string, unknown>;
}
