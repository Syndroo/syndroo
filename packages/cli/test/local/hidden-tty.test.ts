import { spawn } from "node:child_process";
import { closeSync, constants as fsConstants, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

/**
 * A1: the hidden terminal read is truly asynchronous.
 *
 * The fixture is TypeScript, bundled once with the repository's esbuild, and
 * run on a real pseudo-terminal through the pre-existing PTY driver. A signal
 * delivered while the read waits must reach the event loop, and the terminal
 * must be restored on every exit path.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(HERE, "..", "..");
const PTY_RUNNER = path.join(CLI_ROOT, "test", "support", "pty-run.py");
const FIXTURE = path.join(CLI_ROOT, "test", "fixtures", "hidden-tty-child.ts");

const buildRoot = mkdtempSync(path.join(tmpdir(), "syndroo-hidden-tty-"));
const BUNDLE = path.join(buildRoot, "hidden-tty-child.mjs");

/**
 * These cases need a writable controlling terminal.
 *
 * A restricted sandbox denies `open("/dev/tty", O_RDWR)`; the root runs this
 * file outside that sandbox, exactly like the loopback fixtures.
 */
const CAN_OPEN_TTY = ((): boolean => {
  try {
    closeSync(openSync("/dev/tty", fsConstants.O_RDWR | fsConstants.O_NONBLOCK));
    return true;
  } catch {
    return false;
  }
})();

afterAll(() => {
  rmSync(buildRoot, { recursive: true, force: true });
});

function buildFixture(): void {
  buildSync({
    absWorkingDir: CLI_ROOT,
    entryPoints: [FIXTURE],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: BUNDLE,
  });
}

interface PtyResult {
  readonly code: number;
  readonly output: string;
}

function runPty(spec: {
  readonly mode?: string;
  readonly trigger: string;
  readonly answer?: string;
  readonly answerDelayMs?: number;
  readonly secondAnswer?: string;
  readonly secondAnswerDelayMs?: number;
  readonly timeoutMs?: number;
}): Promise<PtyResult> {
  buildFixture();

  const encoded = Buffer.from(
    JSON.stringify({
      argv: [process.execPath, BUNDLE, spec.mode ?? "read"],
      cwd: CLI_ROOT,
      env: { ...process.env },
      trigger: spec.trigger,
      timeoutMs: spec.timeoutMs ?? 20_000,
    }),
    "utf8",
  ).toString("base64");

  return new Promise((resolve, reject) => {
    const child = spawn("python3", [PTY_RUNNER, encoded], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let answered = false;

    child.stderr.on("data", chunk => {
      const text = chunk.toString("utf8");
      stderr += text;

      if (!answered && text.includes("@@READY")) {
        answered = true;

        if (spec.answer !== undefined) {
          setTimeout(() => {
            child.stdin.write(spec.answer as string);

            setTimeout(() => {
              child.stdin.end(spec.secondAnswer ?? "");
            }, spec.secondAnswerDelayMs ?? 1200);
          }, spec.answerDelayMs ?? 0);
        }
      }
    });
    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout) as PtyResult);
      } catch {
        reject(new Error(`bad pty output: ${stdout} ${stderr}`));
      }
    });
  });
}

describe("hidden terminal input", () => {
  it.skipIf(!CAN_OPEN_TTY)("reads a line with no echo and restores the terminal", async () => {
    const secret = "HIDDEN-CANARY-1234567890";
    const visible = "VISIBLE-CANARY-24680";
    const result = await runPty({
      trigger: "ECHO_OFF",
      answer: `${secret}\n`,
      secondAnswer: `${visible}\n`,
      // The marker is written with echo off; type immediately.
      answerDelayMs: 0,
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain(`RESULT=${secret.length}`);
    expect(result.output).not.toContain(secret);
    expect(result.output).toContain("RESTORED");
    // The real termios state is compared before and after the hidden read.
    expect(result.output).toContain("TTY_SAME=yes");
    expect(result.output).toContain("TTY_NONEMPTY=yes");
    // The ordinary read after the seam is echoed normally.
    expect(result.output).toContain(visible);
  });

  it.skipIf(!CAN_OPEN_TTY)("ends the wait on a signal and restores the terminal", async () => {
    const result = await runPty({
      mode: "signal",
      trigger: "ECHO_OFF",
    });

    expect(result.code).toBe(130);
    expect(result.output).toContain("ABORTED");
    // Restoration runs in `finally`, so it completes before this marker.
    expect(result.output).toContain("RESTORED");
    expect(result.output).toContain("TTY_SAME=yes");
    expect(result.output).toContain("TTY_NONEMPTY=yes");
  });

  it.skipIf(!CAN_OPEN_TTY)("ends the wait on SIGINT and restores the terminal", async () => {
    const result = await runPty({
      mode: "signal-int",
      trigger: "ECHO_OFF",
    });

    expect(result.code).toBe(130);
    expect(result.output).toContain("ABORTED");
    expect(result.output).toContain("RESTORED");
    expect(result.output).toContain("TTY_SAME=yes");
    expect(result.output).toContain("TTY_NONEMPTY=yes");
  });

  it.skipIf(!CAN_OPEN_TTY)("restores a terminal whose echo was already off", async () => {
    const secret = "HIDDEN-CANARY-13579";
    const result = await runPty({
      mode: "echo-off",
      trigger: "ECHO_WAS_OFF",
      answer: `${secret}\n`,
    });

    expect(result.code).toBe(0);
    expect(result.output).not.toContain(secret);
    // Restoring the original settings exactly means the echo-off state came
    // back rather than being forced on.
    expect(result.output).toContain("TTY_SAME=yes");
    expect(result.output).toContain("TTY_NONEMPTY=yes");
  });
});
