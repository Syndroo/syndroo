import { afterEach, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { publisherFor } from "../src/publishers.js";
import { routeApi } from "../src/api.js";
import { D1Repository } from "../src/repository.js";

const xEnv = () => ({ ...env, X_API_KEY: "test-key", X_API_SECRET: "test-secret", X_ACCESS_TOKEN: "test-token", X_ACCESS_TOKEN_SECRET: "test-token-secret" });
afterEach(() => vi.restoreAllMocks());

it("signs and publishes with the real X SDK inside workerd", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: { id: "123" } }, { status: 201 }));
  await expect(publisherFor("x", xEnv()).publish({ publicationId: "pub-x", platform: "x", content: "Hello 中文 👋" })).resolves.toEqual({ externalId: "123", externalUrl: "https://x.com/i/web/status/123" });
  expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toContain("oauth_signature=");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("persists X platform overrides and provider without posting immediately", async () => {
  const response = await routeApi(new Request("https://syndroo.test/v1/posts", {
    method: "POST",
    headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
    body: JSON.stringify({ content: "Shared", platforms: ["x"], overrides: { x: { content: "X text" } }, scheduledAt: "2030-01-02T03:04:05.000Z" }),
  }), xEnv());
  expect(response.status).toBe(202);
  const { id } = await response.json() as { id: string };
  await expect(new D1Repository(env.DB).getPost(id)).resolves.toMatchObject({ publications: [{ platform: "x", provider: "x-sdk", content: "X text", status: "scheduled" }] });
});

it("rejects partially configured X before persistence", async () => {
  const partial = xEnv();
  partial.X_ACCESS_TOKEN_SECRET = "";
  const prepare = vi.spyOn(env.DB, "prepare");
  await expect(routeApi(new Request("https://syndroo.test/v1/posts", {
    method: "POST", headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
    body: JSON.stringify({ content: "Hello", platforms: ["x"] }),
  }), partial)).rejects.toMatchObject({ code: "PLATFORM_NOT_CONFIGURED", status: 422 });
  expect(prepare).not.toHaveBeenCalled();
});
