import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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
