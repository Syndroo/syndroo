#!/usr/bin/env node
/**
 * Layer 3 entry point: the only command in this repository that may touch a
 * real Syndroo instance and real social accounts.
 *
 * It is deliberately hard to run by accident:
 *
 * - the plan file must exist, be absolute, and name an instance, the accounts,
 *   the content, the platforms, an absolute time with an explicit timezone, an
 *   operation count, stop conditions, an approver, and `"approved": true`;
 * - a valid plan only validates. It exits without contacting anything unless
 *   `--execute` is passed, and execution also requires
 *   `SYNDROO_LIVE_CONFIRM` to equal the plan's own `planId`;
 * - `--execute` is read-only (`doctor` and local `validate`). Only `--write`
 *   reaches a create, and it requires everything above.
 *
 * This entry point is intentionally not part of `npm test` or `npm run
 * e2e:local`.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { resolveRepositoryRoot } from "./package-support.js";

const CONFIRM_ENV = "SYNDROO_LIVE_CONFIRM";
const API_KEY_ENV = "SYNDROO_API_KEY";

/** ISO 8601 with an explicit UTC offset or `Z`. A bare local time is refused. */
const ABSOLUTE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const KNOWN_PLATFORMS: ReadonlySet<string> = new Set([
  "x",
  "threads",
  "bluesky",
  "tumblr",
  "mastodon",
  "linkedin",
  "nostr",
]);

type Arguments = {
  readonly plan: string | undefined;
  readonly cli: string | undefined;
  readonly report: string | undefined;
  readonly execute: boolean;
  readonly write: boolean;
};

type Plan = {
  readonly planId: string;
  readonly instance: string;
  readonly accounts: readonly string[];
  readonly content: string | Readonly<Record<string, string>>;
  readonly platforms: readonly string[];
  readonly time: string;
  readonly operations: number;
  readonly stopConditions: readonly string[];
  readonly approver: string;
};

