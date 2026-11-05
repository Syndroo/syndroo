import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CliIo } from "../src/io.js";
import { run } from "../src/main.js";
import { updateServerConfig } from "../src/server/config.js";
import {
  ensureDeploymentCredentials,
  saveDeploymentState,
  withDeploymentStateLock,
} from "../src/server/deployment-state.js";
import {
  loadCiState,
  loadThreadsConnectDraft,
  saveThreadsConnectDraft,
} from "../src/server/ci-state.js";
import { SERVER_CI_WORKFLOW } from "../src/server/github.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../src/server/process.js";
import {
  ThreadsCiError,
  type ThreadsCiSdk,
} from "../src/server/threads-flow.js";

const PROJECT_ID = "f0c4f706-25a4-4df7-a84c-3b247c64abfe";
const ORIGIN = "https://threads.example";
const CONNECTION_ID = "conn_threads_fixture";
const ADMIN = "admin.fixture-token-that-is-at-least-thirty-two";
const CI_SECRET = "ci.fixture-token-that-is-at-least-thirty-two";
const APP_SECRET = "threads-app-secret-canary";
const SECRET_KEY = "a".repeat(64);
const RUNTIME_KEY = "b".repeat(64);

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "syndroo-task3-")),
  );
  roots.push(root);
  return root;
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
      chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
      done();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

function capture(
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  stdinText = "",
): Capture {
  const stdout = sink();
  const stderr = sink();
  return {
    io: {
      stdin: Readable.from(stdinText.length === 0 ? [] : [stdinText]),
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: {
        HOME: cwd,
        XDG_STATE_HOME: path.join(cwd, "xdg-state"),
        NO_COLOR: "1",
        ...(process.env["PATH"] === undefined ? {} : { PATH: process.env["PATH"] }),
        ...env,
      },
      cwd,
      stdinIsTty: false,
      stdoutIsTty: false,
      hasTty: () => false,
      readTtyLine: () => undefined,
      signal: new AbortController().signal,
    },
    stdout: stdout.text,
    stderr: stderr.text,
  };
}

function processResult(exitCode = 0, stdout = ""): ProcessResult {
  return { status: "exited", exitCode, stdout, stderr: "" };
}

class ScriptedRunner implements ProcessRunner {
  readonly calls: ProcessRequest[] = [];

  constructor(
    private readonly respond: (
      request: ProcessRequest,
    ) => ProcessResult | Promise<ProcessResult>,
  ) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.calls.push(request);
    return await this.respond(request);
  }
}

function oneEnvelope(stdout: string): Record<string, any> {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string) as Record<string, any>;
}

