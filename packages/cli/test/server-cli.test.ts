import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import type { CliIo } from "../src/io.js";
import { CliError } from "../src/cli-error.js";
import { EXIT_CODE } from "../src/exit-codes.js";
import { run } from "../src/main.js";
import {
  ensureDeploymentCredentials,
  saveDeploymentState,
} from "../src/server/deployment-state.js";
import { matchingGithubRemote } from "../src/server/init.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../src/server/process.js";
import { createNodeProcessRunner } from "../src/server/process.js";

// The version this package actually publishes, read from its own manifest so a
// stale literal cannot pin the fixture to a previous release. Read independently
// of the implementation under test, so a wrong dependency version still fails.
const CLI_VERSION = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

const roots: string[] = [];

async function root(): Promise<string> {
  const created = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "syndroo-server-cli-")));
  roots.push(created);
  return created;
}

function result(
  exitCode = 0,
  stdout = "",
  stderr = "",
): ProcessResult {
  return { status: "exited", exitCode, stdout, stderr };
}

class ScriptedRunner implements ProcessRunner {
  readonly calls: ProcessRequest[] = [];

  constructor(
    private readonly respond: (request: ProcessRequest) => ProcessResult | Promise<ProcessResult>,
  ) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.calls.push(request);
    return await this.respond(request);
  }
}

function defaultRunner(options: {
  readonly pushFails?: boolean;
  readonly repoExists?: boolean;
  readonly createFails?: boolean;
  readonly installFails?: boolean;
  readonly remoteUrl?: string;
  readonly remoteHead?: string | null;
  readonly remoteHeadAfterPush?: string;
  readonly remoteId?: string;
  readonly viewFailsAfterCreate?: boolean;
  readonly revParseHead?: string;
} = {}): ScriptedRunner {
  let repoCreated = options.repoExists === true;
  let createdInThisRunner = false;
  let pushed = false;
  let currentRemoteUrl = options.remoteUrl;
  let visibility: "private" | "public" = "private";
  return new ScriptedRunner(async (request) => {
    if (
      request.tool === "git" &&
      request.args[0] === "config" &&
      request.args[1] === "--get"
    ) {
      return result(0, request.args[2] === "user.email" ? "test@example.invalid\n" : "Test User\n");
    }
    if (request.tool === "npm" && request.args[0] === "install") {
      if (options.installFails === true) {
        return result(1, "", "npm error MOCK-PACKAGE-CANARY");
      }
      await fs.writeFile(path.join(request.cwd, "package-lock.json"), '{"lockfileVersion":3}\n', {
        mode: 0o600,
      });
      return result();
    }
    if (request.tool === "git" && request.args[0] === "init") {
      await fs.mkdir(path.join(request.cwd, ".git"), { mode: 0o700 });
      return result();
    }
    if (request.tool === "gh" && request.args[0] === "repo" && request.args[1] === "view") {
      if (
        !repoCreated ||
        (options.viewFailsAfterCreate === true && createdInThisRunner)
      ) {
        return result(1);
      }
      const repository = request.args[2] ?? "octocat/repository";
      return result(
        0,
        JSON.stringify({
          id: options.remoteId ?? "R_syndroo_fixture",
          nameWithOwner: repository,
          isPrivate: visibility === "private",
          url: `https://github.com/${repository}`,
        }),
      );
    }
    if (request.tool === "gh" && request.args[0] === "repo" && request.args[1] === "create") {
      if (options.createFails === true) {
        return result(1);
      }
      repoCreated = true;
      createdInThisRunner = true;
      currentRemoteUrl = `https://github.com/${request.args[2] ?? "octocat/repository"}`;
      visibility = request.args.includes("--public") ? "public" : "private";
      return result();
    }
    if (request.tool === "git" && request.args[0] === "diff") {
      return result(
        0,
        [
          ".gitignore",
          "package-lock.json",
          "package.json",
          "posts/hello.json",
          "syndroo.config.jsonc",
          "wrangler.jsonc",
        ].join("\n"),
      );
    }
    if (request.tool === "git" && request.args[0] === "remote") {
      return currentRemoteUrl === undefined
        ? result(1)
        : result(0, `${currentRemoteUrl}\n`);
    }
    if (request.tool === "git" && request.args[0] === "rev-parse") {
      return result(0, `${options.revParseHead ?? "a".repeat(40)}\n`);
    }
    if (request.tool === "git" && request.args[0] === "ls-remote") {
      if (pushed) {
        return result(
          0,
          `${options.remoteHeadAfterPush ?? "a".repeat(40)}\trefs/heads/main\n`,
        );
      }
      if (options.remoteHead === null) {
        return result();
      }
      return result(
        0,
        `${options.remoteHead ?? "a".repeat(40)}\trefs/heads/main\n`,
      );
    }
    if (request.tool === "git" && request.args[0] === "push") {
      if (options.pushFails === true) {
        return result(1, "", "fatal: MOCK-SECRET-CANARY");
      }
      pushed = true;
      return result();
    }
    return result();
  });
}

type Capture = {
  readonly io: CliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
};

function sink(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, done): void {
      chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf8"));
      done();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

function capture(cwd: string): Capture {
  const stdout = sink();
  const stderr = sink();
  const io: CliIo = {
    stdin: Readable.from([]),
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {
      HOME: path.join(cwd, "home"),
      XDG_CONFIG_HOME: path.join(cwd, "config"),
      XDG_STATE_HOME: path.join(cwd, "state"),
      NO_COLOR: "1",
      ...(process.env["PATH"] === undefined ? {} : { PATH: process.env["PATH"] }),
    },
    cwd,
    stdinIsTty: false,
    stdoutIsTty: false,
    hasTty: () => false,
    readTtyLine: () => undefined,
    signal: new AbortController().signal,
  };
  return { io, stdout: stdout.text, stderr: stderr.text };
}

async function invoke(
  cwd: string,
  argv: readonly string[],
  runner: ProcessRunner,
  stateRoot?: string,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const streams = capture(cwd);
  const exit = await run(argv, streams.io, {}, {
    processRunner: runner,
    randomUUID: () => "f0c4f706-25a4-4df7-a84c-3b247c64abfe",
    ...(stateRoot === undefined ? {} : { stateRoot }),
  });
  return { exit, stdout: streams.stdout(), stderr: streams.stderr() };
}

async function realInitRunner(cwd: string): Promise<{
  readonly runner: ProcessRunner;
  readonly env: NodeJS.ProcessEnv;
}> {
  const home = path.join(cwd, "real-git-home");
  await fs.mkdir(home);
  const env = {
    HOME: home,
    PATH: process.env["PATH"],
  };
  expect(
    spawnSync("git", ["config", "--global", "user.name", "Test User"], {
      cwd,
      env,
    }).status,
  ).toBe(0);
  expect(
    spawnSync("git", ["config", "--global", "user.email", "test@example.invalid"], {
      cwd,
      env,
    }).status,
  ).toBe(0);

  const real = createNodeProcessRunner(env, new AbortController().signal);
  return {
    env,
    runner: {
      async run(request: ProcessRequest): Promise<ProcessResult> {
        if (request.tool === "npm" && request.args[0] === "install") {
          await fs.writeFile(
            path.join(request.cwd, "package-lock.json"),
            '{"lockfileVersion":3}\n',
            { mode: 0o600 },
          );
          return result();
        }
        return await real.run(request);
      },
    },
  };
}

function envelope(stdout: string): Record<string, any> {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string) as Record<string, any>;
}

