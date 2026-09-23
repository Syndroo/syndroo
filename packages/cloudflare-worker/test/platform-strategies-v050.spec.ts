/**
 * Task T6a focused tests: static platform preparation strategies.
 *
 * These tests construct publishers only. Every case runs inside a fail-loud
 * `globalThis.fetch` spy, so a strategy that tried to reach a provider during
 * preparation would fail instead of quietly succeeding. No test uses a live
 * credential or a live provider; every value below is a synthetic sentinel.
 */
import { describe, expect, it } from "vitest";

import {
  BINDING_MATERIAL_VERSION,
  type CredentialSource,
  type EncryptedCredential,
  type EncryptedSlotSnapshot,
  type PublisherPreparation,
  type PublisherPrepareInput,
  type SafeTarget,
} from "@syndroo/application";
import type { Platform, Publisher } from "@syndroo/core";

import {
  CREDENTIAL_PAYLOAD_SCHEMA_VERSION,
  PlatformCredentialInputError,
  decodeCredentialPayloadBytes,
  decodeDirectCredential,
  platformConfigKeys,
  type InstalledPlatform,
} from "../src/composition/platform-credential-decoders.js";
import {
  UninstalledPublisherStrategyError,
  installedPlatforms,
  platformConfigView,
  platformStrategyRegistry,
} from "../src/composition/platform-strategies.js";

const NOW = "2026-09-23T00:00:00.000Z";

/** Synthetic envelope; the strategy never inspects cipher internals. */
const DUMMY_ENVELOPE: EncryptedCredential = Object.freeze({
  version: 1,
  algorithm: "AES-256-GCM",
  keyId: "key-1",
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "AAAA",
});

const INSTALLED: readonly InstalledPlatform[] = [
  "bluesky",
  "threads",
  "x",
  "tumblr",
  "linkedin",
];

interface PlatformFixture {
  readonly platform: Platform;
  readonly providerName: string;
  readonly oauthSupported: boolean;
  /** Complete instance configuration, including unused user tokens. */
  readonly env: Readonly<Record<string, string>>;
  /** Complete stored user group plus its target/configuration fields. */
  readonly stored: Readonly<Record<string, string>>;
  /** A stored group that is missing one required user field. */
  readonly partial: Readonly<Record<string, string>>;
  readonly partialMissing: readonly string[];
  readonly partialSource: CredentialSource;
  readonly storedSource: "credential" | "mixed";
  readonly envTarget: SafeTarget | null;
  readonly storedTarget: SafeTarget | null;
  /** Synthetic user token values that must never be mixed across sources. */
  readonly userSentinels: readonly string[];
}

const FIXTURES: readonly PlatformFixture[] = [
  {
    platform: "bluesky",
    providerName: "bluesky-native",
    oauthSupported: false,
    env: {
      BLUESKY_IDENTIFIER: "env-user.bsky.social",
      BLUESKY_PASSWORD: "env-password-sentinel",
      BLUESKY_HOST: "env.pds.example",
    },
    stored: {
      identifier: "stored-user.bsky.social",
      password: "stored-password-sentinel",
      host: "stored.pds.example",
    },
    partial: { identifier: "partial-user.bsky.social" },
    partialMissing: ["BLUESKY_PASSWORD"],
    partialSource: "mixed",
    storedSource: "credential",
    envTarget: { label: "env.pds.example", source: "user" },
    storedTarget: { label: "stored.pds.example", source: "user" },
    userSentinels: ["env-password-sentinel", "stored-password-sentinel"],
  },
  {
    platform: "threads",
    providerName: "threads-native",
    oauthSupported: false,
    env: { THREADS_ACCESS_TOKEN: "env-threads-token-sentinel" },
    stored: { access_token: "stored-threads-token-sentinel" },
    partial: {},
    partialMissing: ["THREADS_ACCESS_TOKEN"],
    partialSource: "credential",
    storedSource: "credential",
    envTarget: null,
    storedTarget: null,
    userSentinels: ["env-threads-token-sentinel", "stored-threads-token-sentinel"],
  },
  {
    platform: "x",
    providerName: "x-sdk",
    oauthSupported: true,
    env: {
      X_API_KEY: "env-x-key",
      X_API_SECRET: "env-x-secret",
      X_ACCESS_TOKEN: "env-x-user-token-sentinel",
      X_ACCESS_TOKEN_SECRET: "env-x-user-secret-sentinel",
    },
    stored: {
      access_token: "stored-x-token-sentinel",
      access_token_secret: "stored-x-secret-sentinel",
    },
    partial: { access_token: "partial-x-token-sentinel" },
    partialMissing: ["X_ACCESS_TOKEN_SECRET"],
    partialSource: "mixed",
    storedSource: "mixed",
    envTarget: null,
    storedTarget: null,
    userSentinels: [
      "env-x-user-token-sentinel",
      "env-x-user-secret-sentinel",
      "stored-x-token-sentinel",
      "stored-x-secret-sentinel",
    ],
  },
  {
    platform: "tumblr",
    providerName: "tumblr-native",
    oauthSupported: true,
    env: {
      TUMBLR_CONSUMER_KEY: "env-tumblr-consumer",
      TUMBLR_CONSUMER_SECRET: "env-tumblr-consumer-secret",
      TUMBLR_TOKEN: "env-tumblr-token-sentinel",
      TUMBLR_TOKEN_SECRET: "env-tumblr-token-secret-sentinel",
      TUMBLR_BLOG: "envblog",
    },
    stored: {
      token: "stored-tumblr-token-sentinel",
      token_secret: "stored-tumblr-secret-sentinel",
      blog: "storedblog",
    },
    partial: { token: "partial-tumblr-token-sentinel" },
    partialMissing: ["TUMBLR_TOKEN_SECRET"],
    partialSource: "mixed",
    storedSource: "mixed",
    envTarget: { label: "envblog", source: "user" },
    storedTarget: { label: "storedblog", source: "user" },
    userSentinels: [
      "env-tumblr-token-sentinel",
      "env-tumblr-token-secret-sentinel",
      "stored-tumblr-token-sentinel",
    ],
  },
  {
    platform: "linkedin",
    providerName: "linkedin-native",
    oauthSupported: true,
    env: {
      LINKEDIN_ACCESS_TOKEN: "env-linkedin-token-sentinel",
      LINKEDIN_AUTHOR: "urn:li:person:env-author",
      LINKEDIN_API_VERSION: "202603",
    },
    stored: {
      access_token: "stored-linkedin-token-sentinel",
      author: "urn:li:person:stored-author",
      api_version: "202604",
    },
    partial: {},
    partialMissing: ["LINKEDIN_ACCESS_TOKEN"],
    partialSource: "mixed",
    storedSource: "credential",
    envTarget: { label: "urn:li:person:env-author", source: "user" },
    storedTarget: { label: "urn:li:person:stored-author", source: "user" },
    userSentinels: ["env-linkedin-token-sentinel", "stored-linkedin-token-sentinel"],
  },
];

