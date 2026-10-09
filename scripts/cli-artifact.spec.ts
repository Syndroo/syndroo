/**
 * The published `@syndroo/cli` artifact, exercised as an artifact.
 *
 * These three checks are the part of the retired `cli-support.spec.ts` that
 * still applies to architecture v1: the bundled version resolves, the emitted
 * `bin.js` runs a real command, and the emitted `index.js` imports. They read
 * whatever bundle is on disk and never rebuild it, so they cannot race a worker
 * that is editing product source.
 *
 * When `packages/cli/dist` has not been built the whole suite skips with the
 * command that produces it, rather than passing vacuously.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { ROOT } from "./lib/v1-stages.js";

const CLI_DIRECTORY = join(ROOT, "packages", "cli");
const DIST_DIRECTORY = join(CLI_DIRECTORY, "dist");
const BIN_FILE = join(DIST_DIRECTORY, "bin.js");
const LIBRARY_FILE = join(DIST_DIRECTORY, "index.js");
const MANIFEST_FILE = join(CLI_DIRECTORY, "package.json");

const BUILD_COMMAND = "npm run build --workspace @syndroo/cli";
const ARTIFACT_BUILT = existsSync(BIN_FILE) && existsSync(LIBRARY_FILE);

describe(
  "CLI artifact",
  {
    skip: ARTIFACT_BUILT
      ? false
      : `packages/cli/dist is not built; run \`${BUILD_COMMAND}\` before verifying the CLI artifact.`,
  },
  () => {
    it("resolves the packaged version after bundling", async () => {
      const manifest = JSON.parse(await readFile(MANIFEST_FILE, "utf8")) as {
        version?: unknown;
      };
      const version = manifest.version;

      assert.equal(typeof version, "string", "the CLI manifest must declare a version");

      const reported = spawnSync(process.execPath, [BIN_FILE, "--version"], {
        cwd: CLI_DIRECTORY,
        encoding: "utf8",
        timeout: 30_000,
      });

      assert.equal(reported.status, 0, reported.stderr);
      // The bundled version reader resolves the manifest relative to the
      // emitted file, so this fails if the bundle moved out of `dist/` or lost
      // its package root.
      assert.ok(
        reported.stdout.includes(version as string),
        `expected ${String(version)} in ${JSON.stringify(reported.stdout)}`,
      );
    });

    it("runs the emitted bin for a real command", () => {
      // A bundling mistake that leaves an unresolved import or a `require` in
      // an ESM file only shows up when the emitted file actually executes, so
      // at least one real command is run here.
      const help = spawnSync(process.execPath, [BIN_FILE, "--help"], {
        cwd: CLI_DIRECTORY,
        encoding: "utf8",
        timeout: 30_000,
      });

      assert.equal(help.status, 0, help.stderr);

      for (const command of ["connect", "publish", "status"]) {
        assert.ok(
          help.stdout.includes(command),
          `expected the built help to list ${command}: ${JSON.stringify(help.stdout)}`,
        );
      }
    });

    it("imports the emitted library entry point", () => {
      const probe = spawnSync(
        process.execPath,
        [
          "-e",
          [
            `const m = await import(${JSON.stringify(pathToFileURL(LIBRARY_FILE).href)});`,
            "for (const name of ['run','cliVersion','EXIT_CODE','loadConfig','createLocalRuntime']) {",
            "  if (m[name] === undefined) throw new Error(name + ' is not exported');",
            "}",
            "console.log(typeof m.run);",
          ].join(" "),
        ],
        {
          cwd: CLI_DIRECTORY,
          encoding: "utf8",
          timeout: 30_000,
        },
      );

      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(probe.stdout.trim(), "function");
    });
  },
);
