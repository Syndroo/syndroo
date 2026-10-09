import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { providerContractTests } from "@syndroo/provider-sdk/testing";

import plugin, { MASTODON_PROVIDER_VERSION } from "../src/index.js";
import { mastodonCases } from "./fixtures.js";

/** The package version, read from the manifest so drift is caught here. */
async function packageVersion(): Promise<string> {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

describe("mastodon provider contract", () => {
  it("declares the package version and passes the SDK contract suite", async () => {
    const version = await packageVersion();

    expect(MASTODON_PROVIDER_VERSION).toBe(version);
    expect(plugin.manifest.version).toBe(version);

    const result = await providerContractTests({
      plugin,
      packageVersion: version,
      cases: mastodonCases(),
    });

    expect(result.checks).toBeGreaterThan(20);
  });

  it("declares the mastodon id, provider API 1 and only the text capability", () => {
    expect(plugin.manifest.id).toBe("mastodon");
    expect(plugin.manifest.apiVersion).toBe(1);
    expect(plugin.manifest.declaredCapabilities).toEqual(["text"]);
  });

  it("declares no typed credential fields: authentication is the OAuth flow", () => {
    const schema = plugin.manifest.schemas.credentialInput;
    expect(schema).toEqual({ type: "object", additionalProperties: false });
  });

  it("requires the instance, the callback and at least one scope, and rejects unknown keys", () => {
    const schema = plugin.manifest.schemas.connectOptions;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["instance", "redirectUri", "scopes"],
    });
    expect(Object.keys((schema.properties as Record<string, unknown>)).sort()).toEqual([
      "clientId",
      "clientSecret",
      "instance",
      "redirectUri",
      "scopes",
    ]);
    // The instance must be an explicit https host: there is no global default.
    expect((schema.properties as Record<string, Record<string, unknown>>).instance).toMatchObject({
      type: "string",
      pattern: "^https://[^\\s]+$",
    });
  });

  it("supports exactly one status option, the visibility, and rejects unknown keys", () => {
    const schema = plugin.manifest.schemas.publishOptions;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["visibility"],
    });
    expect(Object.keys((schema.properties as Record<string, unknown>))).toEqual(["visibility"]);
    // No invented per-instance or per-status limits in the schema.
    expect((schema.properties as Record<string, Record<string, unknown>>).visibility).not.toHaveProperty(
      "maxLength",
    );
    expect(schema).not.toHaveProperty("maxProperties");
  });

  it("requires non-empty text content", () => {
    const schema = plugin.manifest.schemas.content;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["text"],
    });
  });
});