function fixtureFor(platform: Platform): PlatformFixture {
  const fixture = FIXTURES.find((entry) => entry.platform === platform);
  if (fixture === undefined) {
    throw new Error(`missing fixture for ${platform as string}`);
  }
  return fixture;
}

function baseSlot(platform: Platform): EncryptedSlotSnapshot {
  return {
    platform,
    status: "empty",
    revision: 0,
    bindingId: null,
    envelope: null,
    payloadRevision: null,
    payloadSchemaVersion: null,
    expiresAt: null,
    target: null,
    refreshLease: null,
    refreshState: "ready",
    lastRefreshCommitFingerprint: null,
    updatedAt: null,
  };
}

function payloadBytes(fields: Readonly<Record<string, string>>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(fields));
}

function activeSlot(
  platform: Platform,
  overrides: Partial<EncryptedSlotSnapshot> = {},
): EncryptedSlotSnapshot {
  return {
    ...baseSlot(platform),
    status: "active",
    revision: 7,
    bindingId: "bind-0001",
    envelope: DUMMY_ENVELOPE,
    payloadRevision: 2,
    payloadSchemaVersion: CREDENTIAL_PAYLOAD_SCHEMA_VERSION,
    ...overrides,
  };
}

function prepareInput(
  platform: Platform,
  slot: EncryptedSlotSnapshot,
  plaintext: Uint8Array | null,
  values: Readonly<Record<string, string | undefined>> = {},
): PublisherPrepareInput {
  return {
    platform,
    slot,
    plaintext,
    config: platformConfigView(platform, values),
    now: NOW,
  };
}

function prepare(
  platform: Platform,
  input: Omit<PublisherPrepareInput, "platform">,
): PublisherPreparation {
  return platformStrategyRegistry.strategyFor(platform).prepare({ platform, ...input });
}

interface SpiedPreparation {
  readonly preparation: PublisherPreparation;
  readonly fetchCalls: number;
}

/**
 * Run one synchronous preparation with a fail-loud network spy.
 *
 * Construction must be pure: a provider request would both increment the
 * counter and throw instead of returning a ready envelope.
 */
function prepareWithoutNetwork(
  platform: Platform,
  input: Omit<PublisherPrepareInput, "platform">,
): SpiedPreparation {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("publisher preparation must not perform network work");
  }) as typeof fetch;
  try {
    return { preparation: prepare(platform, input), fetchCalls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function expectBlocked(
  preparation: PublisherPreparation,
): Extract<PublisherPreparation, { kind: "blocked" }> {
  expect(preparation.kind).toBe("blocked");
  if (preparation.kind !== "blocked") {
    throw new Error("expected a blocked preparation");
  }
  return preparation;
}

type PreparedPublisherView = Extract<PublisherPreparation, { kind: "ready" }>["prepared"];

function expectReady(preparation: PublisherPreparation): PreparedPublisherView {
  expect(preparation.kind).toBe("ready");
  if (preparation.kind !== "ready") {
    throw new Error("expected a ready preparation");
  }
  return preparation.prepared;
}

function materialText(prepared: PreparedPublisherView): string {
  return new TextDecoder().decode(prepared.bindingMaterial.bytes);
}

function publisherName(publisher: Publisher): string {
  return publisher.name;
}

describe("installed strategy registry", () => {
  it("lists only the five bundled platforms", () => {
    expect(installedPlatforms).toEqual(INSTALLED);
    expect(platformStrategyRegistry.platforms).toEqual(INSTALLED);
  });

  it("resolves one synchronous strategy per installed platform", () => {
    for (const platform of INSTALLED) {
      const strategy = platformStrategyRegistry.strategyFor(platform);
      expect(typeof strategy.prepare).toBe("function");
    }
  });

  it("throws a fixed error for an uninstalled platform", () => {
    for (const platform of ["mastodon", "nostr"] as const) {
      let caught: unknown;
      try {
        platformStrategyRegistry.strategyFor(platform);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UninstalledPublisherStrategyError);
      expect((caught as Error).message).toBe(
        "no publisher strategy is installed for this platform",
      );
      expect((caught as Error).message).not.toContain(platform);
    }
  });
});

describe("plain configuration mapping", () => {
  it("copies only allowlisted names and trims values", () => {
    const view = platformConfigView("bluesky", {
      BLUESKY_IDENTIFIER: "  env-user.bsky.social  ",
      BLUESKY_PASSWORD: "   ",
      BLUESKY_HOST: "env.pds.example",
      UNRELATED_SECRET: "sentinel-unrelated-secret",
      TUMBLR_BLOG: "cross-platform",
    });

    expect(view.platform).toBe("bluesky");
    expect(view.values).toEqual({
      BLUESKY_IDENTIFIER: "env-user.bsky.social",
      BLUESKY_HOST: "env.pds.example",
    });
    expect(view.values["BLUESKY_PASSWORD"]).toBeUndefined();
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.values)).toBe(true);
    expect(JSON.stringify(view)).not.toContain("sentinel-unrelated-secret");
    expect(view.publicUrl).toBeNull();
  });

  it("names exactly the documented configuration keys", () => {
    expect(platformConfigKeys("bluesky")).toEqual([
      "BLUESKY_IDENTIFIER",
      "BLUESKY_PASSWORD",
      "BLUESKY_HOST",
    ]);
    expect(platformConfigKeys("threads")).toEqual(["THREADS_ACCESS_TOKEN"]);
    expect(platformConfigKeys("x")).toEqual([
      "X_API_KEY",
      "X_API_SECRET",
      "X_ACCESS_TOKEN",
      "X_ACCESS_TOKEN_SECRET",
    ]);
    expect(platformConfigKeys("tumblr")).toEqual([
      "TUMBLR_CONSUMER_KEY",
      "TUMBLR_CONSUMER_SECRET",
      "TUMBLR_TOKEN",
      "TUMBLR_TOKEN_SECRET",
      "TUMBLR_BLOG",
    ]);
    expect(platformConfigKeys("linkedin")).toEqual([
      "LINKEDIN_ACCESS_TOKEN",
      "LINKEDIN_AUTHOR",
      "LINKEDIN_API_VERSION",
    ]);
  });

  it("refuses to map an uninstalled platform", () => {
    expect(() => platformConfigView("mastodon", {})).toThrow(
      UninstalledPublisherStrategyError,
    );
  });
});

