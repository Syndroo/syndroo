/**
 * Layer 2: the installed packages, not the workspace sources.
 *
 * This spec is run by `npm run e2e:consumer`, which packs the artifacts and
 * installs them into a directory outside this monorepo before pointing
 * `SYNDROO_CONSUMER_DIR` here. Every SDK and CLI call runs in a child process
 * whose working directory is that install, so Node resolves the packages from
 * the consumer's own `node_modules`.
 *
 * The Worker still lives in this process, so the children reach it through the
 * same 127.0.0.1 proxy the layer 1 gate uses.
 *
 * It is not part of `e2e:local` or `npm test`: without a prepared install there
 * is nothing to test, and a skipped consumer check must not look like a pass.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SyndrooApi } from "../src/client.js";
import { REPOSITORY_ROOT, assertBundleReady, startHarness, type Harness } from "../src/harness.js";
import { startLoopbackProxy, type LoopbackProxy } from "../src/loopback-proxy.js";
import { MOCK_CREDENTIALS } from "../src/redact.js";

const consumerDirectory = process.env["SYNDROO_CONSUMER_DIR"];
const expectedVersion = process.env["SYNDROO_CONSUMER_VERSION"] ?? "";
const source = process.env["SYNDROO_CONSUMER_SOURCE"] ?? "tarball";

if (consumerDirectory === undefined || consumerDirectory.length === 0) {
  throw new Error(
    "SYNDROO_CONSUMER_DIR is not set. Run this spec through `npm run e2e:consumer -- --source tarball`.",
  );
}

const SDK_BIN = join(consumerDirectory, "node_modules", ".bin", "syndroo");
const SDK_PACKAGE = join(
  consumerDirectory,
  "node_modules",
  "@syndroo",
  "sdk",
  "package.json",
);
const CLI_PACKAGE = join(
  consumerDirectory,
  "node_modules",
  "@syndroo",
  "cli",
  "package.json",
);

let harness: Harness;
let proxy: LoopbackProxy;
let started = false;

beforeAll(async () => {
  await assertBundleReady();

  for (const [label, path] of [
    ["the installed SDK", SDK_PACKAGE],
    ["the installed CLI", CLI_PACKAGE],
    ["the installed CLI bin", SDK_BIN],
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(`${label} is missing at ${path}; the consumer install did not complete.`);
    }
  }
});

beforeEach(async () => {
  started = false;
  const instance = await startHarness();
  harness = instance;
  proxy = await startLoopbackProxy(instance);
  started = true;
});

afterEach(async () => {
  if (!started) {
    return;
  }

  started = false;
  await proxy.dispose();
  await harness.dispose();
});

/**
 * The SDK unrefs the timers it sleeps on so a server process is never pinned
 * open by a wait. A one-shot script has the opposite requirement, so it holds a
 * referenced interval for the duration and clears it before exiting. Without
 * this, `posts.wait` can let Node exit mid-poll with no output at all.
 */
const KEEP_ALIVE = [
  "const keepAlive = setInterval(() => {}, 1000);",
  "try {",
].join("\n");

const RELEASE_KEEP_ALIVE = [
  "} finally {",
  "  clearInterval(keepAlive);",
  "}",
].join("\n");

