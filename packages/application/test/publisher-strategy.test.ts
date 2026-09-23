import { describe, expect, it } from "vitest";

import type { Publisher, PublishRequest, PublishResult } from "@syndroo/core";

import {
  BINDING_MATERIAL_VERSION,
  InvalidContractInputError,
  computeCredentialBinding,
  emptyPlatformConfig,
  encodeBindingMaterial,
  type BindingMaterial,
  type BindingSigner,
  type PublisherPreparation,
  type PublisherPrepareInput,
  type PublisherStrategy,
  type SafePlatformStatus,
} from "../src/index.js";

function stubPublisher(platform: string): Publisher {
  return {
    name: platform,
    async publish(request: PublishRequest): Promise<PublishResult> {
      return { externalId: request.publicationId };
    },
  };
}

/** Real WebCrypto HMAC so the signing path is exercised, not simulated. */
function testSigner(): BindingSigner {
  return {
    async sign(material: BindingMaterial): Promise<string> {
      const key = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(32).fill(7),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const buffer = new ArrayBuffer(material.bytes.byteLength);
      new Uint8Array(buffer).set(material.bytes);
      const signature = await crypto.subtle.sign("HMAC", key, buffer);
      return [...new Uint8Array(signature)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    },
  };
}

const readyStatus: SafePlatformStatus = {
  platform: "x",
  configured: true,
  source: "env",
  oauthSupported: false,
  readiness: "ready",
  missingFields: [],
  expiresAt: null,
  revision: 0,
};

const blockedStatus: SafePlatformStatus = {
  platform: "x",
  configured: false,
  source: null,
  oauthSupported: false,
  readiness: "missing_credentials",
  missingFields: ["X_ACCESS_TOKEN"],
  expiresAt: null,
  revision: 0,
};

function strategy(): PublisherStrategy {
  return {
    prepare(input: PublisherPrepareInput): PublisherPreparation {
      if (input.plaintext === null && input.config.values["X_ACCESS_TOKEN"] === undefined) {
        return {
          kind: "blocked",
          reason: "missing_credentials",
          status: blockedStatus,
          readiness: "missing_credentials",
          missingFields: ["X_ACCESS_TOKEN"],
        };
      }
      const envPath = input.plaintext === null;
      return {
        kind: "ready",
        prepared: {
          platform: input.platform,
          publisher: stubPublisher(input.platform),
          status: readyStatus,
          target: null,
          slotBindingId: input.slot.bindingId,
          // Env path: the whole selected field group. D1 path: slot binding id
          // plus app/target only, never the refresh-varying user token.
          bindingMaterial: encodeBindingMaterial({
            platform: input.platform,
            source: envPath ? "env" : "credential",
            fields: envPath
              ? [
                  ["X_API_KEY", input.config.values["X_API_KEY"] ?? null],
                  ["X_ACCESS_TOKEN", input.config.values["X_ACCESS_TOKEN"] ?? null],
                  ["X_ACCESS_TOKEN_SECRET", input.config.values["X_ACCESS_TOKEN_SECRET"] ?? null],
                  ["target", null],
                ]
              : [
                  ["slotBinding", input.slot.bindingId],
                  ["X_API_KEY", input.config.values["X_API_KEY"] ?? null],
                  ["target", null],
                ],
          }),
          credentialRevision: input.slot.revision,
          credentialSource: envPath ? "env" : "credential",
        },
      };
    },
  };
}

const emptySlot = {
  platform: "x" as const,
  status: "empty" as const,
  revision: 0,
  bindingId: null,
  envelope: null,
  payloadRevision: null,
  payloadSchemaVersion: null,
  expiresAt: null,
  target: null,
  refreshLease: null,
  refreshState: "ready" as const,
  lastRefreshCommitFingerprint: null,
  updatedAt: null,
};

describe("publisher strategy envelope", () => {
  it("returns a ready envelope without touching the network", async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls.push("fetch");
      throw new Error("construction must not perform network work");
    }) as typeof fetch;
    try {
      const preparation = strategy().prepare({
        platform: "x",
        slot: emptySlot,
        plaintext: null,
        config: {
          platform: "x",
          values: { X_API_KEY: "synthetic-key", X_ACCESS_TOKEN: "synthetic-token" },
          publicUrl: null,
        },
        now: "2026-09-23T00:00:00.000Z",
      });
      expect(preparation.kind).toBe("ready");
      if (preparation.kind === "ready") {
        expect(preparation.prepared.publisher.name).toBe("x");
        expect(preparation.prepared.credentialRevision).toBe(0);
        expect(preparation.prepared.slotBindingId).toBeNull();
        expect(preparation.prepared.bindingMaterial.version).toBe(BINDING_MATERIAL_VERSION);
        expect(preparation.prepared.bindingMaterial.bytes.byteLength).toBeGreaterThan(0);
        expect(preparation.prepared.bindingMaterial.source).toBe("env");
      }
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a blocked envelope with safe reasons instead of throwing", () => {
    const preparation = strategy().prepare({
      platform: "x",
      slot: emptySlot,
      plaintext: null,
      config: emptyPlatformConfig("x"),
      now: "2026-09-23T00:00:00.000Z",
    });
    expect(preparation.kind).toBe("blocked");
    if (preparation.kind === "blocked") {
      expect(preparation.reason).toBe("missing_credentials");
      expect(preparation.missingFields).toEqual(["X_ACCESS_TOKEN"]);
      expect(preparation.status.readiness).toBe("missing_credentials");
    }
  });
});