const THREADS_PROJECT_ID = "f0c4f706-25a4-4df7-a84c-3b247c64abfe";

/**
 * Write a project whose recorded deployment is verified for the configured
 * origin, so `connect threads` reaches its own contract checks instead of
 * failing on the project selection.
 */
async function writeThreadsProject(root: string): Promise<{
  readonly project: string;
  readonly stateRoot: string;
}> {
  const project = path.join(root, "deployment");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(
    path.join(project, "syndroo.config.jsonc"),
    `${JSON.stringify(
      {
        version: 1,
        projectId: THREADS_PROJECT_ID,
        scope: "fixture",
        publicOrigin: "https://threads.example",
        threads: { appId: "123456789", connectionId: "conn_fixture" },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(project, "package.json"),
    `${JSON.stringify({
      private: true,
      dependencies: {
        "@syndroo/cli": CLI_VERSION,
        "@syndroo/cloudflare": CLI_VERSION,
      },
      devDependencies: { wrangler: "4.132.0" },
      syndroo: { generated: true, server: 1 },
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(project, "wrangler.jsonc"),
    `{
  "name": "fixture-worker",
  "main": "./node_modules/@syndroo/cloudflare/dist/worker.js",
  "compatibility_flags": ["global_fetch_strictly_public"],
  "d1_databases": [{"binding":"DB","database_name":"fixture-db"}],
  "queues": {
    "producers": [{"binding":"WORK_QUEUE","queue":"fixture-work"}],
    "consumers": [{"queue":"fixture-work"},{"queue":"fixture-dead"}]
  },
  "vars": {"PUBLIC_FETCH_STRICT":"enabled"},
  "secrets": {"required":["API_BEARER","SECRET_KEY","RUNTIME_KEY"]}
}
`,
  );
  await fs.writeFile(
    path.join(project, ".gitignore"),
    "node_modules/\nwrangler.effective.jsonc\n.syndroo/\n",
  );
  await fs.mkdir(path.join(project, "node_modules", ".bin"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.mkdir(path.join(project, "node_modules", "wrangler"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(
    path.join(project, "node_modules", "wrangler", "package.json"),
    '{"name":"wrangler","version":"4.132.0"}\n',
  );
  await fs.writeFile(
    path.join(project, "node_modules", ".bin", "wrangler"),
    "#!/usr/bin/env node\n",
    { mode: 0o700 },
  );
  const stateRoot = path.join(root, "threads-state");
  await saveDeploymentState(stateRoot, {
    version: 1,
    projectId: THREADS_PROJECT_ID,
    accountId: "account_fixture",
    workerName: "fixture-worker",
    step: "deployed",
    operationId: "deploy_fixture",
    resources: {
      d1: { name: "fixture-db", id: "d1_fixture" },
      queues: [
        { name: "fixture-work", id: "queue_work" },
        { name: "fixture-dead", id: "queue_dead" },
      ],
    },
    worker: { name: "fixture-worker", tag: "worker_tag_fixture" },
    origin: "https://threads.example",
    versionId: "version_fixture",
    updatedAt: "2026-11-02T00:00:00.000Z",
  });
  await ensureDeploymentCredentials({
    stateRoot,
    projectId: THREADS_PROJECT_ID,
    accountId: "account_fixture",
    workerName: "fixture-worker",
    newDeployment: false,
    supplied: {
      API_BEARER: "admin.fixture-token-that-is-at-least-thirty-two",
      SECRET_KEY: "a".repeat(64),
      RUNTIME_KEY: "b".repeat(64),
    },
  });
  return { project, stateRoot };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((created) => fs.rm(created, { recursive: true, force: true })));
});

describe("server init", () => {
  it.each([
    ["my.syndroo", "my-syndroo"],
    ["foo_bar", "foo-bar"],
    ["a".repeat(80), "a".repeat(58)],
  ])("generates a valid Worker slug for %s", async (directoryName, expectedSlug) => {
    const cwd = await root();
    const target = path.join(cwd, directoryName);

    const run = await invoke(
      cwd,
      ["server", "init", target, "--json"],
      defaultRunner(),
    );

    expect(run.exit).toBe(0);
    const wrangler = await fs.readFile(
      path.join(target, "wrangler.jsonc"),
      "utf8",
    );
    const workerName = /"name": "([^"]+)"/.exec(wrangler)?.[1];
    expect(workerName).toBe(expectedSlug);
    expect(workerName).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
    expect(workerName).not.toMatch(/-$/);
    expect(workerName?.length).toBeLessThanOrEqual(58);
    expect(wrangler).toContain(`"QUEUE_NAME": "${expectedSlug}-work"`);
    expect(wrangler).toContain(`"DLQ_NAME": "${expectedSlug}-dead"`);
  });

  it("creates a thin deterministic project and performs no GitHub effect by default", async () => {
    const cwd = await root();
    const target = path.join(cwd, "deployment");
    const runner = defaultRunner();

    const run = await invoke(cwd, ["server", "init", target, "--json"], runner);

    expect(run.exit).toBe(0);
    expect(envelope(run.stdout)).toMatchObject({
      protocolVersion: 1,
      operation: "server",
      ok: true,
      result: {
        subcommand: "init",
        status: "initialized",
        projectId: "f0c4f706-25a4-4df7-a84c-3b247c64abfe",
      },
    });
    expect(runner.calls.some((call) => call.tool === "gh")).toBe(false);

    const manifest = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf8")) as {
      private?: boolean;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      syndroo?: unknown;
    };
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies).toEqual({
      "@syndroo/cli": CLI_VERSION,
      "@syndroo/cloudflare": CLI_VERSION,
    });
    expect(manifest.devDependencies).toEqual({ wrangler: "4.132.0" });
    expect(manifest.syndroo).toEqual({ generated: true, server: 1 });
    expect((manifest as { scripts?: Record<string, string> }).scripts).toEqual({
      doctor: "syndroo server doctor",
    });

    expect(await fs.readFile(path.join(target, "syndroo.config.jsonc"), "utf8")).toContain(
      '"projectId": "f0c4f706-25a4-4df7-a84c-3b247c64abfe"',
    );
    const wrangler = await fs.readFile(path.join(target, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('./node_modules/@syndroo/cloudflare/dist/worker.js');
    expect(wrangler).not.toContain('"SCOPE"');
    expect(await fs.readFile(path.join(target, "posts/hello.json"), "utf8")).toBe(
      '{\n  "text": "Hello from Syndroo CI"\n}\n',
    );
    expect(await fs.readFile(path.join(target, ".gitignore"), "utf8")).toContain(".syndroo/");

    const add = runner.calls.find((call) => call.tool === "git" && call.args[0] === "add");
    expect(add?.args).toEqual([
      "add",
      "--",
      ".gitignore",
      "package.json",
      "package-lock.json",
      "syndroo.config.jsonc",
      "wrangler.jsonc",
      "posts/hello.json",
    ]);
    expect(runner.calls).toContainEqual(
      expect.objectContaining({
        tool: "git",
        args: ["commit", "--signoff", "-m", "chore: initialize Syndroo deployment"],
      }),
    );
    expect(await fs.readdir(path.join(cwd, "state")).catch(() => [])).toEqual([]);
  });

  it("creates a private repository only when GitHub creation is explicit", async () => {
    const cwd = await root();
    const target = path.join(cwd, "private");
    const runner = defaultRunner();

    const run = await invoke(
      cwd,
      ["server", "init", target, "--github", "octocat/syndroo-site", "--private", "--json"],
      runner,
    );

    expect(run.exit).toBe(0);
    const create = runner.calls.find((call) => call.tool === "gh" && call.args[0] === "repo" && call.args[1] === "create");
    expect(create?.args).toEqual([
      "repo",
      "create",
      "octocat/syndroo-site",
      "--private",
      "--source",
      ".",
      "--remote",
      "origin",
    ]);
    expect(runner.calls.some((call) => call.tool === "git" && call.args[0] === "push")).toBe(true);
  });

  it("uses public visibility only when requested", async () => {
    const cwd = await root();
    const target = path.join(cwd, "public");
    const runner = defaultRunner();

    const run = await invoke(
      cwd,
      ["server", "init", target, "--github", "octocat/syndroo-public", "--public", "--json"],
      runner,
    );

    expect(run.exit).toBe(0);
    const create = runner.calls.find((call) => call.tool === "gh" && call.args[0] === "repo" && call.args[1] === "create");
    expect(create?.args).toContain("--public");
    expect(create?.args).not.toContain("--private");
  });

  it("rejects a non-empty unrelated destination without mutation", async () => {
    const cwd = await root();
    const target = path.join(cwd, "occupied");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "keep.txt"), "user content\n");
    const runner = defaultRunner();

    const run = await invoke(cwd, ["server", "init", target, "--json"], runner);
    const body = envelope(run.stdout);

    expect(run.exit).not.toBe(0);
    expect(body).toMatchObject({
      operation: "server",
      ok: false,
      error: { code: "SERVER_PROJECT_CONFLICT", details: { subcommand: "init" } },
    });
    expect(runner.calls).toEqual([]);
    expect(await fs.readFile(path.join(target, "keep.txt"), "utf8")).toBe("user content\n");
  });

  it("stops before mutation when the explicit GitHub repository already exists", async () => {
    const cwd = await root();
    const target = path.join(cwd, "remote-collision");
    const runner = defaultRunner({ repoExists: true });

    const run = await invoke(
      cwd,
      ["server", "init", target, "--github", "octocat/existing", "--json"],
      runner,
    );

    expect(run.exit).not.toBe(0);
    expect(envelope(run.stdout)).toMatchObject({
      operation: "server",
      ok: false,
      error: { code: "SERVER_GITHUB_COLLISION" },
    });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(runner.calls.some((call) => call.tool === "gh" && call.args[1] === "create")).toBe(
      false,
    );
  });

  it("preserves generated files and hides raw output when packages are unavailable", async () => {
    const cwd = await root();
    const target = path.join(cwd, "package-failure");
    const runner = defaultRunner({ installFails: true });

    const run = await invoke(cwd, ["server", "init", target, "--json"], runner);

    expect(run.exit).not.toBe(0);
    expect(envelope(run.stdout)).toMatchObject({
      operation: "server",
      ok: false,
      error: {
        code: "SERVER_PACKAGE_UNAVAILABLE",
        details: { subcommand: "init" },
      },
    });
    expect(run.stdout).not.toContain("MOCK-PACKAGE-CANARY");
    expect(run.stderr).not.toContain("MOCK-PACKAGE-CANARY");
    expect(await fs.readFile(path.join(target, "package.json"), "utf8")).toContain(
      '"private": true',
    );
    expect(await fs.readFile(path.join(target, "syndroo.config.jsonc"), "utf8")).toContain(
      "projectId",
    );
  });

  it("resumes its own failed package installation without rewriting generated files", async () => {
    const cwd = await root();
    const target = path.join(cwd, "install-retry");
    const failed = await invoke(
      cwd,
      ["server", "init", target, "--json"],
      defaultRunner({ installFails: true }),
    );
    const packageBefore = await fs.readFile(path.join(target, "package.json"), "utf8");

    expect(failed.exit).not.toBe(0);
    await expect(fs.stat(path.join(target, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(target, "package-lock.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const retried = await invoke(
      cwd,
      ["server", "init", target, "--json"],
      defaultRunner(),
    );

    expect(retried.exit).toBe(0);
    expect(envelope(retried.stdout)["result"]).toMatchObject({
      subcommand: "init",
      status: "unchanged",
      projectId: "f0c4f706-25a4-4df7-a84c-3b247c64abfe",
    });
    expect(await fs.readFile(path.join(target, "package.json"), "utf8")).toBe(packageBefore);
    expect(await fs.readFile(path.join(target, "package-lock.json"), "utf8")).toContain(
      "lockfileVersion",
    );
    expect((await fs.stat(path.join(target, ".git"))).isDirectory()).toBe(true);
  });

  it("does not overwrite an edited generated file while resuming a partial init", async () => {
    const cwd = await root();
    const target = path.join(cwd, "edited-partial");
    await invoke(
      cwd,
      ["server", "init", target, "--json"],
      defaultRunner({ installFails: true }),
    );
    const edited = `${await fs.readFile(path.join(target, "posts/hello.json"), "utf8")}// user edit\n`;
    await fs.writeFile(path.join(target, "posts/hello.json"), edited);

    const retried = await invoke(
      cwd,
      ["server", "init", target, "--json"],
      defaultRunner(),
    );

    expect(retried.exit).not.toBe(0);
    expect(envelope(retried.stdout)).toMatchObject({
      operation: "server",
      ok: false,
      error: { code: "SERVER_PROJECT_CONFLICT" },
    });
    expect(await fs.readFile(path.join(target, "posts/hello.json"), "utf8")).toBe(edited);
  });

  it("refuses a pre-existing Git directory even when its worktree is empty", async () => {
    const cwd = await root();
    const target = path.join(cwd, "preexisting-git");
    await fs.mkdir(target);
    expect(spawnSync("git", ["init", "-q", "."], { cwd: target }).status).toBe(0);
    await fs.writeFile(path.join(target, "unrelated.txt"), "staged user content\n");
    expect(spawnSync("git", ["add", "--", "unrelated.txt"], { cwd: target }).status).toBe(0);
    await fs.rm(path.join(target, "unrelated.txt"));
    const runner = defaultRunner();

    const run = await invoke(cwd, ["server", "init", target, "--json"], runner);

    expect(run.exit).not.toBe(0);
    expect(envelope(run.stdout)).toMatchObject({
      operation: "server",
      ok: false,
      error: { code: "SERVER_PROJECT_CONFLICT" },
    });
    expect(runner.calls).toEqual([]);
    expect(spawnSync("git", ["show", ":unrelated.txt"], { cwd: target }).status).toBe(0);
  });

  it("preserves the generated repo and private recovery record after a failed push", async () => {
    const cwd = await root();
    const target = path.join(cwd, "push-failure");
    const runner = defaultRunner({ pushFails: true });

    const run = await invoke(
      cwd,
      ["server", "init", target, "--github", "octocat/syndroo-site", "--json"],
      runner,
    );

    expect(run.exit).not.toBe(0);
    expect(envelope(run.stdout)).toMatchObject({
      operation: "server",
      ok: false,
      error: {
        code: "SERVER_GITHUB_PUSH_FAILED",
        details: { subcommand: "init", nextAction: "RETRY_INIT" },
      },
    });
    expect(run.stdout).not.toContain("MOCK-SECRET-CANARY");
    expect(run.stderr).not.toContain("MOCK-SECRET-CANARY");
    expect(await fs.readFile(path.join(target, "syndroo.config.jsonc"), "utf8")).toContain(
      "projectId",
    );

    const recoveryRoot = path.join(target, ".syndroo");
    const recoveryFile = path.join(recoveryRoot, "recovery.json");
    expect((await fs.stat(recoveryRoot)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(recoveryFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(recoveryFile, "utf8"))).toMatchObject({
      version: 1,
      step: "remote-created",
      github: { owner: "octocat", repo: "syndroo-site", visibility: "private" },
      remoteId: "R_syndroo_fixture",
      head: "a".repeat(40),
    });
  });

  it("refuses to resume when a failed remote was deleted and recreated", async () => {
    const cwd = await root();
    const target = path.join(cwd, "remote-recreated");
    await invoke(
      cwd,
      ["server", "init", target, "--github", "octocat/recreated", "--json"],
      defaultRunner({ pushFails: true, remoteId: "R_original" }),
    );
    const recoveryFile = path.join(target, ".syndroo", "recovery.json");
    const recoveryBefore = await fs.readFile(recoveryFile, "utf8");
    const retryRunner = defaultRunner({
      repoExists: true,
      remoteUrl: "git@github.com:octocat/recreated.git",
      remoteId: "R_recreated",
      remoteHead: null,
    });

    const retry = await invoke(
      cwd,
      ["server", "init", target, "--github", "octocat/recreated", "--json"],
      retryRunner,
    );

    expect(retry.exit).not.toBe(0);
    expect(envelope(retry.stdout)).toMatchObject({
      operation: "server",
      ok: false,
      error: { code: "SERVER_GITHUB_RECOVERY_CONFLICT" },
    });
    expect(
      retryRunner.calls.some(
        (call) => call.tool === "git" && call.args[0] === "push",
      ),
    ).toBe(false);
    expect(await fs.readFile(recoveryFile, "utf8")).toBe(recoveryBefore);
  });

  it("refuses to resume when the recorded local head changed", async () => {
    const cwd = await root();
    const target = path.join(cwd, "changed-recovery-head");
    await invoke(
      cwd,
      ["server", "init", target, "--github", "octocat/changed-head", "--json"],
      defaultRunner({
        pushFails: true,
        remoteId: "R_original",
        revParseHead: "a".repeat(40),
      }),
    );
    const retryRunner = defaultRunner({
      repoExists: true,
      remoteUrl: "https://github.com/octocat/changed-head.git",
      remoteId: "R_original",
      remoteHead: null,
      revParseHead: "b".repeat(40),
    });

    const retry = await invoke(
      cwd,
      ["server", "init", target, "--github", "octocat/changed-head", "--json"],
      retryRunner,
    );

    expect(retry.exit).not.toBe(0);
    expect(envelope(retry.stdout)).toMatchObject({
      operation: "server",
      ok: false,
      error: { code: "SERVER_GITHUB_RECOVERY_CONFLICT" },
    });
    expect(
      retryRunner.calls.some(
        (call) => call.tool === "git" && call.args[0] === "push",
      ),
    ).toBe(false);
  });

  it("resumes a failed push when the immutable remote identity and head still match", async () => {
    const cwd = await root();
    const target = path.join(cwd, "same-remote-resume");
    await invoke(
      cwd,
      ["server", "init", target, "--github", "octocat/resume", "--json"],
      defaultRunner({ pushFails: true, remoteId: "R_original" }),
    );
    const recoveryFile = path.join(target, ".syndroo", "recovery.json");
    const recoveryBefore = JSON.parse(
      await fs.readFile(recoveryFile, "utf8"),
    ) as { remoteId: string; head: string };
    const retryRunner = defaultRunner({
      repoExists: true,
      remoteUrl: "ssh://git@github.com/octocat/resume.git",
      remoteId: "R_original",
      remoteHead: null,
    });

    const retry = await invoke(
      cwd,
      ["server", "init", target, "--github", "octocat/resume", "--json"],
      retryRunner,
    );

    expect(retry.exit).toBe(0);
    expect(
      retryRunner.calls.filter(
        (call) => call.tool === "git" && call.args[0] === "push",
      ),
    ).toHaveLength(1);
    expect(
      JSON.parse(await fs.readFile(recoveryFile, "utf8")),
    ).toMatchObject({
      step: "complete",
      remoteId: recoveryBefore.remoteId,
      head: recoveryBefore.head,
    });
  });

  it("fails closed when created remote identity cannot be recorded", async () => {
    const cwd = await root();
    const target = path.join(cwd, "ambiguous-create");
    const runner = defaultRunner({
      viewFailsAfterCreate: true,
      pushFails: true,
    });

    const run = await invoke(
      cwd,
      ["server", "init", target, "--github", "octocat/ambiguous", "--json"],
      runner,
    );

    expect(run.exit).not.toBe(0);
    expect(envelope(run.stdout)).toMatchObject({
      operation: "server",
      ok: false,
      error: { code: "SERVER_GITHUB_RECOVERY_CONFLICT" },
    });
    expect(
      runner.calls.some(
        (call) => call.tool === "git" && call.args[0] === "push",
      ),
    ).toBe(false);
    await expect(
      fs.stat(path.join(target, ".syndroo", "recovery.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recognizes its own completed repository without overwriting it", async () => {
    const cwd = await root();
    const target = path.join(cwd, "repeat");
    await invoke(cwd, ["server", "init", target, "--json"], defaultRunner());
    const runner = defaultRunner();

    const run = await invoke(cwd, ["server", "init", target, "--json"], runner);

    expect(run.exit).toBe(0);
    expect(envelope(run.stdout)["result"]).toMatchObject({
      subcommand: "init",
      status: "unchanged",
    });
    expect(runner.calls).toEqual([]);
  });

  it("accepts normal application edits on a completed project", async () => {
    const cwd = await root();
    const target = path.join(cwd, "edited-complete");
    await invoke(cwd, ["server", "init", target, "--json"], defaultRunner());
    const configFile = path.join(target, "syndroo.config.jsonc");
    const postFile = path.join(target, "posts", "hello.json");
    const configText = (
      await fs.readFile(configFile, "utf8")
    ).replace(
      '"scope": "default"',
      '"scope": "default",\n  "publicOrigin": "https://deploy.example"',
    );
    const postText = '{\n  "text": "Edited after deployment"\n}\n';
    await fs.writeFile(configFile, configText);
    await fs.writeFile(postFile, postText);
    const runner = defaultRunner();

    const run = await invoke(
      cwd,
      ["server", "init", target, "--json"],
      runner,
    );

    expect(run.exit).toBe(0);
    expect(envelope(run.stdout)["result"]).toMatchObject({
      subcommand: "init",
      status: "unchanged",
    });
    expect(runner.calls).toEqual([]);
    expect(await fs.readFile(configFile, "utf8")).toBe(configText);
    expect(await fs.readFile(postFile, "utf8")).toBe(postText);
  });

  it("allows late GitHub attachment after normal application edits", async () => {
    const cwd = await root();
    const target = path.join(cwd, "edited-late-github");
    await invoke(cwd, ["server", "init", target, "--json"], defaultRunner());
    const configFile = path.join(target, "syndroo.config.jsonc");
    const postFile = path.join(target, "posts", "hello.json");
    const configText = (
      await fs.readFile(configFile, "utf8")
    ).replace(
      '"scope": "default"',
      '"scope": "production",\n  "publicOrigin": "https://deploy.example"',
    );
    const postText = '{\n  "text": "Late GitHub edit"\n}\n';
    await fs.writeFile(configFile, configText);
    await fs.writeFile(postFile, postText);

    const run = await invoke(
      cwd,
      ["server", "init", target, "--github", "octocat/edited", "--json"],
      defaultRunner(),
    );

    expect(run.exit).toBe(0);
    expect(envelope(run.stdout)["result"]).toMatchObject({
      subcommand: "init",
      status: "unchanged",
      github: {
        owner: "octocat",
        repo: "edited",
        visibility: "private",
        pushed: true,
      },
    });
    expect(await fs.readFile(configFile, "utf8")).toBe(configText);
    expect(await fs.readFile(postFile, "utf8")).toBe(postText);
  });

  it("still rejects a completed project with altered dependency pins", async () => {
    const cwd = await root();
    const target = path.join(cwd, "altered-pins");
    await invoke(cwd, ["server", "init", target, "--json"], defaultRunner());
    const packageFile = path.join(target, "package.json");
    const manifest = JSON.parse(await fs.readFile(packageFile, "utf8")) as {
      devDependencies: Record<string, string>;
    };
    manifest.devDependencies["wrangler"] = "4.131.0";
    await fs.writeFile(packageFile, `${JSON.stringify(manifest, null, 2)}\n`);

    const run = await invoke(
      cwd,
      ["server", "init", target, "--json"],
      defaultRunner(),
    );

    expect(run.exit).not.toBe(0);
    expect(envelope(run.stdout)).toMatchObject({
      operation: "server",
      ok: false,
      error: { code: "SERVER_PROJECT_CONFLICT" },
    });
  });

  it("creates a real local Git commit containing only generated files and signoff", async () => {
    const cwd = await root();
    const target = path.join(cwd, "real-git");
    const home = path.join(cwd, "home");
    await fs.mkdir(home);
    const gitEnv = {
      HOME: home,
      PATH: process.env["PATH"],
    };
    expect(
      spawnSync("git", ["config", "--global", "user.name", "Test User"], {
        cwd,
        env: gitEnv,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "--global", "user.email", "test@example.invalid"], {
        cwd,
        env: gitEnv,
      }).status,
    ).toBe(0);

    const real = createNodeProcessRunner(gitEnv, new AbortController().signal);
    const runner: ProcessRunner = {
      async run(request: ProcessRequest): Promise<ProcessResult> {
        if (request.tool === "npm" && request.args[0] === "install") {
          await fs.writeFile(
            path.join(request.cwd, "package-lock.json"),
            '{"lockfileVersion":3}\n',
            { mode: 0o600 },
          );
          return result();
        }
        return await real.run(request);
      },
    };

    const run = await invoke(cwd, ["server", "init", target, "--json"], runner);

    expect(run.exit).toBe(0);
    const message = spawnSync("git", ["log", "-1", "--format=%B"], {
      cwd: target,
      encoding: "utf8",
      env: gitEnv,
    });
    expect(message.status).toBe(0);
    expect(message.stdout).toContain("Signed-off-by: Test User <test@example.invalid>");
    const files = spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: target,
      encoding: "utf8",
      env: gitEnv,
    });
    expect(files.status).toBe(0);
    expect(
      files.stdout
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .sort(),
    ).toEqual([
      ".gitignore",
      "package-lock.json",
      "package.json",
      "posts/hello.json",
      "syndroo.config.jsonc",
      "wrangler.jsonc",
    ]);
  });

  it("finishes a committing phase when the exact signed initial commit already exists", async () => {
    const cwd = await root();
    const target = path.join(cwd, "committed-before-phase-record");
    const home = path.join(cwd, "home");
    await fs.mkdir(home);
    const gitEnv = {
      HOME: home,
      PATH: process.env["PATH"],
    };
    expect(
      spawnSync("git", ["config", "--global", "user.name", "Test User"], {
        cwd,
        env: gitEnv,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "--global", "user.email", "test@example.invalid"], {
        cwd,
        env: gitEnv,
      }).status,
    ).toBe(0);

    const real = createNodeProcessRunner(gitEnv, new AbortController().signal);
    const runner: ProcessRunner = {
      async run(request: ProcessRequest): Promise<ProcessResult> {
        if (request.tool === "npm" && request.args[0] === "install") {
          await fs.writeFile(
            path.join(request.cwd, "package-lock.json"),
            '{"lockfileVersion":3}\n',
            { mode: 0o600 },
          );
          return result();
        }
        return await real.run(request);
      },
    };

    const initialized = await invoke(
      cwd,
      ["server", "init", target, "--json"],
      runner,
    );
    expect(initialized.exit).toBe(0);
    const beforeHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: target,
      encoding: "utf8",
      env: gitEnv,
    });
    expect(beforeHead.status).toBe(0);
    const initFile = path.join(target, ".syndroo", "init.json");
    const record = JSON.parse(await fs.readFile(initFile, "utf8")) as {
      phase: string;
    };
    record.phase = "committing";
    await fs.writeFile(initFile, `${JSON.stringify(record, null, 2)}\n`);

    const resumed = await invoke(
      cwd,
      ["server", "init", target, "--json"],
      runner,
    );

    expect(resumed.exit).toBe(0);
    expect(envelope(resumed.stdout)["result"]).toMatchObject({
      subcommand: "init",
      status: "unchanged",
    });
    const afterHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: target,
      encoding: "utf8",
      env: gitEnv,
    });
    expect(afterHead.stdout).toBe(beforeHead.stdout);
    const count = spawnSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: target,
      encoding: "utf8",
      env: gitEnv,
    });
    expect(count.stdout.trim()).toBe("1");
    expect(JSON.parse(await fs.readFile(initFile, "utf8"))).toMatchObject({
      phase: "complete",
    });
  });

  it("fails closed when a committing-phase HEAD does not match", async () => {
    const cwd = await root();
    const target = path.join(cwd, "mismatched-committing-head");
    const { env, runner } = await realInitRunner(cwd);
    expect(
      (await invoke(cwd, ["server", "init", target, "--json"], runner)).exit,
    ).toBe(0);
    expect(
      spawnSync("git", ["commit", "--amend", "-m", "wrong initial commit"], {
        cwd: target,
        env,
      }).status,
    ).toBe(0);
    const initFile = path.join(target, ".syndroo", "init.json");
    const record = JSON.parse(await fs.readFile(initFile, "utf8")) as {
      phase: string;
    };
    record.phase = "committing";
    await fs.writeFile(initFile, `${JSON.stringify(record, null, 2)}\n`);

    const resumed = await invoke(
      cwd,
      ["server", "init", target, "--json"],
      runner,
    );

    expect(resumed.exit).not.toBe(0);
    expect(envelope(resumed.stdout)).toMatchObject({
      operation: "server",
      ok: false,
      error: { code: "SERVER_GIT_FAILED" },
    });
    expect(JSON.parse(await fs.readFile(initFile, "utf8"))).toMatchObject({
      phase: "committing",
    });
  });

  it("creates the initial commit when a committing phase has no HEAD", async () => {
    const cwd = await root();
    const target = path.join(cwd, "committing-without-head");
    const { env, runner } = await realInitRunner(cwd);
    expect(
      (await invoke(cwd, ["server", "init", target, "--json"], runner)).exit,
    ).toBe(0);
    expect(
      spawnSync("git", ["update-ref", "-d", "refs/heads/main"], {
        cwd: target,
        env,
      }).status,
    ).toBe(0);
    const initFile = path.join(target, ".syndroo", "init.json");
    const record = JSON.parse(await fs.readFile(initFile, "utf8")) as {
      phase: string;
    };
    record.phase = "committing";
    await fs.writeFile(initFile, `${JSON.stringify(record, null, 2)}\n`);

    const resumed = await invoke(
      cwd,
      ["server", "init", target, "--json"],
      runner,
    );

    expect(resumed.exit).toBe(0);
    const count = spawnSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: target,
      encoding: "utf8",
      env,
    });
    expect(count.stdout.trim()).toBe("1");
    expect(JSON.parse(await fs.readFile(initFile, "utf8"))).toMatchObject({
      phase: "complete",
    });
  });

  it("verifies a completed GitHub push using SSH remotes and the recorded commit", async () => {
    const cwd = await root();
    const target = path.join(cwd, "github-complete");
    await invoke(
      cwd,
      ["server", "init", target, "--github", "octocat/verified", "--json"],
      defaultRunner(),
    );
    const recovery = JSON.parse(
      await fs.readFile(path.join(target, ".syndroo", "recovery.json"), "utf8"),
    ) as { remoteId: string; head: string };

    expect(recovery.remoteId).toBe("R_syndroo_fixture");
    expect(recovery.head).toBe("a".repeat(40));
    expect(
      matchingGithubRemote("git@github.com:octocat/verified.git", {
        owner: "octocat",
        repo: "verified",
        visibility: "private",
      }),
    ).toBe(true);

    const rerun = await invoke(
      cwd,
      ["server", "init", target, "--github", "octocat/verified", "--json"],
      defaultRunner({
        repoExists: true,
        remoteUrl: "git@github.com:octocat/verified.git",
      }),
    );

    expect(rerun.exit).toBe(0);
    expect(envelope(rerun.stdout)["result"]).toMatchObject({
      status: "unchanged",
      github: { pushed: true },
    });
  });

  it("stops when the recorded GitHub branch head no longer matches", async () => {
    const cwd = await root();
    const target = path.join(cwd, "github-mismatch");
    await invoke(
      cwd,
      ["server", "init", target, "--github", "octocat/mismatch", "--json"],
      defaultRunner(),
    );

    const rerun = await invoke(
      cwd,
      ["server", "init", target, "--github", "octocat/mismatch", "--json"],
      defaultRunner({
        repoExists: true,
        remoteUrl: "ssh://git@github.com/octocat/mismatch.git",
        remoteHead: "b".repeat(40),
      }),
    );

    expect(rerun.exit).not.toBe(0);
    expect(envelope(rerun.stdout)).toMatchObject({
      operation: "server",
      ok: false,
      error: { code: "SERVER_GITHUB_RECOVERY_CONFLICT" },
    });
  });
});