type Step = {
  readonly label: string;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));

  if (arguments_.plan === undefined) {
    finish(2, {
      error: "a live run requires --plan <absolute path to an approved plan file>",
      usage:
        "npm run e2e:live -- --plan /absolute/path/to/approved-live-plan.json [--execute [--write]]",
    });
    return;
  }

  if (!isAbsolute(arguments_.plan)) {
    finish(2, {
      error: `--plan must be an absolute path; received ${JSON.stringify(arguments_.plan)}`,
    });
    return;
  }

  let raw: string;

  try {
    raw = await readFile(arguments_.plan, "utf8");
  } catch (error) {
    finish(2, {
      error: `the plan file could not be read: ${error instanceof Error ? error.message : String(error)}`,
      plan: arguments_.plan,
    });
    return;
  }

  let document: unknown;

  try {
    document = JSON.parse(raw);
  } catch (error) {
    finish(2, {
      error: `the plan file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      plan: arguments_.plan,
    });
    return;
  }

  const problems = validatePlan(document);

  if (problems.length > 0 || !isPlan(document)) {
    finish(2, {
      error: "the live plan is not approved for execution",
      plan: arguments_.plan,
      problems,
    });
    return;
  }

  const plan = document;
  const host = new URL(plan.instance).origin;

  if (!arguments_.execute) {
    finish(3, {
      ok: false,
      plan: arguments_.plan,
      planId: plan.planId,
      instance: host,
      platforms: plan.platforms,
      time: plan.time,
      accounts: plan.accounts,
      error:
        "the plan is valid, but this entry point only validates unless --execute is passed",
      notes: [
        `Execution additionally requires ${CONFIRM_ENV} to equal ${plan.planId}.`,
        "Nothing was contacted: no health check, no post, no registry or platform call.",
      ],
    });
    return;
  }

  if (process.env[CONFIRM_ENV] !== plan.planId) {
    finish(2, {
      ok: false,
      error: `--execute requires ${CONFIRM_ENV} to equal ${JSON.stringify(plan.planId)}`,
      note: "This confirmation is separate from the plan file so an unattended job cannot post on its own.",
    });
    return;
  }

  const apiKey = process.env[API_KEY_ENV];

  if (apiKey === undefined || apiKey.length === 0) {
    finish(2, {
      ok: false,
      error: `${API_KEY_ENV} must be set in the environment for a live run; it is never read from a file`,
    });
    return;
  }

  let cli = arguments_.cli ?? process.env["SYNDROO_LIVE_CLI"];

  if (cli === undefined) {
    // Only the default path needs the repository root, so a plan can still be
    // validated from any directory.
    try {
      cli = join(resolveRepositoryRoot(process.cwd()), "packages", "cli", "dist", "bin.js");
    } catch (error) {
      finish(2, {
        error: "the CLI binary could not be located from this directory",
        hint: "Pass --cli <path> or set SYNDROO_LIVE_CLI to a built or installed bin.js.",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  if (!existsSync(cli)) {
    finish(1, {
      error: `the CLI binary was not found at ${cli}`,
      hint: "Run `npm run build` first, or pass --cli <path to a built or installed bin.js>.",
    });
    return;
  }

  const fixtureDirectory = await mkdtemp(join(tmpdir(), "syndroo-live-"));
  const steps: Step[] = [];

  try {
    const environment = {
      ...process.env,
      [API_KEY_ENV]: apiKey,
      SYNDROO_BASE_URL: host,
    };

    steps.push(
      await run(
        "doctor",
        cli,
        ["doctor", "--json", "--base-url", host],
        fixtureDirectory,
        environment,
      ),
    );

    const failed = steps.filter((step) => step.status !== 0);

    if (failed.length > 0) {
      finish(1, { ok: false, error: "the read-only live check failed", instance: host, steps });
      return;
    }

    if (arguments_.write) {
      const documentPath = await writeDocument(fixtureDirectory, plan);
      const validated = await run(
        "posts validate",
        cli,
        ["posts", "validate", "--file", documentPath, "--json"],
        fixtureDirectory,
        environment,
      );
      steps.push(validated);

      if (validated.status !== 0) {
        finish(1, { ok: false, error: "the live document was rejected locally", steps });
        return;
      }

      for (let operation = 1; operation <= plan.operations; operation += 1) {
        const key = `${plan.planId}-${String(operation)}`;
        const created = await run(
          `posts create ${key}`,
          cli,
          [
            "posts",
            "create",
            "--file",
            documentPath,
            "--idempotency-key",
            key,
            "--json",
            "--yes",
          ],
          fixtureDirectory,
          environment,
        );
        steps.push(created);

        if (created.status !== 0) {
          // A failed create is never retried with a new key: that is exactly
          // how a duplicate post is created.
          finish(1, {
            ok: false,
            error: `operation ${String(operation)} did not finish; stop and reconcile before continuing`,
            instance: host,
            idempotencyKey: key,
            steps,
          });
          return;
        }
      }
    }

    const report = {
      ok: true,
      planId: plan.planId,
      instance: host,
      accounts: plan.accounts,
      platforms: plan.platforms,
      time: plan.time,
      operations: plan.operations,
      wrote: arguments_.write,
      steps: steps.map((step) => ({
        label: step.label,
        status: step.status,
        stdout: step.stdout.trim(),
        stderr: step.stderr.trim(),
      })),
      notes: [
        arguments_.write
          ? "Creates returned an acceptance receipt; check each post's publications before claiming delivery."
          : "Read-only run: doctor only.",
      ],
    };

    if (arguments_.report !== undefined) {
      await writeFile(arguments_.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }

    finish(0, report);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

/**
 * Every problem is reported at once so an operator fixes the plan in one pass
 * instead of discovering one missing field per attempt.
 */
function validatePlan(value: unknown): string[] {
  const problems: string[] = [];

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["the plan must be a JSON object"];
  }

  const record = value as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const entry = record[key];

    if (typeof entry !== "string" || entry.trim().length === 0) {
      problems.push(`${key} must be a non-empty string`);
      return undefined;
    }

    return entry;
  };

  text("planId");
  text("approver");

  const instance = text("instance");

  if (instance !== undefined && !isHttpUrl(instance)) {
    problems.push("instance must be an absolute http(s) URL");
  }

  const accounts = record["accounts"];

  if (!isNonEmptyStringArray(accounts)) {
    problems.push("accounts must be a non-empty array of non-empty strings");
  }

  const platforms = record["platforms"];

  if (!isNonEmptyStringArray(platforms)) {
    problems.push("platforms must be a non-empty array of non-empty strings");
  } else {
    for (const platform of platforms) {
      if (!KNOWN_PLATFORMS.has(platform)) {
        problems.push(`platforms contains an unknown platform ${JSON.stringify(platform)}`);
      }
    }
  }

  const content = record["content"];

  if (typeof content === "string") {
    if (content.trim().length === 0) {
      problems.push("content must not be empty");
    }
  } else if (!isNonEmptyStringRecord(content)) {
    problems.push("content must be a non-empty string or an object of non-empty strings");
  }

  const time = text("time");

  if (time !== undefined && !ABSOLUTE_TIME.test(time)) {
    problems.push(
      `time must be an absolute ISO 8601 timestamp with a timezone, for example 2026-10-01T09:00:00+09:00; received ${JSON.stringify(time)}`,
    );
  }

  const operations = record["operations"];

  if (
    typeof operations !== "number" ||
    !Number.isSafeInteger(operations) ||
    operations < 1
  ) {
    problems.push("operations must be a positive integer");
  }

  const stopConditions = record["stopConditions"];

  if (
    !isNonEmptyStringArray(stopConditions) &&
    (typeof stopConditions !== "string" || stopConditions.trim().length === 0)
  ) {
    problems.push("stopConditions must be a non-empty string or array of strings");
  }

  if (record["approved"] !== true) {
    problems.push('approved must be exactly true; an approved live plan is an explicit decision');
  }

  return problems;
}

function isPlan(value: unknown): value is Plan {
  return typeof value === "object" && value !== null && validatePlan(value).length === 0;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (url.protocol === "https:" || url.protocol === "http:") && url.host.length > 0;
  } catch {
    return false;
  }
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}

function isNonEmptyStringRecord(
  value: unknown,
): value is Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const entries = Object.entries(value);

  return (
    entries.length > 0 &&
    entries.every(
      ([key, entry]) => key.length > 0 && typeof entry === "string" && entry.length > 0,
    )
  );
}

/** Turns the approved plan into the one post document the CLI accepts. */
async function writeDocument(
  directory: string,
  plan: Plan,
): Promise<string> {
  const primary = plan.platforms[0] as string;
  const overrides: Record<string, { content: string }> = {};
  let content: string;

  if (typeof plan.content === "string") {
    content = plan.content;
  } else {
    content = plan.content[primary] ?? Object.values(plan.content)[0] ?? "";

    for (const [platform, value] of Object.entries(plan.content)) {
      if (platform !== primary) {
        overrides[platform] = { content: value };
      }
    }
  }

  const path = join(directory, "post.json");

  await writeFile(
    path,
    `${JSON.stringify(
      {
        content,
        platforms: [...plan.platforms],
        ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
        scheduledAt: plan.time,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return path;
}

function parseArguments(argv: readonly string[]): Arguments {
  let plan: string | undefined;
  let cli: string | undefined;
  let report: string | undefined;
  let execute = false;
  let write = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;

    if (token === "--execute") {
      execute = true;
      continue;
    }

    if (token === "--write") {
      write = true;
      continue;
    }

    if (token === "--plan" || token === "--cli" || token === "--report") {
      const value = argv[index + 1];

      if (value === undefined || value.length === 0) {
        throw new Error(`${token} requires a value.`);
      }

      if (token === "--plan") {
        plan = value;
      } else if (token === "--cli") {
        cli = value;
      } else {
        report = value;
      }

      index += 1;
      continue;
    }

    // Accept the `--plan=<path>` form as well as `--plan <path>`.
    if (token.startsWith("--plan=") || token.startsWith("--cli=") || token.startsWith("--report=")) {
      const separator = token.indexOf("=");
      const name = token.slice(0, separator);
      const value = token.slice(separator + 1);

      if (value.length === 0) {
        throw new Error(`${name} requires a value.`);
      }

      if (name === "--plan") {
        plan = value;
      } else if (name === "--cli") {
        cli = value;
      } else {
        report = value;
      }

      continue;
    }

    throw new Error(`Unknown argument ${JSON.stringify(token)}.`);
  }

  if (write && !execute) {
    throw new Error("--write requires --execute; a write is never implied.");
  }

  return { plan, cli, report, execute, write };
}

async function run(
  label: string,
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Step> {
  return await new Promise<Step>((settle) => {
    const child = spawn(command, [...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n${command} did not exit within 10 minutes`;
    }, 10 * 60 * 1000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      settle({ label, status: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      settle({ label, status: code, stdout, stderr });
    });
  });
}

function finish(exitCode: number, payload: Readonly<Record<string, unknown>>): void {
  console.log(JSON.stringify({ ok: exitCode === 0, exitCode, ...payload }, null, 2));
  process.exitCode = exitCode;
}

try {
  await main();
} catch (error) {
  finish(2, { error: error instanceof Error ? error.message : String(error) });
}
