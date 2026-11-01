import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Syndroo, SyndrooError } from "@syndroo/sdk";
import type {
  ConnectRequest,
  ConnectResult,
  ExecutionResult,
  PublishRequest,
  PublishResult,
  RequestOptions,
  WaitOptions,
} from "@syndroo/sdk";
import {
  MAX_POST_BYTES,
  ThreadsCiError,
  parseCanonicalHttpsOrigin,
  parsePublishArguments,
  parseThreadsPostBytes,
  runThreadsBootstrap,
  runThreadsPublish,
  threadsCallbackUrl,
  type ThreadsCiSdk,
} from "./lib/threads-ci.js";

const ORIGIN = "https://syndroo.example";
const CONNECTION_ID = "conn_threads_fixture";
const APP_SECRET = "threads-app-secret-canary";
const APPROVAL = "approval-secret-canary";
const TEST_NOW = "2099-01-01T00:00:00.000Z";

const account = {
  provider: "threads",
  accountId: "threads-account-fixture",
  origin: "https://www.threads.net",
} as const;

const credentialStep: ConnectResult = {
  status: "action_required",
  connectSessionId: "cs_fixture",
  stepRevision: 1,
  expiresAt: TEST_NOW,
  action: {
    type: "credential_input",
    fields: [
      { name: "client_id", label: "Threads client id", secret: false },
      { name: "client_secret", label: "Threads client secret", secret: true },
    ],
  },
};

const openUrlStep: ConnectResult = {
  status: "action_required",
  connectSessionId: "cs_fixture",
  stepRevision: 2,
  expiresAt: TEST_NOW,
  action: { type: "open_url", url: "https://www.threads.net/oauth/authorize?state=fixture" },
};

const waitStep: ConnectResult = {
  status: "action_required",
  connectSessionId: "cs_fixture",
  stepRevision: 2,
  expiresAt: TEST_NOW,
  action: { type: "wait_for_callback" },
};

const doneStep: ConnectResult = {
  status: "done",
  connection: {
    connectionId: CONNECTION_ID,
    account,
    isDefault: true,
    active: true,
    observations: [],
    presentation: { accountName: "@fixture.threads" },
  },
};

const prepared: PublishResult = {
  status: "confirmation_required",
  operationId: "op_fixture",
  approvalToken: APPROVAL,
  expiresAt: TEST_NOW,
  preview: [],
};

const executionSucceeded: ExecutionResult = {
  phase: "execution",
  operationId: "op_fixture",
  status: "succeeded",
  deliveries: [
    {
      deliveryId: "delivery_fixture",
      connectionId: CONNECTION_ID,
      account,
      attempts: 1,
      outcome: {
        status: "succeeded",
        remoteId: "threads-post-fixture",
        url: "https://www.threads.net/@fixture/post/fixture",
      },
    },
  ],
};

class FakeSdk implements ThreadsCiSdk {
  readonly connectRequests: ConnectRequest[] = [];
  readonly publishRequests: PublishRequest[] = [];
  readonly publishOptions: (RequestOptions | undefined)[] = [];
  readonly waitOperations: string[] = [];
  private readonly connectResponses: ConnectResult[];
  private readonly publishResponses: (PublishResult | Error)[];
  private readonly waitResponse: ExecutionResult | Error;

  constructor(input: {
    readonly connect?: readonly ConnectResult[];
    readonly publish?: readonly (PublishResult | Error)[];
    readonly wait?: ExecutionResult | Error;
  }) {
    this.connectResponses = [...(input.connect ?? [])];
    this.publishResponses = [...(input.publish ?? [])];
    this.waitResponse = input.wait ?? executionSucceeded;
  }

  async connect(request: ConnectRequest, _options?: RequestOptions): Promise<ConnectResult> {
    this.connectRequests.push(request);
    const response = this.connectResponses.shift();
    if (response === undefined) {
      throw new Error("unexpected fake connect call");
    }
    return response;
  }

