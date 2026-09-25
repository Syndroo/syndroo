import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLI_VENDOR_DIRECTORY,
  cliArtifactFileName,
  collectDisallowedSpecifiers,
  findBareSpecifiers,
  isAllowedBareSpecifier,
  isInside,
  listFilesRecursively,
  relativeSpecifier,
  vendorCliDeclarations,
} from "./cli-support.js";

const SUPPORT_SCRIPT = fileURLToPath(new URL("./cli-support.js", import.meta.url));

assert.ok(
  existsSync(SUPPORT_SCRIPT),
  `Compiled support module missing at ${SUPPORT_SCRIPT}. Run \`npm run build:scripts\` first.`,
);

describe("bare specifier scanning", () => {
  it("finds static, side-effect, dynamic, and require specifiers", () => {
    const text = [
      'import { alpha } from "@syndroo/core";',
      'export { beta } from "jsonc-parser";',
      'import "node:fs";',
      'const gamma = await import("esbuild");',
      'const delta = require("left-pad");',
      'import { epsilon } from "./local.js";',
    ].join("\n");

    assert.deepEqual(findBareSpecifiers(text), [
      "@syndroo/core",
      "esbuild",
      "jsonc-parser",
      "left-pad",
      "node:fs",
    ]);
  });

  it("ignores relative specifiers and duplicates", () => {
    const text = [
      'import { alpha } from "./alpha.js";',
      'import { beta } from "../beta.js";',
      'import { gamma } from "./alpha.js";',
    ].join("\n");

    assert.deepEqual(findBareSpecifiers(text), []);
  });

  it("allows only Node built-ins as external", () => {
    assert.equal(isAllowedBareSpecifier("node:fs"), true);
    assert.equal(isAllowedBareSpecifier("node:crypto"), true);
    assert.equal(isAllowedBareSpecifier("@syndroo/core"), false);
    assert.equal(isAllowedBareSpecifier("jsonc-parser"), false);
    // A bare `fs` is not a built-in specifier form in this project.
    assert.equal(isAllowedBareSpecifier("fs"), false);
  });
});

describe("artifact naming and containment", () => {
  it("names the candidate artifact after its version", () => {
    assert.equal(
      cliArtifactFileName("0.6.0-rc.1"),
      "syndroo-cli-0.6.0-rc.1.tgz",
    );
  });

  it("treats a directory as inside itself but not a sibling prefix", () => {
    assert.equal(isInside("/a/dist", "/a/dist/x.js"), true);
    assert.equal(isInside("/a/dist", "/a/dist"), true);
    assert.equal(isInside("/a/dist", "/a/dist-other/x.js"), false);
    assert.equal(isInside("/a/dist", "/a/other/x.js"), false);
  });

  it("always produces a relative specifier", () => {
    assert.equal(relativeSpecifier("/a/dist", "/a/dist/_vendor/sdk/index.js"), "./_vendor/sdk/index.js");
    assert.equal(relativeSpecifier("/a/dist/local", "/a/dist/_vendor/core/index.js"), "../_vendor/core/index.js");
  });
});

describe("declaration vendoring", () => {
  it("copies the vendored trees and rewrites every reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "syndroo-cli-support-"));

    try {
      const dist = join(root, "packages", "cli", "dist");
      await mkdir(join(dist, "local"), { recursive: true });

      await writeFixture(
        join(root, "packages", "sdk", "dist"),
        {
          "index.d.ts": 'export { SyndrooClient } from "./client.js";\n',
          "client.d.ts": "export declare class SyndrooClient {}\n",
        },
      );
      await writeFixture(
        join(root, "packages", "core", "dist"),
        {
          "index.d.ts": 'export { LocalProviderError } from "./local-publishing.js";\n',
          "local-publishing.d.ts": "export declare class LocalProviderError {}\n",
        },
      );

      await writeFile(
        join(dist, "client.d.ts"),
        'import { SyndrooClient } from "@syndroo/sdk";\nexport declare function createClient(): SyndrooClient;\n',
        "utf8",
      );
      await writeFile(
        join(dist, "local", "auth.d.ts"),
        'import { LocalProviderError } from "@syndroo/core";\nexport declare const e: typeof LocalProviderError;\n',
        "utf8",
      );

      const rewritten = await vendorCliDeclarations(root, dist);

      assert.deepEqual(
        rewritten.map((file) => file.slice(dist.length + 1)).sort(),
        ["client.d.ts", join("local", "auth.d.ts")].sort(),
      );

      // Depth matters: a nested declaration must reach the vendor tree with
      // `../`, not `./`.
      assert.match(
        await readFile(join(dist, "client.d.ts"), "utf8"),
        /from "\.\/_vendor\/sdk\/index\.js"/u,
      );
      assert.match(
        await readFile(join(dist, "local", "auth.d.ts"), "utf8"),
        /from "\.\.\/_vendor\/core\/index\.js"/u,
      );

      assert.equal(
        existsSync(join(dist, CLI_VENDOR_DIRECTORY, "sdk", "client.d.ts")),
        true,
      );
      assert.equal(
        existsSync(join(dist, CLI_VENDOR_DIRECTORY, "core", "local-publishing.d.ts")),
        true,
      );

      // The vendored trees keep their own relative imports, so the copied graph
      // still resolves, and nothing is left pointing at a bare specifier.
      assert.deepEqual(
        await collectDisallowedSpecifiers(dist, [".d.ts"]),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a bare specifier that was never vendored", async () => {
    const root = await mkdtemp(join(tmpdir(), "syndroo-cli-support-"));

    try {
      const dist = join(root, "dist");
      await mkdir(dist, { recursive: true });
      await writeFile(
        join(dist, "index.js"),
        'import { localPublishing } from "@syndroo/core";\nimport { readFileSync } from "node:fs";\n',
        "utf8",
      );

      const violations = await collectDisallowedSpecifiers(dist, [".js"]);

      assert.equal(violations.length, 1);
      assert.equal(violations[0]?.specifier, "@syndroo/core");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("recursive listing", () => {
  it("returns an empty list for a missing directory", async () => {
    assert.deepEqual(await listFilesRecursively("/nonexistent/syndroo"), []);
  });

  it("sorts files across nested directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "syndroo-cli-support-"));

    try {
      await writeFixture(join(root, "dist"), {
        "b.js": "",
        "a.js": "",
        [join("nested", "c.js")]: "",
      });

      const listed = (await listFilesRecursively(join(root, "dist"))).map((file) =>
        file.slice(root.length + 1),
      );

      assert.deepEqual(listed, [
        join("dist", "a.js"),
        join("dist", "b.js"),
        join("dist", "nested", "c.js"),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeFixture(
  directory: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    const target = resolve(directory, name);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, text, "utf8");
  }
}
