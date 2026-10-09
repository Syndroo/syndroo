/**
 * Architecture-v1 build graph (A0 wiring).
 *
 * This is wiring, not implementation. It builds the eleven packages in the
 * shared dependency order (`./lib/v1-stages.ts`) and reports every stage by name
 * and exit code, including stages that have no `src/**\/*.ts` yet. A stage with
 * no sources is reported as MISSING and fails the run unless `--allow-missing`
 * is passed, so a partially implemented tree can never be reported as a green
 * whole-tree build.
 *
 * Run with Node's type stripping (`node scripts/build-v1.ts`); the root
 * `engines` field requires Node >= 24.19.0. No package here is imported: every
 * stage is a separate `npm run build --workspace` process.
 */
import { spawnSync } from "node:child_process";

import {
  MIN_NODE_ENGINE,
  ROOT,
  STAGES,
  buildOrderLabel,
  formatStageLine,
  hasSources,
  type V1Stage,
} from "./lib/v1-stages.ts";

const MIN_NODE = [24, 19, 0] as const;
/** Wall-clock budget for one `npm run build --workspace` stage. */
const STAGE_TIMEOUT_MS =
  Number.parseInt(process.env.SYNDROO_V1_STAGE_TIMEOUT_MS ?? "", 10) || 300_000;

function nodeIsTooOld(): boolean {
  const [major = 0, minor = 0, patch = 0] = process.versions.node
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < MIN_NODE.length; index += 1) {
    const want = MIN_NODE[index] as number;
    const have = [major, minor, patch][index] as number;
    if (have > want) {
      return false;
    }
    if (have < want) {
      return true;
    }
  }
  return false;
}

function runNpm(args: readonly string[]): { code: number; output: string } {
  const result = spawnSync("npm", args, {
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

function firstFailureLines(output: string): string {
  const lines = output.split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(0, 4).join("\n      ");
}

function main(): number {
  const allowMissing = process.argv.includes("--allow-missing");
  console.log("syndroo architecture-v1 build graph (A0 wiring)");
  console.log(`  node v${process.versions.node}  root ${ROOT}`);
  console.log(`  order: ${buildOrderLabel()}`);
  if (nodeIsTooOld()) {
    console.log(`  [warn] root engines require Node ${MIN_NODE_ENGINE}`);
  }
  console.log("");

  let built = 0;
  let failed = 0;
  const missing: string[] = [];

  STAGES.forEach((stage: V1Stage, index: number) => {
    if (!hasSources(stage)) {
      missing.push(stage.name);
      console.log(
        formatStageLine(
          index,
          stage,
          "MISSING",
          `no src/**/*.ts yet${stage.bundlesCore === true ? "; must bundle private Core" : ""}`,
        ),
      );
      return;
    }
    const command = ["run", "build", "--workspace", stage.name];
    const { code, output } = runNpm(command);
    if (code === 0) {
      built += 1;
      console.log(formatStageLine(index, stage, "ok", `npm ${command.join(" ")} (exit 0)`));
      return;
    }
    failed += 1;
    console.log(formatStageLine(index, stage, "FAIL", `npm ${command.join(" ")} (exit ${code})`));
    if (output.length > 0) {
      console.log(`          ${firstFailureLines(output).replaceAll("\n", "\n      ")}`);
    }
  });

  console.log("");
  console.log(`summary: ${built} built, ${failed} failed, ${missing.length} missing implementation`);
  if (missing.length > 0) {
    console.log("missing (explicit, not skipped):");
    for (const name of missing) {
      console.log(`  - ${name}`);
    }
  }
  if (failed > 0) {
    console.log("exit 1: at least one stage failed to build");
    return 1;
  }
  if (missing.length > 0 && !allowMissing) {
    console.log("exit 1: missing stages are fatal unless --allow-missing is passed");
    return 1;
  }
  if (missing.length > 0) {
    console.log("exit 0 with --allow-missing: every stage that has sources built; missing stages listed above");
    return 0;
  }
  console.log("exit 0: every stage built");
  return 0;
}

process.exitCode = main();