describe("Env-only preparation", () => {
  it.each(INSTALLED)("prepares %s from the complete Env user group", (platform) => {
    const fixture = fixtureFor(platform);
    const { preparation, fetchCalls } = prepareWithoutNetwork(
      platform,
      prepareInput(platform, baseSlot(platform), null, fixture.env),
    );
    const prepared = expectReady(preparation);

    expect(fetchCalls).toBe(0);
    expect(publisherName(prepared.publisher)).toBe(fixture.providerName);
    expect(prepared.status).toMatchObject({
      platform,
      configured: true,
      source: "env",
      oauthSupported: fixture.oauthSupported,
      readiness: "ready",
      missingFields: [],
      expiresAt: null,
      revision: 0,
    });
    expect(prepared.status.target).toEqual(fixture.envTarget ?? undefined);
    expect(prepared.target).toEqual(fixture.envTarget);
    expect(prepared.slotBindingId).toBeNull();
    expect(prepared.credentialRevision).toBe(0);
    expect(prepared.credentialSource).toBe("env");
    expect(prepared.bindingMaterial.source).toBe("env");
    expect(prepared.bindingMaterial.version).toBe(BINDING_MATERIAL_VERSION);
    expect(JSON.stringify(prepared.status)).not.toContain("sentinel");
  });

  it.each(INSTALLED)("treats a tombstoned %s slot as an Env selection", (platform) => {
    const fixture = fixtureFor(platform);
    const slot: EncryptedSlotSnapshot = {
      ...baseSlot(platform),
      status: "tombstone",
      revision: 4,
      bindingId: "bind-deleted",
    };
    const prepared = expectReady(
      prepare(platform, prepareInput(platform, slot, null, fixture.env)),
    );

    expect(prepared.status.source).toBe("env");
    expect(prepared.status.revision).toBe(4);
    expect(prepared.slotBindingId).toBeNull();
    expect(publisherName(prepared.publisher)).toBe(fixture.providerName);
  });
});

describe("active D1 preparation", () => {
  it.each(INSTALLED)("prepares %s from the decrypted group only", (platform) => {
    const fixture = fixtureFor(platform);
    const { preparation, fetchCalls } = prepareWithoutNetwork(
      platform,
      prepareInput(platform, activeSlot(platform), payloadBytes(fixture.stored), fixture.env),
    );
    const prepared = expectReady(preparation);

    expect(fetchCalls).toBe(0);
    expect(publisherName(prepared.publisher)).toBe(fixture.providerName);
    expect(prepared.status.source).toBe(fixture.storedSource);
    expect(prepared.credentialSource).toBe(fixture.storedSource);
    expect(prepared.status.readiness).toBe("ready");
    expect(prepared.slotBindingId).toBe("bind-0001");
    expect(prepared.status.revision).toBe(7);
    expect(prepared.credentialRevision).toBe(7);
    expect(prepared.target).toEqual(fixture.storedTarget);
    expect(prepared.status.target).toEqual(fixture.storedTarget ?? undefined);

    // The D1 material carries the slot binding id plus app/target
    // configuration, never a selected user token.
    const text = materialText(prepared);
    expect(text).toContain("bind-0001");
    for (const sentinel of fixture.userSentinels) {
      expect(text).not.toContain(sentinel);
    }
  });
});