  async publish(request: PublishRequest, options?: RequestOptions): Promise<PublishResult> {
    this.publishRequests.push(request);
    this.publishOptions.push(options);
    const response = this.publishResponses.shift();
    if (response === undefined) {
      throw new Error("unexpected fake publish call");
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }

  async wait(operationId: string, _options?: WaitOptions): Promise<ExecutionResult> {
    this.waitOperations.push(operationId);
    if (this.waitResponse instanceof Error) {
      throw this.waitResponse;
    }
    return this.waitResponse;
  }
}

describe("canonical Threads settings", () => {
  it("normalizes a root HTTPS origin and builds the exact callback", () => {
    assert.equal(parseCanonicalHttpsOrigin("https://SYNDROO.example/"), ORIGIN);
    assert.equal(threadsCallbackUrl(ORIGIN), `${ORIGIN}/oauth/callback/threads`);
  });

  it("rejects non-HTTPS, paths, credentials, queries, and fragments", () => {
    for (const value of [
      "http://syndroo.example",
      "https://user:pass@syndroo.example",
      `${ORIGIN}/prefix`,
      `${ORIGIN}?x=1`,
      `${ORIGIN}#fragment`,
    ]) {
      assert.throws(() => parseCanonicalHttpsOrigin(value), ThreadsCiError);
    }
  });

  it("accepts only the strict post shape", () => {
    assert.equal(parseThreadsPostBytes(Buffer.from('{"text":"Hello"}')), "Hello");
    for (const source of [
      "",
      "[]",
      '{"text":""}',
      '{"text":"x","targets":[]}',
      '{"text":1}',
    ]) {
      assert.throws(() => parseThreadsPostBytes(Buffer.from(source)), ThreadsCiError);
    }
    assert.throws(
      () => parseThreadsPostBytes(Buffer.alloc(MAX_POST_BYTES + 1, 0x61)),
      ThreadsCiError,
    );
  });

  it("requires --yes and a valid stable request id", () => {
    assert.throws(
      () => parsePublishArguments(["--input", "post.json"]),
      /--request-id is required/,
    );
    assert.throws(
      () =>
        parsePublishArguments([
          "--input",
          "post.json",
          "--request-id",
          "threads-ci:no-yes",
        ]),
      /explicit --yes/,
    );
    const parsed = parsePublishArguments([
      "--input",
      "post.json",
      "--request-id",
      "threads-ci:abc",
      "--yes",
    ]);
    assert.equal(parsed.yes, true);
    assert.equal(parsed.requestId, "threads-ci:abc");
  });
});

describe("Threads bootstrap", () => {
  it("resumes credentials, prints authorization, polls callback, and returns a connection", async () => {
    const client = new FakeSdk({
      connect: [credentialStep, openUrlStep, waitStep, waitStep, doneStep],
    });
    const authorizations: Array<{ url: string; expiresAt: string; callbackUrl: string }> = [];
    let clock = 0;

    const result = await runThreadsBootstrap({
      client,
      syndrooUrl: ORIGIN,
      appId: "threads-app-id",
      appSecret: APP_SECRET,
      requestId: "threads-connect:test",
      timeoutMs: 10_000,
      intervalMs: 250,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      onAuthorization: (value) => authorizations.push(value),
    });

    assert.equal(result.connectionId, CONNECTION_ID);
    assert.equal(result.callbackUrl, `${ORIGIN}/oauth/callback/threads`);
    assert.equal(client.connectRequests[0]?.type, "start");
    assert.deepEqual(
      client.connectRequests[0]?.type === "start"
        ? client.connectRequests[0].options
        : undefined,
      { redirectUri: `${ORIGIN}/oauth/callback/threads` },
    );
    assert.equal(client.connectRequests[1]?.type, "resume");
    assert.equal(authorizations.length, 1);
    assert.equal(authorizations[0]?.callbackUrl, `${ORIGIN}/oauth/callback/threads`);
    assert.equal(
      JSON.stringify(result).includes(APP_SECRET),
      false,
    );
  });

  it("does not treat a repeated action_required as success", async () => {
    const client = new FakeSdk({
      connect: [credentialStep, credentialStep],
    });
    await assert.rejects(
      () =>
        runThreadsBootstrap({
          client,
          syndrooUrl: ORIGIN,
          appId: "threads-app-id",
          appSecret: APP_SECRET,
          timeoutMs: 2_000,
          intervalMs: 250,
        }),
      (error: unknown) =>
        error instanceof ThreadsCiError && error.code === "CREDENTIALS_REQUIRED_AGAIN",
    );
    assert.equal(client.connectRequests.length, 2);
  });

  it("stops callback polling at the configured deadline", async () => {
    const client = new FakeSdk({
      connect: [credentialStep, openUrlStep, ...Array.from({ length: 10 }, () => waitStep)],
    });
    let clock = 0;
    await assert.rejects(
      () =>
        runThreadsBootstrap({
          client,
          syndrooUrl: ORIGIN,
          appId: "threads-app-id",
          appSecret: APP_SECRET,
          timeoutMs: 1_000,
          intervalMs: 250,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
        }),
      (error: unknown) => error instanceof ThreadsCiError && error.code === "CALLBACK_TIMEOUT",
    );
  });

  it("reports an expired authorization clearly", async () => {
    const expired = { ...openUrlStep, expiresAt: "2020-01-01T00:00:00.000Z" } as const;
    const client = new FakeSdk({ connect: [credentialStep, expired] });
    await assert.rejects(
      () =>
        runThreadsBootstrap({
          client,
          syndrooUrl: ORIGIN,
          appId: "threads-app-id",
          appSecret: APP_SECRET,
          timeoutMs: 2_000,
          intervalMs: 250,
        }),
      (error: unknown) =>
        error instanceof ThreadsCiError && error.code === "AUTHORIZATION_EXPIRED",
    );
  });
});

describe("Threads publication", () => {
  it("prepares once, executes the same approval, and waits for full success", async () => {
    const client = new FakeSdk({
      publish: [prepared, executionSucceeded],
      wait: executionSucceeded,
    });
    const result = await runThreadsPublish({
      client,
      connectionId: CONNECTION_ID,
      requestId: "threads-ci:stable",
      text: "Hello from CI",
      yes: true,
      waitTimeoutMs: 5_000,
      pollIntervalMs: 250,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.status, "succeeded");
    assert.equal(client.publishRequests.length, 2);
    assert.equal(client.publishRequests[0]?.type, "prepare");
    assert.equal(client.publishRequests[1]?.type, "execute");
    assert.equal(
      client.publishRequests[1]?.type === "execute"
        ? client.publishRequests[1].approvalToken
        : undefined,
      APPROVAL,
    );
    assert.equal(client.publishOptions[0]?.idempotencyKey, "threads-ci:stable");
    assert.deepEqual(client.waitOperations, ["op_fixture"]);
    assert.equal(JSON.stringify(result).includes(APPROVAL), false);
  });

  it("sends a prepare replay directly to status without execute or reprepare", async () => {
    const client = new FakeSdk({
      publish: [executionSucceeded],
      wait: executionSucceeded,
    });
    const result = await runThreadsPublish({
      client,
      connectionId: CONNECTION_ID,
      requestId: "threads-ci:replay",
      text: "Replay",
      yes: true,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(client.publishRequests.length, 1);
    assert.equal(client.publishRequests[0]?.type, "prepare");
    assert.deepEqual(client.waitOperations, ["op_fixture"]);
  });

  it("preserves the prepared operation id when the execute response is lost", async () => {
    const client = new FakeSdk({
      publish: [prepared, new SyndrooError("TIMEOUT")],
    });
    const result = await runThreadsPublish({
      client,
      connectionId: CONNECTION_ID,
      requestId: "threads-ci:lost-execute",
      text: "Lost execute response",
      yes: true,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.status, "unknown");
    assert.equal(result.operationId, "op_fixture");
    assert.equal(result.errorCode, "TIMEOUT");
    assert.match(result.message ?? "", /same --request-id/);
    assert.deepEqual(
      client.publishRequests.map((request) => request.type),
      ["prepare", "execute"],
    );
    assert.deepEqual(client.waitOperations, []);
    assert.equal(JSON.stringify(result).includes(APPROVAL), false);
  });

  for (const status of ["failed", "partial", "unknown"] as const) {
    it(`exits nonzero for ${status} and does not publish again`, async () => {
      const outcome: ExecutionResult = {
        ...executionSucceeded,
        status,
        deliveries: executionSucceeded.deliveries.map((delivery) => ({
          ...delivery,
          outcome:
            delivery.outcome === null
              ? null
              : { ...delivery.outcome },
        })),
      };
      if (status === "unknown") {
        outcome.deliveries[0]!.outcome = {
          status: "unknown",
          disposition: "unknown",
          reason: "network",
        };
      }
      const client = new FakeSdk({
        publish: [prepared, outcome],
        wait: outcome,
      });
      const result = await runThreadsPublish({
        client,
        connectionId: CONNECTION_ID,
        requestId: `threads-ci:${status}`,
        text: "Terminal failure fixture",
        yes: true,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.status, status);
      assert.equal(client.publishRequests.length, 2);
    });
  }

  it("exits nonzero for a durable pending result and does not prepare again", async () => {
    const pending: ExecutionResult = {
      phase: "execution",
      operationId: "op_fixture",
      status: "pending",
      deliveries: [],
    };
    const client = new FakeSdk({
      publish: [prepared, pending],
      wait: pending,
    });
    const result = await runThreadsPublish({
      client,
      connectionId: CONNECTION_ID,
      requestId: "threads-ci:pending",
      text: "Pending fixture",
      yes: true,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.status, "pending");
    assert.equal(client.publishRequests.length, 2);
  });

  it("keeps the operation id on timeout and never republishes", async () => {
    const timeout = new SyndrooError("WAIT_TIMEOUT");
    const client = new FakeSdk({
      publish: [prepared, { ...executionSucceeded, status: "running" }],
      wait: timeout,
    });
    const result = await runThreadsPublish({
      client,
      connectionId: CONNECTION_ID,
      requestId: "threads-ci:timeout",
      text: "Timeout fixture",
      yes: true,
      waitTimeoutMs: 1,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.status, "timeout");
    assert.equal(result.operationId, "op_fixture");
    assert.equal(result.errorCode, "WAIT_TIMEOUT");
    assert.equal(client.publishRequests.length, 2);
  });

  it("refuses to prepare without explicit approval", async () => {
    const client = new FakeSdk({ publish: [prepared] });
    await assert.rejects(
      () =>
        runThreadsPublish({
          client,
          connectionId: CONNECTION_ID,
          requestId: "threads-ci:no-yes",
          text: "No approval",
          yes: false,
        }),
      /explicit --yes/,
    );
    assert.equal(client.publishRequests.length, 0);
  });
});

describe("existing SDK integration", () => {
  it("uses the real SDK transport and stable prepare idempotency header", async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const fetch = async (input: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as { type?: string };
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      requests.push({ url: input, headers, body });
      const result =
        body.type === "prepare"
          ? prepared
          : body.type === "execute"
            ? executionSucceeded
            : { type: "operation", operation: executionSucceeded };
      return new Response(
        JSON.stringify({
          protocolVersion: 1,
          operation: input.endsWith("/status") ? "status" : "publish",
          ok: true,
          result,
          error: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = new Syndroo({
      baseUrl: ORIGIN,
      apiKey: "ci-fixture-token",
      fetch,
    });
    const result = await runThreadsPublish({
      client,
      connectionId: CONNECTION_ID,
      requestId: "threads-ci:sdk",
      text: "SDK fixture",
      yes: true,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(requests.length, 3);
    assert.equal(requests[0]?.headers["idempotency-key"], "threads-ci:sdk");
    assert.equal(requests[1]?.headers["idempotency-key"], undefined);
    assert.equal(requests[2]?.headers["idempotency-key"], undefined);
  });
});

describe("workflow template", () => {
  it("is manual, pinned, and carries no admin credential", async () => {
    const path = new URL("../../examples/threads-ci/workflow.yml", import.meta.url);
    const workflow = await readFile(path, "utf8");
    assert.match(workflow, /^on:\s*\n\s+workflow_dispatch:/m);
    assert.match(
      workflow,
      /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/,
    );
    assert.match(
      workflow,
      /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/,
    );
    assert.match(workflow, /npm run build --workspace @syndroo\/sdk/);
    assert.match(workflow, /npm run build:scripts/);
    assert.match(workflow, /--input examples\/threads-ci\/post\.json/);
    assert.doesNotMatch(workflow, /--input[^\n]*\$\{\{/);
    assert.doesNotMatch(workflow, /SYNDROO_ADMIN_TOKEN|API_BEARER|CI_BEARER/);
    assert.doesNotMatch(workflow, /uses:\s*Syndroo\/|threads-publish@/i);
  });
});

describe("executable publication wrapper", () => {
  const scriptPath = fileURLToPath(new URL("./threads-publish.js", import.meta.url));
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const tokenCanary = "wrapper-token-output-canary";

  function runWrapper(
    args: readonly string[],
    overrides: Readonly<Record<string, string>>,
  ): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, [scriptPath, ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, ...overrides },
      timeout: 5_000,
    });
  }

  it("exits nonzero for missing --yes and never prints the CI token", () => {
    const result = runWrapper(
      [
        "--input",
        "examples/threads-ci/post.json",
        "--request-id",
        "threads-ci:wrapper",
      ],
      {
        SYNDROO_URL: "https://syndroo.example",
        SYNDROO_TOKEN: tokenCanary,
        SYNDROO_CONNECTION_ID: CONNECTION_ID,
      },
    );
    assert.equal(result.status, 2);
    assert.match(String(result.stderr), /explicit --yes/);
    assert.equal(`${String(result.stdout)}${String(result.stderr)}`.includes(tokenCanary), false);
  });

  it("exits nonzero for invalid configuration and never prints the CI token", () => {
    const result = runWrapper(
      [
        "--input",
        "examples/threads-ci/post.json",
        "--request-id",
        "threads-ci:wrapper",
        "--yes",
      ],
      {
        SYNDROO_URL: "http://127.0.0.1:9",
        SYNDROO_TOKEN: tokenCanary,
        SYNDROO_CONNECTION_ID: CONNECTION_ID,
      },
    );
    assert.equal(result.status, 2);
    assert.match(String(result.stderr), /canonical HTTPS origin/);
    assert.equal(`${String(result.stdout)}${String(result.stderr)}`.includes(tokenCanary), false);
  });

  it("prints the prepared operation id when the execute response times out", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "syndroo-threads-ci-"));
    const hookPath = join(temporaryDirectory, "offline-fetch-hook.mjs");
    const envelope = {
      protocolVersion: 1,
      operation: "publish",
      ok: true,
      result: prepared,
      error: null,
    };
    await writeFile(
      hookPath,
      `const preparedEnvelope = ${JSON.stringify(envelope)};
const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);
globalThis.setTimeout = (callback, milliseconds, ...args) =>
  originalSetTimeout(callback, Math.min(Number(milliseconds), 20), ...args);
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  if (url.endsWith("/v1/publish") && body.type === "prepare") {
    return new Response(JSON.stringify(preparedEnvelope), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.endsWith("/v1/publish") && body.type === "execute") {
    return new Promise((_resolve, reject) => {
      const keepAlive = originalSetTimeout(() => {}, 1000);
      const signal = init?.signal;
      const abort = () => {
        originalClearTimeout(keepAlive);
        reject(new DOMException("aborted", "AbortError"));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  throw new Error("unexpected offline fetch");
};
`,
      "utf8",
    );

    try {
      const result = runWrapper(
        [
          "--input",
          "examples/threads-ci/post.json",
          "--request-id",
          "threads-ci:lost-execute-wrapper",
          "--yes",
        ],
        {
          SYNDROO_URL: "https://syndroo.example",
          SYNDROO_TOKEN: tokenCanary,
          SYNDROO_CONNECTION_ID: CONNECTION_ID,
          NODE_OPTIONS: `--import=${pathToFileURL(hookPath).href}`,
        },
      );
      assert.equal(result.status, 1);
      const output = JSON.parse(String(result.stdout)) as {
        status?: unknown;
        operationId?: unknown;
        errorCode?: unknown;
        message?: unknown;
      };
      assert.equal(output.status, "unknown");
      assert.equal(output.operationId, "op_fixture");
      assert.equal(output.errorCode, "TIMEOUT");
      assert.match(String(output.message), /same --request-id/);
      assert.equal(`${String(result.stdout)}${String(result.stderr)}`.includes(tokenCanary), false);
      assert.equal(String(result.stdout).includes(APPROVAL), false);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
