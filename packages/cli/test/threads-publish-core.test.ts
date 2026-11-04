import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { SyndrooError } from "@syndroo/sdk";

import type * as T from "../../../packages/core/src/domain/records.js";
import { compileProviderSchema } from "../../../packages/core/src/protocol/compiler.js";
import { createCore } from "../../../packages/core/src/runtime.js";
import threadsPlugin from "../../../packages/provider-threads/src/index.js";
import { MemoryCredentials, MemoryState } from "../../../tests/fixtures/state/memory.js";

import type { CliIo } from "../src/io.js";
import { run } from "../src/main.js";
import {
  runThreadsPublish,
  type ThreadsCiSdk,
} from "../src/server/threads-flow.js";

/**
 * Issue #2 regression: the CLI builds a `prepare` request whose target must
 * carry the exact post text in `options.text`, because the Threads provider's
 * `publishOptions` schema requires it and `freezePost` reads only
 * `input.options.text`.
 *
 * These tests pass the request the CLI actually builds through the real Core
 * use case, the real Threads provider manifest and the real freeze function.
 * A permissive SDK stub would accept `content.text` alone and hide the defect.
 */

const API_HOST = "https://graph.threads.net";
const PROFILE_ORIGIN = "https://www.threads.net";
const ACCOUNT_ID = "threads-account-fixture";
const ACCESS_TOKEN = "threads-access-token-canary";
const CONNECTION_ID = "conn_threads_fixture";
const PROJECT_ID = "f0c4f706-25a4-4df7-a84c-3b247c64abfe";
const ORIGIN = "https://threads.example";
const CI_SECRET = "ci.fixture-token-that-is-at-least-thirty-two";

const TEXTS = {
  ascii: "Hello from CI",
  unicode: "Publ\u00edcalo \ud83d\ude80 \u2014 \u4f60\u597d caf\u00e9",
  whitespace: "  line one\nline two\t\n\n line three  ",
} as const;

type SentRequest = {
  readonly method: string;
  readonly path: string;
  readonly url: URL;
};

function threadsCoreHarness() {
  let sequence = 0;
  let time = "2026-11-04T00:00:00.000Z";
  const state = new MemoryState("threads-core-test");
  const credentials = new MemoryCredentials(state);
  const requests: SentRequest[] = [];

  const transport: T.ProviderTransport = {
    async request(input) {
      const url = new URL(input.url);
      requests.push({ method: input.method, path: url.pathname, url });
      if (input.method === "GET" && url.pathname === "/me") {
        return {
          type: "response",
          status: 200,
          headers: {},
          body: JSON.stringify({ id: ACCOUNT_ID, username: "fixture.threads" }),
        };
      }
      if (input.method === "POST" && url.pathname === "/me/threads") {
        return {
          type: "response",
          status: 200,
          headers: {},
          body: JSON.stringify({ id: "threads-post-fixture" }),
        };
      }
      return { type: "transport_error", stage: "before_request", code: "unexpected_fixture_request" };
    },
  };

  const implementation: T.Implementation = {
    provider: "threads",
    packageName: "@syndroo/provider-threads",
    version: threadsPlugin.manifest.version,
    apiVersion: 1,
    artifactFingerprint: "artifact-threads-fixture",
    schemaFingerprint: "schema-threads-fixture",
  };

  async function load(): Promise<T.LoadedProvider> {
    return {
      plugin: threadsPlugin,
      implementation: { ...implementation },
      validators: {
        connectOptions: compileProviderSchema(threadsPlugin.manifest.schemas.connectOptions),
        credentialInput: compileProviderSchema(threadsPlugin.manifest.schemas.credentialInput),
        content: compileProviderSchema(threadsPlugin.manifest.schemas.content),
        publishOptions: compileProviderSchema(threadsPlugin.manifest.schemas.publishOptions),
      },
    };
  }

  const providers: T.ProviderRegistry = {
    async describe() {
      return {
        provider: "threads",
        availability: "available",
        provenance: "official",
        implementation: { ...implementation },
        manifest: threadsPlugin.manifest,
      };
    },
    async list() {
      return [
        {
          provider: "threads",
          availability: "available",
          provenance: "official",
          implementation: { ...implementation },
        },
      ];
    },
    async load() {
      return await load();
    },
  };

  const digest = async (value: T.Json, keyed: boolean): Promise<T.Digest> => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (!keyed) {
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
    }
    const key = new TextEncoder().encode("threads-core-test-key");
    const signature = await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      bytes,
    );
    return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
  };

  const deps: T.CoreDependencies = {
    state,
    credentials,
    providers,
    clock: { now: () => time },
    entropy: {
      id: (prefix) => `${prefix}_${++sequence}`,
      token: () => `token_${++sequence}`,
    },
    digests: {
      canonical: (value) => digest(value, false),
      sensitive: (value) => digest(value, true),
    },
    providerContext: () => ({
      now: time,
      signal: new AbortController().signal,
      transport,
    }),
    execution: { type: "foreground" },
  };

  const { core } = createCore(deps);

  async function seedConnection(): Promise<void> {
    const staged = await credentials.put({
      creationId: CONNECTION_ID,
      owner: { kind: "credential", ownerId: CONNECTION_ID, version: 1 },
      value: { apiHost: API_HOST, accessToken: ACCESS_TOKEN, username: "fixture.threads" },
    });
    const connection: T.ConnectionRecord = {
      connectionId: CONNECTION_ID,
      account: { provider: "threads", accountId: ACCOUNT_ID, origin: PROFILE_ORIGIN },
      isDefault: true,
      active: true,
      revision: 1,
      bindingRevision: 1,
      credentialRevision: 1,
      secretRef: staged.ref,
      observations: [],
    };
    state.connections.set(CONNECTION_ID, connection);
  }

  /** Adapt the real Core to the narrow client surface the CLI consumes. */
  const client: ThreadsCiSdk = {
    async connect() {
      throw new Error("unexpected connect call");
    },
    async publish(request, options) {
      const context: T.CallContext = {
        principalId: "owner",
        ...(options?.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: options.idempotencyKey }),
        signal: new AbortController().signal,
      };
      const result = request.type === "execute"
        ? await core.publish(
            { type: "execute", approvalToken: request.approvalToken },
            context,
          )
        : await core.publish(
            request as unknown as T.PrepareRequest | T.RetryRequest,
            context,
          );
      return result as never;
    },
    async wait(operationId) {
      const status = await core.status(
        { type: "operation", operationId },
        { principalId: "owner", signal: new AbortController().signal },
      );
      if (status.type !== "operation" || status.operation.phase !== "execution") {
        throw new Error("the fixture operation is not in its execution phase");
      }
      return status.operation as never;
    },
  };

  return { state, client, requests, seedConnection };
}

