import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { collectImportSpecifiers } from "./lib/bundle-v1.js";
import { CLI_DIST_DIR, bundleCli, verifyCliBundleArtifact } from "./bundle-v1-cli.js";

/**
 * The `@syndroo/cli` bundle must inline the private `@syndroo/core` in the
 * JavaScript *and* resolve it in the published declarations: an embedder
 * type-checking the tarball has no `@syndroo/core` to resolve, so a surviving
 * `import ... from "@syndroo/core"` in a `.d.ts` makes the package unusable.
 * These tests build the real artifact and prove the gate is falsifiable.
 *
 * The file uses `node:test` like the server and Worker specs, which the root
 * `vitest` config does not collect, so run it the way `test:scripts` runs them
 * (`npm run build:scripts` first):
 *
 *   node --test .build/scripts/bundle-v1-cli.spec.js
 *
 * Adding this file to the root `test:scripts` list is a root-manifest change and
 * belongs to whoever owns `package.json`, not to this bundle step.
 */

const scratch: string[] = [];

after(() => {
  for (const directory of scratch) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function copyOfArtifact(): string {
  const directory = mkdtempSync(join(tmpdir(), "syndroo-cli-bundle-"));
  scratch.push(directory);
  cpSync(CLI_DIST_DIR, directory, { recursive: true });
  return directory;
}

/** Every declaration file in the artifact, relative to the artifact root. */
function declarations(directory = CLI_DIST_DIR): string[] {
  return readdirSync(directory, { recursive: true })
    .map((entry) => String(entry).replaceAll("\\", "/"))
    .filter((entry) => entry.endsWith(".d.ts"))
    .sort();
}

describe("@syndroo/cli bundle", () => {
  it("builds a publishable artifact that inlines private Core", async () => {
    await bundleCli();

    assert.deepEqual(
      verifyCliBundleArtifact(),
      [],
      "the freshly built CLI bundle must verify with no problems",
    );

    const entry = readFileSync(join(CLI_DIST_DIR, "bin.js"), "utf8");

    assert.doesNotMatch(entry, /from\s*["']@syndroo\/core["']/u, "bin.js must not import private Core");
    assert.match(entry, /createCore/u, "the inlined Core code must be present in the bundle");
  });

  it("ships declarations that resolve Core relative to the artifact", () => {
    // Falsifiable: drop the declaration inlining from `bundlePackage` and the
    // public `.d.ts` keep their bare `@syndroo/core` specifier, so the
    // first assertion reports the offending file instead of an empty list.
    const offenders: string[] = [];

    for (const relative of declarations()) {
      for (const specifier of collectImportSpecifiers(readFileSync(join(CLI_DIST_DIR, relative), "utf8"))) {
        if (specifier === "@syndroo/core" || specifier.startsWith("@syndroo/core/")) {
          offenders.push(`${relative} imports ${specifier}`);
        }
      }
    }

    assert.deepEqual(offenders, [], "no published declaration may import the private Core package");
    assert.ok(
      existsSync(join(CLI_DIST_DIR, "_vendor", "core", "index.d.ts")),
      "the inlined Core declarations must be copied into the artifact",
    );
    assert.match(
      readFileSync(join(CLI_DIST_DIR, "commands", "context.d.ts"), "utf8"),
      /\.\.\/_vendor\/core\/index\.js/u,
      "public declarations must point at the vendored Core declarations",
    );
  });

  it("fails verification when an emitted declaration still imports Core", () => {
    const directory = copyOfArtifact();
    const target = join(directory, "runtime", "index.d.ts");

    writeFileSync(target, `import type * as T from "@syndroo/core";\n${readFileSync(target, "utf8")}`);

    const problems = verifyCliBundleArtifact(directory);

    assert.ok(
      problems.some((problem) => problem.includes("imports") && problem.includes("@syndroo/core")),
      `expected a surviving-declaration-import problem, got:\n${problems.join("\n")}`,
    );
  });
});
