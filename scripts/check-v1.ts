/**
 * Architecture-v1 check graph (A0 wiring).
 *
 * Three kinds of evidence, all reported explicitly and none silently skipped:
 *
 * 1. static wiring checks against the manifests (workspace list, Node engines,
 *    the private Core boundary, LICENSE/NOTICE presence);
 * 2. `npm run check --workspace` for every stage that has sources, so strict
 *    type checking covers the package including its tests;
 * 3. `npm test --workspace` (`--tests`) and `npm pack --dry-run --workspace`
 *    (`--pack`) for the stages that can run them.
 *
 * A stage with no `src/**\/*.ts` is MISSING and fails the run unless
 * `--allow-missing` is passed. The default scripts pass no such flag, so the
 * default gates fail on a missing artifact. A public package that lists private
 * `@syndroo/core` as a devDependency must bundle Core. `@syndroo/cli` (F3a),
 * `@syndroo/server` (F4) and `@syndroo/cloudflare` (F4) each have a real bundle
 * step, so each is checked here: the manifest must run its `scripts/bundle-v1-*`
 * bundler, and when `dist/` is present the bundle must have private Core compiled
 * in and keep it out of `dependencies`. When a `dist/` is absent the row is
 * PENDING, never `ok`: an artifact that was not built is an assertion that was
 * not verified. PENDING does not fail the run, because this graph deliberately
 * does not build.
 *
 * Build order comes from `./lib/v1-stages.ts`, the single list shared with
 * `scripts/build-v1.ts`. Run with Node's type stripping (`node
 * scripts/check-v1.ts`); the root `engines` field requires Node >= 24.19.0.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { cliBundleStatus, verifyCliBundleStep } from "./bundle-v1-cli.ts";
import { cloudflareBundleStatus, verifyCloudflareBundleStep } from "./bundle-v1-cloudflare.ts";
import { serverBundleStatus, verifyServerBundleStep } from "./bundle-v1-server.ts";
import {
  MIN_NODE_ENGINE,
  ROOT,
  STAGES,
  formatStageLine,
  hasSources,
  type V1Stage,
} from "./lib/v1-stages.ts";

const PRIVATE_CORE = "@syndroo/core";

/**
 * Every public package whose private Core must be bundled, and how each is
 * verified. A stage that gains a Core devDependency without an entry here still
 * reports PENDING rather than silently passing, so this list may lag the
 * manifest but never lies about it.
 */
type BundleCheck = {
  readonly name: string;
  /** The command an operator runs to produce the artifact. */
  readonly command: string;
  /** What the passing row asserts. */
  readonly okMessage: string;
  readonly verifyStep: () => string[];
  readonly status: () => { readonly built: boolean; readonly problems: readonly string[] };
};

const BUNDLE_CHECKS: readonly BundleCheck[] = [
  {
    name: "@syndroo/cli",
    command: "npm run build --workspace @syndroo/cli",
    okMessage: `dist/bin.js inlines private ${PRIVATE_CORE} and does not depend on it`,
    verifyStep: verifyCliBundleStep,
    status: () => cliBundleStatus(),
  },
  {
    name: "@syndroo/server",
    command: "npm run build --workspace @syndroo/server",
    okMessage: `dist/index.js inlines private ${PRIVATE_CORE} and does not depend on it`,
    verifyStep: verifyServerBundleStep,
    status: () => serverBundleStatus(),
  },
  {
    name: "@syndroo/cloudflare",
    command: "npm run build --workspace @syndroo/cloudflare",
    okMessage: `dist/worker.js inlines private ${PRIVATE_CORE} with no external or node: import`,
    verifyStep: verifyCloudflareBundleStep,
    status: () => cloudflareBundleStatus(),
  },
];
/**
 * Wall-clock budget for one `npm run ... --workspace` stage. A legacy suite that
 * opens a listener without an exit can otherwise stall the whole graph; the
 * stage is then reported as TIMEOUT, never as a pass.
 */
const STAGE_TIMEOUT_MS =
  Number.parseInt(process.env.SYNDROO_V1_STAGE_TIMEOUT_MS ?? "", 10) || 300_000;

type Manifest = {
  name?: string;
  version?: string;
  private?: boolean;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  workspaces?: unknown;
};

