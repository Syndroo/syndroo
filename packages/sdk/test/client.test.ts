import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SyndrooClient,
  isPostDelivered,
  isPostTerminal,
  type SyndrooClientOptions,
} from "../src/index.js";
import {
  headerOf,
  jsonResponse,
  requestAt,
  startFixtureServer,
  type FixtureServer,
} from "./support/loopback.js";

const API_KEY = "test-instance-key-not-a-real-secret";
const servers: FixtureServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();

  while (servers.length > 0) {
    const server = servers.pop();

    if (server !== undefined) {
      await server.close();
    }
  }
});

async function fixture(
  ...args: Parameters<typeof startFixtureServer>
): Promise<FixtureServer> {
  const server = await startFixtureServer(...args);
  servers.push(server);
  return server;
}

function client(
  server: FixtureServer,
  options: Partial<SyndrooClientOptions> = {},
): SyndrooClient {
  return new SyndrooClient({ baseUrl: server.url, apiKey: API_KEY, ...options });
}

const DETAIL = {
  id: "post_1",
  content: "Hello from Syndroo",
  platforms: ["bluesky"],
  status: "published",
  createdAt: "2030-01-02T03:04:05.000Z",
  publications: [
    {
      id: "pub_1",
      postId: "post_1",
      platform: "bluesky",
      provider: "bluesky-native",
      content: "Hello from Syndroo",
      status: "published",
      attempts: 1,
      externalId: "bafyreiexample",
      externalUrl: "https://bsky.app/profile/alice/post/3example",
      errorAmbiguous: false,
      createdAt: "2030-01-02T03:04:05.000Z",
      publishedAt: "2030-01-02T03:04:06.000Z",
    },
  ],
};

