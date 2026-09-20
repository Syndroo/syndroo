#!/usr/bin/env node
/**
 * Layer Web: delegate the browser gate to the separate website repository.
 *
 * This entry point orchestrates; it does not reimplement the website gate. It
 * locates the Syndroo web checkout, then runs that repository's own build,
 * check, test, and Playwright commands there, forwarding `--project` so the
 * browser run uses the real `chrome` channel the checklist requires.
 *
 * Nothing in the website repository is edited, and a missing checkout or a
 * missing Playwright install is reported as a failure with the command to fix
 * it instead of silently passing.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveRepositoryRoot } from "./package-support.js";

const DEFAULT_SIBLING = "syndroo-web";

type Arguments = {
  readonly root: string | undefined;
  readonly project: string | undefined;
  readonly install: boolean;
  readonly skipTests: boolean;
};

type Step = {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const root = arguments_.root ?? process.env["SYNDROO_WEB_ROOT"] ?? defaultSiblingRoot();

  if (!existsSync(join(root, "package.json"))) {
    finish(1, {
      error: "the Syndroo website repository was not found",
      lookedFor: root,
      hint: "Clone it next to this repository, or pass --root <path> / set SYNDROO_WEB_ROOT.",
    });
    return;
  }

  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    name?: string;
    scripts?: Readonly<Record<string, string>>;
  };

  if (manifest.scripts?.["build"] === undefined) {
    finish(1, {
      error: `${root} has no "build" script, so it is not the Syndroo website checkout`,
      packageName: manifest.name ?? null,
    });
    return;
  }

  if (!existsSync(join(root, "node_modules")) && !arguments_.install) {
    finish(1, {
      error: `${root} has no node_modules`,
      hint: "Run `npm ci` there, or pass --install to let this entry point do it.",
    });
    return;
  }

  const steps: Step[] = [];
  const planned: Array<readonly [string, string, readonly string[]]> = [
    ...(arguments_.install ? [["install", "npm", ["ci"]] as const] : []),
    ["build", "npm", ["run", "build"]],
    ["check", "npm", ["run", "check"]],
    ...(arguments_.skipTests ? [] : [["test", "npm", ["test"]] as const]),
  ];

  for (const [label, command, args] of planned) {
    const step = await capture(label, command, args, root);
    steps.push(step);

    if (step.status !== 0) {
      report(steps, root, arguments_);
      finish(1, { error: `the website step "${label}" failed`, root, steps });
      return;
    }
  }

  if (arguments_.project !== undefined) {
    const playwright = join(root, "node_modules", ".bin", "playwright");

    if (!existsSync(playwright)) {
      finish(1, {
        error: `Playwright is not installed in ${root}`,
        hint: "Run `npm ci` there, then re-run this entry point.",
        root,
        steps,
      });
      return;
    }

    const step = await capture(
      `playwright --project=${arguments_.project}`,
      playwright,
      ["test", `--project=${arguments_.project}`],
      root,
    );

    steps.push(step);

    if (step.status !== 0) {
      report(steps, root, arguments_);
      finish(1, { error: "the browser project failed", root, steps });
      return;
    }
  }

  report(steps, root, arguments_);
  finish(0, { ok: true, root, project: arguments_.project ?? null, steps });
}

function report(steps: readonly Step[], root: string, arguments_: Arguments): void {
  for (const step of steps) {
    process.stderr.write(
      `e2e:web: ${step.label} in ${root} -> exit ${String(step.status)}\n`,
    );
  }

  if (arguments_.project === undefined) {
    process.stderr.write(
      "e2e:web: no --project given, so no Playwright project ran; pass --project=chrome for the required browser gate.\n",
    );
  }
}

async function capture(
  label: string,
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<Step> {
  return await new Promise<Step>((settle) => {
    const child = spawn(command, [...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n${command} did not exit within 30 minutes`;
    }, 30 * 60 * 1000);

    const done = (
      status: number | null,
      extra: string,
    ): void => {
      clearTimeout(timer);
      settle({ label, command, args, status, stdout, stderr: `${stderr}${extra}` });
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      done(null, `\n${error.message}`);
    });
    child.once("close", (code) => {
      done(code, "");
    });
  });
}

function parseArguments(argv: readonly string[]): Arguments {
  let root: string | undefined;
  let project: string | undefined;
  let install = false;
  let skipTests = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;

    if (token === "--install") {
      install = true;
      continue;
    }

    if (token === "--skip-tests") {
      skipTests = true;
      continue;
    }

    if (token === "--root" || token === "--project") {
      const value = argv[index + 1];

      if (value === undefined || value.length === 0) {
        throw new Error(`${token} requires a value.`);
      }

      if (token === "--root") {
        root = resolve(value);
      } else {
        project = value;
      }

      index += 1;
      continue;
    }

    // Both `--project chrome` and the documented `--project=chrome` are accepted.
    if (token.startsWith("--root=") || token.startsWith("--project=")) {
      const separator = token.indexOf("=");
      const name = token.slice(0, separator);
      const value = token.slice(separator + 1);

      if (value.length === 0) {
        throw new Error(`${name} requires a value.`);
      }

      if (name === "--root") {
        root = resolve(value);
      } else {
        project = value;
      }

      continue;
    }

    throw new Error(`Unknown argument ${JSON.stringify(token)}.`);
  }

  return { root, project, install, skipTests };
}

function finish(exitCode: number, payload: Readonly<Record<string, unknown>>): void {
  console.log(JSON.stringify({ ok: exitCode === 0, exitCode, ...payload }, null, 2));
  process.exitCode = exitCode;
}

/**
 * The default is the `syndroo-web` checkout next to this repository, which
 * only makes sense when this entry point runs from inside the repository.
 */
function defaultSiblingRoot(): string {
  return resolve(resolveRepositoryRoot(process.cwd()), "..", DEFAULT_SIBLING);
}

try {
  await main();
} catch (error) {
  finish(2, { error: error instanceof Error ? error.message : String(error) });
}