async function deployFailure(failure: {
  readonly code: string;
  readonly details: Record<string, unknown>;
}): Promise<{ exit: number; stdout: string; stderr: string }> {
  const cwd = await root();
  const { project, stateRoot } = await writeThreadsProject(cwd);
  const streams = capture(project);
  const exit = await run(
    ["server", "--project", project, "deploy", "--yes", "--json"],
    streams.io,
    {},
    {
      stateRoot,
      runDeploy: async () => {
        throw new CliError("deploy", {
          code: failure.code,
          exitCode: EXIT_CODE.USAGE,
          details: failure.details,
        });
      },
    },
  );
  return { exit, stdout: streams.stdout(), stderr: streams.stderr() };
}

describe("server account guidance", () => {
  it("names the project-local whoami check and account-versus-member distinction", async () => {
    const run = await deployFailure({
      code: "SERVER_DEPLOY_ACCOUNT_SELECTION_REQUIRED",
      details: { nextAction: "SELECT_CLOUDFLARE_ACCOUNT" },
    });

    expect(run.exit).toBe(2);
    expect(envelope(run.stdout)).toMatchObject({
      operation: "server",
      ok: false,
      error: {
        code: "SERVER_DEPLOY_ACCOUNT_SELECTION_REQUIRED",
        details: { subcommand: "deploy", nextAction: "SELECT_CLOUDFLARE_ACCOUNT" },
      },
    });
    expect(envelope(run.stdout)["error"]["details"]).not.toHaveProperty("account");
    expect(run.stderr).toContain("./node_modules/.bin/wrangler whoami");
    expect(run.stderr).toContain("--account <ACCOUNT_ID>");
    expect(run.stderr).toContain("not a member ID");
    expect(run.stderr).toContain(
      "retry the login only if that check reports the session itself failed",
    );
  });

  it("keeps raw account output out of the diagnostic", async () => {
    const run = await deployFailure({
      code: "SERVER_DEPLOY_ACCOUNT_SELECTION_REQUIRED",
      details: {
        nextAction: "SELECT_CLOUDFLARE_ACCOUNT",
        account: {
          access: "account_inaccessible",
          idFormMismatch: false,
          available: [{ id: "RAW-ACCOUNT-ID-CANARY", name: "RAW-LABEL-CANARY" }],
          availableCount: 1,
        },
      },
    });

    expect(run.stdout).not.toContain("RAW-ACCOUNT-ID-CANARY");
    expect(run.stderr).not.toContain("RAW-ACCOUNT-ID-CANARY");
    expect(run.stdout).not.toContain("RAW-LABEL-CANARY");
    expect(run.stderr).not.toContain("RAW-LABEL-CANARY");
  });
});

