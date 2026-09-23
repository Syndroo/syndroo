/**
 * Native workerd evidence for the concrete OAuth/refresh drivers.
 *
 * Every driver call below runs inside workerd and its outbound request is
 * answered by the fail-closed fixture in
 * `support/oauth-drivers-v050-fixtures.ts`; the recorded request log is read
 * back through the fixture's control routes. `globalThis.fetch` is never
 * replaced, and no destination outside the fixture can be reached.
 *
 * The file is named `*.native.ts` on purpose: it only runs under
 * `test/oauth-drivers-v050.vitest.config.ts`, which is the only project with
 * that fixture. General discovery must never pick it up.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  AuthUseCaseError,
  OAuthDriverError,
  beginOAuthConnect,
  computeCredentialBinding,
  encodeBindingMaterial,
  type BindingSigner,
  type OAuthCallbackSnapshot,
  type OAuthDriver,
  type OAuthDriverResolver,
  type OAuthRefreshDriver,
} from "@syndroo/application";
import { createSnapshotFake } from "@syndroo/application/testing";
import type { Platform } from "@syndroo/core";
import { oauth1Signature } from "@syndroo/transport";

import {
  LINKEDIN_APP_FIELDS,
  TUMBLR_APP_FIELDS,
  X_APP_FIELDS,
  createLinkedInRefreshResolver,
  createOAuthDriverResolver,
} from "../src/composition/oauth-drivers.js";
import { expiresAtFromSeconds, parsePublicOrigin } from "../src/composition/oauth-protocol-support.js";
import { createHmacBindingSigner } from "../src/infrastructure/crypto/hmac-binding-signer.js";
import type { RecordedRequest } from "./support/oauth-drivers-v050-fixtures.js";

const ORIGIN = "https://worker.example";
const SIGNER = createHmacBindingSigner({ key: btoa("k".repeat(32)) });
const X_VALUES = { X_API_KEY: "x-app-key-sentinel", X_API_SECRET: "x-app-secret-sentinel" };
const TUMBLR_VALUES = {
  TUMBLR_CONSUMER_KEY: "tumblr-key-sentinel",
  TUMBLR_CONSUMER_SECRET: "tumblr-secret-sentinel",
};
const LINKEDIN_VALUES = {
  LINKEDIN_CLIENT_ID: "linkedin-client-sentinel",
  LINKEDIN_CLIENT_SECRET: "linkedin-client-secret-sentinel",
};
const NOW = "2026-09-23T00:00:00.000Z";

interface FixtureState {
  readonly requests: readonly RecordedRequest[];
  readonly unexpected: number;
}

async function fixtureState(): Promise<FixtureState> {
  const response = await fetch("https://stats.invalid/_requests");
  return (await response.json()) as FixtureState;
}

async function requests(): Promise<readonly RecordedRequest[]> {
  return (await fixtureState()).requests;
}

function resolver(values: Record<string, string | undefined>, publicUrl: string | null = ORIGIN) {
  return createOAuthDriverResolver({ values, publicUrl, signer: SIGNER });
}

async function driverFor(
  platform: Platform,
  values: Record<string, string | undefined>,
  publicUrl: string | null = ORIGIN,
): Promise<OAuthDriver> {
  const driver = await resolver(values, publicUrl)(platform);
  expect(driver).not.toBeNull();
  return driver as OAuthDriver;
}

function headerParameters(header: string): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const part of header.replace(/^OAuth /, "").split(", ")) {
    const separator = part.indexOf("=");
    const name = decodeURIComponent(part.slice(0, separator));
    const raw = part.slice(separator + 1);
    parameters[name] = decodeURIComponent(raw.replace(/^"|"$/g, ""));
  }
  return parameters;
}

function nativePayload(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

function formBody(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

function linkedInCallback(code: string): OAuthCallbackSnapshot {
  return {
    platform: "linkedin",
    state: "state-abc",
    code,
    verifier: null,
    requestToken: null,
  };
}

async function failureOf(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return null;
  } catch (error) {
    return error;
  }
}

function confirmInput(candidate: Uint8Array, overrides: Partial<{
  readonly author: string | null;
  readonly apiVersion: string | null;
  readonly blog: string | null;
}> = {}) {
  return {
    candidate,
    target: { author: null, apiVersion: null, blog: null, ...overrides },
    now: NOW,
  };
}

beforeEach(async () => {
  await fetch("https://stats.invalid/_reset");
});

describe("X OAuth1 driver", () => {
  it("signs and sends exactly one request-token POST carrying the state", async () => {
    const driver = await driverFor("x", X_VALUES);

    const begin = await driver.begin({ state: "state-abc", now: NOW });

    const recorded = await requests();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe("POST");
    expect(recorded[0]?.url).toBe("https://api.twitter.com/oauth/request_token");
    const parameters = headerParameters(recorded[0]?.headers["authorization"] ?? "");
    expect(parameters["oauth_consumer_key"]).toBe(X_VALUES.X_API_KEY);
    const callback = parameters["oauth_callback"] as string;
    expect(callback).toBe(`${ORIGIN}/v1/auth/x/callback?state=state-abc`);
    expect(parameters["oauth_signature"]).toBe(
      await oauth1Signature({
        method: "POST",
        url: "https://api.twitter.com/oauth/request_token",
        consumerKey: X_VALUES.X_API_KEY,
        consumerSecret: X_VALUES.X_API_SECRET,
        oauthParameters: [["oauth_callback", callback]],
        timestamp: parameters["oauth_timestamp"] as string,
        nonce: parameters["oauth_nonce"] as string,
      }),
    );
    expect(begin.requestToken).toBe("req-token");
    expect(new TextDecoder().decode(begin.requestSecret as Uint8Array)).toBe("req-secret");
    expect(begin.authorizationUrl).toBe(
      "https://api.twitter.com/oauth/authorize?oauth_token=req-token",
    );
  });

  it("rejects malformed, unconfirmed, denied, redirecting and oversized responses once", async () => {
    const cases: readonly (readonly [string, string])[] = [
      ["state-duplicate", "invalid_response"],
      ["state-unconfirmed", "invalid_response"],
      ["state-missing-token", "invalid_response"],
      ["state-empty-secret", "invalid_response"],
      ["state-not-form", "invalid_response"],
      ["state-redirect", "invalid_response"],
      ["state-oversized", "invalid_response"],
      ["state-denied", "denied"],
      ["state-unavailable", "unavailable"],
    ];
    for (const [state, reason] of cases) {
      await fetch("https://stats.invalid/_reset");
      const driver = await driverFor("x", X_VALUES);

      let failure: unknown = null;
      try {
        await driver.begin({ state, now: NOW });
      } catch (error) {
        failure = error;
      }

      expect(failure, state).toBeInstanceOf(OAuthDriverError);
      expect((failure as OAuthDriverError).reason, state).toBe(reason);
      expect(await requests(), state).toHaveLength(1);
      // Fixed message and fixed reason only: no provider body text escapes.
      expect((failure as Error).message, state).toBe(
        "the authorization driver could not complete the request",
      );
      expect(JSON.stringify(failure), state).not.toContain("oauth_token");
      expect(JSON.stringify(failure), state).not.toContain("x-app-secret-sentinel");
    }
  });

  it("exchanges once with the original token, secret and verifier", async () => {
    const driver = await driverFor("x", X_VALUES);
    await fetch("https://stats.invalid/_reset");

    const result = await driver.exchange({
      callback: {
        platform: "x",
        state: "state-abc",
        code: null,
        verifier: "verifier-1",
        requestToken: "req-token",
      },
      requestSecret: new TextEncoder().encode("req-secret"),
      now: NOW,
    });

    const recorded = await requests();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.url).toBe("https://api.twitter.com/oauth/access_token");
    const parameters = headerParameters(recorded[0]?.headers["authorization"] ?? "");
    expect(parameters["oauth_token"]).toBe("req-token");
    expect(parameters["oauth_verifier"]).toBe("verifier-1");
    expect(parameters["oauth_signature"]).toBe(
      await oauth1Signature({
        method: "POST",
        url: "https://api.twitter.com/oauth/access_token",
        consumerKey: X_VALUES.X_API_KEY,
        consumerSecret: X_VALUES.X_API_SECRET,
        token: "req-token",
        tokenSecret: "req-secret",
        oauthParameters: [["oauth_verifier", "verifier-1"]],
        timestamp: parameters["oauth_timestamp"] as string,
        nonce: parameters["oauth_nonce"] as string,
      }),
    );
    expect(nativePayload(result.plaintext)).toEqual({
      access_token: "acc-token",
      access_token_secret: "acc-secret",
    });
    expect(result.expiresAt).toBeNull();
    expect(result.target).toBeNull();
    expect(result.missingFields).toEqual([]);
    // The exchange output is readable by the same parser `confirm` trusts.
    expect(nativePayload(driver.confirm(confirmInput(result.plaintext)).plaintext)).toEqual({
      access_token: "acc-token",
      access_token_secret: "acc-secret",
    });
  });

  it("confirms locally, validates the stored group and rejects overrides", async () => {
    const driver = await driverFor("x", X_VALUES);
    await fetch("https://stats.invalid/_reset");
    const candidate = new TextEncoder().encode(
      JSON.stringify({ access_token: "stored-token", access_token_secret: "stored-secret" }),
    );

    const confirmed = driver.confirm(confirmInput(candidate));

    expect(nativePayload(confirmed.plaintext)).toEqual({
      access_token: "stored-token",
      access_token_secret: "stored-secret",
    });
    expect(confirmed.target).toBeNull();
    expect(confirmed.missingFields).toEqual([]);
    expect(await requests()).toEqual([]);

    for (const overrides of [
      { author: "urn:li:person:x" },
      { apiVersion: "202604" },
      { blog: "blog" },
    ]) {
      expect(() => driver.confirm(confirmInput(candidate, overrides))).toThrowError(
        OAuthDriverError,
      );
    }
    expect(await requests()).toEqual([]);
  });

  it("rejects malformed, incomplete, unknown-key and padded native payloads without network", async () => {
    const driver = await driverFor("x", X_VALUES);
    await fetch("https://stats.invalid/_reset");
    const payloads: readonly Uint8Array[] = [
      new TextEncoder().encode("{}"),
      new TextEncoder().encode(JSON.stringify({ access_token: "only" })),
      new TextEncoder().encode(JSON.stringify({ access_token: "", access_token_secret: "s" })),
      new TextEncoder().encode(
        JSON.stringify({ access_token: "a", access_token_secret: "s", extra: "unknown" }),
      ),
      new TextEncoder().encode(
        '{"access_token":"a","access_token_secret":"s","__proto__":{"polluted":true}}',
      ),
      new TextEncoder().encode('{"access_token":" padded","access_token_secret":"s"}'),
      new Uint8Array(0),
      new Uint8Array([0xff, 0xfe]),
    ];
    for (const candidate of payloads) {
      expect(() => driver.confirm(confirmInput(candidate))).toThrowError(OAuthDriverError);
    }
    expect(await requests()).toEqual([]);
    expect(JSON.stringify({})).not.toContain("polluted");
  });

  it("rejects a duplicate or incomplete access-token response once", async () => {
    for (const verifier of ["duplicate", "missing-secret"]) {
      await fetch("https://stats.invalid/_reset");
      const driver = await driverFor("x", X_VALUES);

      const failure = await failureOf(() =>
        driver.exchange({
          callback: {
            platform: "x",
            state: "state-abc",
            code: null,
            verifier,
            requestToken: "req-token",
          },
          requestSecret: new TextEncoder().encode("req-secret"),
          now: NOW,
        }),
      );

      expect(failure, verifier).toBeInstanceOf(OAuthDriverError);
      expect((failure as OAuthDriverError).reason, verifier).toBe("invalid_response");
      expect(await requests(), verifier).toHaveLength(1);
      expect(JSON.stringify(failure), verifier).not.toContain("x-app-secret-sentinel");
    }
  });

  it("rejects padded or control-bearing request tokens before they are stored", async () => {
    for (const state of ["state-padded-secret", "state-control-token"]) {
      await fetch("https://stats.invalid/_reset");
      const driver = await driverFor("x", X_VALUES);

      const failure = await failureOf(() => driver.begin({ state, now: NOW }));

      expect(failure, state).toBeInstanceOf(OAuthDriverError);
      expect((failure as OAuthDriverError).reason, state).toBe("invalid_response");
      expect((failure as Error).message, state).toBe(
        "the authorization driver could not complete the request",
      );
      expect(await requests(), state).toHaveLength(1);
    }
  });

  it("rejects padded or control-bearing access tokens instead of storing them", async () => {
    for (const verifier of ["padded-token", "control-secret"]) {
      await fetch("https://stats.invalid/_reset");
      const driver = await driverFor("x", X_VALUES);

      const failure = await failureOf(() =>
        driver.exchange({
          callback: {
            platform: "x",
            state: "state-abc",
            code: null,
            verifier,
            requestToken: "req-token",
          },
          requestSecret: new TextEncoder().encode("req-secret"),
          now: NOW,
        }),
      );

      expect(failure, verifier).toBeInstanceOf(OAuthDriverError);
      expect((failure as OAuthDriverError).reason, verifier).toBe("invalid_response");
      expect(JSON.stringify(failure), verifier).not.toContain("acc-secret");
      expect(await requests(), verifier).toHaveLength(1);
    }
  });
});

describe("Tumblr OAuth1 driver", () => {
  it("signs and sends exactly one request-token POST carrying the state", async () => {
    const driver = await driverFor("tumblr", TUMBLR_VALUES);
    expect(driver.protocol).toBe("oauth1");
    expect(driver.canonicalCallbackUrl).toBe(`${ORIGIN}/v1/auth/tumblr/callback`);

    const begin = await driver.begin({ state: "state-abc", now: NOW });

    const recorded = await requests();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe("POST");
    expect(recorded[0]?.url).toBe("https://www.tumblr.com/oauth/request_token");
    const parameters = headerParameters(recorded[0]?.headers["authorization"] ?? "");
    expect(parameters["oauth_consumer_key"]).toBe(TUMBLR_VALUES.TUMBLR_CONSUMER_KEY);
    const callback = parameters["oauth_callback"] as string;
    expect(callback).toBe(`${ORIGIN}/v1/auth/tumblr/callback?state=state-abc`);
    expect(parameters["oauth_signature"]).toBe(
      await oauth1Signature({
        method: "POST",
        url: "https://www.tumblr.com/oauth/request_token",
        consumerKey: TUMBLR_VALUES.TUMBLR_CONSUMER_KEY,
        consumerSecret: TUMBLR_VALUES.TUMBLR_CONSUMER_SECRET,
        oauthParameters: [["oauth_callback", callback]],
        timestamp: parameters["oauth_timestamp"] as string,
        nonce: parameters["oauth_nonce"] as string,
      }),
    );
    expect(begin.requestToken).toBe("tumblr-req");
    expect(new TextDecoder().decode(begin.requestSecret as Uint8Array)).toBe("tumblr-req-secret");
    expect(begin.authorizationUrl).toBe(
      "https://www.tumblr.com/oauth/authorize?oauth_token=tumblr-req",
    );
  });

  it("rejects an unconfirmed request token without echoing provider text", async () => {
    const driver = await driverFor("tumblr", TUMBLR_VALUES);

    const failure = await failureOf(() => driver.begin({ state: "state-unconfirmed", now: NOW }));

    expect(failure).toBeInstanceOf(OAuthDriverError);
    expect((failure as OAuthDriverError).reason).toBe("invalid_response");
    expect(await requests()).toHaveLength(1);
    expect(JSON.stringify(failure)).not.toContain("maybe");
    expect(JSON.stringify(failure)).not.toContain(TUMBLR_VALUES.TUMBLR_CONSUMER_SECRET);
  });

  it("exchanges once with the original request token and asks for the blog", async () => {
    const driver = await driverFor("tumblr", TUMBLR_VALUES);
    await fetch("https://stats.invalid/_reset");

    const result = await driver.exchange({
      callback: {
        platform: "tumblr",
        state: "state-abc",
        code: null,
        verifier: "verifier-1",
        requestToken: "tumblr-req",
      },
      requestSecret: new TextEncoder().encode("tumblr-req-secret"),
      now: NOW,
    });

    const recorded = await requests();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.url).toBe("https://www.tumblr.com/oauth/access_token");
    const parameters = headerParameters(recorded[0]?.headers["authorization"] ?? "");
    expect(parameters["oauth_token"]).toBe("tumblr-req");
    expect(parameters["oauth_verifier"]).toBe("verifier-1");
    expect(parameters["oauth_signature"]).toBe(
      await oauth1Signature({
        method: "POST",
        url: "https://www.tumblr.com/oauth/access_token",
        consumerKey: TUMBLR_VALUES.TUMBLR_CONSUMER_KEY,
        consumerSecret: TUMBLR_VALUES.TUMBLR_CONSUMER_SECRET,
        token: "tumblr-req",
        tokenSecret: "tumblr-req-secret",
        oauthParameters: [["oauth_verifier", "verifier-1"]],
        timestamp: parameters["oauth_timestamp"] as string,
        nonce: parameters["oauth_nonce"] as string,
      }),
    );
    expect(nativePayload(result.plaintext)).toEqual({
      token: "tumblr-acc",
      token_secret: "tumblr-acc-secret",
    });
    expect(result.expiresAt).toBeNull();
    expect(result.target).toBeNull();
    expect(result.missingFields).toEqual(["blog"]);
  });

  it("requires the blog from the operator and never reads it as provider evidence", async () => {
    const driver = await driverFor("tumblr", TUMBLR_VALUES);
    await fetch("https://stats.invalid/_reset");
    const candidateText =
      '{"blog":"alice","token":"stored-token","token_secret":"stored-secret"}';
    const candidate = new TextEncoder().encode(candidateText);

    const deferred = driver.confirm(confirmInput(candidate));

    expect(new TextDecoder().decode(deferred.plaintext)).toBe(candidateText);
    expect(deferred.target).toBeNull();
    expect(deferred.missingFields).toEqual(["blog"]);

    const confirmed = driver.confirm(confirmInput(candidate, { blog: "My-Blog" }));

    expect(nativePayload(confirmed.plaintext)).toEqual({
      blog: "my-blog",
      token: "stored-token",
      token_secret: "stored-secret",
    });
    expect(confirmed.target).toEqual({ label: "my-blog", source: "user" });
    expect(confirmed.missingFields).toEqual([]);

    expect(driver.confirm(confirmInput(candidate, { blog: "alice.tumblr.com" })).target).toEqual({
      label: "alice",
      source: "user",
    });

    for (const blog of ["not a blog!", "", "alice.tumblr.com/x"]) {
      expect(() => driver.confirm(confirmInput(candidate, { blog }))).toThrowError(OAuthDriverError);
    }
    for (const overrides of [
      { author: "urn:li:person:x" },
      { apiVersion: "202604" },
    ]) {
      expect(() => driver.confirm(confirmInput(candidate, overrides))).toThrowError(
        OAuthDriverError,
      );
    }
    expect(await requests()).toEqual([]);
  });

  it("rejects malformed candidate payloads without network", async () => {
    const driver = await driverFor("tumblr", TUMBLR_VALUES);
    await fetch("https://stats.invalid/_reset");
    const encoder = new TextEncoder();
    const payloads: readonly Uint8Array[] = [
      encoder.encode("{}"),
      encoder.encode(JSON.stringify({ token: "only" })),
      encoder.encode(JSON.stringify({ token: "", token_secret: "s" })),
      encoder.encode(
        JSON.stringify({ token: "t", token_secret: "s", consumer_key: "app-secret-copy" }),
      ),
      encoder.encode('{"token":" padded","token_secret":"s"}'),
      encoder.encode('{"token":"t\\n","token_secret":"s"}'),
      new Uint8Array(0),
      new Uint8Array([0x7b, 0xff]),
    ];
    for (const candidate of payloads) {
      expect(() => driver.confirm(confirmInput(candidate))).toThrowError(OAuthDriverError);
    }
    expect(await requests()).toEqual([]);
  });

  it("rejects padded request and access tokens before they can be stored", async () => {
    const beginDriver = await driverFor("tumblr", TUMBLR_VALUES);
    const beginFailure = await failureOf(() =>
      beginDriver.begin({ state: "state-padded-token", now: NOW }),
    );
    expect(beginFailure).toBeInstanceOf(OAuthDriverError);
    expect((beginFailure as OAuthDriverError).reason).toBe("invalid_response");
    expect(await requests()).toHaveLength(1);

    await fetch("https://stats.invalid/_reset");
    const exchangeDriver = await driverFor("tumblr", TUMBLR_VALUES);
    const exchangeFailure = await failureOf(() =>
      exchangeDriver.exchange({
        callback: {
          platform: "tumblr",
          state: "state-abc",
          code: null,
          verifier: "padded-secret",
          requestToken: "tumblr-req",
        },
        requestSecret: new TextEncoder().encode("tumblr-req-secret"),
        now: NOW,
      }),
    );
    expect(exchangeFailure).toBeInstanceOf(OAuthDriverError);
    expect((exchangeFailure as OAuthDriverError).reason).toBe("invalid_response");
    expect(await requests()).toHaveLength(1);
  });
});

describe("LinkedIn OAuth2 driver", () => {
  const CALLBACK = `${ORIGIN}/v1/auth/linkedin/callback`;

  it("builds the authorization URL without sending a request", async () => {
    const driver = await driverFor("linkedin", LINKEDIN_VALUES);
    expect(driver.protocol).toBe("oauth2");
    expect(driver.canonicalCallbackUrl).toBe(CALLBACK);
    await fetch("https://stats.invalid/_reset");

    const begin = await driver.begin({ state: "state-abc", now: NOW });

    expect(await requests()).toEqual([]);
    expect(begin.requestToken).toBeNull();
    expect(begin.requestSecret).toBeNull();
    const url = new URL(begin.authorizationUrl);
    expect(url.origin).toBe("https://www.linkedin.com");
    expect(url.pathname).toBe("/oauth/v2/authorization");
    expect([...url.searchParams.entries()].sort()).toEqual([
      ["client_id", LINKEDIN_VALUES.LINKEDIN_CLIENT_ID],
      ["redirect_uri", CALLBACK],
      ["response_type", "code"],
      ["scope", "w_member_social openid profile"],
      ["state", "state-abc"],
    ]);
  });

  it("exchanges one code with form parameters and the strict token response", async () => {
    const driver = await driverFor("linkedin", LINKEDIN_VALUES);
    await fetch("https://stats.invalid/_reset");

    const result = await driver.exchange({
      callback: linkedInCallback("code-alpha"),
      requestSecret: null,
      now: NOW,
    });

    const recorded = await requests();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe("POST");
    expect(recorded[0]?.url).toBe("https://www.linkedin.com/oauth/v2/accessToken");
    expect(recorded[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(formBody(recorded[0]?.body ?? "")).toEqual({
      grant_type: "authorization_code",
      code: "code-alpha",
      redirect_uri: CALLBACK,
      client_id: LINKEDIN_VALUES.LINKEDIN_CLIENT_ID,
      client_secret: LINKEDIN_VALUES.LINKEDIN_CLIENT_SECRET,
    });
    expect(nativePayload(result.plaintext)).toEqual({
      access_token: "li-token",
      refresh_token: "li-refresh",
    });
    expect(result.expiresAt).toBe("2026-09-23T01:00:00.000Z");
    expect(result.target).toBeNull();
    expect(result.missingFields).toEqual(["author", "api_version"]);
  });

  it("accepts only the documented success payloads", async () => {
    const cases: readonly (readonly [string, string | null, Record<string, string>])[] = [
      ["code-no-refresh", null, { access_token: "li-token" }],
      ["code-expiry-zero", NOW, { access_token: "li-token" }],
    ];
    for (const [code, expectedExpiry, expectedPayload] of cases) {
      await fetch("https://stats.invalid/_reset");
      const driver = await driverFor("linkedin", LINKEDIN_VALUES);

      const result = await driver.exchange({
        callback: linkedInCallback(code),
        requestSecret: null,
        now: NOW,
      });

      expect(nativePayload(result.plaintext), code).toEqual(expectedPayload);
      expect(result.expiresAt, code).toBe(expectedExpiry);
      expect(result.target, code).toBeNull();
      expect(result.missingFields, code).toEqual(["author", "api_version"]);
      expect(await requests(), code).toHaveLength(1);
    }
  });

  it("rejects undecodable, empty, wrong-type and refused token responses once", async () => {
    const cases: readonly (readonly [string, string])[] = [
      ["code-bad-json", "invalid_response"],
      ["code-array", "invalid_response"],
      ["code-empty-token", "invalid_response"],
      ["code-padded-token", "invalid_response"],
      ["code-control-token", "invalid_response"],
      ["code-padded-refresh", "invalid_response"],
      ["code-no-token", "invalid_response"],
      ["code-empty-refresh", "invalid_response"],
      ["code-null-refresh", "invalid_response"],
      ["code-expiry-negative", "invalid_response"],
      ["code-expiry-float", "invalid_response"],
      ["code-expiry-string", "invalid_response"],
      ["code-expiry-huge", "invalid_response"],
      ["code-denied", "denied"],
    ];
    for (const [code, reason] of cases) {
      await fetch("https://stats.invalid/_reset");
      const driver = await driverFor("linkedin", LINKEDIN_VALUES);

      const failure = await failureOf(() =>
        driver.exchange({ callback: linkedInCallback(code), requestSecret: null, now: NOW }),
      );

      expect(failure, code).toBeInstanceOf(OAuthDriverError);
      expect((failure as OAuthDriverError).reason, code).toBe(reason);
      expect(await requests(), code).toHaveLength(1);
      expect(JSON.stringify(failure), code).not.toContain("li-refresh");
      expect(JSON.stringify(failure), code).not.toContain(LINKEDIN_VALUES.LINKEDIN_CLIENT_SECRET);
    }
  });

  it("confirms the explicit author and API version and rejects overrides", async () => {
    const driver = await driverFor("linkedin", LINKEDIN_VALUES);
    await fetch("https://stats.invalid/_reset");
    const candidateText = '{"access_token":"stored-token","refresh_token":"stored-refresh"}';
    const candidate = new TextEncoder().encode(candidateText);

    const deferred = driver.confirm(confirmInput(candidate));
    expect(new TextDecoder().decode(deferred.plaintext)).toBe(candidateText);
    expect(deferred.target).toBeNull();
    expect(deferred.missingFields).toEqual(["author", "api_version"]);

    const authorOnly = driver.confirm(
      confirmInput(candidate, { author: "urn:li:person:abc123" }),
    );
    expect(authorOnly.missingFields).toEqual(["api_version"]);
    expect(authorOnly.target).toBeNull();
    expect(new TextDecoder().decode(authorOnly.plaintext)).toBe(candidateText);

    expect(
      driver.confirm(confirmInput(candidate, { apiVersion: "202604" })).missingFields,
    ).toEqual(["author"]);

    const confirmed = driver.confirm(
      confirmInput(candidate, { author: "urn:li:person:abc123", apiVersion: "202604" }),
    );
    expect(nativePayload(confirmed.plaintext)).toEqual({
      access_token: "stored-token",
      refresh_token: "stored-refresh",
      author: "urn:li:person:abc123",
      api_version: "202604",
    });
    expect(confirmed.target).toEqual({ label: "urn:li:person:abc123", source: "user" });
    expect(confirmed.missingFields).toEqual([]);

    for (const overrides of [
      { author: "alice", apiVersion: "202604" },
      { author: "urn:li:person:abc123", apiVersion: "2026" },
      { author: "urn:li:organization:0", apiVersion: "202604" },
      { author: "urn:li:person:abc123", apiVersion: "202613" },
      { blog: "alice" },
    ]) {
      expect(() => driver.confirm(confirmInput(candidate, overrides))).toThrowError(
        OAuthDriverError,
      );
    }

    for (const text of [
      '{"access_token":""}',
      '{"access_token":"t","refresh_token":""}',
      '{"access_token":"t","unknown":"x"}',
      '{"access_token":"t","author":"urn:li:person:abc","api_version":"202604","extra":"x"}',
      '{"refresh_token":"r"}',
      "{}",
    ]) {
      expect(() => driver.confirm(confirmInput(new TextEncoder().encode(text)))).toThrowError(
        OAuthDriverError,
      );
    }
    expect(await requests()).toEqual([]);
  });
});

describe("LinkedIn refresh driver", () => {
  const AUTHOR = "urn:li:person:abc123";
  const API_VERSION = "202604";

  function refreshPayload(refreshToken: string, extra: Record<string, string> = {}): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({
        access_token: "li-token",
        refresh_token: refreshToken,
        author: AUTHOR,
        api_version: API_VERSION,
        ...extra,
      }),
    );
  }

  function refreshDriverFor(platform: Platform): OAuthRefreshDriver {
    const driver = createLinkedInRefreshResolver({ values: LINKEDIN_VALUES })(platform);
    expect(driver).not.toBeNull();
    return driver as OAuthRefreshDriver;
  }

  it("preflights the complete stored payload without any network", async () => {
    const driver = refreshDriverFor("linkedin");
    await fetch("https://stats.invalid/_reset");
    const encoder = new TextEncoder();

    expect(driver.canRefresh(refreshPayload("li-refresh"))).toBe(true);
    expect(
      driver.canRefresh(
        encoder.encode(
          JSON.stringify({ access_token: "t", author: AUTHOR, api_version: API_VERSION }),
        ),
      ),
    ).toBe(false);
    expect(driver.canRefresh(refreshPayload(""))).toBe(false);
    expect(
      driver.canRefresh(
        encoder.encode(
          JSON.stringify({
            access_token: "t",
            refresh_token: "r",
            author: "alice",
            api_version: API_VERSION,
          }),
        ),
      ),
    ).toBe(false);
    expect(
      driver.canRefresh(
        encoder.encode(
          JSON.stringify({ access_token: "t", refresh_token: "r", author: AUTHOR }),
        ),
      ),
    ).toBe(false);
    expect(driver.canRefresh(refreshPayload("r", { extra: "unknown" }))).toBe(false);
    expect(driver.canRefresh(encoder.encode("not-json"))).toBe(false);
    expect(driver.canRefresh(new Uint8Array(0))).toBe(false);
    expect(driver.canRefresh(new Uint8Array([0xff, 0xfe]))).toBe(false);

    expect(await requests()).toEqual([]);
  });

  it("rotates the refresh token and preserves author and API version", async () => {
    const driver = refreshDriverFor("linkedin");
    await fetch("https://stats.invalid/_reset");
    await fetch("https://stats.invalid/_reset");

    const result = await driver.refresh({ plaintext: refreshPayload("refresh-rotated"), now: NOW });

    const recorded = await requests();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe("POST");
    expect(recorded[0]?.url).toBe("https://www.linkedin.com/oauth/v2/accessToken");
    expect(formBody(recorded[0]?.body ?? "")).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-rotated",
      client_id: LINKEDIN_VALUES.LINKEDIN_CLIENT_ID,
      client_secret: LINKEDIN_VALUES.LINKEDIN_CLIENT_SECRET,
    });
    expect(nativePayload(result.plaintext)).toEqual({
      access_token: "li-new",
      refresh_token: "li-rotated",
      author: AUTHOR,
      api_version: API_VERSION,
    });
    expect(result.expiresAt).toBe("2026-09-23T00:01:00.000Z");
    // A refreshed payload must always pass this driver's own preflight, so a
    // committed group can never be unreadable by the next refresh.
    expect(driver.canRefresh(result.plaintext)).toBe(true);
  });

  it("preserves the stored refresh token only when the provider omits it", async () => {
    const driver = refreshDriverFor("linkedin");
    await fetch("https://stats.invalid/_reset");

    const result = await driver.refresh({ plaintext: refreshPayload("refresh-absent"), now: NOW });

    expect(nativePayload(result.plaintext)).toEqual({
      access_token: "li-new",
      refresh_token: "refresh-absent",
      author: AUTHOR,
      api_version: API_VERSION,
    });
    expect(result.expiresAt).toBe("2026-09-23T00:01:00.000Z");

    for (const token of ["refresh-empty"]) {
      await fetch("https://stats.invalid/_reset");
      const failure = await failureOf(() =>
        driver.refresh({ plaintext: refreshPayload(token), now: NOW }),
      );
      expect(failure, token).toBeInstanceOf(OAuthDriverError);
      expect((failure as OAuthDriverError).reason, token).toBe("invalid_response");
      expect(await requests(), token).toHaveLength(1);
      expect(JSON.stringify(failure), token).not.toContain("li-new");
    }
  });

  it("rejects padded or control-bearing provider tokens on the refresh path", async () => {
    const driver = refreshDriverFor("linkedin");

    for (const token of ["refresh-padded-token", "refresh-control-refresh"]) {
      await fetch("https://stats.invalid/_reset");

      const failure = await failureOf(() =>
        driver.refresh({ plaintext: refreshPayload(token), now: NOW }),
      );

      expect(failure, token).toBeInstanceOf(OAuthDriverError);
      expect((failure as OAuthDriverError).reason, token).toBe("invalid_response");
      expect(await requests(), token).toHaveLength(1);
      expect(JSON.stringify(failure), token).not.toContain("li-rotated");
    }
  });

  it("fails closed before any request on an unusable stored payload", async () => {
    const driver = refreshDriverFor("linkedin");
    await fetch("https://stats.invalid/_reset");

    for (const text of [
      '{"access_token":"t"}',
      '{"access_token":"t","refresh_token":"r"}',
      '{"access_token":"t","refresh_token":"r","author":"alice","api_version":"202604"}',
      "not-json",
    ]) {
      const failure = await failureOf(() =>
        driver.refresh({ plaintext: new TextEncoder().encode(text), now: NOW }),
      );
      expect(failure, text).toBeInstanceOf(OAuthDriverError);
      expect((failure as OAuthDriverError).reason, text).toBe("invalid_response");
    }

    expect(await requests()).toEqual([]);
  });

  it("reports a provider refusal as denied", async () => {
    const driver = refreshDriverFor("linkedin");
    await fetch("https://stats.invalid/_reset");

    const failure = await failureOf(() =>
      driver.refresh({ plaintext: refreshPayload("refresh-denied"), now: NOW }),
    );

    expect(failure).toBeInstanceOf(OAuthDriverError);
    expect((failure as OAuthDriverError).reason).toBe("denied");
    expect(await requests()).toHaveLength(1);
    expect(JSON.stringify(failure)).not.toContain("refresh-denied");
  });
});

describe("OAuth driver resolver invariants", () => {
  it("derives a stable, domain-separated configuration fingerprint", async () => {
    const first = await driverFor("x", X_VALUES);
    const second = await driverFor("x", X_VALUES);

    expect(first.startConfigBinding).toBe(second.startConfigBinding);
    expect(first.startConfigBinding).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(first.startConfigBinding).not.toContain(X_VALUES.X_API_SECRET);

    const rotated = await driverFor("x", { ...X_VALUES, X_API_SECRET: "rotated-app-secret" });
    expect(rotated.startConfigBinding).not.toBe(first.startConfigBinding);

    const movedOrigin = await driverFor("x", X_VALUES, "https://other.example");
    expect(movedOrigin.startConfigBinding).not.toBe(first.startConfigBinding);

    const unrelated = await driverFor("x", { ...X_VALUES, X_ACCESS_TOKEN: "unrelated" });
    expect(unrelated.startConfigBinding).toBe(first.startConfigBinding);

    const tumblr = await driverFor("tumblr", TUMBLR_VALUES);
    expect(tumblr.startConfigBinding).not.toBe(first.startConfigBinding);

    // A publishing connection binding over the same platform and signer must
    // never collide with the OAuth configuration fingerprint.
    const publishingBinding = await computeCredentialBinding(
      encodeBindingMaterial({
        platform: "x",
        source: "env",
        fields: [
          ["api_key", X_VALUES.X_API_KEY],
          ["api_secret", X_VALUES.X_API_SECRET],
          ["access_token", "user-access"],
          ["access_token_secret", "user-secret"],
        ],
      }),
      SIGNER,
    );
    expect(publishingBinding).not.toBe(first.startConfigBinding);
  });

  it("captures the signer once and computes each platform fingerprint once", async () => {
    let calls = 0;
    const mutable: BindingSigner = {
      async sign(material) {
        calls += 1;
        return SIGNER.sign(material);
      },
    };
    const resolverInstance = createOAuthDriverResolver({
      values: X_VALUES,
      publicUrl: ORIGIN,
      signer: mutable,
    });

    const before = (await resolverInstance("x")) as OAuthDriver;
    mutable.sign = async () => "0".repeat(64);
    const after = (await resolverInstance("x")) as OAuthDriver;
    const independent = await driverFor("x", X_VALUES);

    expect(after.startConfigBinding).toBe(before.startConfigBinding);
    expect(before.startConfigBinding).toBe(independent.startConfigBinding);
    expect(calls).toBe(1);
  });

  it("fails a supported platform as configuration-unavailable and returns null only when unsupported", async () => {
    const unavailable = "OAuth configuration is unavailable";
    await fetch("https://stats.invalid/_reset");

    for (const values of [{}, { X_API_KEY: "half-a-group" }]) {
      await expect(resolver(values)("x")).rejects.toThrow(unavailable);
    }
    await expect(resolver({}, ORIGIN)("tumblr")).rejects.toThrow(unavailable);
    await expect(resolver({}, ORIGIN)("linkedin")).rejects.toThrow(unavailable);
    await expect(resolver(X_VALUES, null)("x")).rejects.toThrow(unavailable);
    await expect(resolver(X_VALUES, "http://worker.example")("x")).rejects.toThrow(unavailable);
    await expect(resolver(X_VALUES, "https://worker.example/path")("x")).rejects.toThrow(
      unavailable,
    );

    // A platform this build cannot drive stays null, whatever the configuration
    // says, because the portable use case maps null to "unsupported".
    expect(await resolver({})("bluesky")).toBeNull();
    expect(await resolver(X_VALUES)("threads")).toBeNull();

    expect(() =>
      createOAuthDriverResolver({
        values: X_VALUES,
        publicUrl: ORIGIN,
        signer: {} as unknown as BindingSigner,
      }),
    ).toThrowError(Error);

    const normalized = await driverFor("x", X_VALUES, "https://worker.example/");
    expect(normalized.canonicalCallbackUrl).toBe(`${ORIGIN}/v1/auth/x/callback`);
    expect(await requests()).toEqual([]);
  });

  it("keeps the LinkedIn refresh resolver usable without a public origin", async () => {
    const unavailable = "OAuth configuration is unavailable";
    const connect = createOAuthDriverResolver({
      values: LINKEDIN_VALUES,
      publicUrl: null,
      signer: SIGNER,
    });
    const refresh = createLinkedInRefreshResolver({ values: LINKEDIN_VALUES });

    // Connect needs the origin and fails closed; refresh needs no origin at all.
    await expect(connect("linkedin")).rejects.toThrow(unavailable);
    expect(refresh("linkedin")).not.toBeNull();
    expect(refresh("x")).toBeNull();
    expect(refresh("bluesky")).toBeNull();
    expect(() => createLinkedInRefreshResolver({ values: {} })("linkedin")).toThrow(unavailable);
    expect(() =>
      createLinkedInRefreshResolver({ values: { LINKEDIN_CLIENT_ID: "half" } })("linkedin"),
    ).toThrow(unavailable);
  });

  it("maps resolver outcomes through the portable connect use case", async () => {
    const fake = createSnapshotFake();
    let issued = 0;
    const ids = (kind: "oauth_state" | "operation_id"): string => `${kind}-${(issued += 1)}`;
    const dependencies = (drivers: OAuthDriverResolver) => ({
      credentials: fake.credentials,
      getCipher: () => fake.cipher,
      drivers,
      clock: fake.clock,
      ids,
    });
    await fetch("https://stats.invalid/_reset");

    // Null resolver result: this build has no OAuth flow for the platform.
    await expect(
      beginOAuthConnect(
        { platform: "bluesky" },
        dependencies(
          createOAuthDriverResolver({ values: X_VALUES, publicUrl: ORIGIN, signer: SIGNER }),
        ),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", reason: "oauth_unsupported" });

    // A supported platform with unusable configuration is instance readiness.
    for (const values of [{}, X_VALUES]) {
      const publicUrl = values === X_VALUES ? null : ORIGIN;
      const failure = await failureOf(() =>
        beginOAuthConnect(
          { platform: "x" },
          dependencies(createOAuthDriverResolver({ values, publicUrl, signer: SIGNER })),
        ),
      );
      expect(failure).toBeInstanceOf(AuthUseCaseError);
      expect((failure as AuthUseCaseError).code).toBe("INSTANCE_NOT_READY");
      expect((failure as AuthUseCaseError).reason).toBe("unavailable");
    }

    expect(await requests()).toEqual([]);
  });
});

describe("OAuth protocol helpers", () => {
  it("accepts only a bare HTTPS origin in its raw form", () => {
    expect(parsePublicOrigin("https://worker.example")).toBe("https://worker.example");
    expect(parsePublicOrigin("https://worker.example/")).toBe("https://worker.example");
    expect(parsePublicOrigin("https://worker.example:8443")).toBe("https://worker.example:8443");

    const rejected: readonly unknown[] = [
      "http://worker.example",
      "https://worker.example/path",
      "https://worker.example/a/..",
      "https://worker.example/?",
      "https://worker.example/#",
      "https://worker.example?",
      "https://worker.example#fragment",
      "https://user@worker.example",
      "https://worker.example\\a",
      "HTTPS://worker.example",
      " https://worker.example",
      "https://worker.example ",
      "https://worker.example\n",
      "https://worker.e\u0000xample",
      "",
      null,
      42,
      `https://${"a".repeat(2_100)}.example`,
    ];
    for (const value of rejected) {
      expect(parsePublicOrigin(value), String(value)).toBeNull();
    }
  });

  it("bounds expires_in to the Date domain against the exchange baseline", () => {
    expect(expiresAtFromSeconds(undefined, NOW)).toEqual({ kind: "ok", expiresAt: null });
    expect(expiresAtFromSeconds(0, NOW)).toEqual({ kind: "ok", expiresAt: NOW });
    expect(expiresAtFromSeconds(60, NOW)).toEqual({
      kind: "ok",
      expiresAt: "2026-09-23T00:01:00.000Z",
    });

    const invalid: readonly unknown[] = [
      -1,
      1.5,
      "60",
      null,
      true,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      9_007_199_254_740_992,
      9_007_199_254_740_991,
      8_640_000_000_001,
    ];
    for (const value of invalid) {
      expect(expiresAtFromSeconds(value, NOW), String(value)).toEqual({ kind: "invalid" });
    }
  });

  it("fails closed on a destination the fixture does not list", async () => {
    await fetch("https://stats.invalid/_reset");

    const response = await fetch("https://unlisted.invalid/oauth/token");
    const state = await fixtureState();

    expect({ status: response.status, unexpected: state.unexpected }).toEqual({
      status: 500,
      unexpected: 1,
    });
    expect(state.requests.map((request) => request.url)).toEqual([
      "https://unlisted.invalid/oauth/token",
    ]);
  });
});
