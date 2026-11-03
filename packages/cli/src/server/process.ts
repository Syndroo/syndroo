import { spawn } from "node:child_process";
import path from "node:path";

export type ServerTool = "git" | "gh" | "npm" | "node" | "wrangler";

export type ProcessRequest = {
  readonly tool: ServerTool;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Bounded stdin for a command that must not receive a secret in argv. */
  readonly stdin?: Uint8Array;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Tool-local auth overrides; disallowed names are ignored. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
};

export type ProcessResult = {
  readonly status: "exited" | "timed_out" | "output_limit" | "spawn_error";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_LIMIT = 65_536;
const MAX_OUTPUT_LIMIT = 1_048_576;
const MAX_STDIN_BYTES = 1_048_576;
const MAX_ARGS = 64;
const MAX_ARG_BYTES = 131_072;

const SAFE_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "GH_CONFIG_DIR",
] as const;

const TOOL_ENVIRONMENT_KEYS: Readonly<Record<ServerTool, readonly string[]>> = {
  git: ["SSH_AUTH_SOCK"],
  gh: ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_ENTERPRISE_TOKEN"],
  npm: ["NODE_AUTH_TOKEN", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_REGISTRY"],
  node: [],
  wrangler: [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL",
    "WRANGLER_OUTPUT_FILE_PATH",
    "WRANGLER_SEND_METRICS",
    "CI",
  ],
};

function toolPath(tool: ServerTool, cwd: string): string {
  if (tool === "node") {
    return process.execPath;
  }
  if (tool === "wrangler") {
    return path.join(cwd, "node_modules", ".bin", "wrangler");
  }
  return tool;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  return Math.min(maximum, Math.max(1, value ?? fallback));
}

export function serverProcessEnvironment(
  tool: ServerTool,
  environment: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  const allowed = new Set([...SAFE_ENVIRONMENT_KEYS, ...TOOL_ENVIRONMENT_KEYS[tool]]);
  for (const key of allowed) {
    const value = environment[key];
    if (value !== undefined) {
      safe[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (allowed.has(key) && value !== undefined) {
      safe[key] = value;
    }
  }
  return safe;
}

function validateRequest(request: ProcessRequest): void {
  if (
    request.args.length > MAX_ARGS ||
    request.args.some(
      (argument) =>
        argument.length > MAX_ARG_BYTES ||
        /[\u0000]/.test(argument),
    ) ||
    (request.stdin?.length ?? 0) > MAX_STDIN_BYTES
  ) {
    throw new Error("PROCESS_REQUEST_INVALID");
  }
}

export function createNodeProcessRunner(
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): ProcessRunner {
  return {
    run(request: ProcessRequest): Promise<ProcessResult> {
      validateRequest(request);

      return new Promise((resolve) => {
        const outputLimit = boundedInteger(
          request.maxOutputBytes,
          DEFAULT_OUTPUT_LIMIT,
          MAX_OUTPUT_LIMIT,
        );
        const timeoutMs = boundedInteger(
          request.timeoutMs,
          DEFAULT_TIMEOUT_MS,
          MAX_TIMEOUT_MS,
        );
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let reason: "timed_out" | "output_limit" | undefined;
        let settled = false;

        const child = spawn(toolPath(request.tool, request.cwd), [...request.args], {
          cwd: request.cwd,
          env: serverProcessEnvironment(
            request.tool,
            environment,
            request.environment,
          ),
          shell: false,
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });

        const kill = (): void => {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              if (process.platform !== "win32" && child.pid !== undefined) {
                process.kill(-child.pid, "SIGKILL");
              } else {
                child.kill("SIGKILL");
              }
            } catch {
              child.kill("SIGKILL");
            }
          }
        };
        const timeout = setTimeout(() => {
          reason = "timed_out";
          kill();
        }, timeoutMs);
        const abort = (): void => kill();
        signal.addEventListener("abort", abort, { once: true });

        const collect = (target: Buffer[], chunk: Buffer): void => {
          const current = stdoutBytes + stderrBytes;
          const remaining = Math.max(0, outputLimit - current);
          if (remaining > 0) {
            target.push(chunk.subarray(0, remaining));
          }
          if (current + chunk.length > outputLimit) {
            reason = "output_limit";
            kill();
          }
        };

        child.stdout.on("data", (chunk: Buffer) => {
          collect(stdout, chunk);
          stdoutBytes += chunk.length;
        });
        child.stderr.on("data", (chunk: Buffer) => {
          collect(stderr, chunk);
          stderrBytes += chunk.length;
        });
        child.on("error", () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
          resolve({
            status: "spawn_error",
            exitCode: null,
            stdout: "",
            stderr: "",
          });
        });
        child.on("close", (code) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
          resolve({
            status: reason ?? "exited",
            exitCode: code,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });

        child.stdin.on("error", () => undefined);
        child.stdin.end(request.stdin);

        if (signal.aborted) {
          kill();
        }
      });
    },
  };
}