describe("whole-group selection", () => {
  it.each(INSTALLED)(
    "never completes a partial %s D1 group from Env user tokens",
    (platform) => {
      const fixture = fixtureFor(platform);
      const { preparation, fetchCalls } = prepareWithoutNetwork(
        platform,
        prepareInput(platform, activeSlot(platform), payloadBytes(fixture.partial), fixture.env),
      );
      const blocked = expectBlocked(preparation);

      expect(fetchCalls).toBe(0);
      expect(blocked.reason).toBe("missing_credentials");
      expect(blocked.readiness).toBe("missing_credentials");
      expect(blocked.missingFields).toEqual(fixture.partialMissing);
      expect(blocked.status.configured).toBe(false);
      // A blocked selected D1 group keeps its selected source where known.
      expect(blocked.status.source).toBe(fixture.partialSource);
      const outward = JSON.stringify(blocked);
      for (const sentinel of fixture.userSentinels) {
        expect(outward).not.toContain(sentinel);
      }
    },
  );

  it.each(["bluesky", "x", "tumblr"] as const)(
    "keeps the selected %s D1 binding independent of unused Env user tokens",
    (platform) => {
      const fixture = fixtureFor(platform);
      const slot = activeSlot(platform);
      const first = expectReady(
        prepare(platform, prepareInput(platform, slot, payloadBytes(fixture.stored), fixture.env)),
      );

      const rotated: Record<string, string> = { ...fixture.env };
      for (const key of [
        "BLUESKY_IDENTIFIER",
        "BLUESKY_PASSWORD",
        "X_ACCESS_TOKEN",
        "X_ACCESS_TOKEN_SECRET",
        "TUMBLR_TOKEN",
        "TUMBLR_TOKEN_SECRET",
      ]) {
        if (rotated[key] !== undefined) {
          rotated[key] = "rotated-env-user-token-sentinel";
        }
      }

      const second = expectReady(
        prepare(platform, prepareInput(platform, slot, payloadBytes(fixture.stored), rotated)),
      );
      expect(Array.from(second.bindingMaterial.bytes)).toEqual(
        Array.from(first.bindingMaterial.bytes),
      );
    },
  );

  it("blocks an active X slot without runtime app fields", () => {
    const fixture = fixtureFor("x");
    const blocked = expectBlocked(
      prepare("x", prepareInput("x", activeSlot("x"), payloadBytes(fixture.stored), {})),
    );

    expect(blocked.reason).toBe("needs_configuration");
    expect(blocked.readiness).toBe("needs_configuration");
    expect(blocked.missingFields).toEqual(["X_API_KEY", "X_API_SECRET"]);
    expect(blocked.status.source).toBe("credential");
  });

  it("blocks an active LinkedIn slot without a target author", () => {
    const blocked = expectBlocked(
      prepare(
        "linkedin",
        prepareInput(
          "linkedin",
          activeSlot("linkedin"),
          payloadBytes({ access_token: "stored-linkedin-token-sentinel" }),
          {},
        ),
      ),
    );

    expect(blocked.reason).toBe("needs_configuration");
    // The documented API-version default still applies.
    expect(blocked.missingFields).toEqual(["LINKEDIN_AUTHOR"]);
    expect(blocked.status.source).toBe("credential");
  });
});

