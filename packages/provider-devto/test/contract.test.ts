import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { providerContractTests } from "@syndroo/provider-sdk/testing";

import plugin, { DEVTO_PROVIDER_VERSION } from "../src/index.js";
import { devtoCases } from "./fixtures.js";

/** The package version, read from the manifest so drift is caught here. */
async function packageVersion(): Promise<string> {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

describe("devto provider contract", () => {
  it("declares the package version and passes the SDK contract suite", async () => {
    const version = await packageVersion();

    expect(DEVTO_PROVIDER_VERSION).toBe(version);
    expect(plugin.manifest.version).toBe(version);

    const result = await providerContractTests({
      plugin,
      packageVersion: version,
      cases: devtoCases(),
    });

    expect(result.checks).toBeGreaterThan(20);
  });

  it("declares the devto id, provider API 1 and the article capability", () => {
    expect(plugin.manifest.id).toBe("devto");
    expect(plugin.manifest.apiVersion).toBe(1);
    expect(plugin.manifest.declaredCapabilities).toEqual(["article"]);
  });

  it("prompts a single secret API key from the connect schema", () => {
    const schema = plugin.manifest.schemas.credentialInput;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["apiKey"],
    });
    expect((schema.properties as Record<string, unknown>).apiKey).toEqual({
      type: "string",
      minLength: 1,
    });
  });

  it("supports exactly the verified text/markdown body fields and rejects unknown keys", () => {
    const schema = plugin.manifest.schemas.publishOptions;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["title", "body_markdown"],
    });
    expect(Object.keys((schema.properties as Record<string, unknown>)).sort()).toEqual([
      "body_markdown",
      "canonical_url",
      "description",
      "published",
      "tags",
      "title",
    ]);
    // No HTML, media, series or organization escape hatch in this version.
    expect((schema.properties as Record<string, unknown>)).not.toHaveProperty("main_image");
    expect((schema.properties as Record<string, unknown>)).not.toHaveProperty("series");
    expect((schema.properties as Record<string, unknown>)).not.toHaveProperty("organization_id");
    // No invented title-length or tag-count limit.
    expect((schema.properties as Record<string, Record<string, unknown>>).title).not.toHaveProperty(
      "maxLength",
    );
    expect((schema.properties as Record<string, Record<string, unknown>>).tags).not.toHaveProperty(
      "maxItems",
    );
  });

  it("keeps content optional so an article-only target may send {}", () => {
    const schema = plugin.manifest.schemas.content;
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(schema).not.toHaveProperty("required");
  });
});
