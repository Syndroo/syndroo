import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { providerContractTests } from "@syndroo/provider-sdk/testing";

import plugin, { LINKEDIN_PROVIDER_VERSION, LINKEDIN_VERSION } from "../src/index.js";
import { linkedinCases } from "./fixtures.js";

/** The package version, read from the manifest so drift is caught here. */
async function packageVersion(): Promise<string> {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

describe("linkedin provider contract", () => {
  it("declares the package version and passes the SDK contract suite", async () => {
    const version = await packageVersion();

    expect(LINKEDIN_PROVIDER_VERSION).toBe(version);
    expect(plugin.manifest.version).toBe(version);

    const result = await providerContractTests({
      plugin,
      packageVersion: version,
      cases: linkedinCases(),
    });

    expect(result.checks).toBeGreaterThan(20);
  });

  it("declares the linkedin id, provider API 1 and only the text capability", () => {
    expect(plugin.manifest.id).toBe("linkedin");
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
    expect((schema.properties as Record<string, unknown>).client_id).toEqual({
      type: "string",
      minLength: 1,
    });
    expect((schema.properties as Record<string, unknown>).client_secret).toEqual({
      type: "string",
      minLength: 1,
    });
  });

  it("requires only the redirect URI and rejects unknown connect options", () => {
    const schema = plugin.manifest.schemas.connectOptions;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["redirectUri"],
    });
    expect(Object.keys((schema.properties as Record<string, unknown>)).sort()).toEqual([
      "clientId",
      "clientSecret",
      "redirectUri",
      "scopes",
    ]);
  });

  it("supports the verified post fields, pins the version, and rejects unknown keys", () => {
    const schema = plugin.manifest.schemas.publishOptions;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["commentary", "visibility"],
    });
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties).sort()).toEqual([
      "author",
      "commentary",
      "distribution",
      "linkedinVersion",
      "visibility",
    ]);
    // Only the member author selection is implemented.
    expect(properties.author).toEqual({ type: "string", enum: ["member"] });
    // The API version is pinned by the schema; a caller cannot override it.
    expect(properties.linkedinVersion).toEqual({ type: "string", const: LINKEDIN_VERSION });
    // No invented commentary length limit.
    expect(properties.commentary).not.toHaveProperty("maxLength");
    expect(properties.commentary).not.toHaveProperty("maxBytes");
  });

  it("keeps content optional so a post-only target may send {}", () => {
    const schema = plugin.manifest.schemas.content;
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(schema).not.toHaveProperty("required");
  });
});
