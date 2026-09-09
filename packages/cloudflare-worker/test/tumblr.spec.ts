import { afterEach, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { publisherFor } from "../src/publishers.js";
import { routeApi } from "../src/api.js";
import { D1Repository } from "../src/repository.js";

const tumblrEnv = () => ({ ...env, TUMBLR_CONSUMER_KEY: "test-key", TUMBLR_CONSUMER_SECRET: "test-secret", TUMBLR_TOKEN: "test-token", TUMBLR_TOKEN_SECRET: "test-secret", TUMBLR_BLOG: "example" });
const apiRequest = () => new Request("https://syndroo.test/v1/posts", {
  method: "POST", headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
  body: JSON.stringify({ content: "Shared", platforms: ["tumblr"], overrides: { tumblr: { content: "Tumblr text" } }, scheduledAt: "2030-01-02T03:04:05.000Z" }),
});
afterEach(() => vi.restoreAllMocks());

it("signs and publishes Tumblr with Web Crypto in workerd", async () => {
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ meta: { status: 201 }, response: { id: "123" } }, { status: 201 }));
  await expect(publisherFor("tumblr", tumblrEnv()).publish({ publicationId: "pub", platform: "tumblr", content: "Hello" })).resolves.toEqual({ externalId: "123", externalUrl: "https://example.tumblr.com/post/123" });
  expect(new Headers(mock.mock.calls[0]?.[1]?.headers).get("authorization")).toContain("oauth_signature=");
  expect(mock).toHaveBeenCalledTimes(1);
});
it("persists Tumblr override and provider", async () => {
  const response = await routeApi(apiRequest(), tumblrEnv());
  expect(response.status).toBe(202);
  const { id } = await response.json() as { id: string };
  await expect(new D1Repository(env.DB).getPost(id)).resolves.toMatchObject({ publications: [{ platform: "tumblr", provider: "tumblr-native", content: "Tumblr text", status: "scheduled" }] });
});
it.each([{ TUMBLR_TOKEN_SECRET: "" }, { TUMBLR_BLOG: "https://evil.example/" }])("rejects invalid configuration before persistence", async override => {
  const prepare = vi.spyOn(env.DB, "prepare");
  await expect(routeApi(apiRequest(), { ...tumblrEnv(), ...override })).rejects.toMatchObject({ status: 422, code: "PLATFORM_NOT_CONFIGURED" });
  expect(prepare).not.toHaveBeenCalled();
});