describe("server deploy evidence diagnostics", () => {
  it("uses placeholders and the canonical procedure when recovery evidence is required", async () => {
    const run = await deployFailure({
      code: "SERVER_DEPLOY_RECOVERY_REQUIRED",
      details: {
        nextAction: "PROVIDE_DEPLOY_RECOVERY",
        failedStep: "deploy-pending",
        evidence: {
          stage: "verification",
          receipt: "missing",
          receiptRetained: false,
          expectedWorkerTag: "unverified-input-canary",
          expectedVersionId: "unverified-input-canary",
        },
      },
    });

    expect(run.exit).toBe(2);
    expect(envelope(run.stdout)).toMatchObject({
      operation: "server",
      ok: false,
      error: {
        code: "SERVER_DEPLOY_RECOVERY_REQUIRED",
        details: {
          subcommand: "deploy",
          evidence: { stage: "verification", receipt: "missing" },
        },
      },
    });
    expect(run.stderr).toContain(
      '{"workerTag":"<VERIFIED_WORKER_TAG>","versionId":"<VERIFIED_VERSION_ID>"}',
    );
    expect(run.stderr).toContain("references/server.md");
    expect(run.stderr).toContain("never adopt evidence from the Worker name");
    // Unverified --recover input is not echoed back as if it were evidence.
    expect(run.stderr).not.toContain("unverified-input-canary");
    expect(run.stdout).not.toContain("unverified-input-canary");
  });

  it("prescribes reconciliation, not recovery, for a complete receipt", async () => {
    const run = await deployFailure({
      code: "SERVER_DEPLOY_AMBIGUOUS",
      details: {
        nextAction: "RERUN_DEPLOY_TO_RECONCILE",
        failedStep: "deploy-pending",
        receiptRetained: true,
        evidence: {
          stage: "deploy",
          processStatus: "timed_out",
          receipt: "complete",
          receiptRetained: true,
        },
      },
    });

    expect(run.stderr).toContain("outcome is unknown");
    expect(run.stderr).toContain("timed out");
    expect(run.stderr).toContain("rerun the same project to reconcile");
    expect(run.stderr).not.toContain("--recover");
    expect(run.stderr).not.toContain("deploys a new version");
  });

  it("explains that a receipt-less rerun may then require explicit evidence", async () => {
    const run = await deployFailure({
      code: "SERVER_DEPLOY_AMBIGUOUS",
      details: {
        nextAction: "RERUN_DEPLOY_TO_RECONCILE",
        evidence: {
          stage: "deploy",
          processStatus: "timed_out",
          receipt: "missing",
          receiptRetained: false,
        },
      },
    });

    expect(run.stderr).toContain("holds no usable record");
    expect(run.stderr).toContain("that rerun asks for explicit recovery evidence");
    expect(run.stderr).not.toContain("--recover <path|->");
  });

  it("tells the caller to retry the start when the deploy never spawned", async () => {
    const run = await deployFailure({
      code: "SERVER_DEPLOY_FAILED",
      details: {
        nextAction: "RETRY_DEPLOY",
        evidence: { stage: "deploy", processStatus: "spawn_error" },
      },
    });

    expect(run.stderr).toContain("could not be started");
    expect(run.stderr).toContain("fix the local install and retry");
    expect(run.stderr).not.toContain("--recover");
  });

  it("still explains recovery when the failure carries no evidence", async () => {
    const run = await deployFailure({
      code: "SERVER_DEPLOY_RECEIPT_INVALID",
      details: { nextAction: "PROVIDE_DEPLOY_RECOVERY", failedStep: "deploy-pending" },
    });

    expect(run.stderr).toContain("is not valid machine output");
    expect(run.stderr).toContain(
      '{"workerTag":"<VERIFIED_WORKER_TAG>","versionId":"<VERIFIED_VERSION_ID>"}',
    );
    expect(run.stderr).toContain("references/server.md");
    expect(envelope(run.stdout)["error"]["details"]).not.toHaveProperty("evidence");
  });

  it("keeps retry guidance generic without spawn-failure evidence", async () => {
    const run = await deployFailure({
      code: "SERVER_DEPLOY_FAILED",
      details: { nextAction: "RETRY_DEPLOY" },
    });

    expect(run.stderr).toContain("retry the deployment after checking the reported failure");
    expect(run.stderr).not.toContain("did not start");
  });

  it("allowlists evidence and never prints hostile raw values", async () => {
    const run = await deployFailure({
      code: "SERVER_DEPLOY_AMBIGUOUS",
      details: {
        nextAction: "RERUN_DEPLOY_TO_RECONCILE",
        evidence: {
          stage: "deploy",
          receipt: "RAW-EVIDENCE-CANARY; rm -rf /",
          processStatus: "RAW-STATUS-CANARY",
          processExitCode: "RAW-EXIT-CANARY",
        },
      },
    });

    expect(run.stderr).not.toContain("RAW-EVIDENCE-CANARY");
    expect(run.stderr).not.toContain("RAW-STATUS-CANARY");
    expect(run.stderr).not.toContain("RAW-EXIT-CANARY");
    expect(run.stderr).not.toContain("rm -rf");
    expect(envelope(run.stdout)["error"]["details"].evidence).toEqual({
      stage: "deploy",
    });
  });
});