describe("D1 blocking without Env fallback", () => {
  const CORRUPT_PAYLOADS: readonly (readonly [string, Uint8Array])[] = [
    ["empty bytes", new Uint8Array(0)],
    ["not JSON", new TextEncoder().encode("not-json")],
    ["array body", new TextEncoder().encode("[]")],
    ["unknown field", new TextEncoder().encode(JSON.stringify({ unexpected: "value" }))],
    ["non-string value", new TextEncoder().encode(JSON.stringify({ access_token: 5 }))],
    [
      "control character",
      new TextEncoder().encode(JSON.stringify({ access_token: "bad\u0000token" })),
    ],
  ];

  it.each(INSTALLED)("blocks an expired %s slot despite a complete Env group", (platform) => {
    const fixture = fixtureFor(platform);
    const slot = activeSlot(platform, { expiresAt: "2026-09-22T00:00:00.000Z" });
    const blocked = expectBlocked(
      prepare(platform, prepareInput(platform, slot, payloadBytes(fixture.stored), fixture.env)),
    );

    expect(blocked.reason).toBe("expired");
    expect(blocked.readiness).toBe("expired");
    expect(blocked.status.configured).toBe(false);
    expect(blocked.status.expiresAt).toBe("2026-09-22T00:00:00.000Z");
    expect(blocked.status.source).toBe(fixture.storedSource);
    expect(blocked.missingFields).toEqual([]);
  });

  it.each(INSTALLED)("reports an invalid %s expiry as unavailable", (platform) => {
    const fixture = fixtureFor(platform);
    const slot = activeSlot(platform, { expiresAt: "2026-13-40T00:00:00.000Z" });
    const blocked = expectBlocked(
      prepare(platform, prepareInput(platform, slot, payloadBytes(fixture.stored), fixture.env)),
    );

    expect(blocked.reason).toBe("unavailable");
    expect(blocked.readiness).toBe("unavailable");
    expect(blocked.status.expiresAt).toBeNull();
  });

  it.each(INSTALLED)("blocks corrupt %s payloads", (platform) => {
    const fixture = fixtureFor(platform);
    for (const [label, bytes] of CORRUPT_PAYLOADS) {
      const blocked = expectBlocked(
        prepare(platform, prepareInput(platform, activeSlot(platform), bytes, fixture.env)),
      );
      expect(blocked.reason, `${platform} ${label}`).toBe("invalid_configuration");
      expect(blocked.status.configured).toBe(false);
      expect(blocked.status.source).toBe(fixture.storedSource);
    }
  });

  it.each(INSTALLED)("blocks an unreadable %s plaintext", (platform) => {
    const fixture = fixtureFor(platform);
    const blocked = expectBlocked(
      prepare(platform, prepareInput(platform, activeSlot(platform), null, fixture.env)),
    );

    expect(blocked.reason).toBe("unavailable");
    expect(blocked.missingFields).toEqual([]);
    expect(blocked.status.configured).toBe(false);
    expect(blocked.status.expiresAt).toBeNull();
  });

  it.each(INSTALLED)("blocks an unexpected %s payload generation", (platform) => {
    const fixture = fixtureFor(platform);
    const slot = activeSlot(platform, { payloadSchemaVersion: 2 });
    const blocked = expectBlocked(
      prepare(platform, prepareInput(platform, slot, payloadBytes(fixture.stored), fixture.env)),
    );
    expect(blocked.reason).toBe("invalid_configuration");
  });

  it("blocks an active slot without a binding id", () => {
    const fixture = fixtureFor("x");
    const slot = activeSlot("x", { bindingId: null });
    const blocked = expectBlocked(
      prepare("x", prepareInput("x", slot, payloadBytes(fixture.stored), fixture.env)),
    );
    expect(blocked.reason).toBe("invalid_configuration");
    expect(blocked.status.source).toBe("mixed");
  });

  it("blocks an active slot without an envelope", () => {
    const fixture = fixtureFor("x");
    const slot = activeSlot("x", { envelope: null });
    const blocked = expectBlocked(
      prepare("x", prepareInput("x", slot, payloadBytes(fixture.stored), fixture.env)),
    );
    expect(blocked.reason).toBe("invalid_configuration");
  });

  it("defers preparation while a refresh lease is live", () => {
    const fixture = fixtureFor("x");
    const slot = activeSlot("x", {
      refreshLease: {
        token: "lease-token",
        acquiredAt: "2026-09-22T23:59:30.000Z",
        expiresAt: "2026-09-23T00:00:30.000Z",
        revision: 7,
      },
    });
    const blocked = expectBlocked(
      prepare("x", prepareInput("x", slot, payloadBytes(fixture.stored), fixture.env)),
    );

    expect(blocked.reason).toBe("unavailable");
    expect(blocked.status.source).toBe("mixed");
  });

  it("requires reconnection for an expired unresolved lease", () => {
    const fixture = fixtureFor("x");
    const slot = activeSlot("x", {
      refreshLease: {
        token: "lease-token",
        acquiredAt: "2026-09-22T23:58:00.000Z",
        expiresAt: "2026-09-22T23:59:00.000Z",
        revision: 7,
      },
    });
    const blocked = expectBlocked(
      prepare("x", prepareInput("x", slot, payloadBytes(fixture.stored), fixture.env)),
    );
    expect(blocked.reason).toBe("reconnect_required");
  });

  it("requires reconnection for sticky refresh state", () => {
    const fixture = fixtureFor("x");
    const slot = activeSlot("x", { refreshState: "reconnect_required" });
    const blocked = expectBlocked(
      prepare("x", prepareInput("x", slot, payloadBytes(fixture.stored), fixture.env)),
    );
    expect(blocked.reason).toBe("reconnect_required");
    expect(blocked.readiness).toBe("reconnect_required");
  });

  it("rejects an unknown persisted slot status", () => {
    const fixture = fixtureFor("x");
    const slot = {
      ...activeSlot("x"),
      status: "actve",
    } as unknown as EncryptedSlotSnapshot;
    const blocked = expectBlocked(
      prepare("x", prepareInput("x", slot, payloadBytes(fixture.stored), fixture.env)),
    );

    expect(blocked.reason).toBe("invalid_configuration");
    expect(blocked.status.source).toBeNull();
  });

  it("rejects a negative revision", () => {
    const fixture = fixtureFor("x");
    const slot = activeSlot("x", { revision: -1 });
    const blocked = expectBlocked(
      prepare("x", prepareInput("x", slot, payloadBytes(fixture.stored), fixture.env)),
    );
    expect(blocked.reason).toBe("invalid_configuration");
    expect(blocked.status.revision).toBe(0);
  });

  it("fails closed on a platform mismatch", () => {
    const fixture = fixtureFor("bluesky");
    const foreignSlot = { ...activeSlot("x"), platform: "x" } as EncryptedSlotSnapshot;
    const blockedSlot = expectBlocked(
      prepare(
        "bluesky",
        prepareInput("bluesky", foreignSlot, payloadBytes(fixture.stored), fixture.env),
      ),
    );
    expect(blockedSlot.reason).toBe("invalid_configuration");

    const foreignConfig = { platform: "threads", values: {}, publicUrl: null } as const;
    const blockedConfig = expectBlocked(
      platformStrategyRegistry.strategyFor("bluesky").prepare({
        platform: "bluesky",
        slot: activeSlot("bluesky"),
        plaintext: payloadBytes(fixture.stored),
        config: foreignConfig,
        now: NOW,
      }),
    );
    expect(blockedConfig.reason).toBe("invalid_configuration");

    const blockedCall = expectBlocked(
      platformStrategyRegistry.strategyFor("bluesky").prepare({
        platform: "x",
        slot: activeSlot("bluesky"),
        plaintext: payloadBytes(fixture.stored),
        config: platformConfigView("bluesky", fixture.env),
        now: NOW,
      }),
    );
    expect(blockedCall.reason).toBe("invalid_configuration");
  });

  it("rejects an inconsistent decrypted payload on an absent slot", () => {
    const fixture = fixtureFor("bluesky");
    const blocked = expectBlocked(
      prepare(
        "bluesky",
        prepareInput("bluesky", baseSlot("bluesky"), payloadBytes(fixture.stored), fixture.env),
      ),
    );
    expect(blocked.reason).toBe("invalid_configuration");
    expect(blocked.status.source).toBeNull();
  });
});

