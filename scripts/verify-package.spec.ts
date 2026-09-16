import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { findTextViolations, isInside } from "./package-support.js";

const VERIFIER = fileURLToPath(
  new URL("./verify-package.js", import.meta.url),
);

assert.ok(
  existsSync(VERIFIER),
  `Compiled verifier missing at ${VERIFIER}. Run \`npm run build:scripts\` first.`,
);

describe("artifact leak detection", () => {
  it("flags workspace, experiment, and account identifiers", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['{"dependencies":{"x":"workspace:*"}}', "workspace-protocol"],
      ["import '../../experiments/crosspost-cloudflare/src/index.ts'", "experiment-path"],
      ['{"account_id":"0123456789abcdef0123456789abcdef"}', "account-id-json"],
      ['{"database_id":"11111111-2222-3333-4444-555555555555"}', "database-id-json"],
      ['const SYNDROO_API_KEY = "super-secret-value";', "api-key-assignment"],
    ];

    for (const [text, code] of cases) {
      assert.deepEqual(
        findTextViolations(text, "fixture").map((violation) => violation.code),
        [code],
        `expected ${code} for ${text}`,
      );
    }
  });

  it("does not flag legitimate documentation or binding names", () => {
    const safe = [
      "Add the secret names to `.dev.vars` for local development.",
      "Set `SYNDROO_API_KEY` as a Worker secret.",
      "env.SYNDROO_API_KEY is required for every /v1 route.",
      'interface Env { SYNDROO_API_KEY: string }',
    ];

    for (const text of safe) {
      assert.deepEqual(findTextViolations(text, "fixture"), []);
    }
  });

  it("keeps path containment checks exact", () => {
    assert.equal(isInside("/tmp/work", "/tmp/work/fixture"), true);
    assert.equal(isInside("/tmp/work", "/tmp/work"), true);
    assert.equal(isInside("/tmp/work", "/tmp/workshop"), false);
  });
});

describe("verification gate", () => {
  it("fails closed on a version mismatch without packing", async () => {
    const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
    // Keep this run's evidence separate from candidates under review.
    const artifactParent = await mkdtemp(resolve(tmpdir(), "syndroo-gate-"));
    // The override is a container, not an owned directory: everything a caller
    // put there must survive the run untouched.
    const sentinel = resolve(artifactParent, "keep-me.txt");
    await writeFile(sentinel, "do not delete\n", "utf8");

    try {
      const result = spawnSync(process.execPath, [VERIFIER], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          SYNDROO_EXPECT_PACKAGE_VERSION: "9.9.9-rc.1",
          SYNDROO_PACKAGE_ARTIFACT_DIR: artifactParent,
        },
      });

      assert.equal(result.status, 1, result.stdout + result.stderr);

      const report = JSON.parse(result.stdout) as {
        ok: boolean;
        artifactDirectory: string;
        tarball: string | null;
        failures: Array<{ code: string; detail: string }>;
      };

      assert.equal(report.ok, false);
      assert.ok(
        report.failures.some((failure) => failure.code === "manifest-version"),
        JSON.stringify(report.failures),
      );
      assert.ok(
        report.failures.some((failure) => failure.detail.includes("9.9.9-rc.1")),
        JSON.stringify(report.failures),
      );

      // The caller's container and its contents survive, and the run reports
      // the child directory it actually created.
      assert.equal(
        await readFile(sentinel, "utf8"),
        "do not delete\n",
        "the caller-provided artifact directory was modified",
      );
      assert.equal(existsSync(artifactParent), true);
      assert.notEqual(report.artifactDirectory, artifactParent);
      assert.equal(
        resolve(report.artifactDirectory).startsWith(`${artifactParent}/`),
        true,
        `reported artifact directory is not inside the container: ${report.artifactDirectory}`,
      );
      assert.equal(existsSync(report.artifactDirectory), true);
      assert.deepEqual(
        (await readdir(artifactParent)).sort(),
        ["keep-me.txt", report.artifactDirectory.split("/").at(-1) ?? ""].sort(),
        "the container should hold the sentinel and exactly one run directory",
      );
      assert.equal(report.tarball, null, "the gate must stop before packing");
      assert.deepEqual(await readdir(report.artifactDirectory), []);
    } finally {
      await rm(artifactParent, { recursive: true, force: true });
    }
  });
});