describe("server command boundary", () => {
  it("uses the current directory for nested commands when --project is omitted", async () => {
    const cwd = await root();
    const { project, stateRoot } = await writeThreadsProject(cwd);

    // The documented form: run inside an initialized project without --project.
    const run = await invoke(
      project,
      ["server", "connect", "threads", "--app-id", "123456789", "--json"],
      defaultRunner(),
      stateRoot,
    );

    expect(run.exit).toBe(2);
    expect(envelope(run.stdout)).toMatchObject({
      protocolVersion: 1,
      operation: "server",
      ok: false,
      error: {
        code: "SERVER_THREADS_SECRET_REQUIRED",
        details: {
          subcommand: "connect",
          nextAction: "PROVIDE_THREADS_APP_SECRET",
        },
      },
    });
  });

  it("still resolves an explicit project directory", async () => {
    const cwd = await root();
    const { project, stateRoot } = await writeThreadsProject(cwd);

    const run = await invoke(
      cwd,
      [
        "server", "--project", project, "connect", "threads",
        "--app-id", "123456789", "--json",
      ],
      defaultRunner(),
      stateRoot,
    );

    expect(run.exit).toBe(2);
    expect(envelope(run.stdout)).toMatchObject({
      error: { code: "SERVER_THREADS_SECRET_REQUIRED" },
    });
  });

  it("emits exactly one server envelope for an invalid server option", async () => {
    const cwd = await root();
    const run = await invoke(cwd, ["server", "frobnicate", "--json"], defaultRunner());

    expect(run.exit).toBe(2);
    expect(envelope(run.stdout)).toMatchObject({
      protocolVersion: 1,
      operation: "server",
      ok: false,
      error: { code: "USAGE", details: { subcommand: "server" } },
    });
    expect(run.stderr).not.toContain("frobnicate");
  });

  it("emits exactly one usage envelope for a bare server command", async () => {
    const cwd = await root();
    const run = await invoke(cwd, ["server", "--json"], defaultRunner());

    expect(run.exit).toBe(2);
    expect(envelope(run.stdout)).toMatchObject({
      operation: "server",
      ok: false,
      error: { code: "USAGE", details: { subcommand: "server" } },
    });
  });

  it("emits exactly one server envelope for duplicated JSON output flags", async () => {
    const cwd = await root();
    const run = await invoke(
      cwd,
      ["server", "init", "--json", "--json"],
      defaultRunner(),
    );

    expect(run.exit).toBe(2);
    expect(envelope(run.stdout)).toMatchObject({
      operation: "server",
      ok: false,
      error: { code: "USAGE", details: { subcommand: "init" } },
    });
  });

  it("does not load or consult the local publishing runtime", async () => {
    const cwd = await root();
    const localConfig = path.join(cwd, "config", "syndroo", "config.json");
    await fs.mkdir(path.dirname(localConfig), { recursive: true });
    await fs.writeFile(localConfig, '{"version":1,"providers":');
    const target = path.join(cwd, "deployment");
    await invoke(cwd, ["server", "init", target, "--json"], defaultRunner());

    const run = await invoke(
      cwd,
      ["server", "--project", target, "doctor", "--json"],
      defaultRunner(),
    );

    expect(run.exit).toBe(0);
    expect(envelope(run.stdout)["result"]).toMatchObject({
      subcommand: "doctor",
      status: "ok",
    });
  });

  it("doctor is read-only and reports local tool checks", async () => {
    const cwd = await root();
    const target = path.join(cwd, "deployment");
    await invoke(cwd, ["server", "init", target, "--json"], defaultRunner());
    const before = await fs.readdir(target, { recursive: true });
    const runner = defaultRunner();

    const run = await invoke(
      cwd,
      ["server", "--project", target, "doctor", "--json"],
      runner,
    );

    expect(run.exit).toBe(0);
    expect(envelope(run.stdout)["result"]).toMatchObject({
      subcommand: "doctor",
      status: "ok",
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "config", status: "ok" }),
        expect.objectContaining({ name: "git", status: "ok" }),
        expect.objectContaining({ name: "npm", status: "ok" }),
      ]),
    });
    expect(await fs.readdir(target, { recursive: true })).toEqual(before);
    expect(runner.calls.every((call) => !call.args.includes("install"))).toBe(true);
  });
});