describe("source of the selected fields", () => {
  it("reports credential when no instance value is selected", () => {
    const fixture = fixtureFor("bluesky");
    const prepared = expectReady(
      prepare(
        "bluesky",
        prepareInput("bluesky", activeSlot("bluesky"), payloadBytes(fixture.stored), fixture.env),
      ),
    );
    expect(prepared.status.source).toBe("credential");
  });

  it("reports mixed when a selected configuration value comes from instance Env", () => {
    const fixture = fixtureFor("bluesky");
    const stored = { identifier: "stored-user.bsky.social", password: "stored-password-sentinel" };
    const prepared = expectReady(
      prepare(
        "bluesky",
        prepareInput("bluesky", activeSlot("bluesky"), payloadBytes(stored), fixture.env),
      ),
    );

    expect(prepared.status.source).toBe("mixed");
    expect(prepared.target).toEqual({ label: "env.pds.example", source: "user" });
  });

  it("reports null for a missing Env user group", () => {
    const blocked = expectBlocked(
      prepare("threads", prepareInput("threads", baseSlot("threads"), null, {})),
    );

    expect(blocked.reason).toBe("missing_credentials");
    expect(blocked.status.source).toBeNull();
    expect(blocked.missingFields).toEqual(["THREADS_ACCESS_TOKEN"]);
  });

  it("keeps source env when only target configuration is missing", () => {
    const blocked = expectBlocked(
      prepare(
        "tumblr",
        prepareInput("tumblr", baseSlot("tumblr"), null, {
          TUMBLR_CONSUMER_KEY: "env-tumblr-consumer",
          TUMBLR_CONSUMER_SECRET: "env-tumblr-consumer-secret",
          TUMBLR_TOKEN: "env-tumblr-token-sentinel",
          TUMBLR_TOKEN_SECRET: "env-tumblr-token-secret-sentinel",
        }),
      ),
    );

    expect(blocked.reason).toBe("needs_configuration");
    expect(blocked.readiness).toBe("needs_configuration");
    expect(blocked.status.source).toBe("env");
    expect(blocked.missingFields).toEqual(["TUMBLR_BLOG"]);
  });

  it("ignores unused Env user tokens for an active slot", () => {
    const fixture = fixtureFor("linkedin");
    const prepared = expectReady(
      prepare(
        "linkedin",
        prepareInput("linkedin", activeSlot("linkedin"), payloadBytes(fixture.stored), fixture.env),
      ),
    );

    expect(prepared.status.source).toBe("credential");
    expect(prepared.target).toEqual({ label: "urn:li:person:stored-author", source: "user" });
  });

  it("reports provider provenance only for an exactly matching stored label", () => {
    const fixture = fixtureFor("tumblr");
    const matching = activeSlot("tumblr", {
      target: { label: "StoredBlog", source: "provider" },
    });
    const prepared = expectReady(
      prepare("tumblr", prepareInput("tumblr", matching, payloadBytes(fixture.stored), fixture.env)),
    );
    expect(prepared.target).toEqual({ label: "storedblog", source: "provider" });

    const mismatched = activeSlot("tumblr", {
      target: { label: "unrelatedblog", source: "provider" },
    });
    const fallback = expectReady(
      prepare(
        "tumblr",
        prepareInput("tumblr", mismatched, payloadBytes(fixture.stored), fixture.env),
      ),
    );
    expect(fallback.target).toEqual({ label: "storedblog", source: "user" });
  });
});

function bytesOf(prepared: PreparedPublisherView): readonly number[] {
  return Array.from(prepared.bindingMaterial.bytes);
}

describe("binding material", () => {
  it("changes with a target change", () => {
    const fixture = fixtureFor("bluesky");
    const slot = activeSlot("bluesky");
    const first = expectReady(
      prepare("bluesky", prepareInput("bluesky", slot, payloadBytes(fixture.stored), fixture.env)),
    );
    const second = expectReady(
      prepare(
        "bluesky",
        prepareInput(
          "bluesky",
          slot,
          payloadBytes({ ...fixture.stored, host: "other.pds.example" }),
          fixture.env,
        ),
      ),
    );

    expect(bytesOf(second)).not.toEqual(bytesOf(first));
  });

  it("changes with an app credential change", () => {
    const fixture = fixtureFor("x");
    const slot = activeSlot("x");
    const first = expectReady(
      prepare("x", prepareInput("x", slot, payloadBytes(fixture.stored), fixture.env)),
    );
    const second = expectReady(
      prepare(
        "x",
        prepareInput("x", slot, payloadBytes(fixture.stored), {
          ...fixture.env,
          X_API_KEY: "rotated-x-app-key",
        }),
      ),
    );

    expect(bytesOf(second)).not.toEqual(bytesOf(first));
  });

  it("changes with a source change even when the selected values match", () => {
    const fixture = fixtureFor("bluesky");
    const withoutHost = {
      identifier: "stored-user.bsky.social",
      password: "stored-password-sentinel",
    };
    const fromEnv = expectReady(
      prepare(
        "bluesky",
        prepareInput("bluesky", activeSlot("bluesky"), payloadBytes(withoutHost), fixture.env),
      ),
    );
    // Same host value, but now selected from the stored group.
    const fromStored = expectReady(
      prepare(
        "bluesky",
        prepareInput(
          "bluesky",
          activeSlot("bluesky"),
          payloadBytes({ ...withoutHost, host: "env.pds.example" }),
          fixture.env,
        ),
      ),
    );

    expect(fromEnv.bindingMaterial.source).toBe("mixed");
    expect(fromStored.bindingMaterial.source).toBe("credential");
    expect(fromStored.target).toEqual(fromEnv.target);
    expect(bytesOf(fromStored)).not.toEqual(bytesOf(fromEnv));
  });

  it("preserves the connection identity across a same-grant token rotation", () => {
    const linkedin = fixtureFor("linkedin");
    const linkedinSlot = activeSlot("linkedin");
    const before = expectReady(
      prepare(
        "linkedin",
        prepareInput("linkedin", linkedinSlot, payloadBytes(linkedin.stored), linkedin.env),
      ),
    );
    const after = expectReady(
      prepare(
        "linkedin",
        prepareInput(
          "linkedin",
          linkedinSlot,
          payloadBytes({
            ...linkedin.stored,
            access_token: "rotated-linkedin-token-sentinel",
            refresh_token: "refreshed-grant-token",
          }),
          linkedin.env,
        ),
      ),
    );
    expect(bytesOf(after)).toEqual(bytesOf(before));

    const tumblr = fixtureFor("tumblr");
    const tumblrSlot = activeSlot("tumblr");
    const tumblrBefore = expectReady(
      prepare("tumblr", prepareInput("tumblr", tumblrSlot, payloadBytes(tumblr.stored), tumblr.env)),
    );
    const tumblrAfter = expectReady(
      prepare(
        "tumblr",
        prepareInput(
          "tumblr",
          tumblrSlot,
          payloadBytes({ ...tumblr.stored, token: "rotated-tumblr-token-sentinel" }),
          tumblr.env,
        ),
      ),
    );
    expect(bytesOf(tumblrAfter)).toEqual(bytesOf(tumblrBefore));
  });

  it("covers the complete Env group, so an Env token rotation changes the binding", () => {
    const fixture = fixtureFor("threads");
    const slot = baseSlot("threads");
    const first = expectReady(prepare("threads", prepareInput("threads", slot, null, fixture.env)));
    const second = expectReady(
      prepare(
        "threads",
        prepareInput("threads", slot, null, {
          THREADS_ACCESS_TOKEN: "rotated-env-threads-token-sentinel",
        }),
      ),
    );

    expect(first.credentialSource).toBe("env");
    expect(bytesOf(second)).not.toEqual(bytesOf(first));
    expect(new TextDecoder().decode(first.bindingMaterial.bytes)).toContain(
      "env-threads-token-sentinel",
    );
  });

  it("is deterministic for identical inputs", () => {
    const fixture = fixtureFor("x");
    const slot = activeSlot("x");
    const input = prepareInput("x", slot, payloadBytes(fixture.stored), fixture.env);
    expect(bytesOf(expectReady(prepare("x", input)))).toEqual(
      bytesOf(expectReady(prepare("x", input))),
    );
  });
});

