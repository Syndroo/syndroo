import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { SERVER_DIST_DIR, bundleServer, verifyServerBundleArtifact } from "./bundle-v1-server.js";

/**
 * The `@syndroo/server` bundle must inline the private `@syndroo/core`. These
 * tests build the real artifact (the same call the package `build` script makes)
 * and then prove the gate is falsifiable: a copy that imports Core, or a record
 * that no longer claims Core was inlined, must fail verification.
 */

const scratch: string[] = [];

after(() => {
  for (const directory of scratch) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function copyOfArtifact(): string {
  const directory = mkdtempSync(join(tmpdir(), "syndroo-server-bundle-"));
  scratch.push(directory);
  cpSync(SERVER_DIST_DIR, directory, { recursive: true });
  return directory;
}

/** Every declaration file in the artifact, repository-relative to `dist`. */
function declarations(directory = SERVER_DIST_DIR): string[] {
  return readdirSync(directory, { recursive: true })
    .map((entry) => String(entry).replaceAll("\\", "/"))
    .filter((entry) => entry.endsWith(".d.ts"))
    .sort();
}

describe("@syndroo/server bundle", () => {
  it("builds a publishable artifact that inlines private Core", async () => {
    await bundleServer();

    assert.deepEqual(
      verifyServerBundleArtifact(),
      [],
      "the freshly built server bundle must verify with no problems",
    );

    const entry = readFileSync(join(SERVER_DIST_DIR, "index.js"), "utf8");

    assert.doesNotMatch(
      entry,
      /from\s*["']@syndroo\/core["']/u,
      "the emitted bundle must not import the private Core package",
    );
    assert.match(entry, /createCore/u, "the inlined Core code must be present in the bundle");
  });

  it("fails verification when the entry imports Core instead of inlining it", () => {
    const directory = copyOfArtifact();
    const entry = join(directory, "index.js");

    writeFileSync(entry, `import { createCore } from "@syndroo/core";\n${readFileSync(entry, "utf8")}`);

    const problems = verifyServerBundleArtifact(directory);

    assert.ok(
      problems.some((problem) => problem.includes("@syndroo/core")),
      `expected a Core-import problem, got:\n${problems.join("\n")}`,
    );
  });

  it("fails verification when the record no longer claims Core was inlined", () => {
    const directory = copyOfArtifact();
    const info = join(directory, "bundle.json");
    const record = JSON.parse(readFileSync(info, "utf8")) as {
      inlinedWorkspacePackages: string[];
    };

    record.inlinedWorkspacePackages = record.inlinedWorkspacePackages.filter(
      (name) => name !== "@syndroo/core",
    );
    writeFileSync(info, `${JSON.stringify(record, null, 2)}\n`);

    const problems = verifyServerBundleArtifact(directory);

    assert.ok(
      problems.some((problem) => problem.includes("@syndroo/core")),
      `expected a "not recorded as inlined" problem, got:\n${problems.join("\n")}`,
    );
  });

  it("resolves the inlined Core declarations instead of importing the private package", () => {
    // Falsifiable: without the declaration inlining in `bundlePackage`, every
    // public `.d.ts` below would still carry the bare `@syndroo/core` specifier
    // and the first assertion would fail.
    for (const relative of declarations()) {
      assert.doesNotMatch(
        readFileSync(join(SERVER_DIST_DIR, relative), "utf8"),
        /["']@syndroo\/core["']/u,
        `${relative} must not reference the private Core package`,
      );
    }

    assert.ok(
      existsSync(join(SERVER_DIST_DIR, "_vendor", "core", "index.d.ts")),
      "the inlined Core declarations must be copied into the artifact",
    );
    assert.match(
      readFileSync(join(SERVER_DIST_DIR, "state", "state.d.ts"), "utf8"),
      /\.\.\/_vendor\/core\/index\.js/u,
      "public declarations must point at the vendored Core declarations",
    );
  });

  it("fails verification when an emitted declaration still imports Core", () => {
    const directory = copyOfArtifact();
    const target = join(directory, "state", "state.d.ts");

    writeFileSync(target, `import type * as T from "@syndroo/core";\n${readFileSync(target, "utf8")}`);

    const problems = verifyServerBundleArtifact(directory);

    assert.ok(
      problems.some((problem) => problem.includes("imports") && problem.includes("@syndroo/core")),
      `expected a surviving-declaration-import problem, got:\n${problems.join("\n")}`,
    );
  });
});
