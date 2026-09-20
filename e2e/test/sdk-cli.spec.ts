/**
 * Layer 1 extension: the published client packages, not just the Worker.
 *
 * The original Mock SNS gate drives the bundled Worker over `Harness.fetch`.
 * This spec adds the two artifacts a user actually installs: the built
 * `@syndroo/sdk` and the built `syndroo` CLI binary. Both reach the same
 * in-process Worker through a 127.0.0.1 proxy, so the full local path
 * (client -> HTTP -> bundle -> D1/Queue -> real adapters -> Mock SNS) is
 * exercised without a real network destination.
 *
 * Layer 2 (installing tarballs outside the monorepo) is `npm run e2e:consumer`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SyndrooClient } from "@syndroo/sdk";

import { SyndrooApi } from "../src/client.js";
import { REPOSITORY_ROOT, assertBundleReady, startHarness, type Harness } from "../src/harness.js";
import { startLoopbackProxy, type LoopbackProxy } from "../src/loopback-proxy.js";
import { MOCK_CREDENTIALS } from "../src/redact.js";

const CLI_BIN = resolve(REPOSITORY_ROOT, "packages", "cli", "dist", "bin.js");
const SDK_ENTRY = resolve(REPOSITORY_ROOT, "packages", "sdk", "dist", "index.js");

type CliRun = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

let harness: Harness;
let proxy: LoopbackProxy;
let fixtureDirectory: string;
let started = false;

beforeAll(async () => {
  await assertBundleReady();

  for (const [label, path] of [
    ["the CLI binary", CLI_BIN],
    ["the SDK build", SDK_ENTRY],
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(
        `Missing ${label} at ${path}. Run \`npm run build\` before this gate; ` +
          "it tests the built packages, not the TypeScript sources.",
      );
    }
  }
});

beforeEach(async () => {
  started = false;
  const instance = await startHarness();
  harness = instance;
  proxy = await startLoopbackProxy(instance);
  fixtureDirectory = await mkdtemp(join(tmpdir(), "syndroo-cli-fixture-"));
  started = true;
});

afterEach(async () => {
  if (!started) {
    return;
  }

  started = false;
  await proxy.dispose();
  await harness.dispose();
  await rm(fixtureDirectory, { recursive: true, force: true });
});

/**
 * Runs the CLI binary as a real child process with no terminal attached. The
 * only credentials it receives are the harness's fake ones.
 *
 * The child is spawned asynchronously on purpose: the Worker it talks to lives
 * in this process, so a blocking `spawnSync` would deadlock the loop that has
 * to answer its HTTP requests.
 */
async function runCli(args: readonly string[]): Promise<CliRun> {
  return await new Promise<CliRun>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: fixtureDirectory,
      env: {
        PATH: process.env["PATH"] ?? "",
        SYNDROO_BASE_URL: proxy.origin,
        SYNDROO_API_KEY: MOCK_CREDENTIALS.apiKey,
        HOME: fixtureDirectory,
      },
      // A closed stdin keeps the run non-interactive without leaving a pipe
      // that never reaches end of file.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`The CLI did not exit: ${args.join(" ")}`));
    }, 30_000);

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
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? -1, stdout, stderr });
    });
  });
}

describe("built SDK against the bundled Worker", () => {
  it("creates, reads, and waits for a post through the real HTTP contract", async () => {
    const client = new SyndrooClient({
      baseUrl: proxy.origin,
      apiKey: MOCK_CREDENTIALS.apiKey,
    });

    await expect(client.health()).resolves.toMatchObject({ status: "ok" });

    const content = `sdk e2e content ${String(Date.now())}`;
    const receipt = await client.posts.create(
      { content, platforms: ["threads"] },
      { idempotencyKey: "sdk-e2e-create-1" },
    );

    // A receipt is acceptance, never delivery: the create answer itself says
    // the post is only queued.
    expect(receipt.status).toBe("queued");

    const queued = await client.posts.get(receipt.id);
    const publicationId = queued.publications[0]?.id;

    expect(publicationId).toBeDefined();
    await harness.deliverQueueMessage({ publicationId: publicationId as string });

    const published = await client.posts.wait(receipt.id, { timeoutMs: 10_000 });

    expect(published.status).toBe("published");
    expect(published.publications[0]?.externalId).toBeDefined();
    expect(harness.mockSns.requests).toHaveLength(1);
    expect(harness.mockSns.requests[0]?.path).toBe("/me/threads");
  });

  it("replays an identical create instead of publishing twice", async () => {
    const client = new SyndrooClient({
      baseUrl: proxy.origin,
      apiKey: MOCK_CREDENTIALS.apiKey,
    });
    const input = {
      content: `sdk replay content ${String(Date.now())}`,
      platforms: ["threads"],
    };
    const options = { idempotencyKey: "sdk-e2e-replay" };

    const first = await client.posts.create(input, options);
    const second = await client.posts.create(input, options);

    expect(second.id).toBe(first.id);

    const queued = await client.posts.get(first.id);
    const publicationId = queued.publications[0]?.id as string;

    await harness.deliverQueueMessage({ publicationId });
    await client.posts.wait(first.id, { timeoutMs: 10_000 });
    // One accepted post, one remote write, even though create ran twice.
    expect(harness.mockSns.requests).toHaveLength(1);
  });
});