describe("preparation is pure and mutations cannot leak", () => {
  it("performs zero network work for every platform on both sources", () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("publisher preparation must not perform network work");
    }) as typeof fetch;
    try {
      for (const platform of INSTALLED) {
        const fixture = fixtureFor(platform);
        expect(
          prepare(platform, prepareInput(platform, baseSlot(platform), null, fixture.env)).kind,
        ).toBe("ready");
        expect(
          prepare(
            platform,
            prepareInput(platform, activeSlot(platform), payloadBytes(fixture.stored), fixture.env),
          ).kind,
        ).toBe("ready");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toBe(0);
  });

  it("returns a frozen synchronous envelope", () => {
    const fixture = fixtureFor("x");
    const preparation = prepare("x", prepareInput("x", baseSlot("x"), null, fixture.env));

    expect(preparation).not.toBeInstanceOf(Promise);
    expect(Object.isFrozen(preparation)).toBe(true);
  });

  it("exposes a frozen status copy per call", () => {
    const fixture = fixtureFor("x");
    const input = prepareInput("x", baseSlot("x"), null, fixture.env);
    const first = expectReady(prepare("x", input));
    const second = expectReady(prepare("x", input));

    expect(Object.isFrozen(first.status)).toBe(true);
    expect(Object.isFrozen(first.status.missingFields)).toBe(true);
    expect(first.status).not.toBe(second.status);
    expect(first.publisher).not.toBe(second.publisher);
  });

  it("is unaffected by mutation of the input plaintext or configuration map", () => {
    const fixture = fixtureFor("x");
    const values: Record<string, string | undefined> = { ...fixture.env };
    const plaintext = payloadBytes(fixture.stored);
    const prepared = expectReady(
      prepare("x", {
        slot: activeSlot("x"),
        plaintext,
        config: platformConfigView("x", values),
        now: NOW,
      }),
    );
    const bindingSnapshot = bytesOf(prepared);
    const statusSnapshot = prepared.status;
    const targetSnapshot = prepared.target;

    plaintext.fill(0);
    for (const key of Object.keys(values)) {
      delete values[key];
    }

    expect(bytesOf(prepared)).toEqual(bindingSnapshot);
    expect(prepared.status).toBe(statusSnapshot);
    expect(prepared.target).toBe(targetSnapshot);
    expect(publisherName(prepared.publisher)).toBe(fixture.providerName);

    const mutated = expectBlocked(
      prepare("x", {
        slot: activeSlot("x"),
        plaintext,
        config: platformConfigView("x", values),
        now: NOW,
      }),
    );
    expect(mutated.reason).toBe("invalid_configuration");
  });

  it("keeps synthetic secrets out of every outward status", () => {
    for (const platform of INSTALLED) {
      const fixture = fixtureFor(platform);
      const ready = expectReady(
        prepare(
          platform,
          prepareInput(platform, activeSlot(platform), payloadBytes(fixture.stored), fixture.env),
        ),
      );
      const blocked = expectBlocked(
        prepare(
          platform,
          prepareInput(platform, activeSlot(platform), payloadBytes(fixture.partial), fixture.env),
        ),
      );

      const outward = `${JSON.stringify(ready.status)}${JSON.stringify(blocked.status)}`;
      for (const sentinel of fixture.userSentinels) {
        expect(outward, `${platform} ${sentinel}`).not.toContain(sentinel);
      }
    }
  });
});