function frozenTargets(harness: ReturnType<typeof threadsCoreHarness>): readonly T.FrozenTarget[] {
  return [...harness.state.intents.values()].flatMap((intent) => intent.targets);
}

describe("Threads publish through real Core and provider freezing", () => {
  for (const [name, text] of Object.entries(TEXTS)) {
    it(`preserves ${name} text exactly through options, freeze, preview and the outgoing request`, async () => {
      const harness = threadsCoreHarness();
      await harness.seedConnection();

      const result = await runThreadsPublish({
        client: harness.client,
        connectionId: CONNECTION_ID,
        requestId: `issue-2:${name}`,
        text,
        yes: true,
        waitTimeoutMs: 5_000,
        pollIntervalMs: 250,
      });

      expect(result.exitCode).toBe(0);
      expect(result.status).toBe("succeeded");
      expect(result.operationId).toMatch(/^op_/);
      expect(result.operationId).not.toBe(`issue-2:${name}`);

      const targets = frozenTargets(harness);
      expect(targets).toHaveLength(1);
      const target = targets[0]!;
      expect(target.canonicalContent).toEqual({ text });
      expect(target.canonicalOptions).toEqual({ text });
      expect(target.frozen.effectiveContent).toEqual({ text });
      expect(target.frozen.effectiveOptions).toEqual({ text });
      expect(target.frozen.payload).toEqual({
        text,
        media_type: "TEXT",
        auto_publish_text: true,
      });
      expect(target.frozen.preview.content).toEqual({ text });
      expect(target.frozen.preview.fields).toContainEqual({ name: "text", value: text });

      const published = harness.requests.filter(
        (request) => request.method === "POST" && request.path === "/me/threads",
      );
      expect(published).toHaveLength(1);
      expect(published[0]!.url.searchParams.get("text")).toBe(text);
    });
  }
});

describe("Threads prepare request shape", () => {
  it("puts the exact input text in the target options the provider validates", async () => {
    const requests: unknown[] = [];
    const prepared = {
      status: "confirmation_required",
      operationId: "op_fixture",
      approvalToken: "approval-fixture",
      expiresAt: "2026-11-04T00:10:00.000Z",
      preview: [],
    };
    const execution = {
      phase: "execution",
      operationId: "op_fixture",
      status: "succeeded",
      deliveries: [
        {
          deliveryId: "delivery_fixture",
          connectionId: CONNECTION_ID,
          account: { provider: "threads", accountId: ACCOUNT_ID, origin: PROFILE_ORIGIN },
          attempts: 1,
          outcome: { status: "succeeded", remoteId: "threads-post-fixture" },
        },
      ],
    };
    const client: ThreadsCiSdk = {
      async connect() {
        throw new Error("unexpected connect");
      },
      async publish(request) {
        requests.push(request);
        return (request.type === "prepare" ? prepared : execution) as never;
      },
      async wait() {
        return execution as never;
      },
    };

    await runThreadsPublish({
      client,
      connectionId: CONNECTION_ID,
      requestId: "issue-2:shape",
      text: TEXTS.whitespace,
      yes: true,
    });

    expect(requests[0]).toEqual({
      type: "prepare",
      content: { text: TEXTS.whitespace },
      targets: [
        {
          provider: "threads",
          connection: CONNECTION_ID,
          options: { text: TEXTS.whitespace },
        },
      ],
    });
  });
});

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

