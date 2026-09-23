/**
 * `posts.wait` has to keep a standalone Node process alive until it settles,
 * and then let that process exit. Both halves are event-loop properties, so
 * they are only observable from a real child process: the child writes a
 * completion marker, and a wait that stops holding the loop open exits 13
 * ("unsettled top-level await") without ever writing it.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SUPPORT_DIR = new URL("./support/", import.meta.url);
const CHILD_SCRIPT = fileURLToPath(new URL("wait-child.ts", SUPPORT_DIR));

/** Keep in sync with the marker prefix written by `support/wait-child.ts`. */
const MARKER_PREFIX = "SYNDROO_WAIT_CHILD ";

/**
 * The runtime executing the suite, or an explicit `SYNDROO_SDK_TEST_NODE`
 * override. Runtime support is reported from the run, never from a hardcoded
 * local path.
 */
const CHILD_NODE = process.env["SYNDROO_SDK_TEST_NODE"] ?? process.execPath;

/** The parent watchdog: a hung child fails the test instead of the suite. */
const CHILD_TIMEOUT_MS = 8_000;
const TEST_TIMEOUT_MS = 20_000;

interface ChildRun {
  readonly marker: Record<string, unknown>;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
}

function runChild(mode: string): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(CHILD_NODE, [CHILD_SCRIPT, mode], {
      cwd: fileURLToPath(SUPPORT_DIR),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CHILD_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);

      if (timedOut) {
        reject(
          new Error(
            `The standalone wait child (${mode}) was still running after ` +
              `${CHILD_TIMEOUT_MS}ms and had to be killed, so the wait never ` +
              `released the event loop. stdout: ${stdout} stderr: ${stderr}`,
          ),
        );
        return;
      }

      if (code !== 0) {
        reject(
          new Error(
            `The standalone wait child (${mode}) exited with code ${code}. ` +
              `stdout: ${stdout} stderr: ${stderr}`,
          ),
        );
        return;
      }

      try {
        resolve({
          marker: markerFrom(mode, stdout),
          stdout,
          stderr,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * A child that stops early never reaches the marker, so a missing marker is a
 * failure rather than a skipped assertion.
 */
function markerFrom(mode: string, stdout: string): Record<string, unknown> {
  const line = stdout
    .split("\n")
    .reverse()
    .find(entry => entry.startsWith(MARKER_PREFIX));

  if (line === undefined) {
    throw new Error(
      `The standalone wait child (${mode}) exited without writing the ` +
        `completion marker. stdout: ${stdout}`,
    );
  }

  return JSON.parse(line.slice(MARKER_PREFIX.length)) as Record<string, unknown>;
}

function methodsOf(marker: Record<string, unknown>): string[] {
  const methods = marker["methods"];

  if (!Array.isArray(methods)) {
    throw new Error(`The marker carried no request list: ${JSON.stringify(marker)}`);
  }

  return methods.map(entry => String(entry));
}

/**
 * Node reports a timer delay above 2^31-1ms as a `TimeoutOverflowWarning` and
 * quietly shortens it to 1ms, so an empty list here means the child's deadlines
 * were honored as configured.
 */
function warningsOf(marker: Record<string, unknown>): string[] {
  const warnings = marker["warnings"];

  if (!Array.isArray(warnings)) {
    throw new Error(`The marker carried no warning list: ${JSON.stringify(marker)}`);
  }

  return warnings.map(entry => String(entry));
}

describe("posts.wait in a standalone Node process", () => {
  it(
    "keeps the process alive until the wait settles and then exits on its own",
    async () => {
      const run = await runChild("resolve");

      expect(run.marker["event"]).toBe("settled");
      expect(run.marker["statuses"]).toEqual(["published", "published"]);
      // Two waits: the first needed at least three reads, the second one.
      expect(run.marker["calls"]).toBeGreaterThanOrEqual(4);
      expect(methodsOf(run.marker)).not.toContain("POST");
      expect(warningsOf(run.marker)).toEqual([]);
      expect(run.elapsedMs).toBeLessThan(5_000);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects at its own deadline with the named wait error and exits on its own",
    async () => {
      const run = await runChild("deadline");

      expect(run.marker["event"]).toBe("rejected");
      expect(run.marker["name"]).toBe("SyndrooWaitTimeoutError");
      expect(run.marker["code"]).toBe("WAIT_TIMEOUT");
      expect(run.marker["requestMayHaveBeenApplied"]).toBe(false);
      expect(run.marker["calls"]).toBeGreaterThanOrEqual(2);
      expect(methodsOf(run.marker)).not.toContain("POST");
      expect(warningsOf(run.marker)).toEqual([]);
      expect(run.elapsedMs).toBeLessThan(5_000);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects a caller abort and exits without a lingering handle",
    async () => {
      const run = await runChild("abort");

      expect(run.marker["event"]).toBe("rejected");
      expect(run.marker["name"]).toBe("SyndrooAbortError");
      expect(run.marker["code"]).toBe("ABORTED");
      expect(run.marker["requestMayHaveBeenApplied"]).toBe(false);
      expect(run.marker["calls"]).toBeGreaterThanOrEqual(1);
      expect(methodsOf(run.marker)).not.toContain("POST");
      expect(warningsOf(run.marker)).toEqual([]);
      expect(run.elapsedMs).toBeLessThan(5_000);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "honors the largest Node timer deadline and clears it without hanging",
    async () => {
      const run = await runChild("max-timer");

      expect(run.marker["event"]).toBe("settled");
      expect(run.marker["statuses"]).toEqual(["published", "published"]);
      expect(methodsOf(run.marker)).not.toContain("POST");
      // A clamped timer would warn; an uncleared one would keep the child
      // alive until the parent watchdog killed it.
      expect(warningsOf(run.marker)).toEqual([]);
      expect(run.elapsedMs).toBeLessThan(5_000);
    },
    TEST_TIMEOUT_MS,
  );
});
