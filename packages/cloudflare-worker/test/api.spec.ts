import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { routeApi } from "../src/api.js";
import { publisherFor } from "../src/publishers.js";

const origin = "https://syndroo.test";
const authHeaders = {
  authorization: "Bearer test-api-key",
  "content-type": "application/json",
};

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error(`Expected ${key} to be a string`);
  }
  return field;
}

describe("Syndroo API", () => {
  it.each(["bluesky", "threads"] as const)("rejects missing %s credentials before persistence or enqueue", async platform => {
    const unconfigured: Env = {
      SYNDROO_API_KEY: "test-api-key",
      DB: { prepare() { throw new Error("Unexpected database access"); } } as unknown as D1Database,
      PUBLICATION_QUEUE: { sendBatch() { throw new Error("Unexpected queue access"); } } as unknown as Env["PUBLICATION_QUEUE"],
    };
    await expect(routeApi(new Request(`${origin}/v1/posts`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ content: "Hello", platforms: [platform] }),
    }), unconfigured)).rejects.toMatchObject({ status: 422, code: "PLATFORM_NOT_CONFIGURED" });
    expect(() => publisherFor(platform, unconfigured)).toThrow("Platform credentials are not configured");
  });

  it("accepts Threads alone without Bluesky credentials", async () => {
    const threadsOnly = { ...env };
    delete threadsOnly.BLUESKY_IDENTIFIER;
    delete threadsOnly.BLUESKY_PASSWORD;
    const response = await routeApi(new Request(`${origin}/v1/posts`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ content: "Threads only", platforms: ["threads"], scheduledAt: "2030-01-02T03:04:05.000Z" }),
    }), threadsOnly);
    expect(response.status).toBe(202);
  });

  it("serves a public health endpoint", async () => {
    const response = await exports.default.fetch(`${origin}/health`);

    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toEqual({ status: "ok" });
  });

  it("requires bearer authentication for API routes", async () => {
    const response = await exports.default.fetch(`${origin}/v1/posts`);

    expect(response.status).toBe(401);
    await expect(json(response)).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("persists a scheduled Bluesky post and its resolved publication", async () => {
    const createResponse = await exports.default.fetch(`${origin}/v1/posts`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "Shared content",
        platforms: ["bluesky"],
        overrides: { bluesky: { content: "Bluesky content" } },
        scheduledAt: "2030-01-02T03:04:05.000Z",
      }),
    });

    expect(createResponse.status).toBe(202);
    const created = await json(createResponse);
    expect(created).toMatchObject({
      status: "scheduled",
    });

    const id = stringField(created, "id");
    const getResponse = await exports.default.fetch(
      `${origin}/v1/posts/${id}`,
      { headers: authHeaders },
    );

    expect(getResponse.status).toBe(200);
    const detail = await json(getResponse);
    expect(detail).toMatchObject({
      id,
      content: "Shared content",
      platforms: ["bluesky"],
      scheduledAt: "2030-01-02T03:04:05.000Z",
      status: "scheduled",
      publications: [
        {
          platform: "bluesky",
          provider: "bluesky-native",
          content: "Bluesky content",
          status: "scheduled",
          attempts: 0,
        },
      ],
    });
  });

  it("persists Threads and Bluesky publications", async () => {
    const createResponse = await exports.default.fetch(`${origin}/v1/posts`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "Shared content",
        platforms: ["threads", "bluesky"],
        overrides: {
          threads: { content: "Threads content" },
          bluesky: { content: "Bluesky content" },
        },
        scheduledAt: "2030-01-02T03:04:05.000Z",
      }),
    });

    expect(createResponse.status).toBe(202);
    const created = await json(createResponse);
    const id = stringField(created, "id");
    const getResponse = await exports.default.fetch(`${origin}/v1/posts/${id}`, {
      headers: authHeaders,
    });

    expect(await json(getResponse)).toMatchObject({
      platforms: ["threads", "bluesky"],
      publications: [
        { platform: "threads", provider: "threads-native", content: "Threads content" },
        { platform: "bluesky", provider: "bluesky-native", content: "Bluesky content" },
      ],
    });
  });

  it("replays matching idempotent requests without creating another post", async () => {
    const headers = { ...authHeaders, "idempotency-key": "grantdai:post:en:test" };
    const body = JSON.stringify({
      content: "Shared content",
      platforms: ["threads", "bluesky"],
      scheduledAt: "2030-01-02T03:04:05.000Z",
    });
    const first = await exports.default.fetch(`${origin}/v1/posts`, {
      method: "POST",
      headers,
      body,
    });
    const second = await exports.default.fetch(`${origin}/v1/posts`, {
      method: "POST",
      headers,
      body,
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    const firstBody = await json(first);
    await expect(json(second)).resolves.toMatchObject({
      id: firstBody.id,
      status: "scheduled",
      replayed: true,
    });
  });

  it("rejects a reused idempotency key with different content", async () => {
    const headers = { ...authHeaders, "idempotency-key": "grantdai:post:en:conflict" };
    const request = (content: string) =>
      exports.default.fetch(`${origin}/v1/posts`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          content,
          platforms: ["bluesky"],
          scheduledAt: "2030-01-02T03:04:05.000Z",
        }),
      });

    expect((await request("First")).status).toBe(202);
    const conflict = await request("Second");
    expect(conflict.status).toBe(409);
    await expect(json(conflict)).resolves.toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
  });

  it("rejects platform adapters that are not installed", async () => {
    const response = await exports.default.fetch(`${origin}/v1/posts`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "Not publishable yet",
        platforms: ["mastodon"],
      }),
    });

    expect(response.status).toBe(422);
    await expect(json(response)).resolves.toMatchObject({
      error: { code: "PLATFORM_NOT_CONFIGURED" },
    });
  });
});
