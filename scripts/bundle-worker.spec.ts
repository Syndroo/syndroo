import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PACKAGE_PATH, planWorkerBundle, resolveRepositoryRoot } from "./package-support.js";

const BUNDLE_SCRIPT = fileURLToPath(new URL("./bundle-worker.js", import.meta.url));
const repositoryRoot = resolveRepositoryRoot(process.cwd());

assert.ok(
  existsSync(BUNDLE_SCRIPT),
  `Compiled bundler missing at ${BUNDLE_SCRIPT}. Run \`npm run build:scripts\` first.`,
);

describe("worker bundle plan", () => {
  it("writes the bundle into the published package, not the repository root", () => {
    const plan = planWorkerBundle("/tmp/syndroo-root");

    assert.equal(
      plan.outputDirectory,
      resolve("/tmp/syndroo-root", PACKAGE_PATH, "dist"),
    );
    // Regression guard: a relative `--outdir` is resolved against the
    // directory of `--config`, which wrote the bundle into the root `dist/`.
    assert.notEqual(plan.outputDirectory, resolve("/tmp/syndroo-root", "dist"));
    assert.ok(plan.outputDirectory.startsWith(`${resolve("/tmp/syndroo-root")}/`));
    assert.equal(plan.configPath, resolve("/tmp/syndroo-root", "wrangler.jsonc"));
  });

  it("passes wrangler an absolute output directory and the root config", () => {
    const plan = planWorkerBundle("/tmp/syndroo-root");

    assert.deepEqual(plan.wranglerArguments, [
      "deploy",
      "--dry-run",
      "--outdir",
      plan.outputDirectory,
      "--config",
      plan.configPath,
    ]);
    assert.equal(plan.wranglerArguments.includes("dist"), false);
  });
});

describe("worker bundle execution", () => {
  // The bundle step intentionally clears the package dist, so the deploy entry
  // point and the generated license file are rebuilt afterwards to leave the
  // workspace in a complete state for whoever runs next.
  after(() => {
    const restore = spawnSync("npm", ["run", "build:package"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 10 * 60 * 1000,
    });

    assert.equal(
      restore.status,
      0,
      `restoring the package dist failed: ${restore.stdout}\n${restore.stderr}`,
    );
  });

  it("refreshes the package dist and leaves the repository root dist alone", async () => {
    const plan = planWorkerBundle(repositoryRoot);
    const rootBundle = resolve(repositoryRoot, "dist", "index.js");
    const packageBundle = resolve(plan.outputDirectory, "index.js");
    const staleSentinel = resolve(plan.outputDirectory, "stale-artifact.txt");

    await mkdir(plan.outputDirectory, { recursive: true });
    await writeFile(staleSentinel, "stale\n", "utf8");

    const rootBundleBefore = existsSync(rootBundle)
      ? (await stat(rootBundle)).mtimeMs
      : undefined;
    const startedAt = Date.now();

    const result = spawnSync(process.execPath, [BUNDLE_SCRIPT], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 5 * 60 * 1000,
    });

    assert.equal(
      result.status,
      0,
      `bundle failed: ${result.stdout}\n${result.stderr}`,
    );
    assert.equal(existsSync(packageBundle), true, "package bundle missing");
    assert.ok(
      (await stat(packageBundle)).mtimeMs >= startedAt - 1000,
      "package bundle was not rebuilt for this run",
    );
    assert.equal(
      existsSync(staleSentinel),
      false,
      "stale artifacts survived the bundle",
    );

    if (rootBundleBefore !== undefined) {
      assert.equal(
        (await stat(rootBundle)).mtimeMs,
        rootBundleBefore,
        "the repository root dist was rewritten",
      );
    }

    await rm(staleSentinel, { force: true });
  });
});
