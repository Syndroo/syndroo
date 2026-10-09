import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { providerContractTests } from "@syndroo/provider-sdk/testing";

import plugin, { BLUESKY_PROVIDER_VERSION } from "../src/index.js";
import { blueskyCases } from "./fixtures.js";

/** The package version, read from the manifest so drift is caught here. */
async function packageVersion(): Promise<string> {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

describe("bluesky provider contract", () => {
  it("declares the package version and passes the SDK contract suite", async () => {
    const version = await packageVersion();

    expect(BLUESKY_PROVIDER_VERSION).toBe(version);
    expect(plugin.manifest.version).toBe(version);

    const result = await providerContractTests({
      plugin,
      packageVersion: version,
      cases: blueskyCases(),
    });

    expect(result.checks).toBeGreaterThan(20);
  });

  it("declares the bluesky id, provider API 1 and only the text capability", () => {
    expect(plugin.manifest.id).toBe("bluesky");
    expect(plugin.manifest.apiVersion).toBe(1);
    expect(plugin.manifest.declaredCapabilities).toEqual(["text"]);
  });

  it("prompts an identifier and a secret app password from the connect schema", () => {
    const schema = plugin.manifest.schemas.credentialInput;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["identifier", "password"],
    });
    expect((schema.properties as Record<string, unknown>).identifier).toEqual({
      type: "string",
      minLength: 1,
    });
    expect((schema.properties as Record<string, unknown>).password).toEqual({
      type: "string",
      minLength: 1,
    });
  });

  it("claims no post options but rejects unknown keys", async () => {
    const options = plugin.manifest.schemas.publishOptions;
    expect(options).toMatchObject({ type: "object", additionalProperties: false });
    expect(options).not.toHaveProperty("properties");

    const content = plugin.manifest.schemas.content;
    expect(content).toMatchObject({ type: "object", additionalProperties: false, required: ["text"] });
  });
});
