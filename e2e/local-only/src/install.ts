/**
 * Offline installation of the candidate tarball outside the repository.
 *
 * The runtime type dependency tarballs are supplied by the caller (root packed
 * them from the locked `node_modules`), so the install performs no registry
 * request. Dependencies are prepared before the offline phase.
 */

import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface InstallResult {
  readonly bin: string;
  readonly consumer: string;
  readonly log: string;
}

export async function installCli(input: {
  readonly tarball: string;
  readonly depsDir: string;
  readonly root: string;
}): Promise<InstallResult> {
  const consumer = join(input.root, "consumer");
  const cache = join(input.root, "npm-cache");
  const home = join(input.root, "home");

  await mkdir(consumer, { recursive: true });
  await mkdir(cache, { recursive: true });
  await mkdir(home, { recursive: true });

  const deps = (await readdir(input.depsDir))
    .filter(name => name.endsWith(".tgz"))
    .map(name => join(input.depsDir, name));

  const args = [
    "install",
    "--prefix",
    consumer,
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--cache",
    cache,
    ...deps,
    input.tarball,
  ];
  const result = await run("npm", args, {
    cwd: input.root,
    env: {
      ...process.env,
      HOME: home,
      npm_config_cache: cache,
      npm_config_offline: "true",
    },
  });

  if (result.code !== 0) {
    throw new Error(`offline install failed (${result.code}): ${result.stderr.slice(0, 2_000)}`);
  }

  return {
    bin: join(consumer, "node_modules", "@syndroo", "cli", "dist", "bin.js"),
    consumer,
    log: `${result.stdout}${result.stderr}`,
  };
}

function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk as string;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk as string;
    });
    child.on("error", error => resolve({ code: null, stdout, stderr: `${stderr}${String(error)}` }));
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}
