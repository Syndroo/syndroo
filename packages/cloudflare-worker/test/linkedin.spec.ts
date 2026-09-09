import { afterEach, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { publisherFor } from "../src/publishers.js";
import { routeApi } from "../src/api.js";
import { D1Repository } from "../src/repository.js";

const linkedInEnv = () => ({ ...env, LINKEDIN_ACCESS_TOKEN: "test-token", LINKEDIN_AUTHOR: "urn:li:person:Test123", LINKEDIN_API_VERSION: "202604" });
const apiRequest = () => new Request("https://syndroo.test/v1/posts", {
  method: "POST", headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
  body: JSON.stringify({ content: "Shared", platforms: ["linkedin"], overrides: { linkedin: { content: "LinkedIn text" } }, scheduledAt: "2030-01-02T03:04:05.000Z" }),
});
afterEach(() => vi.restoreAllMocks());
it("publishes LinkedIn through native fetch in workerd", async () => {
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:123" } }));
  await expect(publisherFor("linkedin", linkedInEnv()).publish({ publicationId: "pub", platform: "linkedin", content: "Hi (team)" })).resolves.toHaveProperty("externalId", "urn:li:share:123");
  expect(JSON.parse(String(mock.mock.calls[0]?.[1]?.body)).commentary).toBe("Hi \\(team\\)");
  expect(mock).toHaveBeenCalledTimes(1);
});
it("persists the platform override and native provider", async () => {
  const response = await routeApi(apiRequest(), linkedInEnv());
  expect(response.status).toBe(202);
  const { id } = await response.json() as { id: string };
  await expect(new D1Repository(env.DB).getPost(id)).resolves.toMatchObject({ publications: [{ platform: "linkedin", provider: "linkedin-native", content: "LinkedIn text", status: "scheduled" }] });
});
it.each([{ LINKEDIN_ACCESS_TOKEN: "" }, { LINKEDIN_AUTHOR: "not-a-urn" }, { LINKEDIN_API_VERSION: "202613" }])("rejects invalid configuration before persistence", async override => {
  const prepare = vi.spyOn(env.DB, "prepare");
  await expect(routeApi(apiRequest(), { ...linkedInEnv(), ...override })).rejects.toMatchObject({ code: "PLATFORM_NOT_CONFIGURED", status: 422 });
  expect(prepare).not.toHaveBeenCalled();
});
