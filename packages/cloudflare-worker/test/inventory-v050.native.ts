/**
 * Discovery inventory proof (Node host).
 *
 * Ownership comes from Vitest's own discovery for every configuration on disk,
 * so the assertions cannot drift from what a real run would collect. The suite
 * fails when any test-like file is owned by no project, owned twice, or when a
 * project reports no files or cannot be listed at all.
 *
 * A disposable fixture project proves the discovery is dynamic: a
 * configuration created during the test is picked up and re-listed after a new
 * file appears, without touching any hardcoded project list.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  buildReport,
  computeInventory,
  discoverProjectFiles,
  parseDiscoveryOutput,
  type InventoryReport,
  type ProjectDiscovery,
} from "./support/test-inventory.js";

const here = resolve(fileURLToPath(import.meta.url), "..");
const packageRoot = resolve(here, "..");
const vitest = resolve(packageRoot, "../../node_modules/vitest/vitest.mjs");
const discoveryTimeoutMs = 60_000;

let inventory: InventoryReport;

beforeAll(async () => {
  inventory = await computeInventory(packageRoot, {
    timeoutMs: discoveryTimeoutMs,
    vitest,
  });
}, 300_000);

describe("discovery output parsing", () => {
  it("ignores watchdog lines around the JSON list", () => {
    const output = [
      "[watchdog 2026-01-01T00:00:00.000Z +0.0s] label=inventory:fixture",
      '[{"file":"/tmp/alpha.native.ts"},{"file":"/tmp/beta.native.ts"}]',
      "[watchdog 2026-01-01T00:00:00.100Z +0.1s] child exited code=0 signal=null",
      "[watchdog 2026-01-01T00:00:00.100Z +0.1s] process group at exit:",
      "ps failed: Operation not permitted",
    ].join("\n");

    expect(parseDiscoveryOutput(output)).toEqual([
      "/tmp/alpha.native.ts",
      "/tmp/beta.native.ts",
    ]);
  });

  it("rejects output without a file list", () => {
    expect(() => parseDiscoveryOutput("[watchdog] nothing here")).toThrow();
  });
});

describe("test project inventory", () => {
  it("discovers the main project plus dedicated configurations", () => {
    expect(inventory.projects.map((project) => project.name)).toContain("main");
    expect(inventory.projects.length).toBeGreaterThan(1);
    expect(inventory.candidates.length).toBeGreaterThan(10);
  });

  it("lists every project without a discovery failure", () => {
    expect(inventory.discoveryFailures).toEqual([]);
    expect(inventory.emptyProjects).toEqual([]);
  });

  it("claims every spec/test/native file exactly once", () => {
    expect(inventory.orphans).toEqual([]);
    expect(inventory.duplicates).toEqual([]);
    expect(inventory.unexpectedProjectFiles).toEqual([]);
  });

  it("keeps the crypto and R2 suites out of the main project", () => {
    expect(inventory.claims.get("test/crypto-v050.spec.ts")).toEqual([
      "storage-v050",
    ]);
    expect(inventory.claims.get("test/r2-v050.spec.ts")).toEqual([
      "storage-v050",
    ]);
  });
});

describe("claim comparison", () => {
  const project = (
    name: string,
    files: readonly string[],
  ): ProjectDiscovery => ({
    name,
    config: `test/${name}.vitest.config.ts`,
    files,
    exitCode: 0,
    error: undefined,
  });

  it("reports a duplicate claim", () => {
    const report = buildReport(
      [project("a", ["test/shared.spec.ts"]), project("b", ["test/shared.spec.ts"])],
      ["test/shared.spec.ts"],
    );

    expect(report.duplicates).toEqual(["test/shared.spec.ts"]);
    expect(report.orphans).toEqual([]);
  });

  it("reports an orphan and an unexpected project file", () => {
    const report = buildReport(
      [project("a", ["test/only.spec.ts", "e2e/outside.spec.ts"])],
      ["test/only.spec.ts", "test/nobody.spec.ts"],
    );

    expect(report.orphans).toEqual(["test/nobody.spec.ts"]);
    expect(report.unexpectedProjectFiles).toEqual(["e2e/outside.spec.ts"]);
    expect(report.duplicates).toEqual([]);
  });
});

describe("dynamic discovery fixture", () => {
  it("picks up a configuration created during the run", async () => {
    const fixtureRoot = join(here, ".inventory-fixture");
    const config = join(fixtureRoot, "fixture.vitest.config.ts");

    mkdirSync(fixtureRoot, { recursive: true });

    try {
      writeFileSync(
        config,
        [
          'import { defineConfig } from "vitest/config";',
          "",
          "export default defineConfig({",
          "  root: import.meta.dirname,",
          "  test: { include: [\"./*.native.ts\"], environment: \"node\" },",
          "});",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(fixtureRoot, "alpha.native.ts"),
        'import { expect, it } from "vitest";\nit("alpha", () => expect(1).toBe(1));\n',
      );

      const first = await discoverProjectFiles(
        packageRoot,
        "test/.inventory-fixture/fixture.vitest.config.ts",
        { timeoutMs: discoveryTimeoutMs, vitest },
      );

      expect(first.error).toBeUndefined();
      expect(first.files).toEqual(["test/.inventory-fixture/alpha.native.ts"]);

      writeFileSync(
        join(fixtureRoot, "beta.native.ts"),
        'import { expect, it } from "vitest";\nit("beta", () => expect(2).toBe(2));\n',
      );

      const second = await discoverProjectFiles(
        packageRoot,
        "test/.inventory-fixture/fixture.vitest.config.ts",
        { timeoutMs: discoveryTimeoutMs, vitest },
      );

      expect(second.files).toEqual([
        "test/.inventory-fixture/alpha.native.ts",
        "test/.inventory-fixture/beta.native.ts",
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 300_000);
});