describe("built CLI against the bundled Worker", () => {
  it("reports configuration without writing anything", async () => {
    const doctor = await runCli(["doctor", "--json"]);

    expect(doctor.status).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      command: "doctor",
      ok: true,
      health: { reachable: true },
      createRequests: 0,
    });
    expect(harness.mockSns.requests).toHaveLength(0);
  });

  it("validates a document without creating a post", async () => {
    const documentPath = await writeDocument("cli-validate", {
      content: "cli validate content",
      platforms: ["threads"],
    });
    const validated = await runCli([
      "posts",
      "validate",
      "--file",
      documentPath,
      "--json",
    ]);

    expect(validated.status).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({
      command: "posts.validate",
      valid: true,
      createRequests: 0,
    });

    const api = new SyndrooApi(harness);

    expect(await api.listPosts()).toHaveLength(0);
    expect(harness.mockSns.requests).toHaveLength(0);
  });

  it("creates, lists, reads, and waits for a post", async () => {
    const content = `cli e2e content ${String(Date.now())}`;
    const documentPath = await writeDocument("cli-create", {
      content,
      platforms: ["threads"],
    });
    const created = await runCli([
      "posts",
      "create",
      "--file",
      documentPath,
      "--idempotency-key",
      "cli-e2e-create-1",
      "--json",
      "--yes",
    ]);

    expect(created.status).toBe(0);

    const receipt = JSON.parse(created.stdout) as {
      id: string;
      status: string;
      accepted: boolean;
      delivered: boolean;
    };

    expect(receipt.status).toBe("queued");
    // An acceptance receipt is not a delivery.
    expect(receipt.accepted).toBe(true);
    expect(receipt.delivered).toBe(false);

    const replayed = await runCli([
      "posts",
      "create",
      "--file",
      documentPath,
      "--idempotency-key",
      "cli-e2e-create-1",
      "--json",
      "--yes",
    ]);

    expect(replayed.status).toBe(0);
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      id: receipt.id,
      replayed: true,
    });

    const listed = await runCli(["posts", "list", "--json"]);

    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ count: 1 });
    expect((JSON.parse(listed.stdout) as { posts: unknown[] }).posts).toHaveLength(1);

    const read = await runCli(["posts", "get", receipt.id, "--json"]);

    expect(read.status).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({
      command: "posts.get",
      post: { id: receipt.id },
    });

    const api = new SyndrooApi(harness);
    const queued = await api.getPost(receipt.id);
    const publicationId = queued.body.publications[0]?.id as string;

    await harness.deliverQueueMessage({ publicationId });

    const waited = await runCli([
      "posts",
      "wait",
      receipt.id,
      "--timeout",
      "10s",
      "--json",
    ]);

    expect(waited.status).toBe(0);
    expect(JSON.parse(waited.stdout)).toMatchObject({
      command: "posts.wait",
      delivered: true,
      post: { id: receipt.id, status: "published" },
    });
    expect(harness.mockSns.requests).toHaveLength(1);
  });

  it("refuses a non-interactive create that has no idempotency key", async () => {
    const documentPath = await writeDocument("cli-no-key", {
      content: "cli missing key content",
      platforms: ["threads"],
    });
    const result = await runCli([
      "posts",
      "create",
      "--file",
      documentPath,
      "--json",
      "--yes",
    ]);

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      exitCode: 2,
      error: { code: "IDEMPOTENCY_KEY_REQUIRED" },
    });

    const api = new SyndrooApi(harness);

    // Nothing was sent: no post exists and no platform call was made.
    expect(await api.listPosts()).toHaveLength(0);
    expect(harness.mockSns.requests).toHaveLength(0);
  });

  it("prints the bundled Skill path", async () => {
    const result = await runCli(["skill", "path", "--json"]);

    expect(result.status).toBe(0);

    const output = JSON.parse(result.stdout) as { path: string };

    expect(existsSync(join(output.path, "SKILL.md"))).toBe(true);
  });
});

async function writeDocument(name: string, document: unknown): Promise<string> {
  const path = join(fixtureDirectory, `${name}.json`);

  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  return path;
}