async function writeProject(
  root: string,
  overrides: Partial<{
    publicOrigin: string;
    appId: string;
    connectionId: string;
  }> = {},
): Promise<string> {
  const project = path.join(root, "project");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(
    path.join(project, "syndroo.config.jsonc"),
    `${JSON.stringify(
      {
        version: 1,
        projectId: PROJECT_ID,
        scope: "fixture",
        publicOrigin: overrides.publicOrigin ?? ORIGIN,
        threads: {
          appId: overrides.appId ?? "123456789",
          connectionId: overrides.connectionId ?? CONNECTION_ID,
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return project;
}

async function seedDeployment(
  root: string,
  project: string,
  origin = ORIGIN,
): Promise<string> {
  const stateRoot = path.join(root, "private-state");
  await saveDeploymentState(stateRoot, {
    version: 1,
    projectId: PROJECT_ID,
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
    origin,
    versionId: "version_fixture",
    updatedAt: "2026-11-02T00:00:00.000Z",
  });
  await ensureDeploymentCredentials({
    stateRoot,
    projectId: PROJECT_ID,
    accountId: "account_fixture",
    workerName: "fixture-worker",
    newDeployment: false,
    supplied: {
      API_BEARER: ADMIN,
      SECRET_KEY,
      RUNTIME_KEY,
    },
  });
  await fs.writeFile(
    path.join(project, "package.json"),
    `${JSON.stringify({
      private: true,
      dependencies: {
        "@syndroo/cli": "0.7.2",
        "@syndroo/cloudflare": "0.7.2",
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
    path.join(project, "wrangler.effective.jsonc"),
    `{"name":"fixture-worker","account_id":"account_fixture"}\n`,
    { mode: 0o600 },
  );
  return stateRoot;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("server command surface", () => {
  it("renders nested server command help instead of the local command with the same name", async () => {
    const root = await temporaryRoot();
    const output = capture(root);

    const exit = await run(
      ["server", "connect", "threads", "--help"],
      output.io,
    );

    expect(exit).toBe(0);
    expect(output.stdout()).toContain("Usage: syndroo server connect threads");
    expect(output.stdout()).toContain("--app-secret-stdin");
    expect(output.stdout()).not.toContain("Usage: syndroo connect");
  });

  it("renders nested help without letting a malformed option consume it", async () => {
    const root = await temporaryRoot();
    const output = capture(root);

    const exit = await run(
      [
        "server", "connect", "threads", "--request-id", "--help", "--json",
      ],
      output.io,
    );

    expect(exit).toBe(0);
    expect(output.stdout()).toContain("Usage: syndroo server connect threads");
    expect(output.stdout()).toContain("--request-id <id>");
    expect(output.stderr()).toBe("");
  });

  it("keeps existing local command help behavior", async () => {
    const root = await temporaryRoot();
    const output = capture(root);

    const exit = await run(["connect", "bluesky", "--help"], output.io);

    expect(exit).toBe(0);
    expect(output.stdout()).toContain("Usage: syndroo connect [options] [provider]");
    expect(output.stderr()).toBe("");
  });
});

describe("server publish threads", () => {
  it("uses only the scoped token and preserves the operation id on a lost execute response", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = await seedDeployment(root, project);
    const seen: Array<{ origin: string; token: string }> = [];
    const factory = (origin: string, token: string): ThreadsCiSdk => {
      seen.push({ origin, token });
      return {
        async connect() {
          throw new Error("unexpected connect");
        },
        async publish(request) {
          if (request.type === "prepare") {
            return {
              status: "confirmation_required",
              operationId: "op_task3_fixture",
              approvalToken: "approval-fixture",
              expiresAt: "2026-11-02T00:10:00.000Z",
              preview: [],
            };
          }
          throw Object.assign(new Error("socket closed"), { code: "TIMEOUT" });
        },
        async wait() {
          throw new Error("unexpected wait");
        },
      };
    };
    await fs.writeFile(path.join(project, "post.json"), '{"text":"Task three"}\n');
    const streams = capture(project, {
      SYNDROO_TOKEN: CI_SECRET,
      SYNDROO_ADMIN_TOKEN: ADMIN,
    });

    const exit = await run(
      [
        "server",
        "--project",
        project,
        "publish",
        "threads",
        "--input",
        "post.json",
        "--request-id",
        "task3:publish",
        "--yes",
        "--json",
      ],
      streams.io,
      {},
      { stateRoot, threadsClientFactory: factory },
    );

    expect(exit).toBe(1);
    expect(seen).toEqual([{ origin: ORIGIN, token: CI_SECRET }]);
    expect(oneEnvelope(streams.stdout())).toMatchObject({
      operation: "server",
      ok: true,
      result: {
        subcommand: "publish",
        provider: "threads",
        status: "unknown",
        operationId: "op_task3_fixture",
      },
    });
    expect(`${streams.stdout()}${streams.stderr()}`).not.toContain(CI_SECRET);
    expect(`${streams.stdout()}${streams.stderr()}`).not.toContain(ADMIN);
  });

  it("rejects workflow target conflicts before creating a client", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = await seedDeployment(root, project);
    const factory = vi.fn();
    await fs.writeFile(path.join(project, "post.json"), '{"text":"Task three"}\n');
    const streams = capture(project, {
      SYNDROO_TOKEN: CI_SECRET,
      SYNDROO_URL: "https://other.example",
    });

    const exit = await run(
      [
        "server",
        "--project",
        project,
        "publish",
        "threads",
        "--input",
        "post.json",
        "--request-id",
        "task3:conflict",
        "--yes",
        "--json",
      ],
      streams.io,
      {},
      { stateRoot, threadsClientFactory: factory },
    );

    expect(exit).not.toBe(0);
    expect(factory).not.toHaveBeenCalled();
    expect(oneEnvelope(streams.stdout())).toMatchObject({
      operation: "server",
      ok: false,
      error: { code: "SERVER_THREADS_TARGET_CONFLICT" },
    });
  });
});

describe("server connect threads", () => {
  it("requires the configured origin to match the verified deployment", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = await seedDeployment(root, project, "https://other.example");
    const factory = vi.fn();
    const streams = capture(project, { THREADS_APP_SECRET: APP_SECRET });

    const exit = await run(
      ["server", "--project", project, "connect", "threads", "--json"],
      streams.io,
      {},
      { stateRoot, threadsClientFactory: factory },
    );

    expect(exit).not.toBe(0);
    expect(factory).not.toHaveBeenCalled();
    expect(oneEnvelope(streams.stdout())).toMatchObject({
      operation: "server",
      ok: false,
      error: { code: "SERVER_THREADS_DEPLOYMENT_MISMATCH" },
    });
  });

  it("reads the app secret from explicit stdin and persists only the verified connection", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = await seedDeployment(root, project);
    const seen: Array<{ origin: string; token: string }> = [];
    const client: ThreadsCiSdk = {
      async connect(request) {
        if (request.type === "start") {
          return {
            status: "action_required",
            connectSessionId: "cs_task3",
            stepRevision: 0,
            action: { type: "credential_input", fields: [] },
            expiresAt: "2026-11-02T00:10:00.000Z",
          } as never;
        }
        if (request.type === "resume" && request.stepRevision === 0) {
          return {
            status: "action_required",
            connectSessionId: "cs_task3",
            stepRevision: 1,
            action: { type: "open_url", url: "https://threads.example/oauth" },
            expiresAt: "2026-11-02T00:10:00.000Z",
          } as never;
        }
        return {
          status: "done",
          connection: {
            connectionId: "conn_verified_task3",
            presentation: { accountName: "fixture" },
          },
        } as never;
      },
      async publish() {
        throw new Error("unexpected publish");
      },
      async wait() {
        throw new Error("unexpected wait");
      },
    };
    const factory = (origin: string, token: string): ThreadsCiSdk => {
      seen.push({ origin, token });
      return client;
    };
    const streams = capture(project, {}, `${APP_SECRET}\n`);

    const exit = await run(
      [
        "server",
        "--project",
        project,
        "connect",
        "threads",
        "--request-id",
        "task3:connect",
        "--app-secret-stdin",
        "--json",
      ],
      streams.io,
      {},
      {
        stateRoot,
        threadsClientFactory: factory,
        now: () => Date.parse("2026-11-02T00:00:00.000Z"),
      },
    );

    expect(exit).toBe(0);
    expect(seen).toEqual([{ origin: ORIGIN, token: ADMIN }]);
    expect(oneEnvelope(streams.stdout())).toMatchObject({
      operation: "server",
      ok: true,
      result: {
        subcommand: "connect",
        provider: "threads",
        status: "connected",
        connectionId: "conn_verified_task3",
        callbackUrl: `${ORIGIN}/oauth/callback/threads`,
      },
    });
    const config = await fs.readFile(path.join(project, "syndroo.config.jsonc"), "utf8");
    expect(config).toContain('"connectionId": "conn_verified_task3"');
    expect(config).not.toContain(APP_SECRET);
    expect(`${streams.stdout()}${streams.stderr()}`).not.toContain(APP_SECRET);
  });

  it("clears an authoritative expired attempt so a fresh reconnect can start", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = await seedDeployment(root, project);
    let expired = true;
    const client: ThreadsCiSdk = {
      async connect(request) {
        if (request.type === "start") {
          return {
            status: "action_required",
            connectSessionId: "cs_expiry",
            stepRevision: 0,
            action: { type: "credential_input", fields: [] },
            expiresAt: "2026-11-02T00:30:00.000Z",
          } as never;
        }
        if (request.type === "resume" && request.stepRevision === 0) {
          return {
            status: "action_required",
            connectSessionId: "cs_expiry",
            stepRevision: 1,
            action: { type: "open_url", url: "https://threads.example/oauth" },
            expiresAt: expired
              ? "2026-11-02T00:00:00.000Z"
              : "2026-11-02T00:30:00.000Z",
          } as never;
        }
        return {
          status: "done",
          connection: {
            connectionId: "conn_after_expiry",
            presentation: { accountName: "fixture" },
          },
        } as never;
      },
      async publish() {
        throw new Error("unexpected publish");
      },
      async wait() {
        throw new Error("unexpected wait");
      },
    };
    const first = capture(project, { THREADS_APP_SECRET: APP_SECRET });
    const firstExit = await run(
      [
        "server",
        "--project",
        project,
        "connect",
        "threads",
        "--request-id",
        "task3:expired",
        "--json",
      ],
      first.io,
      {},
      {
        stateRoot,
        threadsClientFactory: () => client,
        now: () => Date.parse("2026-11-02T00:00:00.000Z"),
      },
    );

    expect(firstExit).not.toBe(0);
    expect(oneEnvelope(first.stdout()).error).toMatchObject({
      code: "SERVER_THREADS_AUTHORIZATION_EXPIRED",
      details: { nextAction: "RESTART_THREADS_CONNECT" },
    });
    expect(oneEnvelope(first.stdout()).error.details).not.toHaveProperty("operationId");
    expect(await loadThreadsConnectDraft(stateRoot, PROJECT_ID)).toBeNull();

    expired = false;
    const second = capture(project, { THREADS_APP_SECRET: APP_SECRET });
    const secondExit = await run(
      [
        "server",
        "--project",
        project,
        "connect",
        "threads",
        "--json",
      ],
      second.io,
      {},
      {
        stateRoot,
        threadsClientFactory: () => client,
        randomUUID: () => "task3-fresh-request",
        now: () => Date.parse("2026-11-02T00:00:00.000Z"),
      },
    );

    expect(secondExit).toBe(0);
    expect(oneEnvelope(second.stdout()).result).toMatchObject({
      status: "connected",
      connectionId: "conn_after_expiry",
    });
  });

  it("reuses one request identity for simultaneous starts", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = await seedDeployment(root, project);
    const requestIds: Array<string | undefined> = [];
    let started = 0;
    let releaseStarts!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseStarts = resolve;
    });
    const client: ThreadsCiSdk = {
      async connect(_request, options) {
        requestIds.push(options?.idempotencyKey);
        started += 1;
        if (started === 2) releaseStarts();
        await bothStarted;
        throw new ThreadsCiError("CALLBACK_TIMEOUT", "fixture timeout", 1);
      },
      async publish() {
        throw new Error("unexpected publish");
      },
      async wait() {
        throw new Error("unexpected wait");
      },
    };
    let generated = 0;
    const runConnect = (): ReturnType<typeof run> => {
      const output = capture(project, { THREADS_APP_SECRET: APP_SECRET });
      return run(
        ["server", "--project", project, "connect", "threads", "--json"],
        output.io,
        {},
        {
          stateRoot,
          threadsClientFactory: () => client,
          randomUUID: () => `task3-concurrent-${++generated}`,
          now: () => Date.parse("2026-11-02T00:00:00.000Z"),
        },
      );
    };

    const exits = await Promise.all([runConnect(), runConnect()]);

    expect(exits).not.toContain(0);
    expect(generated).toBe(1);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe("task3-concurrent-1");
    expect(requestIds[1]).toBe(requestIds[0]);
    expect(await loadThreadsConnectDraft(stateRoot, PROJECT_ID)).toMatchObject({
      requestId: "task3-concurrent-1",
    });
  });

  it("does not apply or clear a stale completion after a newer draft is claimed", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = await seedDeployment(root, project);
    let releaseStart!: () => void;
    let enteredStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const started = new Promise<void>((resolve) => {
      enteredStart = resolve;
    });
    const client: ThreadsCiSdk = {
      async connect(request) {
        if (request.type === "start") {
          enteredStart();
          await gate;
          return {
            status: "action_required",
            connectSessionId: "cs_stale",
            stepRevision: 0,
            action: { type: "credential_input", fields: [] },
            expiresAt: "2026-11-02T00:30:00.000Z",
          } as never;
        }
        return {
          status: "done",
          connection: {
            connectionId: "conn_stale_completion",
            presentation: { accountName: "stale" },
          },
        } as never;
      },
      async publish() {
        throw new Error("unexpected publish");
      },
      async wait() {
        throw new Error("unexpected wait");
      },
    };
    const output = capture(project, { THREADS_APP_SECRET: APP_SECRET });
    const pending = run(
      ["server", "--project", project, "connect", "threads", "--json"],
      output.io,
      {},
      {
        stateRoot,
        threadsClientFactory: () => client,
        randomUUID: () => "task3:older",
        now: () => Date.parse("2026-11-02T00:00:00.000Z"),
      },
    );

    await started;
    await saveThreadsConnectDraft(stateRoot, {
      version: 1,
      projectId: PROJECT_ID,
      origin: ORIGIN,
      appId: "123456789",
      requestId: "task3:newer",
      createdAt: "2026-11-02T00:01:00.000Z",
    });
    releaseStart();
    const exit = await pending;

    expect(exit).not.toBe(0);
    expect(oneEnvelope(output.stdout()).error).toMatchObject({
      code: "SERVER_THREADS_STALE_CONNECT",
      details: { nextAction: "INSPECT_THREADS_CONNECT_STATE" },
    });
    expect(await loadThreadsConnectDraft(stateRoot, PROJECT_ID)).toMatchObject({
      requestId: "task3:newer",
    });
    const config = await fs.readFile(path.join(project, "syndroo.config.jsonc"), "utf8");
    expect(config).toContain(`"connectionId": "${CONNECTION_ID}"`);
    expect(config).not.toContain("conn_stale_completion");
  });

  it("does not apply completion after the project deployment origin changes", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = await seedDeployment(root, project);
    let releaseStart!: () => void;
    let enteredStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const started = new Promise<void>((resolve) => {
      enteredStart = resolve;
    });
    const client: ThreadsCiSdk = {
      async connect(request) {
        if (request.type === "start") {
          enteredStart();
          await gate;
          return {
            status: "action_required",
            connectSessionId: "cs_binding",
            stepRevision: 0,
            action: { type: "credential_input", fields: [] },
            expiresAt: "2026-11-02T00:30:00.000Z",
          } as never;
        }
        return {
          status: "done",
          connection: {
            connectionId: "conn_binding_changed",
            presentation: { accountName: "binding" },
          },
        } as never;
      },
      async publish() {
        throw new Error("unexpected publish");
      },
      async wait() {
        throw new Error("unexpected wait");
      },
    };
    const output = capture(project, { THREADS_APP_SECRET: APP_SECRET });
    const pending = run(
      ["server", "--project", project, "connect", "threads", "--json"],
      output.io,
      {},
      {
        stateRoot,
        threadsClientFactory: () => client,
        randomUUID: () => "task3:binding",
        now: () => Date.parse("2026-11-02T00:00:00.000Z"),
      },
    );

    await started;
    await updateServerConfig(project, {
      publicOrigin: "https://changed.threads.example",
    });
    releaseStart();
    const exit = await pending;

    expect(exit).not.toBe(0);
    expect(oneEnvelope(output.stdout()).error).toMatchObject({
      code: "SERVER_THREADS_BINDING_CHANGED",
      details: { nextAction: "INSPECT_THREADS_CONNECT_STATE" },
    });
    expect(await loadThreadsConnectDraft(stateRoot, PROJECT_ID)).toMatchObject({
      requestId: "task3:binding",
      origin: ORIGIN,
    });
    const config = await fs.readFile(path.join(project, "syndroo.config.jsonc"), "utf8");
    expect(config).toContain('"publicOrigin": "https://changed.threads.example"');
    expect(config).toContain(`"connectionId": "${CONNECTION_ID}"`);
    expect(config).not.toContain("conn_binding_changed");
  });

  it("requires explicit --restart permission to abandon an ambiguous pending draft", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = await seedDeployment(root, project);
    await saveThreadsConnectDraft(stateRoot, {
      version: 1,
      projectId: PROJECT_ID,
      origin: ORIGIN,
      appId: "123456789",
      requestId: "task3:pending",
      createdAt: "2026-11-02T00:00:00.000Z",
    });
    const client: ThreadsCiSdk = {
      async connect(request) {
        if (request.type === "start") {
          return {
            status: "action_required",
            connectSessionId: "cs_restart",
            stepRevision: 0,
            action: { type: "credential_input", fields: [] },
            expiresAt: "2026-11-02T00:30:00.000Z",
          } as never;
        }
        return {
          status: "done",
          connection: {
            connectionId: "conn_restarted",
            presentation: { accountName: "restart" },
          },
        } as never;
      },
      async publish() {
        throw new Error("unexpected publish");
      },
      async wait() {
        throw new Error("unexpected wait");
      },
    };
    const rejected = capture(project, { THREADS_APP_SECRET: APP_SECRET });
    const rejectedExit = await run(
      [
        "server", "--project", project, "connect", "threads",
        "--request-id", "task3:replacement", "--json",
      ],
      rejected.io,
      {},
      {
        stateRoot,
        threadsClientFactory: () => client,
        now: () => Date.parse("2026-11-02T00:00:00.000Z"),
      },
    );

    expect(rejectedExit).not.toBe(0);
    expect(oneEnvelope(rejected.stdout()).error.code).toBe("SERVER_THREADS_RESUME_CONFLICT");
    expect(await loadThreadsConnectDraft(stateRoot, PROJECT_ID)).toMatchObject({
      requestId: "task3:pending",
    });

    const restartWithoutIdentity = capture(project, { THREADS_APP_SECRET: APP_SECRET });
    const restartWithoutIdentityExit = await run(
      [
        "server", "--project", project, "connect", "threads",
        "--restart", "--json",
      ],
      restartWithoutIdentity.io,
      {},
      {
        stateRoot,
        threadsClientFactory: () => client,
        now: () => Date.parse("2026-11-02T00:00:00.000Z"),
      },
    );

    expect(restartWithoutIdentityExit).toBe(0);
    expect(oneEnvelope(restartWithoutIdentity.stdout()).result).toMatchObject({
      connectionId: "conn_restarted",
      requestId: "task3:pending",
    });

    await saveThreadsConnectDraft(stateRoot, {
      version: 1,
      projectId: PROJECT_ID,
      origin: ORIGIN,
      appId: "123456789",
      requestId: "task3:pending",
      createdAt: "2026-11-02T00:00:00.000Z",
    });

    const restarted = capture(project, { THREADS_APP_SECRET: APP_SECRET });
    const restartedExit = await run(
      [
        "server", "--project", project, "connect", "threads",
        "--restart", "--request-id", "task3:replacement", "--json",
      ],
      restarted.io,
      {},
      {
        stateRoot,
        threadsClientFactory: () => client,
        now: () => Date.parse("2026-11-02T00:00:00.000Z"),
      },
    );

    expect(restartedExit).toBe(0);
    expect(oneEnvelope(restarted.stdout()).result).toMatchObject({
      connectionId: "conn_restarted",
      requestId: "task3:replacement",
    });
    expect(await loadThreadsConnectDraft(stateRoot, PROJECT_ID)).toBeNull();
  });
});

