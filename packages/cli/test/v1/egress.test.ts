import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ProviderHttpRequest } from "@syndroo/provider-sdk";
import type { ProviderManifest } from "@syndroo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ResolvedConfig } from "../../src/config.js";
import { createLocalRuntime } from "../../src/runtime/local/composition.js";
import type { BuiltinProviderCatalogEntry } from "../../src/runtime/providers/index.js";
import { BUILTIN_PROVIDER_CATALOG } from "../../src/runtime/providers/generated/catalog.js";
import { createPolicyTransport } from "../../src/runtime/transport/policy.js";

/**
 * Provider egress wiring (Astra decision 2026-10-09).
 *
 * The manifest declares the network scope; the host builds one transport per
 * provider from that declaration. These tests prove the committed declarations,
 * the policy the transport builder derives, and that the composed local runtime
 * hands a provider exactly that transport.
 */

const REQUEST: ProviderHttpRequest = {
  url: "https://undeclared.example/anything",
  method: "GET",
  signal: new AbortController().signal,
};

const EXPECTED: Record<string, { fixedOrigins: readonly string[]; federated?: true }> = {
  bluesky: { fixedOrigins: ["https://bsky.social"] },
  devto: { fixedOrigins: ["https://dev.to"] },
  linkedin: { fixedOrigins: ["https://www.linkedin.com", "https://api.linkedin.com"] },
  mastodon: { fixedOrigins: [], federated: true },
  threads: { fixedOrigins: ["https://www.threads.net", "https://graph.threads.net"] },
};

let workDir = "";
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(tmpdir(), "syndroo-egress-"));
});

afterAll(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

function configFor(root: string): ResolvedConfig {
  return {
    configFile: path.join(root, "config.json"),
    configDirectory: root,
    exists: true,
    stateRoot: path.join(root, "state"),
    providers: {},
  };
}

/** A manifest stub carrying only the part the transport builder reads. */
function policy(egress: { fixedOrigins: readonly string[]; federated?: true }): ProviderManifest {
  return { egress } as unknown as ProviderManifest;
}

describe("declared egress", () => {
  it("publishes exactly the reviewed policy for every official provider", () => {
    const ids = BUILTIN_PROVIDER_CATALOG.map(entry => entry.provider);
    expect(ids).toEqual(Object.keys(EXPECTED));
    for (const entry of BUILTIN_PROVIDER_CATALOG) {
      expect(entry.manifest.egress).toEqual(EXPECTED[entry.provider]);
    }
  });

  it("refuses every request when a provider has no readable policy", async () => {
    const transport = createPolicyTransport(undefined);
    expect(await transport.request(REQUEST)).toEqual({
      type: "transport_error", stage: "before_request", code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("denies an origin the manifest did not declare, and lets a declared one through to the network policy", async () => {
    const fixed = createPolicyTransport(policy({ fixedOrigins: ["https://provider.invalid"] }));

    expect(await fixed.request(REQUEST)).toEqual({
      type: "transport_error", stage: "before_request", code: "ORIGIN_NOT_ALLOWED",
    });
    // `.invalid` never resolves, so reaching a *later* before-request failure
    // proves the origin passed the allowlist without contacting a real service.
    const allowed = await fixed.request({ ...REQUEST, url: "https://provider.invalid/anything" });
    expect(allowed).toMatchObject({ type: "transport_error", stage: "before_request" });
    expect(allowed).not.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
  });

  it("keeps a federated provider out of the allowlist check and inside the address policy", async () => {
    const federated = createPolicyTransport(policy({ fixedOrigins: [], federated: true }));

    const wildcard = await federated.request(REQUEST);
    expect(wildcard).toMatchObject({ type: "transport_error", stage: "before_request" });
    expect(wildcard).not.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    expect(await federated.request({ ...REQUEST, url: "http://undeclared.example/anything" })).toEqual({
      type: "transport_error", stage: "before_request", code: "INVALID_REQUEST",
    });
  });

  it("hands the composed runtime the policy transport of the provider it asks about", async () => {
    const root = path.join(workDir, "composed");
    await fs.mkdir(root, { recursive: true });
    const config = configFor(root);
    await fs.writeFile(config.configFile, "{}\n");
    const catalog: readonly BuiltinProviderCatalogEntry[] = [{
      provider: "offline",
      packageName: "@syndroo/provider-offline",
      // The loader requires an absolute root; the composition normally resolves
      // the repository-relative generated value itself.
      resolvedRoot: path.join(REPO_ROOT, "packages", "provider-offline"),
      artifactFingerprint: "0".repeat(64),
      manifest: {
        id: "offline", name: "Offline", version: "1.0.0", apiVersion: 1,
        declaredCapabilities: ["text"],
        egress: { fixedOrigins: ["https://provider.invalid"] },
        schemas: {
          connectOptions: { type: "object" }, credentialInput: { type: "object" },
          content: { type: "object" }, publishOptions: { type: "object" },
        },
      },
    }];

    const runtime = createLocalRuntime(config, { catalog });
    const transport = await runtime.providerTransport("offline");

    expect(await transport.request(REQUEST)).toEqual({
      type: "transport_error", stage: "before_request", code: "ORIGIN_NOT_ALLOWED",
    });
    // An unknown provider has no policy at all, so it stays fail-closed.
    const unknown = await runtime.providerTransport("nobody");
    expect(await unknown.request(REQUEST)).toEqual({
      type: "transport_error", stage: "before_request", code: "PROVIDER_UNAVAILABLE",
    });
  });
});
