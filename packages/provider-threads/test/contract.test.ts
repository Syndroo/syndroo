import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { providerContractTests } from "@syndroo/provider-sdk/testing";

import plugin, {
  THREADS_DEFAULT_API_HOST,
  THREADS_DEFAULT_AUTHORIZATION_HOST,
  THREADS_PROVIDER_VERSION,
} from "../src/index.js";
import { threadsCases } from "./fixtures.js";

/** The package version, read from the manifest so drift is caught here. */
async function packageVersion(): Promise<string> {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

describe("threads provider contract", () => {
  it("declares the package version and passes the SDK contract suite", async () => {
    const version = await packageVersion();

    expect(THREADS_PROVIDER_VERSION).toBe(version);
    expect(plugin.manifest.version).toBe(version);

    const result = await providerContractTests({
      plugin,
      packageVersion: version,
      cases: threadsCases(),
    });

    expect(result.checks).toBeGreaterThan(20);
  });

  it("declares the threads id, provider API 1 and only the text capability", () => {
    expect(plugin.manifest.id).toBe("threads");
    expect(plugin.manifest.apiVersion).toBe(1);
    expect(plugin.manifest.declaredCapabilities).toEqual(["text"]);
  });

  it("prompts a non-secret client id and a secret client secret", () => {
    const schema = plugin.manifest.schemas.credentialInput;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["client_id", "client_secret"],
    });
    expect((schema.properties as Record<string, unknown>).client_secret).toEqual({
      type: "string",
      minLength: 1,
    });
  });

  it("takes both hosts as explicit connect inputs and rejects unknown keys", () => {
    const schema = plugin.manifest.schemas.connectOptions;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["redirectUri"],
    });
    expect(Object.keys((schema.properties as Record<string, unknown>)).sort()).toEqual([
      "apiHost",
      "authorizationHost",
      "clientId",
      "clientSecret",
      "redirectUri",
      "scopes",
    ]);
    // Defaults are the Postman collection's `.net` pair, exported and overridable.
    expect(THREADS_DEFAULT_API_HOST).toBe("https://graph.threads.net");
    expect(THREADS_DEFAULT_AUTHORIZATION_HOST).toBe("https://www.threads.net");
  });

  it("supports exactly the text option and rejects unknown keys", () => {
    const schema = plugin.manifest.schemas.publishOptions;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["text"],
    });
    expect(Object.keys((schema.properties as Record<string, unknown>))).toEqual(["text"]);
    // media_type and auto_publish_text are pinned by the provider, not options.
    expect((schema.properties as Record<string, unknown>)).not.toHaveProperty("media_type");
    expect((schema.properties as Record<string, unknown>)).not.toHaveProperty("auto_publish_text");
    // No invented text length limit.
    expect((schema.properties as Record<string, Record<string, unknown>>).text).not.toHaveProperty(
      "maxLength",
    );
  });

  it("keeps content optional so a post-only target may send {}", () => {
    const schema = plugin.manifest.schemas.content;
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(schema).not.toHaveProperty("required");
  });
});