describe("server ci setup github", () => {
  it("writes a manual workflow and reuses the private CI token after a partial GitHub update", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = await seedDeployment(root, project);
    let githubSecretAttempts = 0;
    let remoteCiInstalled = false;
    const payloads: Uint8Array[] = [];
    const runner = new ScriptedRunner((request) => {
      if (request.tool === "git" && request.args[0] === "remote") {
        return processResult(0, "git@github.com:octocat/syndroo-site.git\n");
      }
      if (request.tool === "gh" && request.args[0] === "repo" && request.args[1] === "view") {
        return processResult(
          0,
          JSON.stringify({
            id: "R_fixture",
            nameWithOwner: "octocat/syndroo-site",
            isPrivate: true,
            url: "https://github.com/octocat/syndroo-site",
          }),
        );
      }
      if (request.tool === "wrangler" && request.args[0] === "whoami") {
        return processResult(
          0,
          JSON.stringify({
            loggedIn: true,
            authType: "OAuth Token",
            accounts: [{ id: "account_fixture", name: "Fixture" }],
          }),
        );
      }
      if (request.tool === "wrangler" && request.args[0] === "auth") {
        return processResult(0, JSON.stringify({ type: "oauth", token: "fixture-api-token" }));
      }
      if (request.tool === "wrangler" && request.args[0] === "secret" && request.args[1] === "list") {
        return processResult(
          0,
          JSON.stringify(
            remoteCiInstalled
              ? [{ name: "CI_BEARER" }, { name: "CI_CONNECTION_ID" }]
              : [],
          ),
        );
      }
      if (request.tool === "wrangler" && request.args[0] === "secret" && request.args[1] === "bulk") {
        if (request.stdin !== undefined) payloads.push(request.stdin);
        remoteCiInstalled = true;
        return processResult();
      }
      if (request.tool === "gh" && request.args[0] === "secret" && request.args[1] === "set") {
        if (request.stdin !== undefined) payloads.push(request.stdin);
        githubSecretAttempts += 1;
        return processResult(githubSecretAttempts === 1 ? 1 : 0);
      }
      if (request.tool === "gh" && request.args[0] === "api" && request.args.includes("--include")) {
        return processResult(0, "HTTP/2.0 200 OK\n{}\n");
      }
      return processResult();
    });
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: { default_environment: { script: { tag: "worker_tag_fixture" } } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const first = capture(project);
    const firstExit = await run(
      [
        "server",
        "--project",
        project,
        "ci",
        "setup",
        "github",
        "--yes",
        "--json",
      ],
      first.io,
      {},
      { stateRoot, processRunner: runner, fetch },
    );

    expect(firstExit).not.toBe(0);
    expect(await fs.readFile(path.join(project, ".github/workflows/threads-publish.yml"), "utf8"))
      .toContain("workflow_dispatch:");
    expect(await fs.readFile(path.join(project, ".github/workflows/threads-publish.yml"), "utf8"))
      .toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(runner.calls.some((call) =>
      call.tool === "gh" && call.args[0] === "api" && call.args[1] === "--method" && call.args[2] === "PUT",
    )).toBe(false);
    expect(payloads[0]).toBeDefined();
    const firstBearer = JSON.parse(Buffer.from(payloads[0] as Uint8Array).toString("utf8"))
      .CI_BEARER as string;
    expect(firstBearer).toMatch(/^[A-Za-z0-9._~+/-]{32,1024}$/);
    expect(firstBearer).not.toBe(ADMIN);

    const second = capture(project);
    const secondExit = await run(
      [
        "server",
        "--project",
        project,
        "ci",
        "setup",
        "github",
        "--yes",
        "--json",
      ],
      second.io,
      {},
      { stateRoot, processRunner: runner, fetch },
    );

    expect(secondExit).toBe(0);
    expect(runner.calls.some((call) => call.tool === "git" && call.args[0] === "push")).toBe(false);
    expect(runner.calls.some((call) => call.tool === "gh" && call.args[0] === "workflow")).toBe(false);
    expect(
      runner.calls
        .filter((call) => call.tool === "wrangler" && call.args[1] === "bulk")
        .every((call) => !call.args.some((arg) => arg.includes(firstBearer))),
    ).toBe(true);
    expect(runner.calls.some((call) => call.tool === "gh" && call.args.includes(ADMIN))).toBe(false);
    expect(runner.calls
      .filter((call) => call.tool === "wrangler" && call.args[0] === "secret")
      .every((call) => call.args.includes("--config") && call.environment?.["CLOUDFLARE_ACCOUNT_ID"] === "account_fixture"))
      .toBe(true);
    expect(oneEnvelope(second.stdout()).result).toMatchObject({
      subcommand: "ci",
      status: "configured",
      workflow: "unchanged",
      ciConnectionId: CONNECTION_ID,
    });
  });

  it("reloads the project and deployment after waiting for the state lock", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = await seedDeployment(root, project);
    let releaseLock!: () => void;
    let acquiredLock!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      acquiredLock = resolve;
    });
    const holder = withDeploymentStateLock(stateRoot, async () => {
      acquiredLock();
      await release;
    });
    await acquired;

    let sawPreLockGit = false;
    const runner = new ScriptedRunner((request) => {
      if (request.tool === "git" && request.args[0] === "remote") {
        sawPreLockGit = true;
        return processResult(0, "https://github.com/octocat/syndroo-site.git\n");
      }
      if (request.tool === "gh" && request.args[0] === "repo" && request.args[1] === "view") {
        return processResult(0, JSON.stringify({
          id: "R_fixture",
          nameWithOwner: "octocat/syndroo-site",
          isPrivate: true,
          url: "https://github.com/octocat/syndroo-site",
        }));
      }
      return processResult();
    });
    const streams = capture(project);
    const command = run(
      ["server", "--project", project, "ci", "setup", "github", "--yes", "--json"],
      streams.io,
      {},
      { stateRoot, processRunner: runner },
    );

    await new Promise<void>((resolve) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (sawPreLockGit || Date.now() - startedAt >= 25) {
          clearInterval(timer);
          resolve();
        }
      }, 1);
    });
    await updateServerConfig(project, {
      publicOrigin: "https://changed.threads.example",
    });
    releaseLock();
    await holder;
    const exit = await command;

    expect(exit).not.toBe(0);
    expect(oneEnvelope(streams.stdout()).error.code).toBe("SERVER_CI_DEPLOYMENT_MISMATCH");
    expect(runner.calls.filter((call) => call.tool === "gh" || call.tool === "wrangler"))
      .toEqual([]);
  });

  it("rejects a second repository identity even after only a partial CI setup", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = await seedDeployment(root, project);
    let secretAttempts = 0;
    let remoteCiInstalled = false;
    const runner = new ScriptedRunner((request) => {
      if (request.tool === "git" && request.args[0] === "remote") {
        return processResult(0, "https://github.com/octocat/repo-a.git\n");
      }
      if (request.tool === "gh" && request.args[0] === "repo" && request.args[1] === "view") {
        const name = String(request.args[2]);
        const id = name.endsWith("repo-a") ? "R_repo_a" : "R_repo_b";
        return processResult(0, JSON.stringify({
          id,
          nameWithOwner: name,
          isPrivate: true,
          url: `https://github.com/${name}`,
        }));
      }
      if (request.tool === "wrangler" && request.args[0] === "whoami") {
        return processResult(0, JSON.stringify({
          loggedIn: true,
          accounts: [{ id: "account_fixture", name: "Fixture" }],
        }));
      }
      if (request.tool === "wrangler" && request.args[0] === "auth") {
        return processResult(0, JSON.stringify({ type: "oauth", token: "fixture-token" }));
      }
      if (request.tool === "wrangler" && request.args[0] === "secret" && request.args[1] === "list") {
        return processResult(0, JSON.stringify(remoteCiInstalled
          ? [{ name: "CI_BEARER" }, { name: "CI_CONNECTION_ID" }]
          : []));
      }
      if (request.tool === "wrangler" && request.args[0] === "secret" && request.args[1] === "bulk") {
        remoteCiInstalled = true;
        return processResult();
      }
      if (request.tool === "gh" && request.args[0] === "api" && request.args.includes("--include")) {
        return processResult(0, "HTTP/2.0 200 OK\n{}\n");
      }
      if (request.tool === "gh" && request.args[0] === "secret" && request.args[1] === "set") {
        secretAttempts += 1;
        return processResult(secretAttempts === 1 ? 1 : 0);
      }
      return processResult();
    });
    const fetch = vi.fn(async () => new Response(
      JSON.stringify({
        success: true,
        result: { default_environment: { script: { tag: "worker_tag_fixture" } } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const first = capture(project);
    const firstExit = await run(
      ["server", "--project", project, "ci", "setup", "github", "--yes", "--json"],
      first.io,
      {},
      { stateRoot, processRunner: runner, fetch },
    );

    expect(firstExit).not.toBe(0);
    expect(await loadCiState(stateRoot, PROJECT_ID)).toMatchObject({
      github: {
        repoId: "R_repo_a",
        repository: "octocat/repo-a",
        configured: false,
      },
    });
    const callsBeforeSecond = runner.calls.length;
    const second = capture(project);
    const secondExit = await run(
      [
        "server", "--project", project, "ci", "setup", "github",
        "--repo", "octocat/repo-b", "--yes", "--json",
      ],
      second.io,
      {},
      { stateRoot, processRunner: runner, fetch },
    );

    expect(secondExit).not.toBe(0);
    expect(oneEnvelope(second.stdout()).error.code).toBe("SERVER_CI_GITHUB_IDENTITY_MISMATCH");
    expect(runner.calls.slice(callsBeforeSecond)
      .filter((call) => call.tool === "wrangler" ||
        (call.tool === "gh" && call.args[0] !== "repo")))
      .toEqual([]);
    expect(await loadCiState(stateRoot, PROJECT_ID)).toMatchObject({
      github: {
        repoId: "R_repo_a",
        repository: "octocat/repo-a",
        configured: false,
      },
    });
  });

  it("preserves a conflicting workflow and performs no remote mutation", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = await seedDeployment(root, project);
    const workflow = path.join(project, ".github/workflows/threads-publish.yml");
    await fs.mkdir(path.dirname(workflow), { recursive: true });
    await fs.writeFile(workflow, "name: user-owned\n");
    const runner = new ScriptedRunner((request) =>
      request.tool === "git" && request.args[0] === "remote"
        ? processResult(0, "https://github.com/octocat/syndroo-site.git\n")
        : processResult(),
    );
    const streams = capture(project);

    const exit = await run(
      ["server", "--project", project, "ci", "setup", "github", "--yes", "--json"],
      streams.io,
      {},
      { stateRoot, processRunner: runner },
    );

    expect(exit).not.toBe(0);
    expect(await fs.readFile(workflow, "utf8")).toBe("name: user-owned\n");
    expect(runner.calls.filter((call) => call.tool === "gh" || call.tool === "wrangler")).toEqual([]);
    expect(oneEnvelope(streams.stdout())).toMatchObject({
      operation: "server",
      ok: false,
      error: { code: "SERVER_CI_WORKFLOW_CONFLICT" },
    });
  });

  it("rejects a symlinked workflow directory without creating outside files", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = await seedDeployment(root, project);
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(project, ".github"), "dir");
    const runner = new ScriptedRunner(() => processResult());
    const streams = capture(project);

    const exit = await run(
      ["server", "--project", project, "ci", "setup", "github", "--yes", "--json"],
      streams.io,
      {},
      { stateRoot, processRunner: runner },
    );

    expect(exit).not.toBe(0);
    expect(oneEnvelope(streams.stdout()).error.code).toBe("SERVER_CI_WORKFLOW_CONFLICT");
    await expect(fs.lstat(path.join(outside, "workflows"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(runner.calls.filter((call) => call.tool === "gh" || call.tool === "wrangler"))
      .toEqual([]);
  });

  it("rejects a workflow target symlink even when its content matches", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = await seedDeployment(root, project);
    const workflowDirectory = path.join(project, ".github/workflows");
    await fs.mkdir(workflowDirectory, { recursive: true });
    const outsideTarget = path.join(root, "outside-workflow.yml");
    await fs.writeFile(outsideTarget, SERVER_CI_WORKFLOW);
    const workflow = path.join(workflowDirectory, "threads-publish.yml");
    await fs.symlink(outsideTarget, workflow);
    const runner = new ScriptedRunner(() => processResult());
    const streams = capture(project);

    const exit = await run(
      ["server", "--project", project, "ci", "setup", "github", "--yes", "--json"],
      streams.io,
      {},
      { stateRoot, processRunner: runner },
    );

    expect(exit).not.toBe(0);
    expect(oneEnvelope(streams.stdout()).error.code).toBe("SERVER_CI_WORKFLOW_CONFLICT");
    expect(await fs.readFile(outsideTarget, "utf8")).toBe(SERVER_CI_WORKFLOW);
    expect((await fs.lstat(workflow)).isSymbolicLink()).toBe(true);
    expect(runner.calls.filter((call) => call.tool === "gh" || call.tool === "wrangler"))
      .toEqual([]);
  });

  it("recovers a missing local CI bearer only through explicit safe input", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = await seedDeployment(root, project);
    const recoveredBearer = "recovered.ci-token-that-is-at-least-thirty-two";
    const uploads: string[] = [];
    const runner = new ScriptedRunner((request) => {
      if (request.tool === "git" && request.args[0] === "remote") {
        return processResult(0, "https://github.com/octocat/syndroo-site.git\n");
      }
      if (request.tool === "gh" && request.args[0] === "repo" && request.args[1] === "view") {
        return processResult(0, JSON.stringify({
          id: "R_fixture",
          nameWithOwner: "octocat/syndroo-site",
          isPrivate: true,
          url: "https://github.com/octocat/syndroo-site",
        }));
      }
      if (request.tool === "wrangler" && request.args[0] === "whoami") {
        return processResult(0, JSON.stringify({
          loggedIn: true,
          accounts: [{ id: "account_fixture", name: "Fixture" }],
        }));
      }
      if (request.tool === "wrangler" && request.args[0] === "auth") {
        return processResult(0, JSON.stringify({ type: "oauth", token: "fixture-token" }));
      }
      if (request.tool === "wrangler" && request.args[0] === "secret" && request.args[1] === "list") {
        return processResult(0, JSON.stringify([{ name: "CI_BEARER" }, { name: "CI_CONNECTION_ID" }]));
      }
      if (request.tool === "wrangler" && request.args[0] === "secret" && request.args[1] === "bulk") {
        uploads.push(Buffer.from(request.stdin ?? []).toString("utf8"));
        return processResult();
      }
      if (request.tool === "gh" && request.args[0] === "api") {
        return processResult(0, "HTTP/2.0 200 OK\n{}\n");
      }
      return processResult();
    });
    const fetch = vi.fn(async () => new Response(
      JSON.stringify({
        success: true,
        result: { default_environment: { script: { tag: "worker_tag_fixture" } } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const args = [
      "server",
      "--project",
      project,
      "ci",
      "setup",
      "github",
      "--yes",
      "--json",
    ] as const;

    const missing = capture(project);
    const missingExit = await run(args, missing.io, {}, {
      stateRoot,
      processRunner: runner,
      fetch,
    });
    expect(missingExit).not.toBe(0);
    expect(oneEnvelope(missing.stdout()).error).toMatchObject({
      code: "SERVER_CI_TOKEN_RECOVERY_REQUIRED",
      details: { nextAction: "PROVIDE_CI_BEARER" },
    });
    expect(uploads).toEqual([]);

    const recovered = capture(project, { SYNDROO_CI_BEARER: recoveredBearer });
    const recoveredExit = await run(args, recovered.io, {}, {
      stateRoot,
      processRunner: runner,
      fetch,
    });
    expect(recoveredExit).toBe(0);
    expect(JSON.parse(uploads[0] ?? "{}" )).toMatchObject({
      CI_BEARER: recoveredBearer,
      CI_CONNECTION_ID: CONNECTION_ID,
    });
    expect(`${recovered.stdout()}${recovered.stderr()}`).not.toContain(recoveredBearer);
  });
});

describe("server deploy wiring", () => {
  it("requires explicit authorization and forwards bounded recovery data", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = path.join(root, "private-state");
    const deploy = vi.fn(async () => ({
      subcommand: "deploy" as const,
      status: "deployed" as const,
      projectDirectory: project,
      accountId: "account_fixture",
      workerName: "fixture-worker",
      origin: ORIGIN,
      versionId: "version_fixture",
      workerTag: "worker_tag_fixture",
      resources: { d1: { name: "fixture-db", id: "d1_fixture" }, queues: [] },
    }));
    const recoveryFile = path.join(root, "recovery.json");
    await fs.writeFile(
      recoveryFile,
      JSON.stringify({ d1Id: "d1_fixture", workerTag: "worker_tag_fixture", versionId: "version_fixture" }),
    );
    const streams = capture(project);

    const exit = await run(
      [
        "server",
        "--project",
        project,
        "deploy",
        "--account",
        "account_fixture",
        "--recover",
        recoveryFile,
        "--yes",
        "--json",
      ],
      streams.io,
      {},
      { stateRoot, runDeploy: deploy },
    );

    expect(exit).toBe(0);
    expect(deploy).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: project, stateRoot }),
      expect.objectContaining({
        authorized: true,
        account: "account_fixture",
        projectDirectory: project,
        recover: {
          d1Id: "d1_fixture",
          workerTag: "worker_tag_fixture",
          versionId: "version_fixture",
        },
      }),
    );
  });
});

describe("server doctor deployment checks", () => {
  it("checks verified resources and marks OAuth/publication readiness unverified without state writes", async () => {
    const root = await temporaryRoot();
    const project = await writeProject(root);
    const stateRoot = await seedDeployment(root, project);
    const runner = new ScriptedRunner((request) => {
      if (request.tool === "wrangler" && request.args[0] === "whoami") {
        return processResult(0, JSON.stringify({
          loggedIn: true,
          accounts: [{ id: "account_fixture", name: "Fixture" }],
        }));
      }
      if (request.tool === "wrangler" && request.args[0] === "auth") {
        return processResult(0, JSON.stringify({ type: "oauth", token: "fixture-token" }));
      }
      return processResult();
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `${ORIGIN}/health`) {
        return new Response("ok", { status: 200 });
      }
      const result = url.includes("/workers/services/")
        ? { default_environment: { script: { tag: "worker_tag_fixture" } } }
        : url.includes("/d1/database/")
          ? { uuid: "d1_fixture", name: "fixture-db" }
          : url.includes("/queues/queue_work")
            ? { queue_id: "queue_work", queue_name: "fixture-work" }
            : { queue_id: "queue_dead", queue_name: "fixture-dead" };
      return new Response(JSON.stringify({ success: true, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const before = await fs.readdir(root, { recursive: true });
    const streams = capture(project);

    const exit = await run(
      ["server", "--project", project, "doctor", "--json"],
      streams.io,
      {},
      { stateRoot, processRunner: runner, fetch },
    );

    expect(exit).toBe(0);
    expect(oneEnvelope(streams.stdout()).result).toMatchObject({
      subcommand: "doctor",
      status: "ok",
      checks: expect.arrayContaining([
        { name: "deployment", status: "ok" },
        { name: "credentials", status: "ok" },
        { name: "cloudflare-resources", status: "ok" },
        { name: "liveness", status: "ok" },
        { name: "oauth-readiness", status: "unverified" },
        { name: "publication-readiness", status: "unverified" },
      ]),
    });
    expect(await fs.readdir(root, { recursive: true })).toEqual(before);
  });
});