function captureInputError(run: () => unknown): PlatformCredentialInputError {
  try {
    run();
  } catch (error) {
    if (error instanceof PlatformCredentialInputError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a PlatformCredentialInputError");
}

describe("direct credential decoder", () => {
  it.each(INSTALLED)("round-trips a %s direct body into a storable payload", (platform) => {
    const fixture = fixtureFor(platform);
    const decoded = decodeDirectCredential(platform, fixture.stored);

    expect(decoded.payloadSchemaVersion).toBe(CREDENTIAL_PAYLOAD_SCHEMA_VERSION);
    expect(decoded.expiresAt).toBeNull();
    expect(decoded.target).toEqual(fixture.storedTarget);
    expect(decodeCredentialPayloadBytes(platform, decoded.plaintext)).toEqual(fixture.stored);

    // The strategy accepts exactly the payload this decoder produced.
    const prepared = expectReady(
      prepare(
        platform,
        prepareInput(platform, activeSlot(platform), decoded.plaintext, fixture.env),
      ),
    );
    expect(publisherName(prepared.publisher)).toBe(fixture.providerName);
  });

  it("produces canonical bytes regardless of key order", () => {
    const left = decodeDirectCredential("x", {
      access_token: "token-a",
      access_token_secret: "token-b",
    });
    const right = decodeDirectCredential("x", {
      access_token_secret: "token-b",
      access_token: "token-a",
    });

    expect(Array.from(left.plaintext)).toEqual(Array.from(right.plaintext));
    expect(new TextDecoder().decode(left.plaintext)).toBe(
      '{"access_token":"token-a","access_token_secret":"token-b"}',
    );
  });

  it("rejects unknown fields without echoing the key", () => {
    const error = captureInputError(() =>
      decodeDirectCredential("x", {
        access_token: "token-a",
        access_token_secret: "token-b",
        SENTINEL_SECRET_UNKNOWN_KEY: "leaked",
      }),
    );

    expect(error.code).toBe("unknown_field");
    expect(error.field).toBeNull();
    expect(error.message).not.toContain("SENTINEL_SECRET_UNKNOWN_KEY");
    expect(JSON.stringify({ message: error.message, field: error.field })).not.toContain(
      "SENTINEL_SECRET_UNKNOWN_KEY",
    );
  });

  it("rejects runtime app secrets and control fields in a direct body", () => {
    expect(
      captureInputError(() =>
        decodeDirectCredential("x", {
          access_token: "token-a",
          access_token_secret: "token-b",
          api_key: "app-key",
        }),
      ).code,
    ).toBe("unknown_field");
    expect(
      captureInputError(() =>
        decodeDirectCredential("tumblr", {
          token: "token-a",
          token_secret: "token-b",
          consumer_key: "app-key",
        }),
      ).code,
    ).toBe("unknown_field");
    expect(
      captureInputError(() =>
        decodeDirectCredential("threads", { access_token: "token-a", expectedRevision: 3 }),
      ).code,
    ).toBe("unknown_field");
    expect(
      captureInputError(() =>
        decodeDirectCredential("threads", {
          access_token: "token-a",
          expires_at: "2026-09-23T00:00:00.000Z",
        }),
      ).code,
    ).toBe("unknown_field");
  });

  it("requires the complete user group", () => {
    const missingPassword = captureInputError(() =>
      decodeDirectCredential("bluesky", { identifier: "alice.bsky.social" }),
    );
    expect(missingPassword.code).toBe("missing_field");
    expect(missingPassword.field).toBe("password");

    const missingSecret = captureInputError(() =>
      decodeDirectCredential("x", { access_token: "token-a" }),
    );
    expect(missingSecret.code).toBe("missing_field");
    expect(missingSecret.field).toBe("access_token_secret");

    const missingToken = captureInputError(() => decodeDirectCredential("linkedin", {}));
    expect(missingToken.code).toBe("missing_field");
    expect(missingToken.field).toBe("access_token");
  });

  it("validates target values through provider validation", () => {
    expect(
      captureInputError(() =>
        decodeDirectCredential("bluesky", {
          identifier: "alice.bsky.social",
          password: "app-password",
          host: "localhost",
        }),
      ).field,
    ).toBe("host");
    expect(
      captureInputError(() =>
        decodeDirectCredential("tumblr", {
          token: "token-a",
          token_secret: "token-b",
          blog: "not a blog",
        }),
      ).field,
    ).toBe("blog");
    expect(
      captureInputError(() =>
        decodeDirectCredential("linkedin", { access_token: "token-a", author: "not-a-urn" }),
      ).field,
    ).toBe("author");
    expect(
      captureInputError(() =>
        decodeDirectCredential("linkedin", { access_token: "token-a", api_version: "20x3" }),
      ).field,
    ).toBe("api_version");
  });

  it("accepts a complete user group without optional target configuration", () => {
    const decoded = decodeDirectCredential("tumblr", {
      token: "token-a",
      token_secret: "token-b",
    });

    expect(decoded.target).toBeNull();
    expect(decoded.payloadSchemaVersion).toBe(CREDENTIAL_PAYLOAD_SCHEMA_VERSION);

    const blocked = expectBlocked(
      prepare("tumblr", prepareInput("tumblr", activeSlot("tumblr"), decoded.plaintext, {})),
    );
    expect(blocked.reason).toBe("needs_configuration");
    expect(blocked.missingFields).toEqual([
      "TUMBLR_CONSUMER_KEY",
      "TUMBLR_CONSUMER_SECRET",
      "TUMBLR_BLOG",
    ]);
  });

  it("rejects non-object and malformed bodies", () => {
    for (const body of [null, [], "token", 5, true, undefined]) {
      expect(captureInputError(() => decodeDirectCredential("threads", body)).code).toBe(
        "invalid_body",
      );
    }
    expect(
      captureInputError(() => decodeDirectCredential("threads", { access_token: 5 })).code,
    ).toBe("invalid_body");
    expect(
      captureInputError(() => decodeDirectCredential("threads", { access_token: "   " })).code,
    ).toBe("invalid_body");
    expect(
      captureInputError(() =>
        decodeDirectCredential("threads", { access_token: "bad\u0000token" }),
      ).code,
    ).toBe("invalid_body");
  });

  it("rejects an uninstalled platform", () => {
    expect(
      captureInputError(() => decodeDirectCredential("mastodon", { access_token: "token-a" }))
        .code,
    ).toBe("unknown_platform");
  });

  it("rejects a payload beyond the 64 KiB canonical bound", () => {
    const error = captureInputError(() =>
      decodeDirectCredential("threads", { access_token: "a".repeat(70 * 1024) }),
    );
    expect(error.code).toBe("invalid_body");
  });

  it("never forwards a hostile body that throws from a getter", () => {
    const body: Record<string, unknown> = {};
    Object.defineProperty(body, "access_token", {
      enumerable: true,
      get() {
        throw new Error("SENTINEL_THROWING_GETTER");
      },
    });

    const error = captureInputError(() => decodeDirectCredential("threads", body));
    expect(error.code).toBe("invalid_body");
    expect(error.field).toBeNull();
    expect(error.message).not.toContain("SENTINEL_THROWING_GETTER");
  });
});
