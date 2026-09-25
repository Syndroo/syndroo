import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLI_VENDOR_DIRECTORY,
  cliDistDirectory,
  collectDisallowedSpecifiers,
  readCliVersion,
} from "./cli-support.js";
import { resolveRepositoryRoot } from "./package-support.js";

const BUNDLE_SCRIPT = fileURLToPath(new URL("./bundle-cli.js", import.meta.url));
const repositoryRoot = resolveRepositoryRoot(process.cwd());
const distDirectory = cliDistDirectory(repositoryRoot);

assert.ok(
  existsSync(BUNDLE_SCRIPT),
  `Compiled CLI bundler missing at ${BUNDLE_SCRIPT}. Run \`npm run build:scripts\` first.`,
);

/**
 * These checks read whatever bundle is on disk. They never rebuild it, so they
 * cannot race a CLI worker that is editing product source.
 */
describe("CLI bundle artifact", () => {
  it("ships only bundled code and vendored declarations", async (context) => {
    if (!existsSync(distDirectory)) {
      context.skip("packages/cli/dist is not built yet");
      return;
    }

    const violations = await collectDisallowedSpecifiers(distDirectory, [
      ".js",
      ".d.ts",
    ]);

    assert.deepEqual(
      violations.map((violation) => `${violation.specifier} in ${violation.file}`),
      [],
      "the published artifact must not import an unpublished package",
    );
  });

  it("vendors the declarations the public surface re-exports", (context) => {
    if (!existsSync(distDirectory)) {
      context.skip("packages/cli/dist is not built yet");
      return;
    }

    for (const slug of ["sdk", "core"]) {
      assert.equal(
        existsSync(join(distDirectory, CLI_VENDOR_DIRECTORY, slug, "index.d.ts")),
        true,
        `${slug} declarations must be vendored into the artifact`,
      );
    }
  });

  it("keeps the executable entry point runnable", async (context) => {
    const bin = join(distDirectory, "bin.js");

    if (!existsSync(bin)) {
      context.skip("packages/cli/dist/bin.js is not built yet");
      return;
    }

    const firstLine = (await readFile(bin, "utf8")).split("\n")[0];

    assert.equal(firstLine, "#!/usr/bin/env node");
    assert.notEqual(statSync(bin).mode & 0o111, 0, "bin.js must stay executable");
  });

  it("resolves the packaged version after bundling", async (context) => {
    const bin = join(distDirectory, "bin.js");

    if (!existsSync(bin)) {
      context.skip("packages/cli/dist/bin.js is not built yet");
      return;
    }

    const version = await readCliVersion(repositoryRoot);
    const reported = spawnSync(process.execPath, [bin, "version"], {
      cwd: resolve(repositoryRoot, "packages", "cli"),
      encoding: "utf8",
      timeout: 30_000,
    });

    assert.equal(reported.status, 0, reported.stderr);
    // The bundled `version.ts` reads the manifest relative to its own location,
    // so this fails if the bundle moved out of `dist/` or lost the package root.
    assert.ok(
      reported.stdout.includes(version),
      `expected ${version} in ${JSON.stringify(reported.stdout)}`,
    );
  });

  it("runs the emitted bin for a real command", async (context) => {
    const bin = join(distDirectory, "bin.js");

    if (!existsSync(bin)) {
      context.skip("packages/cli/dist/bin.js is not built yet");
      return;
    }

    // A bundling mistake that leaves a UMD `require` or an unresolved module
    // only shows up when the emitted file actually executes, so at least one
    // real command is run here.
    const help = spawnSync(process.execPath, [bin, "help"], {
      cwd: resolve(repositoryRoot, "packages", "cli"),
      encoding: "utf8",
      timeout: 30_000,
    });

    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /syndroo/u);

    const skill = spawnSync(process.execPath, [bin, "skill", "path", "--json"], {
      cwd: resolve(repositoryRoot, "packages", "cli"),
      encoding: "utf8",
      timeout: 30_000,
    });

    assert.equal(skill.status, 0, skill.stderr);
    assert.equal(JSON.parse(skill.stdout).exists, true);
  });

  it("imports the emitted library entry point", async (context) => {
    const entry = join(distDirectory, "index.js");

    if (!existsSync(entry)) {
      context.skip("packages/cli/dist/index.js is not built yet");
      return;
    }

    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        [
          `const m = await import(${JSON.stringify(entry)});`,
          "for (const name of ['run','parseArgs','cliVersion','EXIT_CODE','Reporter']) {",
          "  if (m[name] === undefined) throw new Error(name + ' is not exported');",
          "}",
          "console.log(typeof m.run);",
        ].join(" "),
      ],
      { cwd: resolve(repositoryRoot, "packages", "cli"), encoding: "utf8", timeout: 30_000 },
    );

    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout.trim(), "function");
  });

  it("ships third-party notices for the packages that reached the bundle", (context) => {
    const notices = join(distDirectory, "THIRD_PARTY_LICENSES.txt");

    if (!existsSync(notices)) {
      context.skip("packages/cli/dist is not built yet");
      return;
    }

    const text = readFileSync(notices, "utf8");

    // Real inputs, not a fixture list: jsonc-parser is compiled in and the
    // Bluesky SDK brings the whole @atproto family.
    assert.match(text, /jsonc-parser 3\.3\.1/u);
    assert.match(text, /@atproto\/api 0\.20\.42/u);
  });
});