function capture(cwd: string, env: NodeJS.ProcessEnv = {}): Capture {
  const stdout = sink();
  const stderr = sink();
  return {
    io: {
      stdin: Readable.from([]),
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

function oneEnvelope(stdout: string): Record<string, any> {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string) as Record<string, any>;
}

const roots: string[] = [];

async function temporaryProject(): Promise<{ readonly root: string; readonly project: string }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "syndroo-issue-2-")));
  roots.push(root);
  const project = path.join(root, "project");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(
    path.join(project, "syndroo.config.jsonc"),
    `${JSON.stringify(
      {
        version: 1,
        projectId: PROJECT_ID,
        scope: "fixture",
        publicOrigin: ORIGIN,
        threads: { appId: "123456789", connectionId: CONNECTION_ID },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(path.join(project, "post.json"), `${JSON.stringify({ text: TEXTS.ascii })}\n`);
  return { root, project };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("Threads publication diagnostics", () => {
  it("preserves the safe INVALID_INPUT code and never invents an operation from the request id", async () => {
    const { root, project } = await temporaryProject();
    const secretCanary = "Bearer prepare-body-secret-canary-0123456789";
    const rejection = new SyndrooError("PROTOCOL", {
      status: 400,
      serverError: { code: "INVALID_INPUT", message: `rejected: ${secretCanary}` },
    });
    const factory = (): ThreadsCiSdk => ({
      async connect() {
        throw new Error("unexpected connect");
      },
      async publish() {
        throw rejection;
      },
      async wait() {
        throw new Error("unexpected wait");
      },
    });
    const streams = capture(project, { SYNDROO_TOKEN: CI_SECRET });

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
        "issue-2:rejected-prepare",
        "--yes",
        "--json",
      ],
      streams.io,
      {},
      { stateRoot: path.join(root, "state"), threadsClientFactory: factory },
    );

    const output = `${streams.stdout()}${streams.stderr()}`;
    expect(exit).toBe(1);
    const envelope = oneEnvelope(streams.stdout());
    expect(envelope).toMatchObject({
      operation: "server",
      ok: false,
      result: null,
      error: { code: "INVALID_INPUT", message: "The request was rejected as invalid." },
    });
    expect(envelope.error.details).not.toHaveProperty("operationId");
    expect(envelope.error.details?.nextAction).toBe("FIX_THREADS_PUBLICATION");
    expect(output).not.toContain(secretCanary);
    expect(output).not.toContain(CI_SECRET);
    expect(output).not.toContain("issue-2:rejected-prepare");
    expect(output).not.toContain("connection could not be completed");
  });

  it("reports an unexpected publication failure without echoing its response text or claiming a connection failure", async () => {
    const { root, project } = await temporaryProject();
    const secretCanary = "Authorization: Bearer raw-response-secret-canary";
    const factory = (): ThreadsCiSdk => ({
      async connect() {
        throw new Error("unexpected connect");
      },
      async publish() {
        throw new Error(`prepare exploded: ${secretCanary}`);
      },
      async wait() {
        throw new Error("unexpected wait");
      },
    });
    const streams = capture(project, { SYNDROO_TOKEN: CI_SECRET });

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
        "issue-2:unexpected",
        "--yes",
        "--json",
      ],
      streams.io,
      {},
      { stateRoot: path.join(root, "state"), threadsClientFactory: factory },
    );

    const output = `${streams.stdout()}${streams.stderr()}`;
    expect(exit).toBe(1);
    const envelope = oneEnvelope(streams.stdout());
    expect(envelope).toMatchObject({ operation: "server", ok: false, result: null });
    expect(envelope.error.code).not.toBe("SERVER_THREADS_FAILED");
    expect(envelope.error.details).not.toHaveProperty("operationId");
    expect(envelope.error.details?.nextAction).toBe("FIX_THREADS_PUBLICATION");
    expect(output).not.toContain(secretCanary);
    expect(output).not.toContain(CI_SECRET);
    expect(output).not.toContain("connection could not be completed");
  });
});