describe("installed packages outside the monorepo", () => {
  it("resolves both packages from the consumer install, not the workspace", async () => {
    const sdk = JSON.parse(await readFile(SDK_PACKAGE, "utf8")) as {
      name: string;
      version: string;
    };
    const cli = JSON.parse(await readFile(CLI_PACKAGE, "utf8")) as {
      name: string;
      version: string;
      dependencies?: Record<string, string>;
    };

    expect(sdk.name).toBe("@syndroo/sdk");
    expect(cli.name).toBe("@syndroo/cli");
    expect(sdk.version).toBe(expectedVersion);
    expect(cli.version).toBe(expectedVersion);
    // The installed CLI depends on exactly the SDK version it shipped with.
    expect(cli.dependencies?.["@syndroo/sdk"]).toBe(sdk.version);

    const resolved = await run(process.execPath, [
      "--input-type=module",
      "--eval",
      'console.log(import.meta.resolve("@syndroo/sdk"));',
    ]);

    expect(resolved.status).toBe(0);
    // The resolution must stay inside the consumer install; a path back into
    // this checkout would mean the workspace leaked into the test.
    expect(resolved.stdout.trim()).toContain(consumerDirectory);
    expect(resolved.stdout.trim()).not.toContain(REPOSITORY_ROOT);
  });

  it("runs the installed SDK against the local harness", async () => {
    const content = `consumer sdk content ${String(Date.now())}`;
    const created = await run(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        KEEP_ALIVE,
        '  const { SyndrooClient } = await import("@syndroo/sdk");',
        '  const client = new SyndrooClient({ baseUrl: process.env["SYNDROO_BASE_URL"], apiKey: process.env["SYNDROO_API_KEY"] });',
        "  const health = await client.health();",
        "  const receipt = await client.posts.create(",
        '    { content: process.env["CONSUMER_CONTENT"], platforms: ["threads"] },',
        '    { idempotencyKey: "consumer-sdk-create-1" },',
        "  );",
        "  console.log(JSON.stringify({ health, id: receipt.id, status: receipt.status }));",
        RELEASE_KEEP_ALIVE,
      ].join("\n"),
    ], {
      CONSUMER_CONTENT: content,
      SYNDROO_BASE_URL: proxy.origin,
      SYNDROO_API_KEY: MOCK_CREDENTIALS.apiKey,
    });

    expect(created.status).toBe(0);

    const receipt = JSON.parse(created.stdout.split("\n").filter(line => line.startsWith("{"))[0] as string) as {
      health: { status: string };
      id: string;
      status: string;
    };

    expect(receipt.health.status).toBe("ok");
    expect(receipt.status).toBe("queued");

    // The local Queue delivers on its own; wait for the real terminal state
    // instead of racing the flush.
    const api = new SyndrooApi(harness);
    const published = await api.waitForPost(
      receipt.id,
      (post) => post.status === "published",
      { timeoutMs: 15_000, description: "the consumer SDK post to publish" },
    );

    expect(published.publications[0]?.externalId).toBeDefined();

    const waited = await run(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        KEEP_ALIVE,
        '  const { SyndrooClient } = await import("@syndroo/sdk");',
        '  const client = new SyndrooClient({ baseUrl: process.env["SYNDROO_BASE_URL"], apiKey: process.env["SYNDROO_API_KEY"] });',
        '  const post = await client.posts.wait(process.env["CONSUMER_POST_ID"], { timeoutMs: 20000 });',
        "  console.log(JSON.stringify({ status: post.status, externalId: post.publications[0]?.externalId ?? null }));",
        RELEASE_KEEP_ALIVE,
      ].join("\n"),
    ], {
      CONSUMER_POST_ID: receipt.id,
      SYNDROO_BASE_URL: proxy.origin,
      SYNDROO_API_KEY: MOCK_CREDENTIALS.apiKey,
    });

    expect(waited.status).toBe(0);
    expect(JSON.parse(waited.stdout.split("\n").filter(line => line.startsWith("{"))[0] as string)).toMatchObject({
      status: "published",
    });
    // One logical post, one remote write, across both installed packages.
    expect(harness.mockSns.requests).toHaveLength(1);
  });

  it("runs the installed CLI end to end", async () => {
    const version = await run(SDK_BIN, ["version"]);

    expect(version.status).toBe(0);
    expect(version.stdout.trim().length).toBeGreaterThan(0);

    const doctor = await run(SDK_BIN, ["doctor", "--json"]);

    expect(doctor.status).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      command: "doctor",
      health: { reachable: true },
    });

    const content = `consumer cli content ${String(Date.now())}`;
    const documentPath = join(consumerDirectory, "consumer-post.json");
    const { writeFile } = await import("node:fs/promises");

    await writeFile(
      documentPath,
      `${JSON.stringify({ content, platforms: ["threads"] }, null, 2)}\n`,
      "utf8",
    );

    const created = await run(SDK_BIN, [
      "posts",
      "create",
      "--file",
      documentPath,
      "--idempotency-key",
      "consumer-cli-create-1",
      "--json",
      "--yes",
    ]);

    expect(created.status).toBe(0);

    const receipt = JSON.parse(created.stdout) as { id: string; accepted: boolean };

    expect(receipt.accepted).toBe(true);

    const api = new SyndrooApi(harness);

    await api.waitForPost(receipt.id, (post) => post.status === "published", {
      timeoutMs: 15_000,
      description: "the consumer CLI post to publish",
    });

    const waited = await run(SDK_BIN, [
      "posts",
      "wait",
      receipt.id,
      "--timeout",
      "20s",
      "--json",
    ]);

    expect(waited.status).toBe(0);
    expect(JSON.parse(waited.stdout)).toMatchObject({
      delivered: true,
      post: { status: "published" },
    });
    expect(harness.mockSns.requests).toHaveLength(1);
  });
});

/** Runs one child process in the consumer directory and captures its output. */
async function run(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  return await new Promise((settle) => {
    const child = spawn(command, [...args], {
      cwd: consumerDirectory as string,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: consumerDirectory as string,
        // The installed packages always talk to the local harness.
        SYNDROO_BASE_URL: proxy.origin,
        SYNDROO_API_KEY: MOCK_CREDENTIALS.apiKey,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += "\nchild did not exit within 60s";
    }, 60_000);

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
      settle({ status: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      settle({ status: code, stdout, stderr });
    });
  });
}

// `source` is recorded by the orchestrator and reported by the runner output;
// keeping it visible here makes a registry run identifiable in the log.
if (source === "registry") {
  process.stderr.write("consumer.e2e: running against a registry install\n");
}
