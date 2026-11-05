import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { keyBytes } from "../../cloudflare/src/crypto.js";
import { loadServerConfig } from "../src/server/config.js";
import {
  deploymentCredentialFileName,
  deploymentReceiptFileName,
  deploymentStateFileName,
  validateDeploymentCredentials,
} from "../src/server/deployment-state.js";
import {
  runServerDeploy,
  type ServerDeployDependencies,
} from "../src/server/deploy.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../src/server/process.js";

const PROJECT_ID = "f0c4f706-25a4-4df7-a84c-3b247c64abfe";

// The version this package actually publishes, read from its own manifest so a
// stale literal cannot pin the fixture to a previous release. Read independently
// of the implementation under test, so a wrong dependency version still fails.
const CLI_VERSION = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

const SECRETS = {
  API_BEARER: "API-BEARER-SENTINEL.0123456789abcdef",
  SECRET_KEY: "ab".repeat(32),
  RUNTIME_KEY: "cd".repeat(32),
};
const ACCESS_TOKEN = "CLOUDFLARE-ACCESS-TOKEN-SENTINEL";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "syndroo-server-deploy-")),
  );
  roots.push(root);
  return root;
}

type Project = {
  readonly root: string;
  readonly stateRoot: string;
};

async function project(options: {
  readonly publicOrigin?: string;
  readonly wranglerName?: string;
} = {}): Promise<Project> {
  const base = await temporaryRoot();
  const root = path.join(base, "project");
  await fs.mkdir(root, { mode: 0o700 });
  const wranglerName = options.wranglerName ?? "demo-worker";
  await fs.mkdir(path.join(root, "node_modules", ".bin"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.mkdir(path.join(root, "node_modules", "wrangler"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "syndroo-deployment",
        private: true,
        dependencies: {
          "@syndroo/cli": CLI_VERSION,
          "@syndroo/cloudflare": CLI_VERSION,
        },
        devDependencies: { wrangler: "4.132.0" },
        syndroo: { generated: true, server: 1 },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(root, ".gitignore"),
    "node_modules/\nwrangler.effective.jsonc\n.syndroo/\n",
  );
  await fs.writeFile(
    path.join(root, "node_modules", "wrangler", "package.json"),
    '{"name":"wrangler","version":"4.132.0"}\n',
  );
  await fs.writeFile(
    path.join(root, "node_modules", ".bin", "wrangler"),
    "#!/usr/bin/env node\n",
    { mode: 0o700 },
  );
  await fs.writeFile(
    path.join(root, "syndroo.config.jsonc"),
    `{
  // Deployment inputs are separate from key material.
  "version": 1,
  "projectId": "${PROJECT_ID}",
  "scope": "test-scope"${options.publicOrigin === undefined ? "" : `,\n  "publicOrigin": "${options.publicOrigin}"`}
}
`,
  );
  await fs.writeFile(
    path.join(root, "wrangler.jsonc"),
    `{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "${wranglerName}",
  "main": "./node_modules/@syndroo/cloudflare/dist/worker.js",
  "compatibility_date": "2026-09-02",
  "compatibility_flags": ["global_fetch_strictly_public"],
  "vars": {
    "QUEUE_NAME": "${wranglerName}-work",
    "DLQ_NAME": "${wranglerName}-dead",
    "PUBLIC_FETCH_STRICT": "enabled"
  },
  "secrets": {
    "required": ["API_BEARER", "SECRET_KEY", "RUNTIME_KEY"]
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "${wranglerName}" }
  ],
  "queues": {
    "producers": [
      { "binding": "WORK_QUEUE", "queue": "${wranglerName}-work" }
    ],
    "consumers": [
      { "queue": "${wranglerName}-work", "max_retries": 2 },
      { "queue": "${wranglerName}-dead", "max_retries": 0 }
    ]
  }
}
`,
  );
  return {
    root,
    stateRoot: path.join(base, "state"),
  };
}

async function editWrangler(
  testProject: Project,
  edit: (config: Record<string, any>) => void,
): Promise<void> {
  const file = path.join(testProject.root, "wrangler.jsonc");
  const config = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, any>;
  edit(config);
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

type CloudState = {
  worker: { readonly tag: string } | null;
  activeVersionId: string | null;
  d1: Array<{ readonly id: string; readonly name: string }>;
  queues: Array<{ readonly id: string; readonly name: string }>;
  readonly subdomain: string | null;
};

function cloud(): CloudState {
  return {
    worker: null,
    activeVersionId: null,
    d1: [],
    queues: [],
    subdomain: "account-subdomain",
  };
}

function apiEnvelope(result: unknown): Response {
  return Response.json({
    success: true,
    result,
    errors: [],
    messages: [],
  });
}

function apiFailure(code: number): Response {
  return Response.json({
    success: false,
    result: null,
    errors: [{ code, message: "mock API failure" }],
    messages: [],
  });
}

type FetchBehavior = {
  readonly workerPresent?: boolean;
  readonly workerTag?: string;
  readonly d1Present?: boolean;
  readonly queuePresent?: boolean;
  readonly d1CreateLosesResponse?: boolean;
  readonly queueCreateLosesResponse?: boolean;
  readonly subdomainMissing?: boolean;
};

function cloudFetch(
  state: CloudState,
  behavior: FetchBehavior = {},
): typeof fetch {
  if (behavior.workerPresent === true) {
    state.worker = { tag: behavior.workerTag ?? "worker-tag" };
  }
  if (behavior.d1Present === true) {
    state.d1.push({ id: "d1-existing", name: "demo-worker" });
  }
  if (behavior.queuePresent === true) {
    state.queues.push({ id: "queue-existing", name: "demo-worker-work" });
  }

  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe("https://api.cloudflare.com");
    expect(request.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);

    if (
      request.method === "GET" &&
      url.pathname === "/client/v4/accounts/account-id/workers/services/demo-worker"
    ) {
      return state.worker === null ? apiFailure(10007) : apiEnvelope({
        default_environment: { script: { tag: state.worker.tag } },
      });
    }
    if (
      request.method === "GET" &&
      url.pathname === "/client/v4/accounts/account-id/d1/database"
    ) {
      return apiEnvelope(
        state.d1.map((database) => ({
          uuid: database.id,
          name: database.name,
        })),
      );
    }
    if (
      request.method === "GET" &&
      url.pathname.startsWith("/client/v4/accounts/account-id/d1/database/")
    ) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const database = state.d1.find((entry) => entry.id === id);
      return database === undefined
        ? apiFailure(10007)
        : apiEnvelope({ uuid: database.id, name: database.name });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/client/v4/accounts/account-id/d1/database"
    ) {
      const body = await request.json() as { name: string };
      const created = { id: "d1-created", name: body.name };
      state.d1.push(created);
      if (behavior.d1CreateLosesResponse === true) {
        throw new TypeError("mock connection reset");
      }
      return apiEnvelope({ uuid: created.id, name: created.name });
    }
    if (
      request.method === "GET" &&
      url.pathname === "/client/v4/accounts/account-id/queues"
    ) {
      return apiEnvelope(
        state.queues.map((queue) => ({
          queue_id: queue.id,
          queue_name: queue.name,
        })),
      );
    }
    if (
      request.method === "GET" &&
      url.pathname.startsWith("/client/v4/accounts/account-id/queues/")
    ) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const queue = state.queues.find((entry) => entry.id === id);
      return queue === undefined
        ? apiFailure(10007)
        : apiEnvelope({ queue_id: queue.id, queue_name: queue.name });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/client/v4/accounts/account-id/queues"
    ) {
      const body = await request.json() as { queue_name: string };
      const created = { id: `queue-${state.queues.length + 1}`, name: body.queue_name };
      state.queues.push(created);
      if (behavior.queueCreateLosesResponse === true) {
        throw new TypeError("mock connection reset");
      }
      return apiEnvelope({ queue_id: created.id, queue_name: created.name });
    }
    if (
      request.method === "GET" &&
      url.pathname === "/client/v4/accounts/account-id/workers/subdomain"
    ) {
      return behavior.subdomainMissing === true || state.subdomain === null
        ? apiFailure(10007)
        : apiEnvelope({ subdomain: state.subdomain });
    }
    return apiFailure(9999);
  };
}

type RunnerBehavior = {
  readonly accounts?: readonly { readonly id: string; readonly name: string }[];
  readonly existingSecrets?: readonly string[];
  readonly deployStatus?: ProcessResult["status"];
  readonly deployExitCode?: number | null;
  readonly deployTarget?: string;
  readonly deployWorkerTag?: string;
  readonly deployVersionId?: string;
  readonly breakConfigAfterDeploy?: boolean;
  readonly timeoutCreatesWorker?: boolean;
  readonly deployWritesReceipt?: boolean;
  readonly breakStateAfterDeploy?: boolean;
  /** Replace the machine receipt with explicit text (for unreadable output). */
  readonly deployReceiptText?: string;
  /** Replace the machine receipt with raw bytes (for invalid UTF-8). */
  readonly deployReceiptBytes?: Uint8Array;
  /** Remove the receipt file entirely after the subprocess returns. */
  readonly deployDeletesReceipt?: boolean;
  /** Replace the receipt file with a directory so the private read fails. */
  readonly deployReceiptBecomesDirectory?: boolean;
};

class DeployRunner implements ProcessRunner {
  readonly calls: ProcessRequest[] = [];
  readonly secretFiles: Array<{
    readonly path: string;
    readonly mode: number;
    readonly text: string;
  }> = [];
  interruptedStateText: string | undefined;

  constructor(
    private readonly cloud: CloudState,
    private readonly behavior: RunnerBehavior = {},
  ) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.calls.push(request);
    if (request.tool !== "wrangler") {
      return { status: "spawn_error", exitCode: null, stdout: "", stderr: "" };
    }
    if (request.args[0] === "--version") {
      return { status: "exited", exitCode: 0, stdout: "4.132.0\n", stderr: "" };
    }
    if (request.args[0] === "whoami") {
      return {
        status: "exited",
        exitCode: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authType: "OAuth Token",
          accounts: this.behavior.accounts ?? [
            { id: "account-id", name: "Test Account" },
          ],
        }),
        stderr: "",
      };
    }
    if (request.args[0] === "auth" && request.args[1] === "token") {
      return {
        status: "exited",
        exitCode: 0,
        stdout: JSON.stringify({ type: "oauth", token: ACCESS_TOKEN }),
        stderr: "",
      };
    }
    if (request.args[0] === "secret" && request.args[1] === "list") {
      return {
        status: "exited",
        exitCode: 0,
        stdout: JSON.stringify(
          (this.behavior.existingSecrets ?? ["API_BEARER", "SECRET_KEY", "RUNTIME_KEY"])
            .map((name) => ({ name })),
        ),
        stderr: "",
      };
    }
    if (request.args[0] === "deployments" && request.args[1] === "list") {
      if (this.cloud.worker === null || this.cloud.activeVersionId === null) {
        return { status: "exited", exitCode: 1, stdout: "[]", stderr: "" };
      }
      return {
        status: "exited",
        exitCode: 0,
        stdout: JSON.stringify([{
          id: "deployment-latest",
          created_on: "2026-11-02T00:00:00.000Z",
          versions: [{ version_id: this.cloud.activeVersionId, percentage: 100 }],
        }]),
        stderr: "",
      };
    }
    if (request.args[0] === "deploy") {
      const outputPath = request.environment?.["WRANGLER_OUTPUT_FILE_PATH"];
      const secretsArgument = request.args.indexOf("--secrets-file");
      const secretsFile = secretsArgument >= 0 ? request.args[secretsArgument + 1] : undefined;
      if (secretsFile !== undefined) {
        const stat = await fs.stat(secretsFile);
        this.secretFiles.push({
          path: secretsFile,
          mode: stat.mode & 0o777,
          text: await fs.readFile(secretsFile, "utf8"),
        });
      }

      const status = this.behavior.deployStatus ?? "exited";
      const exitCode = this.behavior.deployExitCode ?? 0;
      const successful = status === "exited" && exitCode === 0;
      const writesReceipt = successful || this.behavior.deployWritesReceipt === true;
      const workerTag = writesReceipt
        ? (this.behavior.deployWorkerTag ?? "worker-tag-deployed")
        : "worker-tag-maybe-created";
      const versionId = writesReceipt
        ? (this.behavior.deployVersionId ?? "version-deployed")
        : "version-maybe-created";
      if (
        status === "timed_out" &&
        this.behavior.timeoutCreatesWorker !== false
      ) {
        this.cloud.worker = { tag: workerTag };
        this.cloud.activeVersionId = versionId;
      }
      if (status === "exited" && exitCode !== 0 && writesReceipt) {
        this.cloud.worker = { tag: workerTag };
        this.cloud.activeVersionId = versionId;
      }
      if (successful || writesReceipt) {
        this.cloud.worker = { tag: workerTag };
        this.cloud.activeVersionId = versionId;
        if (outputPath !== undefined && writesReceipt) {
          await fs.writeFile(
            outputPath,
            this.behavior.deployReceiptBytes ??
              this.behavior.deployReceiptText ??
              `${JSON.stringify({
                type: "deploy",
                version: 1,
                worker_name: "demo-worker",
                worker_tag: workerTag,
                version_id: versionId,
                targets: [
                  this.behavior.deployTarget ??
                    "demo-worker.account-subdomain.workers.dev",
                ],
                wrangler_environment: undefined,
              })}\n`,
            { mode: 0o600 },
          );
        }
        if (this.behavior.breakConfigAfterDeploy === true) {
          const configFile = path.join(request.cwd, "syndroo.config.jsonc");
          await fs.rm(configFile);
          await fs.mkdir(configFile, { mode: 0o700 });
        }
        if (
          this.behavior.breakStateAfterDeploy === true &&
          outputPath !== undefined
        ) {
          const stateFile = path.join(
            path.dirname(outputPath),
            deploymentStateFileName(PROJECT_ID),
          );
          this.interruptedStateText = await fs.readFile(stateFile, "utf8");
          await fs.rm(stateFile);
          await fs.mkdir(stateFile, { mode: 0o700 });
        }
      }
      if (
        outputPath !== undefined &&
        this.behavior.deployDeletesReceipt === true
      ) {
        await fs.rm(outputPath, { force: true });
      }
      if (
        outputPath !== undefined &&
        this.behavior.deployReceiptBecomesDirectory === true
      ) {
        await fs.rm(outputPath, { force: true });
        await fs.mkdir(outputPath, { mode: 0o700 });
      }
      return {
        status,
        exitCode,
        stdout: "uploaded safely\n",
        stderr: exitCode === 0 ? "" : "deploy failed CLOUDFLARE-ACCESS-TOKEN-SENTINEL",
      };
    }
    return { status: "exited", exitCode: 1, stdout: "", stderr: "" };
  }
}

