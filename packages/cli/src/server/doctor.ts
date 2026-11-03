import path from "node:path";

import { CliError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import { loadServerConfig, resolveServerProject } from "./config.js";
import { createCloudflareApi, resolveCloudflareSession } from "./cloudflare.js";
import {
  loadDeploymentCredentials,
  loadDeploymentState,
} from "./deployment-state.js";
import {
  GENERATED_MARKER,
  SERVER_DEPENDENCY_VERSIONS,
  readProjectText,
} from "./foundation.js";
import type { ProcessRunner, ServerTool } from "./process.js";

export type DoctorCheck = {
  readonly name: string;
  readonly status:
    | "ok"
    | "missing"
    | "attention_required"
    | "not_configured"
    | "unverified";
};

export type ServerDoctorResult = {
  readonly subcommand: "doctor";
  readonly status: "ok" | "attention_required";
  readonly checks: readonly DoctorCheck[];
};

export type DoctorDependencies = {
  readonly cwd: string;
  readonly projectDirectory?: string;
  readonly runner: ProcessRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly stateRoot?: string;
  readonly fetch?: typeof fetch;
};

function serverError(code: string, nextAction: string): CliError {
  return new CliError(code, {
    code,
    exitCode: EXIT_CODE.USAGE,
    details: { nextAction },
  });
}

async function toolCheck(
  runner: ProcessRunner,
  cwd: string,
  name: string,
  tool: ServerTool,
  args: readonly string[],
): Promise<DoctorCheck> {
  const result = await runner.run({ tool, args, cwd, timeoutMs: 30_000 });
  return {
    name,
    status: result.status === "exited" && result.exitCode === 0 ? "ok" : "missing",
  };
}

function packageCheck(text: string | null): DoctorCheck {
  if (text === null) {
    return { name: "package", status: "missing" };
  }
  try {
    const value = JSON.parse(text) as {
      private?: unknown;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      syndroo?: unknown;
    };
    const ok =
      value.private === true &&
      JSON.stringify(value.syndroo) === JSON.stringify(GENERATED_MARKER) &&
      value.dependencies?.["@syndroo/cli"] === SERVER_DEPENDENCY_VERSIONS.cli &&
      value.dependencies?.["@syndroo/cloudflare"] ===
        SERVER_DEPENDENCY_VERSIONS.cloudflare &&
      value.devDependencies?.["wrangler"] === SERVER_DEPENDENCY_VERSIONS.wrangler;
    return {
      name: "package",
      status: ok ? "ok" : "attention_required",
    };
  } catch {
    return { name: "package", status: "attention_required" };
  }
}

export async function runServerDoctor(
  dependencies: DoctorDependencies,
): Promise<ServerDoctorResult> {
  const projectDirectory = resolveServerProject(
    dependencies.cwd,
    dependencies.projectDirectory,
  );
  let configLoaded;
  try {
    configLoaded = await loadServerConfig(projectDirectory);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw serverError("SERVER_CONFIG_INVALID", "FIX_SERVER_CONFIG");
  }

  const checks: DoctorCheck[] = [
    { name: "config", status: "ok" },
    packageCheck(
      await readProjectText(path.join(projectDirectory, "package.json")),
    ),
    {
      name: "node",
      status:
        Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 24
          ? "ok"
          : "attention_required",
    },
    await toolCheck(dependencies.runner, projectDirectory, "git", "git", ["--version"]),
    await toolCheck(dependencies.runner, projectDirectory, "npm", "npm", ["--version"]),
    await toolCheck(
      dependencies.runner,
      projectDirectory,
      "wrangler",
      "wrangler",
      ["--version"],
    ),
  ];

  const deployment = dependencies.stateRoot === undefined
    ? null
    : await loadDeploymentState(
        dependencies.stateRoot,
        configLoaded.config.projectId,
      );
  if (deployment === null) {
    checks.push(
      { name: "deployment", status: "not_configured" },
      { name: "credentials", status: "not_configured" },
    );
  } else {
    checks.push({
      name: "deployment",
      status:
        deployment.step === "deployed" &&
        deployment.origin === configLoaded.config.publicOrigin &&
        deployment.worker !== undefined &&
        deployment.versionId !== undefined
          ? "ok"
          : "attention_required",
    });
    const credentials = await loadDeploymentCredentials(
      dependencies.stateRoot as string,
      configLoaded.config.projectId,
      { accountId: deployment.accountId, workerName: deployment.workerName },
    );
    checks.push({
      name: "credentials",
      status: credentials === null ? "missing" : "ok",
    });
    if (credentials !== null && deployment.worker !== undefined) {
      try {
        const session = await resolveCloudflareSession(
          dependencies.runner,
          projectDirectory,
          dependencies.env ?? {},
          deployment.accountId,
        );
        const api = createCloudflareApi({
          accountId: session.accountId,
          token: session.token,
          fetch: dependencies.fetch ?? globalThis.fetch,
        });
        const worker = await api.worker(deployment.workerName);
        const d1 = deployment.resources.d1.id === undefined
          ? null
          : await api.d1(deployment.resources.d1.id);
        const queues = await Promise.all(
          deployment.resources.queues.map((queue) =>
            queue.id === undefined ? Promise.resolve(null) : api.queue(queue.id),
          ),
        );
        const resourcesOk =
          worker?.tag === deployment.worker.tag &&
          d1?.name === deployment.resources.d1.name &&
          queues.every((queue, index) =>
            queue?.name === deployment.resources.queues[index]?.name,
          );
        checks.push({
          name: "cloudflare-resources",
          status: resourcesOk ? "ok" : "attention_required",
        });
      } catch {
        checks.push({
          name: "cloudflare-resources",
          status: "attention_required",
        });
      }
    } else {
      checks.push({ name: "cloudflare-resources", status: "not_configured" });
    }
  }

  if (configLoaded.config.publicOrigin !== undefined) {
    let status: DoctorCheck["status"] = "attention_required";
    try {
      const response = await (dependencies.fetch ?? globalThis.fetch)(
        `${configLoaded.config.publicOrigin}/health`,
        { method: "GET", redirect: "error" },
      );
      status = response.ok ? "ok" : "attention_required";
    } catch {
      status = "attention_required";
    }
    checks.push({ name: "liveness", status });
  } else {
    checks.push({ name: "liveness", status: "not_configured" });
  }
  checks.push(
    { name: "oauth-readiness", status: "unverified" },
    { name: "publication-readiness", status: "unverified" },
  );

  const remote = await dependencies.runner.run({
    tool: "git",
    args: ["remote", "get-url", "origin"],
    cwd: projectDirectory,
    timeoutMs: 30_000,
  });
  const githubConfigured =
    remote.status === "exited" &&
    remote.exitCode === 0 &&
    /github\.com[:/]/i.test(remote.stdout);

  if (githubConfigured) {
    checks.push(
      await toolCheck(dependencies.runner, projectDirectory, "github-cli", "gh", ["--version"]),
      await toolCheck(dependencies.runner, projectDirectory, "github-auth", "gh", ["auth", "status"]),
    );
  } else {
    checks.push({ name: "github", status: "not_configured" });
  }

  const status = checks.every(
    (check) =>
      check.status === "ok" ||
      check.status === "not_configured" ||
      check.status === "unverified",
  )
    ? "ok"
    : "attention_required";

  return {
    subcommand: "doctor",
    status,
    checks,
  };
}
