/**
 * `wait()` has to survive in a real Node process.
 *
 * The injected-sleep tests in `wait.test.ts` cannot see whether the poll timer
 * is referenced. This bundles the public client into a child script, spawns it
 * with the same Node binary, and requires the wait to run to completion: an
 * unreferenced sleep timer makes Node exit (13) while the wait is still pending.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("wait() in a real process", () => {
  let workDir: string | undefined;
  let bundle: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "syndroo-sdk-wait-"));
    bundle = join(workDir, "wait-child.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("./support/wait-child.ts", import.meta.url))],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
    });
  }, 60000);

  afterAll(async () => {
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("stays alive across the poll timer instead of exiting early", async () => {
    const result = await execFileAsync(process.execPath, [bundle], { timeout: 30000 });
    expect(result.stdout).toContain("SLEEP_DONE");
    expect(result.stdout).toContain("WAIT_DONE");
    expect(result.stderr).toBe("");
  }, 40000);
});