function dependencies(
  testProject: Project,
  runner: ProcessRunner,
  fetcher: typeof fetch,
): ServerDeployDependencies {
  return {
    cwd: testProject.root,
    runner,
    env: {
      HOME: path.join(testProject.root, "home"),
      XDG_STATE_HOME: path.join(testProject.root, "xdg-state"),
    },
    fetch: fetcher,
    stateRoot: testProject.stateRoot,
  };
}

async function deploy(
  testProject: Project,
  runner: ProcessRunner,
  fetcher: typeof fetch,
  overrides: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof runServerDeploy>>> {
  return await runServerDeploy(dependencies(testProject, runner, fetcher), {
    projectDirectory: testProject.root,
    account: "account-id",
    authorized: true,
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("server deploy", () => {
  it("creates missing resources, deploys, and preserves credentials on rerun", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote);

    const first = await deploy(
      testProject,
      runner,
      cloudFetch(remote),
    );
    const credentialFile = path.join(
      testProject.stateRoot,
      deploymentCredentialFileName(PROJECT_ID),
    );
    const originalCredentials = await fs.readFile(credentialFile, "utf8");

    const secondRunner = new DeployRunner(remote, {
      existingSecrets: ["API_BEARER"],
    });
    const second = await deploy(
      testProject,
      secondRunner,
      cloudFetch(remote),
    );
    const afterCredentials = await fs.readFile(credentialFile, "utf8");
    const generated = (JSON.parse(originalCredentials) as {
      credentials: typeof SECRETS;
    }).credentials;
    const uploaded = JSON.parse(
      secondRunner.secretFiles.at(-1)?.text ?? "{}",
    ) as Partial<typeof SECRETS>;
    const config = await loadServerConfig(testProject.root);

    expect(first).toMatchObject({
      subcommand: "deploy",
      status: "deployed",
      accountId: "account-id",
      workerName: "demo-worker",
      origin: "https://demo-worker.account-subdomain.workers.dev",
    });
    expect(second.status).toBe("deployed");
    expect(afterCredentials).toBe(originalCredentials);
    expect(originalCredentials).not.toContain("SENTINEL");
    expect(keyBytes(generated.SECRET_KEY)).toHaveLength(32);
    expect(keyBytes(generated.RUNTIME_KEY)).toHaveLength(32);
    expect(generated.API_BEARER).toMatch(/^[A-Za-z0-9._~+/-]{32,1024}$/);
    expect(uploaded).toMatchObject({
      SECRET_KEY: generated.SECRET_KEY,
      RUNTIME_KEY: generated.RUNTIME_KEY,
    });
    expect(remote.d1).toEqual([{ id: "d1-created", name: "demo-worker" }]);
    expect(remote.queues).toHaveLength(2);
    expect(config.config.publicOrigin).toBe(
      "https://demo-worker.account-subdomain.workers.dev",
    );
    expect((await fs.stat(credentialFile)).mode & 0o777).toBe(0o600);
    expect(path.relative(testProject.root, credentialFile).startsWith("..")).toBe(
      true,
    );
    expect(
      (await fs.stat(path.join(testProject.root, "wrangler.effective.jsonc")))
        .mode & 0o777,
    ).toBe(0o600);
  });

  it("refuses a foreign existing Worker when ownership is unproven", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote);

    await expect(
      deploy(
        testProject,
        runner,
        cloudFetch(remote, { workerPresent: true }),
      ),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_OWNERSHIP_UNVERIFIED" });
    expect(runner.calls.some((call) => call.args[0] === "deploy")).toBe(false);
  });

  it("does not adopt a same-name D1 or queue after an ambiguous create", async () => {
    const d1Project = await project();
    const d1Remote = cloud();
    const d1Runner = new DeployRunner(d1Remote);
    await expect(
      deploy(
        d1Project,
        d1Runner,
        cloudFetch(d1Remote, { d1CreateLosesResponse: true }),
        { credentials: SECRETS },
      ),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_AMBIGUOUS" });

    await expect(
      deploy(d1Project, new DeployRunner(d1Remote), cloudFetch(d1Remote)),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_OWNERSHIP_UNVERIFIED" });

    const queueProject = await project();
    const queueRemote = cloud();
    const queueRunner = new DeployRunner(queueRemote);
    const error = await (
      deploy(
        queueProject,
        queueRunner,
        cloudFetch(queueRemote, { queueCreateLosesResponse: true }),
        { credentials: SECRETS },
      ).catch((caught: unknown) => caught)
    );
    expect(error).toMatchObject({
      code: "SERVER_DEPLOY_AMBIGUOUS",
      details: {
        failedStep: "planned",
        confirmedResources: {
          d1: { name: "demo-worker", id: "d1-created" },
        },
      },
    });
  });

  it("keeps pending deploy state when a successful-looking deploy output is unconfirmed", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote, {
      deployStatus: "timed_out",
      deployExitCode: null,
    });

    await expect(
      deploy(testProject, runner, cloudFetch(remote), { credentials: SECRETS }),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_AMBIGUOUS" });

    const state = JSON.parse(
      await fs.readFile(
        path.join(testProject.stateRoot, deploymentStateFileName(PROJECT_ID)),
        "utf8",
      ),
    ) as { step: string; origin?: string };
    expect(state.step).toBe("deploy-pending");
    expect(state.origin).toBeUndefined();
    expect(
      (await loadServerConfig(testProject.root)).config.publicOrigin,
    ).toBeUndefined();
    await expect(
      deploy(testProject, new DeployRunner(remote), cloudFetch(remote)),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_RECOVERY_REQUIRED" });
  });

  it("requires imported credentials for an existing Worker and never rotates them", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote);
    await deploy(testProject, runner, cloudFetch(remote), {
      credentials: SECRETS,
    });
    await fs.rm(
      path.join(
        testProject.stateRoot,
        deploymentCredentialFileName(PROJECT_ID),
      ),
    );
    const callsBefore = runner.calls.length;

    await expect(
      deploy(testProject, runner, cloudFetch(remote)),
    ).rejects.toMatchObject({
      code: "SERVER_DEPLOY_CREDENTIAL_RECOVERY_REQUIRED",
    });
    expect(runner.calls.slice(callsBefore).some((call) => call.args[0] === "deploy")).toBe(
      false,
    );

    await expect(
      deploy(testProject, runner, cloudFetch(remote), {
        readCredential: async () => "invalid-imported-key",
      }),
    ).rejects.toMatchObject({
      code: "SERVER_DEPLOY_CREDENTIAL_RECOVERY_REQUIRED",
    });
    expect(
      runner.calls
        .slice(callsBefore)
        .some((call) => call.args[0] === "deploy"),
    ).toBe(false);

    const recovered = await deploy(testProject, runner, cloudFetch(remote), {
      readCredential: async (name: keyof typeof SECRETS) => SECRETS[name],
    });
    expect(recovered.status).toBe("deployed");
    expect(
      await fs.readFile(
        path.join(
          testProject.stateRoot,
          deploymentCredentialFileName(PROJECT_ID),
        ),
        "utf8",
      ),
    ).toContain(SECRETS.SECRET_KEY);
  });

  it("rejects imported credentials outside the Worker contract before any mutation", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote);

    await expect(
      deploy(testProject, runner, cloudFetch(remote), {
        credentials: {
          ...SECRETS,
          SECRET_KEY: "not-a-worker-key",
        },
      }),
    ).rejects.toMatchObject({
      code: "SERVER_DEPLOY_CREDENTIAL_RECOVERY_REQUIRED",
    });
    expect(remote.d1).toEqual([]);
    expect(remote.queues).toEqual([]);
    expect(runner.calls.some((call) => call.args[0] === "deploy")).toBe(false);
    expect(() =>
      validateDeploymentCredentials({
        ...SECRETS,
        API_BEARER: "x".repeat(31),
      }),
    ).toThrow();
  });

  it("reports lock contention without touching remote resources", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote);
    await fs.mkdir(path.join(testProject.stateRoot, "lock"), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(
      path.join(testProject.stateRoot, "lock", "owner.json"),
      `${JSON.stringify({
        format: "syndroo-runtime-v1",
        token: "owner-token-1234567890",
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      deploy(testProject, runner, cloudFetch(remote)),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_STATE_BUSY" });
    expect(runner.calls.every((call) => call.args[0] === "--version")).toBe(true);
  });

  it("rejects a symlinked Wrangler config", async () => {
    const testProject = await project();
    const outside = path.join(testProject.root, "outside-wrangler.jsonc");
    await fs.rename(path.join(testProject.root, "wrangler.jsonc"), outside);
    await fs.symlink(outside, path.join(testProject.root, "wrangler.jsonc"));
    const remote = cloud();

    await expect(
      deploy(testProject, new DeployRunner(remote), cloudFetch(remote)),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_CONFIG_INVALID" });
  });

  it("rejects a symlinked credential record", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote);
    await deploy(testProject, runner, cloudFetch(remote), {
      credentials: SECRETS,
    });
    const credentialFile = path.join(
      testProject.stateRoot,
      deploymentCredentialFileName(PROJECT_ID),
    );
    const outside = path.join(path.dirname(testProject.root), "outside.json");
    await fs.rename(credentialFile, outside);
    await fs.symlink(outside, credentialFile);
    const callsBefore = runner.calls.length;

    await expect(
      deploy(testProject, runner, cloudFetch(remote)),
    ).rejects.toMatchObject({ code: "SERVER_STATE_RECOVERY_REQUIRED" });
    expect(
      runner.calls
        .slice(callsBefore)
        .some((call) => call.args[0] === "deploy"),
    ).toBe(false);
  });

  it("keeps credentials out of argv, tracked files, diagnostics, and reports", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote, {
      deployExitCode: 1,
    });
    const error = await deploy(
      testProject,
      runner,
      cloudFetch(remote),
      { credentials: SECRETS },
    ).catch((caught: unknown) => caught);
    const serialized = JSON.stringify(error);
    const deployCall = runner.calls.find((call) => call.args[0] === "deploy");
    const secretsFile = runner.secretFiles.at(-1);
    const tracked = (
      await fs.readdir(testProject.root, { recursive: true })
    )
      .filter((name) => !name.startsWith("node_modules"))
      .map(async (name) => {
        try {
          return await fs.readFile(path.join(testProject.root, name), "utf8");
        } catch {
          return "";
        }
      });
    const trackedText = (await Promise.all(tracked)).join("\n");

    expect(serialized).not.toContain("SENTINEL");
    expect(JSON.stringify(deployCall)).not.toContain("SENTINEL");
    expect(deployCall?.environment).toMatchObject({
      WRANGLER_SEND_METRICS: "false",
    });
    expect(trackedText).not.toContain("SENTINEL");
    expect(secretsFile?.text).toContain("SENTINEL");
    expect(secretsFile?.mode).toBe(0o600);
    await expect(fs.stat(secretsFile?.path ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps credentials and confirmed deployment state when the origin config write fails", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote, {
      breakConfigAfterDeploy: true,
    });

    await expect(
      deploy(testProject, runner, cloudFetch(remote), {
        credentials: SECRETS,
      }),
    ).rejects.toMatchObject({ code: "SERVER_CONFIG_INVALID" });

    const state = JSON.parse(
      await fs.readFile(
        path.join(
          testProject.stateRoot,
          deploymentStateFileName(PROJECT_ID),
        ),
        "utf8",
      ),
    ) as { step: string; origin: string };
    expect(state).toMatchObject({
      step: "deployed",
      origin: "https://demo-worker.account-subdomain.workers.dev",
    });
    expect(
      await fs.readFile(
        path.join(
          testProject.stateRoot,
          deploymentCredentialFileName(PROJECT_ID),
        ),
        "utf8",
      ),
    ).toContain(SECRETS.SECRET_KEY);
  });

  it("requires an explicit caller authorization and rejects API origin overrides", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote);

    await expect(
      runServerDeploy(dependencies(testProject, runner, cloudFetch(remote)), {
        projectDirectory: testProject.root,
        authorized: false,
      }),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_AUTHORIZATION_REQUIRED" });

    const deps = dependencies(testProject, runner, cloudFetch(remote));
    await expect(
      runServerDeploy(
        {
          ...deps,
          env: {
            ...deps.env,
            CLOUDFLARE_API_BASE_URL: "https://attacker.invalid/client/v4",
          },
        },
        {
          projectDirectory: testProject.root,
          account: "account-id",
          authorized: true,
        },
      ),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_API_ORIGIN_UNSUPPORTED" });
    expect(runner.calls).toEqual([]);
  });

  it("derives queues from WORK_QUEUE and the two consumer names without a suffix convention", async () => {
    const testProject = await project();
    await editWrangler(testProject, (config) => {
      config["queues"]["producers"][0]["queue"] = "jobs-primary";
      config["queues"]["consumers"] = [
        { queue: "jobs-failed", max_retries: 0 },
        { queue: "jobs-primary", max_retries: 2 },
      ];
      config["vars"]["QUEUE_NAME"] = "jobs-primary";
      config["vars"]["DLQ_NAME"] = "jobs-failed";
    });
    const remote = cloud();
    const runner = new DeployRunner(remote);

    await deploy(testProject, runner, cloudFetch(remote), {
      credentials: SECRETS,
    });
    const effective = JSON.parse(
      await fs.readFile(
        path.join(testProject.root, "wrangler.effective.jsonc"),
        "utf8",
      ),
    ) as { vars: Record<string, string> };

    expect(remote.queues.map((queue) => queue.name)).toEqual([
      "jobs-primary",
      "jobs-failed",
    ]);
    expect(effective.vars).toMatchObject({
      QUEUE_NAME: "jobs-primary",
      DLQ_NAME: "jobs-failed",
    });
  });

  it.each([
    [
      "D1 binding",
      (config: Record<string, any>) => {
        config["d1_databases"][0]["binding"] = "WRONG_DB";
      },
    ],
    [
      "producer binding",
      (config: Record<string, any>) => {
        config["queues"]["producers"][0]["binding"] = "WRONG_QUEUE";
      },
    ],
    [
      "Worker main",
      (config: Record<string, any>) => {
        config["main"] = "./worker.js";
      },
    ],
  ])("rejects a wrong %s before remote mutation", async (_label, edit) => {
    const testProject = await project();
    await editWrangler(testProject, edit);
    const remote = cloud();
    const runner = new DeployRunner(remote);

    await expect(
      deploy(testProject, runner, cloudFetch(remote), {
        credentials: SECRETS,
      }),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_CONFIG_INVALID" });
    expect(remote.d1).toEqual([]);
    expect(remote.queues).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it.each([
    [
      "PUBLIC_FETCH_STRICT",
      (config: Record<string, any>) => {
        config["vars"]["PUBLIC_FETCH_STRICT"] = "disabled";
      },
    ],
    [
      "global fetch compatibility flag",
      (config: Record<string, any>) => {
        config["compatibility_flags"] = [];
      },
    ],
    [
      "required encryption names",
      (config: Record<string, any>) => {
        config["secrets"]["required"] = ["API_BEARER"];
      },
    ],
  ])("rejects missing %s before remote mutation", async (_label, edit) => {
    const testProject = await project();
    await editWrangler(testProject, edit);
    const remote = cloud();
    const runner = new DeployRunner(remote);

    await expect(
      deploy(testProject, runner, cloudFetch(remote), {
        credentials: SECRETS,
      }),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_CONFIG_INVALID" });
    expect(remote.d1).toEqual([]);
    expect(remote.queues).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it.each([
    ["PUBLIC_ORIGIN", "https://foreign.example"],
    ["SCOPE", "foreign-scope"],
    ["QUEUE_NAME", "foreign-work"],
    ["DLQ_NAME", "foreign-dead"],
  ])("rejects conflicting owned variable %s before mutation", async (name, value) => {
    const testProject = await project();
    await editWrangler(testProject, (config) => {
      config["vars"][name] = value;
    });
    const remote = cloud();
    const runner = new DeployRunner(remote);

    await expect(
      deploy(testProject, runner, cloudFetch(remote), {
        credentials: SECRETS,
      }),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_CONFIG_INVALID" });
    expect(remote.d1).toEqual([]);
    expect(remote.queues).toEqual([]);
    expect(runner.calls.some((call) => call.args[0] === "deploy")).toBe(false);
  });

  it("requires an explicit custom origin when workers.dev is disabled", async () => {
    const testProject = await project();
    await editWrangler(testProject, (config) => {
      config["workers_dev"] = false;
    });
    const remote = cloud();
    const runner = new DeployRunner(remote);

    await expect(
      deploy(testProject, runner, cloudFetch(remote), {
        credentials: SECRETS,
      }),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_ORIGIN_REQUIRED" });
    expect(remote.d1).toEqual([]);
    expect(remote.queues).toEqual([]);
    expect(runner.calls.some((call) => call.args[0] === "deploy")).toBe(false);
  });

  it("checks the workers.dev subdomain before provisioning resources", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote);

    await expect(
      deploy(
        testProject,
        runner,
        cloudFetch(remote, { subdomainMissing: true }),
        { credentials: SECRETS },
      ),
    ).rejects.toMatchObject({
      code: "SERVER_DEPLOY_WORKERS_DEV_SUBDOMAIN_REQUIRED",
    });
    expect(remote.d1).toEqual([]);
    expect(remote.queues).toEqual([]);
    expect(runner.calls.some((call) => call.args[0] === "deploy")).toBe(false);
  });

  it("safely retries a pending first deploy when the remote Worker is confirmed absent", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote, {
      deployStatus: "timed_out",
      deployExitCode: null,
      timeoutCreatesWorker: false,
    });
    await expect(
      deploy(testProject, runner, cloudFetch(remote), {
        credentials: SECRETS,
      }),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_AMBIGUOUS" });
    const deployCalls = runner.calls.filter((call) => call.args[0] === "deploy").length;

    const retryRunner = new DeployRunner(remote);
    const retried = await deploy(testProject, retryRunner, cloudFetch(remote));
    expect(retried.status).toBe("deployed");
    expect(
      retryRunner.calls.filter((call) => call.args[0] === "deploy"),
    ).toHaveLength(1);
  });

  it.each([
    ["timed out", "timed_out", null],
    ["exited nonzero", "exited", 1],
  ] as const)(
    "retains machine output and automatically reconciles a deploy that %s after upload",
    async (_label, deployStatus, deployExitCode) => {
      const testProject = await project();
      const remote = cloud();
      const firstRunner = new DeployRunner(remote, {
        deployStatus,
        deployExitCode,
        deployWritesReceipt: true,
      });

      await expect(
        deploy(testProject, firstRunner, cloudFetch(remote), {
          credentials: SECRETS,
        }),
      ).rejects.toMatchObject({ code: "SERVER_DEPLOY_AMBIGUOUS" });

      const pending = JSON.parse(
        await fs.readFile(
          path.join(testProject.stateRoot, deploymentStateFileName(PROJECT_ID)),
          "utf8",
        ),
      ) as { operationId: string };
      const receipt = path.join(
        testProject.stateRoot,
        deploymentReceiptFileName(pending.operationId),
      );
      expect(await fs.readFile(receipt, "utf8")).toContain(
        '"worker_tag":"worker-tag-deployed"',
      );
      expect((await fs.stat(receipt)).mode & 0o777).toBe(0o600);

      const secondRunner = new DeployRunner(remote);
      const result = await deploy(
        testProject,
        secondRunner,
        cloudFetch(remote),
      );

      expect(result).toMatchObject({
        status: "deployed",
        workerTag: "worker-tag-deployed",
        versionId: "version-deployed",
      });
      expect(
        secondRunner.calls.some((call) => call.args[0] === "deploy"),
      ).toBe(false);
      expect(
        (await loadServerConfig(testProject.root)).config.publicOrigin,
      ).toBe("https://demo-worker.account-subdomain.workers.dev");
    },
  );

  it("uses a fresh operation receipt for every new deploy and never reuses an older successful record", async () => {
    const testProject = await project();
    const remote = cloud();
    const firstRunner = new DeployRunner(remote, {
      deployWorkerTag: "worker-tag-one",
      deployVersionId: "version-one",
    });
    await deploy(testProject, firstRunner, cloudFetch(remote), {
      credentials: SECRETS,
    });
    const firstState = JSON.parse(
      await fs.readFile(
        path.join(testProject.stateRoot, deploymentStateFileName(PROJECT_ID)),
        "utf8",
      ),
    ) as { operationId: string };

    const secondRunner = new DeployRunner(remote, {
      deployWorkerTag: "worker-tag-two",
      deployVersionId: "version-two",
    });
    await deploy(testProject, secondRunner, cloudFetch(remote));
    const secondState = JSON.parse(
      await fs.readFile(
        path.join(testProject.stateRoot, deploymentStateFileName(PROJECT_ID)),
        "utf8",
      ),
    ) as { operationId: string; versionId: string };

    expect(secondState.versionId).toBe("version-two");
    expect(secondState.operationId).not.toBe(firstState.operationId);
    const firstReceipt = path.join(
      testProject.stateRoot,
      deploymentReceiptFileName(firstState.operationId),
    );
    const secondReceipt = path.join(
      testProject.stateRoot,
      deploymentReceiptFileName(secondState.operationId),
    );
    expect(firstReceipt).not.toBe(secondReceipt);
    expect(await fs.readFile(firstReceipt, "utf8")).toContain("version-one");
    expect(await fs.readFile(secondReceipt, "utf8")).toContain("version-two");

    const failedRunner = new DeployRunner(remote, {
      deployExitCode: 1,
    });
    await expect(
      deploy(testProject, failedRunner, cloudFetch(remote)),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_AMBIGUOUS" });
    const failedState = JSON.parse(
      await fs.readFile(
        path.join(testProject.stateRoot, deploymentStateFileName(PROJECT_ID)),
        "utf8",
      ),
    ) as { operationId: string; step: string };
    expect(failedState).toMatchObject({ step: "deploy-pending" });
    expect([firstState.operationId, secondState.operationId]).not.toContain(
      failedState.operationId,
    );

    const recoveryRunner = new DeployRunner(remote);
    await expect(
      deploy(testProject, recoveryRunner, cloudFetch(remote)),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_RECOVERY_REQUIRED" });
    expect(
      recoveryRunner.calls.some((call) => call.args[0] === "deploy"),
    ).toBe(false);
  });

  it("rejects a stale pre-attempt receipt and uses explicit recovery only as the baseline for a fresh deploy", async () => {
    const testProject = await project();
    const remote = cloud();
    await deploy(
      testProject,
      new DeployRunner(remote, {
        deployWorkerTag: "worker-tag-one",
        deployVersionId: "version-one",
      }),
      cloudFetch(remote),
      { credentials: SECRETS },
    );

    await expect(
      deploy(
        testProject,
        new DeployRunner(remote, {
          deployStatus: "timed_out",
          deployExitCode: null,
          timeoutCreatesWorker: false,
        }),
        cloudFetch(remote),
      ),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_AMBIGUOUS" });

    const pending = JSON.parse(
      await fs.readFile(
        path.join(testProject.stateRoot, deploymentStateFileName(PROJECT_ID)),
        "utf8",
      ),
    ) as { operationId: string };
    await fs.writeFile(
      path.join(
        testProject.stateRoot,
        deploymentReceiptFileName(pending.operationId),
      ),
      `${JSON.stringify({
        type: "deploy",
        version: 1,
        worker_name: "demo-worker",
        worker_tag: "worker-tag-one",
        version_id: "version-one",
        targets: ["demo-worker.account-subdomain.workers.dev"],
        wrangler_environment: undefined,
      })}\n`,
    );

    const staleRunner = new DeployRunner(remote);
    await expect(
      deploy(testProject, staleRunner, cloudFetch(remote)),
    ).rejects.toMatchObject({
      code: "SERVER_DEPLOY_RECEIPT_STALE",
      details: { failedStep: "deploy-pending" },
    });
    expect(staleRunner.calls.some((call) => call.args[0] === "deploy")).toBe(
      false,
    );

    const recoveryRunner = new DeployRunner(remote, {
      deployWorkerTag: "worker-tag-two",
      deployVersionId: "version-two",
    });
    const recovered = await deploy(
      testProject,
      recoveryRunner,
      cloudFetch(remote),
      {
        recover: {
          workerTag: "worker-tag-one",
          versionId: "version-one",
        },
      },
    );
    expect(recovered).toMatchObject({
      workerTag: "worker-tag-two",
      versionId: "version-two",
    });
    expect(
      recoveryRunner.calls.filter((call) => call.args[0] === "deploy"),
    ).toHaveLength(1);
  });

  it.each(["missing", "corrupt"] as const)(
    "does not promote a receipt-recovered deploy when local credentials are %s",
    async (credentialState) => {
      const testProject = await project();
      const remote = cloud();
      const firstRunner = new DeployRunner(remote, {
        deployStatus: "timed_out",
        deployExitCode: null,
        deployWritesReceipt: true,
      });
      await expect(
        deploy(testProject, firstRunner, cloudFetch(remote), {
          credentials: SECRETS,
        }),
      ).rejects.toMatchObject({ code: "SERVER_DEPLOY_AMBIGUOUS" });

      const credentialFile = path.join(
        testProject.stateRoot,
        deploymentCredentialFileName(PROJECT_ID),
      );
      if (credentialState === "missing") {
        await fs.rm(credentialFile);
      } else {
        const record = JSON.parse(await fs.readFile(credentialFile, "utf8")) as {
          credentials: Record<string, string>;
        };
        record.credentials.SECRET_KEY = "invalid";
        await fs.writeFile(credentialFile, `${JSON.stringify(record)}\n`, {
          mode: 0o600,
        });
      }

      const receiptRunner = new DeployRunner(remote);
      const error = await deploy(
        testProject,
        receiptRunner,
        cloudFetch(remote),
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        details: {
          failedStep: "deploy-pending",
          nextAction: "IMPORT_DEPLOY_CREDENTIALS",
        },
      });
      expect(receiptRunner.calls.some((call) => call.args[0] === "deploy")).toBe(
        false,
      );
      const state = JSON.parse(
        await fs.readFile(
          path.join(testProject.stateRoot, deploymentStateFileName(PROJECT_ID)),
          "utf8",
        ),
      ) as { step: string };
      expect(state.step).toBe("deploy-pending");
      expect(
        (await loadServerConfig(testProject.root)).config.publicOrigin,
      ).toBeUndefined();
    },
  );

  it("cannot use custom-origin explicit recovery without fresh machine target evidence", async () => {
    const customOrigin = "https://syndroo.example";
    const testProject = await project({ publicOrigin: customOrigin });
    await editWrangler(testProject, (config) => {
      config["workers_dev"] = false;
    });
    const remote = cloud();
    await deploy(
      testProject,
      new DeployRunner(remote, {
        deployWorkerTag: "worker-tag-one",
        deployVersionId: "version-one",
        deployTarget: `${customOrigin}/*`,
      }),
      cloudFetch(remote),
      { credentials: SECRETS },
    );

    await expect(
      deploy(
        testProject,
        new DeployRunner(remote, {
          deployStatus: "timed_out",
          deployExitCode: null,
          timeoutCreatesWorker: false,
        }),
        cloudFetch(remote),
      ),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_AMBIGUOUS" });

    const recoveryRunner = new DeployRunner(remote, {
      deployWorkerTag: "worker-tag-two",
      deployVersionId: "version-two",
      deployTarget: "https://foreign.example",
    });
    await expect(
      deploy(testProject, recoveryRunner, cloudFetch(remote), {
        recover: {
          workerTag: "worker-tag-one",
          versionId: "version-one",
        },
      }),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_TARGET_UNVERIFIED" });
    expect(
      recoveryRunner.calls.filter((call) => call.args[0] === "deploy"),
    ).toHaveLength(1);
    const state = JSON.parse(
      await fs.readFile(
        path.join(testProject.stateRoot, deploymentStateFileName(PROJECT_ID)),
        "utf8",
      ),
    ) as { step: string };
    expect(state.step).toBe("deploy-pending");
  });

  it("uses verified Worker evidence as a baseline that still requires a fresh deploy", async () => {
    const testProject = await project();
    const remote = cloud();
    const firstRunner = new DeployRunner(remote, {
      deployStatus: "timed_out",
      deployExitCode: null,
    });
    await expect(
      deploy(testProject, firstRunner, cloudFetch(remote), {
        credentials: SECRETS,
      }),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_AMBIGUOUS" });

    await expect(
      deploy(testProject, new DeployRunner(remote), cloudFetch(remote)),
    ).rejects.toMatchObject({
      code: "SERVER_DEPLOY_RECOVERY_REQUIRED",
      details: { nextAction: "PROVIDE_DEPLOY_RECOVERY" },
    });

    await expect(
      deploy(testProject, new DeployRunner(remote), cloudFetch(remote), {
        recover: {
          workerTag: "wrong-worker-tag",
          versionId: "version-maybe-created",
        },
      }),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH" });

    await expect(
      deploy(testProject, new DeployRunner(remote), cloudFetch(remote), {
        recover: {
          workerTag: "worker-tag-maybe-created",
          versionId: "wrong-version",
        },
      }),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH" });

    const recoveredRunner = new DeployRunner(remote);
    const recovered = await deploy(
      testProject,
      recoveredRunner,
      cloudFetch(remote),
      {
        recover: {
          workerTag: "worker-tag-maybe-created",
          versionId: "version-maybe-created",
        },
      },
    );
    expect(recovered).toMatchObject({
      status: "deployed",
      workerTag: "worker-tag-deployed",
      versionId: "version-deployed",
    });
    expect(
      recoveredRunner.calls.filter((call) => call.args[0] === "deploy"),
    ).toHaveLength(1);
  });

  it("treats pending absence of a previously known Worker as identity mismatch", async () => {
    const testProject = await project();
    const remote = cloud();
    await deploy(
      testProject,
      new DeployRunner(remote),
      cloudFetch(remote),
      { credentials: SECRETS },
    );
    const stateFile = path.join(
      testProject.stateRoot,
      deploymentStateFileName(PROJECT_ID),
    );
    const state = JSON.parse(await fs.readFile(stateFile, "utf8")) as {
      step: string;
    };
    state.step = "deploy-pending";
    await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    remote.worker = null;
    remote.activeVersionId = null;
    const runner = new DeployRunner(remote);

    await expect(
      deploy(testProject, runner, cloudFetch(remote)),
    ).rejects.toMatchObject({
      code: "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
      details: { nextAction: "INSPECT_CLOUDFLARE_WORKER" },
    });
    expect(runner.calls.some((call) => call.args[0] === "deploy")).toBe(false);
  });

  it("recovers a lost D1 create reply only through an explicitly verified imported ID", async () => {
    const testProject = await project();
    const remote = cloud();
    await expect(
      deploy(
        testProject,
        new DeployRunner(remote),
        cloudFetch(remote, { d1CreateLosesResponse: true }),
        { credentials: SECRETS },
      ),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_AMBIGUOUS" });

    await expect(
      deploy(testProject, new DeployRunner(remote), cloudFetch(remote)),
    ).rejects.toMatchObject({
      code: "SERVER_DEPLOY_OWNERSHIP_UNVERIFIED",
      details: { nextAction: "PROVIDE_RESOURCE_RECOVERY" },
    });
    expect(remote.d1).toHaveLength(1);
    expect(remote.queues).toEqual([]);

    await expect(
      deploy(testProject, new DeployRunner(remote), cloudFetch(remote), {
        recover: { d1Id: "d1-wrong" },
      }),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH" });
    expect(remote.d1).toHaveLength(1);
    expect(remote.queues).toEqual([]);

    const recoveredRunner = new DeployRunner(remote);
    await deploy(testProject, recoveredRunner, cloudFetch(remote), {
      recover: { d1Id: "d1-created" },
    });
    expect(remote.d1).toEqual([{ id: "d1-created", name: "demo-worker" }]);
    expect(remote.queues).toHaveLength(2);
    expect(
      recoveredRunner.calls.filter(
        (call) => call.args[0] === "deploy",
      ),
    ).toHaveLength(1);
  });

  it("rejects resource recovery for the wrong account or DB name without mutation", async () => {
    const testProject = await project();
    const remote = cloud();
    remote.d1.push(
      { id: "d1-configured", name: "demo-worker" },
      { id: "d1-foreign", name: "foreign-database" },
    );
    const runner = new DeployRunner(remote);

    await expect(
      deploy(testProject, runner, cloudFetch(remote), {
        credentials: SECRETS,
        recover: { d1Id: "d1-foreign" },
      }),
    ).rejects.toMatchObject({
      code: "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
    });
    expect(remote.queues).toEqual([]);
    expect(runner.calls.some((call) => call.args[0] === "deploy")).toBe(false);
  });

  it("uses the verified state account by default in a multi-account login", async () => {
    const testProject = await project();
    const remote = cloud();
    const accounts = [
      { id: "account-id", name: "Test Account" },
      { id: "other-account-id", name: "Other Account" },
    ];
    await deploy(
      testProject,
      new DeployRunner(remote, { accounts }),
      cloudFetch(remote),
      { credentials: SECRETS },
    );

    const rerunRunner = new DeployRunner(remote, { accounts });
    await deploy(testProject, rerunRunner, cloudFetch(remote), {
      account: undefined,
    });

    expect(
      rerunRunner.calls.find((call) => call.args[0] === "whoami"),
    ).toBeDefined();
    expect(remote.worker).not.toBeNull();

    const conflictRunner = new DeployRunner(remote, { accounts });
    const deps = dependencies(
      testProject,
      conflictRunner,
      cloudFetch(remote),
    );
    await expect(
      runServerDeploy(
        {
          ...deps,
          env: {
            ...deps.env,
            CLOUDFLARE_ACCOUNT_ID: "other-account-id",
          },
        },
        {
          projectDirectory: testProject.root,
          authorized: true,
        },
      ),
    ).rejects.toMatchObject({
      code: "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
      details: { nextAction: "INSPECT_SERVER_STATE" },
    });
    expect(
      conflictRunner.calls.some((call) => call.args[0] === "deploy"),
    ).toBe(false);
  });

  it("rejects conflicting environment and Wrangler account IDs before mutation", async () => {
    const testProject = await project();
    await editWrangler(testProject, (config) => {
      config["account_id"] = "other-account-id";
    });
    const remote = cloud();
    const runner = new DeployRunner(remote);
    const deps = dependencies(testProject, runner, cloudFetch(remote));

    await expect(
      runServerDeploy(
        {
          ...deps,
          env: {
            ...deps.env,
            CLOUDFLARE_ACCOUNT_ID: "account-id",
          },
        },
        {
          projectDirectory: testProject.root,
          authorized: true,
          credentials: SECRETS,
        },
      ),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_ACCOUNT_CONFLICT" });
    expect(remote.d1).toEqual([]);
    expect(remote.queues).toEqual([]);
    expect(runner.calls.some((call) => call.args[0] === "deploy")).toBe(false);
  });

  it("recovers a lost queue create reply by exact ID without creating a duplicate", async () => {
    const testProject = await project();
    const remote = cloud();
    await expect(
      deploy(
        testProject,
        new DeployRunner(remote),
        cloudFetch(remote, { queueCreateLosesResponse: true }),
        { credentials: SECRETS },
      ),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_AMBIGUOUS" });

    await expect(
      deploy(testProject, new DeployRunner(remote), cloudFetch(remote), {
        recover: {
          queues: { "demo-worker-work": "queue-wrong" },
        },
      }),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH" });
    expect(remote.queues).toEqual([
      { id: "queue-1", name: "demo-worker-work" },
    ]);

    const recoveredRunner = new DeployRunner(remote);
    await deploy(testProject, recoveredRunner, cloudFetch(remote), {
      recover: {
        queues: { "demo-worker-work": "queue-1" },
      },
    });
    expect(remote.queues).toEqual([
      { id: "queue-1", name: "demo-worker-work" },
      { id: "queue-2", name: "demo-worker-dead" },
    ]);
    expect(
      recoveredRunner.calls.filter(
        (call) => call.args[0] === "deploy",
      ),
    ).toHaveLength(1);
  });

  it("reconciles a valid receipt after the state write fails", async () => {
    const testProject = await project();
    const remote = cloud();
    const firstRunner = new DeployRunner(remote, {
      breakStateAfterDeploy: true,
    });
    await expect(
      deploy(testProject, firstRunner, cloudFetch(remote), {
        credentials: SECRETS,
      }),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_STATE_WRITE_FAILED" });

    const stateFile = path.join(
      testProject.stateRoot,
      deploymentStateFileName(PROJECT_ID),
    );
    await fs.rm(stateFile, { recursive: true });
    await fs.writeFile(stateFile, firstRunner.interruptedStateText ?? "", {
      mode: 0o600,
    });

    const secondRunner = new DeployRunner(remote);
    const result = await deploy(
      testProject,
      secondRunner,
      cloudFetch(remote),
    );
    expect(result.status).toBe("deployed");
    expect(
      secondRunner.calls.some((call) => call.args[0] === "deploy"),
    ).toBe(false);
  });

  it("verifies an existing custom origin only from explicit config and deploy output", async () => {
    const customOrigin = "https://syndroo.example";
    const testProject = await project({ publicOrigin: customOrigin });
    await editWrangler(testProject, (config) => {
      config["workers_dev"] = false;
    });
    const remote = cloud();
    const runner = new DeployRunner(remote, {
      deployTarget: `${customOrigin}/*`,
    });

    const result = await deploy(
      testProject,
      runner,
      cloudFetch(remote),
      { credentials: SECRETS },
    );

    expect(result.origin).toBe(customOrigin);
    expect(
      (await loadServerConfig(testProject.root)).config.publicOrigin,
    ).toBe(customOrigin);
    const effective = JSON.parse(
      await fs.readFile(
        path.join(testProject.root, "wrangler.effective.jsonc"),
        "utf8",
      ),
    ) as { workers_dev?: boolean };
    expect(effective.workers_dev).toBe(false);
  });

  it("does not report an origin when machine deploy output names another target", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote, {
      deployTarget: "https://foreign.example",
    });

    await expect(
      deploy(testProject, runner, cloudFetch(remote), { credentials: SECRETS }),
    ).rejects.toMatchObject({
      code: "SERVER_DEPLOY_TARGET_UNVERIFIED",
      details: {
        nextAction: "VERIFY_PUBLIC_ORIGIN",
        evidence: { stage: "deploy", receipt: "target_mismatch" },
      },
    });
    expect(
      (await loadServerConfig(testProject.root)).config.publicOrigin,
    ).toBeUndefined();
  });

  it("classifies a timed-out deploy with no machine receipt as missing evidence", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote, {
      deployStatus: "timed_out",
      deployExitCode: null,
    });

    const error = await deploy(testProject, runner, cloudFetch(remote), {
      credentials: SECRETS,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SERVER_DEPLOY_AMBIGUOUS",
      details: {
        failedStep: "deploy-pending",
        receiptRetained: true,
        evidence: {
          stage: "deploy",
          processStatus: "timed_out",
          // The receipt file was created but carries no machine record.
          receipt: "missing",
          receiptRetained: true,
        },
      },
    });
    // Raw subprocess output never reaches the structured error.
    expect(JSON.stringify(error)).not.toContain("CLOUDFLARE-ACCESS-TOKEN-SENTINEL");
    expect(JSON.stringify(error)).not.toContain("uploaded safely");

    // The rerun still needs verified Worker evidence and reports it safely.
    const retryRunner = new DeployRunner(remote);
    const retry = await deploy(testProject, retryRunner, cloudFetch(remote))
      .catch((caught: unknown) => caught);
    expect(retry).toMatchObject({
      code: "SERVER_DEPLOY_RECOVERY_REQUIRED",
      details: {
        failedStep: "deploy-pending",
        nextAction: "PROVIDE_DEPLOY_RECOVERY",
        evidence: {
          stage: "verification",
          receipt: "missing",
          receiptRetained: true,
        },
      },
    });
    expect(retryRunner.calls.some((call) => call.args[0] === "deploy")).toBe(
      false,
    );
  });

  it("distinguishes a nonzero deploy subprocess from the receipt it left", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote, {
      deployExitCode: 3,
      deployWritesReceipt: true,
    });

    const error = await deploy(testProject, runner, cloudFetch(remote), {
      credentials: SECRETS,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SERVER_DEPLOY_AMBIGUOUS",
      details: {
        nextAction: "RERUN_DEPLOY_TO_RECONCILE",
        receiptRetained: true,
        evidence: {
          stage: "deploy",
          processStatus: "exited",
          processExitCode: 3,
          receipt: "complete",
          receiptRetained: true,
        },
      },
    });
    expect(JSON.stringify(error)).not.toContain("CLOUDFLARE-ACCESS-TOKEN-SENTINEL");
  });

  it.each([
    ["invalid", "not-json\n"],
    [
      "mismatched_worker",
      `${JSON.stringify({
        type: "deploy",
        version: 1,
        worker_name: "another-worker",
        worker_tag: "worker-tag-deployed",
        version_id: "version-deployed",
        targets: ["another-worker.account-subdomain.workers.dev"],
        wrangler_environment: undefined,
      })}\n`,
    ],
    [
      "incomplete",
      `${JSON.stringify({
        type: "deploy",
        version: 1,
        worker_name: "demo-worker",
        worker_tag: "worker-tag-deployed",
      })}\n`,
    ],
  ] as const)(
    "reports a %s machine receipt after a successful subprocess exit",
    async (classification, receiptText) => {
      const testProject = await project();
      const remote = cloud();
      const runner = new DeployRunner(remote, {
        deployReceiptText: receiptText,
      });

      const error = await deploy(testProject, runner, cloudFetch(remote), {
        credentials: SECRETS,
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "SERVER_DEPLOY_AMBIGUOUS",
        details: {
          receiptRetained: true,
          evidence: {
            stage: "deploy",
            processStatus: "exited",
            processExitCode: 0,
            receipt: classification,
          },
        },
      });
      expect(
        (await loadServerConfig(testProject.root)).config.publicOrigin,
      ).toBeUndefined();
    },
  );

  it("reports a subprocess that never started and keeps the retry action", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote, { deployStatus: "spawn_error" });

    const error = await deploy(testProject, runner, cloudFetch(remote), {
      credentials: SECRETS,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SERVER_DEPLOY_FAILED",
      details: {
        nextAction: "RETRY_DEPLOY",
        evidence: { stage: "deploy", processStatus: "spawn_error" },
      },
    });
    expect(JSON.stringify(error)).not.toContain("CLOUDFLARE-ACCESS-TOKEN-SENTINEL");
  });

  it("distinguishes an absent receipt file from an empty one", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote, {
      deployStatus: "timed_out",
      deployExitCode: null,
      deployDeletesReceipt: true,
    });

    const error = await deploy(testProject, runner, cloudFetch(remote), {
      credentials: SECRETS,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SERVER_DEPLOY_AMBIGUOUS",
      details: {
        receiptRetained: false,
        evidence: {
          stage: "deploy",
          processStatus: "timed_out",
          receipt: "missing",
          receiptRetained: false,
        },
      },
    });
    expect(JSON.stringify(error)).not.toContain("CLOUDFLARE-ACCESS-TOKEN-SENTINEL");
  });

  it("reports an unreadable receipt when the private file cannot be read", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote, {
      deployStatus: "timed_out",
      deployExitCode: null,
      deployReceiptBecomesDirectory: true,
    });

    const error = await deploy(testProject, runner, cloudFetch(remote), {
      credentials: SECRETS,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SERVER_DEPLOY_AMBIGUOUS",
      details: {
        evidence: {
          stage: "deploy",
          processStatus: "timed_out",
          receipt: "unreadable",
        },
      },
    });
  });

  it("does not swallow an unreadable receipt during a pending rerun", async () => {
    const testProject = await project();
    const remote = cloud();
    const firstRunner = new DeployRunner(remote, {
      deployStatus: "timed_out",
      deployExitCode: null,
    });
    await expect(
      deploy(testProject, firstRunner, cloudFetch(remote), {
        credentials: SECRETS,
      }),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_AMBIGUOUS" });

    const pending = JSON.parse(
      await fs.readFile(
        path.join(
          testProject.stateRoot,
          deploymentStateFileName(PROJECT_ID),
        ),
        "utf8",
      ),
    ) as { operationId: string };
    const receiptFile = path.join(
      testProject.stateRoot,
      deploymentReceiptFileName(pending.operationId),
    );
    await fs.rm(receiptFile, { force: true });
    await fs.mkdir(receiptFile, { mode: 0o700 });

    // A read failure keeps its own fail-closed error; only malformed machine
    // output becomes unusable evidence.
    await expect(
      deploy(testProject, new DeployRunner(remote), cloudFetch(remote)),
    ).rejects.toMatchObject({ code: "SERVER_DEPLOY_RECEIPT_UNAVAILABLE" });
  });

  it("keeps a malformed receipt as unusable evidence and still allows verified recovery", async () => {
    const testProject = await project();
    const remote = cloud();
    const firstRunner = new DeployRunner(remote, {
      deployReceiptBytes: Uint8Array.from([0xff, 0xfe, 0x00, 0x7b]),
    });
    const first = await deploy(testProject, firstRunner, cloudFetch(remote), {
      credentials: SECRETS,
    }).catch((caught: unknown) => caught);
    expect(first).toMatchObject({
      code: "SERVER_DEPLOY_AMBIGUOUS",
      details: {
        receiptRetained: true,
        evidence: {
          stage: "deploy",
          processStatus: "exited",
          receipt: "invalid",
          receiptRetained: true,
        },
      },
    });
    // The platform accepted the upload, so the next attempt starts from a
    // recorded Worker with no readable receipt.
    expect(remote.worker).toMatchObject({ tag: "worker-tag-deployed" });

    // An ordinary rerun fails closed without mutating anything.
    const plainRunner = new DeployRunner(remote);
    const plain = await deploy(testProject, plainRunner, cloudFetch(remote))
      .catch((caught: unknown) => caught);
    expect(plain).toMatchObject({
      code: "SERVER_DEPLOY_RECOVERY_REQUIRED",
      details: {
        failedStep: "deploy-pending",
        nextAction: "PROVIDE_DEPLOY_RECOVERY",
        evidence: {
          stage: "verification",
          receipt: "invalid",
          receiptRetained: true,
        },
      },
    });
    expect(plainRunner.calls.some((call) => call.args[0] === "deploy")).toBe(
      false,
    );
    expect(
      (await loadServerConfig(testProject.root)).config.publicOrigin,
    ).toBeUndefined();

    // Independently verified evidence is accepted, then a fresh version deploys.
    const recoveryRunner = new DeployRunner(remote, {
      deployWorkerTag: "worker-tag-two",
      deployVersionId: "version-two",
    });
    const recovered = await deploy(
      testProject,
      recoveryRunner,
      cloudFetch(remote),
      {
        recover: {
          workerTag: "worker-tag-deployed",
          versionId: "version-deployed",
        },
      },
    );
    expect(recovered).toMatchObject({
      status: "deployed",
      workerTag: "worker-tag-two",
      versionId: "version-two",
    });
    expect(
      recoveryRunner.calls.filter((call) => call.args[0] === "deploy"),
    ).toHaveLength(1);
  });

  it("reports invalid UTF-8 machine output as invalid", async () => {
    const testProject = await project();
    const remote = cloud();
    const runner = new DeployRunner(remote, {
      deployReceiptBytes: Uint8Array.from([0xff, 0xfe, 0x00, 0x7b]),
    });

    const error = await deploy(testProject, runner, cloudFetch(remote), {
      credentials: SECRETS,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SERVER_DEPLOY_AMBIGUOUS",
      details: {
        receiptRetained: true,
        evidence: {
          stage: "deploy",
          processStatus: "exited",
          receipt: "invalid",
          receiptRetained: true,
        },
      },
    });
  });
});