function readManifest(directory: string): Manifest | undefined {
  const path = join(ROOT, directory, "package.json");
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

function runNpm(args: readonly string[]): { code: number; output: string } {
  // `npm pack` needs a writable cache. When the default cache is not writable
  // (root-owned ~/.npm), set SYNDROO_V1_NPM_CACHE to a writable directory.
  const cache = process.env.SYNDROO_V1_NPM_CACHE;
  const fullArgs = cache !== undefined && cache.length > 0 ? [...args, "--cache", cache] : args;
  const result = spawnSync("npm", fullArgs, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    timeout: STAGE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { code: 124, output: `stage timed out after ${STAGE_TIMEOUT_MS}ms (SIGKILL)\n${output}` };
  }
  return { code: result.status ?? 1, output };
}

function firstFailureLines(output: string, limit = 4): string {
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(0, limit)
    .join("\n      ");
}

function stageHasTests(dir: string): boolean {
  return existsSync(join(ROOT, "packages", dir, "test"));
}

function main(): number {
  const allowMissing = process.argv.includes("--allow-missing");
  const runTests = process.argv.includes("--tests");
  const runPack = process.argv.includes("--pack");

  console.log("syndroo architecture-v1 check graph (A0 wiring)");
  console.log(`  node v${process.versions.node}  root ${ROOT}`);
  console.log(`  flags: --allow-missing=${allowMissing} --tests=${runTests} --pack=${runPack}`);
  console.log("");

  let staticFailures = 0;

  // 1. Workspace list is exactly the eleven architecture-v1 packages.
  const root = readManifest(".");
  if (root === undefined) {
    console.log("[static] FAIL  root package.json is missing");
    return 1;
  }
  const expectedWorkspaces = STAGES.map((stage) => `packages/${stage.dir}`);
  const actualWorkspaces = Array.isArray(root.workspaces) ? (root.workspaces as string[]) : [];
  const workspacesMatch =
    actualWorkspaces.length === expectedWorkspaces.length &&
    expectedWorkspaces.every((entry) => actualWorkspaces.includes(entry));
  console.log(
    `[static] ${workspacesMatch ? "ok  " : "FAIL"}  workspaces lists exactly the ${expectedWorkspaces.length} v1 packages` +
      (workspacesMatch ? "" : ` (found ${JSON.stringify(actualWorkspaces)})`),
  );
  if (!workspacesMatch) {
    staticFailures += 1;
  }

  // 2. Root Node engine.
  const rootEngine = root.engines?.node;
  const rootEngineOk = rootEngine === MIN_NODE_ENGINE;
  console.log(
    `[static] ${rootEngineOk ? "ok  " : "FAIL"}  root engines.node is ${MIN_NODE_ENGINE} (found ${String(rootEngine)})`,
  );
  if (!rootEngineOk) {
    staticFailures += 1;
  }

  // 3. Per-package static checks.
  const bundleStages: string[] = [];
  for (const stage of STAGES) {
    const manifest = readManifest(join("packages", stage.dir));
    if (manifest === undefined) {
      console.log(`[static] FAIL  ${stage.name}: package.json is missing`);
      staticFailures += 1;
      continue;
    }
    const engineOk = manifest.engines?.node === MIN_NODE_ENGINE;
    const privacyOk = stage.corePackage === true ? manifest.private === true : manifest.private !== true;
    const runtimeCoreDep = manifest.dependencies?.[PRIVATE_CORE];
    const devCoreDep = manifest.devDependencies?.[PRIVATE_CORE];
    const licensesOk =
      existsSync(join(ROOT, "packages", stage.dir, "LICENSE")) &&
      existsSync(join(ROOT, "packages", stage.dir, "NOTICE"));

    const problems: string[] = [];
    if (!engineOk) {
      problems.push(`engines.node should be ${MIN_NODE_ENGINE}`);
    }
    if (!privacyOk) {
      problems.push(stage.corePackage === true ? "Core must be private" : "public package must not be private");
    }
    if (runtimeCoreDep !== undefined) {
      problems.push(`runtime dependency on private ${PRIVATE_CORE} is not allowed`);
    }
    if (!licensesOk) {
      problems.push("LICENSE and NOTICE must both be present");
    }
    if (devCoreDep !== undefined) {
      bundleStages.push(stage.name);
    }

    if (problems.length === 0) {
      console.log(
        `[static] ok    ${stage.name}: engines ${MIN_NODE_ENGINE}, ${stage.corePackage === true ? "private" : "public"}, LICENSE+NOTICE` +
          (devCoreDep === undefined ? "" : `, bundles ${PRIVATE_CORE}`),
      );
    } else {
      staticFailures += 1;
      console.log(`[static] FAIL  ${stage.name}: ${problems.join("; ")}`);
    }
  }

  console.log("");
  // Each bundled package is checked the same way: the manifest must wire the
  // bundler, and when an artifact is present it must have private Core compiled
  // in instead of required. A package with no check here stays PENDING.
  const unbundled: string[] = [];
  const unbuilt: { readonly name: string; readonly command: string }[] = [];
  for (const name of bundleStages) {
    const check = BUNDLE_CHECKS.find((entry) => entry.name === name);

    if (check === undefined) {
      unbundled.push(name);
      console.log(
        `[bundle] PENDING ${name}: published artifact must bundle private ${PRIVATE_CORE}; no bundle step exists yet (D2/E2)`,
      );
      continue;
    }

    const stepProblems = check.verifyStep();

    if (stepProblems.length > 0) {
      staticFailures += 1;
      for (const problem of stepProblems) {
        console.log(`[bundle] FAIL  ${name}: ${problem}`);
      }
      continue;
    }

    const status = check.status();

    if (!status.built) {
      // No artifact means nothing was verified. Reporting `ok` here read like a
      // passing check, so an unbuilt bundle is PENDING, exactly like a stage
      // with no bundler. It stays non-fatal: this graph does not build.
      unbuilt.push({ name, command: check.command });
      console.log(
        `[bundle] PENDING ${name}: no built artifact in this tree to verify; ${check.command} bundles private ${PRIVATE_CORE}`,
      );
      continue;
    }

    if (status.problems.length > 0) {
      staticFailures += 1;
      for (const problem of status.problems) {
        console.log(`[bundle] FAIL  ${name}: ${problem}`);
      }
      continue;
    }

    console.log(`[bundle] ok    ${name}: ${check.okMessage}`);
  }
  if (bundleStages.length > 0) {
    console.log("");
  }

  // 4. Per-stage type checks, then optional tests and pack dry runs.
  let checked = 0;
  let failed = 0;
  const missing: string[] = [];

  STAGES.forEach((stage: V1Stage, index: number) => {
    if (!hasSources(stage)) {
      missing.push(stage.name);
      console.log(formatStageLine(index, stage, "MISSING", "no src/**/*.ts yet, check not run"));
      return;
    }
    const command = ["run", "check", "--workspace", stage.name];
    const { code, output } = runNpm(command);
    if (code === 0) {
      checked += 1;
      console.log(formatStageLine(index, stage, "ok", `npm ${command.join(" ")} (exit 0)`));
    } else {
      failed += 1;
      console.log(formatStageLine(index, stage, "FAIL", `npm ${command.join(" ")} (exit ${code})`));
      if (output.length > 0) {
        console.log(`          ${firstFailureLines(output).replaceAll("\n", "\n      ")}`);
      }
    }

    if (runTests && stageHasTests(stage.dir)) {
      const testCommand = ["test", "--workspace", stage.name];
      const result = runNpm(testCommand);
      if (result.code === 0) {
        console.log(`          tests ok    npm ${testCommand.join(" ")} (exit 0)`);
      } else {
        failed += 1;
        console.log(`          tests FAIL  npm ${testCommand.join(" ")} (exit ${result.code})`);
        if (result.output.length > 0) {
          console.log(`      ${firstFailureLines(result.output).replaceAll("\n", "\n      ")}`);
        }
      }
    }

    if (runPack && stage.corePackage !== true && existsSync(join(ROOT, "packages", stage.dir, "dist"))) {
      const packCommand = ["pack", "--dry-run", "--workspace", stage.name];
      const result = runNpm(packCommand);
      const filename = result.output.split("\n").find((line) => line.includes("filename:"))?.trim() ?? "";
      if (result.code === 0) {
        console.log(`          pack ok     npm ${packCommand.join(" ")} (exit 0) ${filename}`);
      } else {
        failed += 1;
        console.log(`          pack FAIL   npm ${packCommand.join(" ")} (exit ${result.code})`);
      }
    }
  });

  console.log("");
  console.log(
    `summary: ${checked} checked, ${failed} failed, ${missing.length} missing implementation, ${staticFailures} static failure(s)`,
  );
  if (missing.length > 0) {
    console.log("missing (explicit, not skipped):");
    for (const name of missing) {
      console.log(`  - ${name}`);
    }
  }
  if (unbundled.length > 0) {
    console.log("pending bundle steps (public artifact still needs private Core bundled):");
    for (const name of unbundled) {
      console.log(`  - ${name}`);
    }
  }
  if (unbuilt.length > 0) {
    console.log("bundle assertions not verified (build the artifact to verify them):");
    for (const entry of unbuilt) {
      console.log(`  - ${entry.name}: ${entry.command}`);
    }
  }
  if (failed > 0 || staticFailures > 0) {
    console.log("exit 1: failures above");
    return 1;
  }
  if (missing.length > 0 && !allowMissing) {
    console.log("exit 1: missing stages are fatal unless --allow-missing is passed");
    return 1;
  }
  console.log(
    missing.length > 0 ? "exit 0 with --allow-missing: present stages checked" : "exit 0: every stage checked",
  );
  return 0;
}

process.exitCode = main();