describe("SyndrooClient.posts.create", () => {
  it("sends the documented request and reports the 202 receipt as acceptance only", async () => {
    const server = await fixture((_request, response) => {
      jsonResponse(response, 202, { id: "post_1", status: "queued" });
    });

    const receipt = await client(server).posts.create(
      { content: "Hello from Syndroo", platforms: ["bluesky"] },
      { idempotencyKey: "release-announcement-001" },
    );

    expect(receipt).toEqual({ id: "post_1", status: "queued" });
    expect(isPostDelivered(receipt.status)).toBe(false);
    expect(isPostTerminal(receipt.status)).toBe(false);

    const sent = requestAt(server);
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("/v1/posts");
    expect(headerOf(sent, "authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headerOf(sent, "content-type")).toBe("application/json");
    expect(headerOf(sent, "idempotency-key")).toBe("release-announcement-001");
    expect(JSON.parse(sent.body)).toEqual({
      content: "Hello from Syndroo",
      platforms: ["bluesky"],
    });
  });

  it("reports a replayed create without inventing a second post", async () => {
    const server = await fixture((_request, response) => {
      jsonResponse(response, 200, {
        id: "post_1",
        status: "published",
        replayed: true,
      });
    });

    const receipt = await client(server).posts.create(
      { content: "Hello", platforms: ["bluesky"] },
      { idempotencyKey: "same-key" },
    );

    expect(receipt.replayed).toBe(true);
    expect(receipt.id).toBe("post_1");
    expect(server.requestCount()).toBe(1);
  });

  it("preserves multilingual content, escapes, and per-platform overrides byte for byte", async () => {
    const content = [
      "リリースしました",
      "새 릴리스를 공개했습니다",
      "shipped 🚀 with emoji",
      "line one\nline two\ttab",
      `quotes "double" 'single' \`backtick\``,
      "shell $(whoami) && rm -rf --fake",
      "link https://example.com/a?b=c#d",
    ].join("\n");
    const overrides = {
      threads: { content: "Threads: リリース 🚀" },
      x: { content: "X: release" },
    };

    const server = await fixture((_request, response) => {
      jsonResponse(response, 202, { id: "post_2", status: "queued" });
    });

    await client(server).posts.create({
      content,
      platforms: ["bluesky", "threads", "x"],
      overrides,
    });

    const sent = requestAt(server);

    expect(JSON.parse(sent.body)).toEqual({
      content,
      platforms: ["bluesky", "threads", "x"],
      overrides,
    });
    // JSON.stringify leaves non-ASCII intact, so the wire bytes carry the text.
    expect(sent.body).toContain("リリースしました");
    expect(sent.body).toContain("🚀");
    expect(sha256(String(JSON.parse(sent.body).content))).toBe(sha256(content));
    expect(String(JSON.parse(sent.body).overrides.threads.content)).toBe(
      overrides.threads.content,
    );
  });

  it("sends scheduledAt unchanged and never rewrites the caller's object", async () => {
    const server = await fixture((_request, response) => {
      jsonResponse(response, 202, {
        id: "post_3",
        status: "scheduled",
        scheduledAt: "2030-01-02T03:04:05.000Z",
      });
    });

    const input = {
      content: "Scheduled",
      platforms: ["bluesky"],
      scheduledAt: "2030-01-02T03:04:05.000Z",
    };

    const receipt = await client(server).posts.create(input);

    expect(receipt.status).toBe("scheduled");
    expect(receipt.scheduledAt).toBe("2030-01-02T03:04:05.000Z");
    expect(input).toEqual({
      content: "Scheduled",
      platforms: ["bluesky"],
      scheduledAt: "2030-01-02T03:04:05.000Z",
    });
    expect(JSON.parse(requestAt(server).body)).toEqual(input);
  });
});

describe("SyndrooClient.posts.get and list", () => {
  it("reads a post detail with per-platform publications", async () => {
    const server = await fixture((_request, response) => {
      jsonResponse(response, 200, DETAIL);
    });

    const post = await client(server).posts.get("post_1");

    expect(post.status).toBe("published");
    expect(isPostTerminal(post.status)).toBe(true);
    expect(post.publications).toHaveLength(1);
    expect(post.publications[0]?.externalUrl).toBe(
      "https://bsky.app/profile/alice/post/3example",
    );
    expect(requestAt(server).url).toBe("/v1/posts/post_1");
  });

  it("percent-encodes the post id instead of injecting a path", async () => {
    const server = await fixture((_request, response) => {
      jsonResponse(response, 404, {
        error: { code: "POST_NOT_FOUND", message: "Post not found" },
      });
    });

    await expect(client(server).posts.get("post_1/../health")).rejects.toThrow();
    expect(requestAt(server).url).toBe("/v1/posts/post_1%2F..%2Fhealth");
  });

  it("passes the list limit through as a query parameter", async () => {
    const server = await fixture((_request, response) => {
      jsonResponse(response, 200, { items: [DETAIL] });
    });

    const posts = await client(server).posts.list({ limit: 5 });

    expect(posts).toHaveLength(1);
    expect(posts[0]?.id).toBe("post_1");
    expect(requestAt(server).url).toBe("/v1/posts?limit=5");
  });

  it("reads the list without a limit parameter when none is given", async () => {
    const server = await fixture((_request, response) => {
      jsonResponse(response, 200, { items: [] });
    });

    expect(await client(server).posts.list()).toEqual([]);
    expect(requestAt(server).url).toBe("/v1/posts");
  });
});

describe("SyndrooClient.health", () => {
  it("calls the unauthenticated health endpoint without the API key", async () => {
    const server = await fixture((_request, response) => {
      jsonResponse(response, 200, { status: "ok" });
    });

    expect(await client(server).health()).toEqual({ status: "ok" });

    const sent = requestAt(server);
    expect(sent.method).toBe("GET");
    expect(sent.url).toBe("/health");
    expect(headerOf(sent, "authorization")).toBeUndefined();
  });
});

describe("SyndrooClient.posts.wait", () => {
  it("polls read-only until the post reaches a terminal status", async () => {
    const statuses = ["queued", "publishing", "published"];
    const server = await fixture((_request, response, index) => {
      jsonResponse(response, 200, {
        ...DETAIL,
        status: statuses[index] ?? "published",
      });
    });

    const post = await client(server).posts.wait("post_1", {
      timeoutMs: 5_000,
      pollIntervalMs: 10,
    });

    expect(post.status).toBe("published");
    expect(server.requestCount()).toBe(3);
    expect(server.requests.every(entry => entry.method === "GET")).toBe(true);
  });

  it("returns a partially delivered post instead of claiming success", async () => {
    const server = await fixture((_request, response) => {
      jsonResponse(response, 200, { ...DETAIL, status: "partial" });
    });

    const post = await client(server).posts.wait("post_1", { pollIntervalMs: 10 });

    expect(post.status).toBe("partial");
    expect(isPostTerminal(post.status)).toBe(true);
    expect(isPostDelivered(post.status)).toBe(false);
  });
});

describe("SyndrooClient output hygiene", () => {
  it("never writes to the console, so credentials and content stay out of logs", async () => {
    const logSpy = vi.spyOn(console, "log");
    const infoSpy = vi.spyOn(console, "info");
    const warnSpy = vi.spyOn(console, "warn");
    const errorSpy = vi.spyOn(console, "error");
    const debugSpy = vi.spyOn(console, "debug");
    const server = await fixture((request, response) => {
      if (request.method === "POST") {
        jsonResponse(response, 202, { id: "post_1", status: "queued" });
        return;
      }

      if (request.url === "/v1/posts") {
        jsonResponse(response, 200, { items: [DETAIL] });
        return;
      }

      if (request.url === "/health") {
        jsonResponse(response, 200, { status: "ok" });
        return;
      }

      jsonResponse(response, 200, DETAIL);
    });

    const syndroo = client(server);
    const receipt = await syndroo.posts.create(
      { content: "Hello", platforms: ["bluesky"] },
      { idempotencyKey: "silent-1" },
    );
    await syndroo.posts.get(receipt.id);
    await syndroo.posts.list();
    await syndroo.health();

    expect(logSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