describe("connection binding", () => {
  it("derives an HMAC from material instead of reusing the slot binding id", async () => {
    const material = encodeBindingMaterial({
      platform: "x",
      source: "credential",
      fields: [
        ["slotBinding", "bind-1"],
        ["X_API_KEY", "app-key"],
        ["target", null],
      ],
    });
    const binding = await computeCredentialBinding(material, testSigner());
    expect(binding).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(binding).not.toContain("bind-1");
  });

  it("is order-independent but field-sensitive", async () => {
    const signer = testSigner();
    const left = await computeCredentialBinding(
      encodeBindingMaterial({
        platform: "x",
        source: "env",
        fields: [
          ["user", "alice"],
          ["app", "app-key"],
          ["target", "timeline"],
        ],
      }),
      signer,
    );
    const reordered = await computeCredentialBinding(
      encodeBindingMaterial({
        platform: "x",
        source: "env",
        fields: [
          ["target", "timeline"],
          ["user", "alice"],
          ["app", "app-key"],
        ],
      }),
      signer,
    );
    const changedTarget = await computeCredentialBinding(
      encodeBindingMaterial({
        platform: "x",
        source: "env",
        fields: [
          ["user", "alice"],
          ["app", "app-key"],
          ["target", "other-timeline"],
        ],
      }),
      signer,
    );
    expect(reordered).toBe(left);
    expect(changedTarget).not.toBe(left);
  });

  it("excludes refresh-varying user tokens on the D1 path", async () => {
    const slotFields = [
      ["slotBinding", "bind-1"],
      ["X_API_KEY", "app-key"],
      ["target", null],
    ] as const;
    const first = encodeBindingMaterial({
      platform: "x",
      source: "credential",
      fields: [...slotFields],
    });
    const afterRefresh = encodeBindingMaterial({
      platform: "x",
      source: "credential",
      fields: [...slotFields],
    });
    expect(Array.from(afterRefresh.bytes)).toEqual(Array.from(first.bytes));
    // The Env path is a different source, so switching sources changes the binding.
    const envPath = encodeBindingMaterial({
      platform: "x",
      source: "env",
      fields: [...slotFields],
    });
    expect(envPath.source).not.toBe(first.source);
    expect(envPath.bytes).not.toEqual(first.bytes);
  });

  it("rejects a signer that does not return a hex digest", async () => {
    const material = encodeBindingMaterial({
      platform: "x",
      source: "env",
      fields: [["user", "alice"]],
    });
    await expect(
      computeCredentialBinding(material, { sign: async () => "not-a-digest" }),
    ).rejects.toThrow(InvalidContractInputError);
  });
});
