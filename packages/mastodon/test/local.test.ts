/// <reference types="node" />

import type { ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  LocalProviderError,
  type FrozenDelivery,
  type LocalCredentials,
  type TargetBinding,
} from "@syndroo/core";

import {
  MastodonLocalProvider,
  mastodonTargetId,
  parseMastodonTargetId,
} from "../src/index.js";
import {
  headerOf,
  hold,
  loopbackTransport,
  rawResponse,
  redirectResponse,
  startFixtureServer,
  waitFor,
  type FixtureHandler,
  type FixtureServer,
  type RecordedRequest,
} from "./support/loopback.js";

const TRUSTED_ORIGIN = "https://mastodon.test";
const ACCESS_TOKEN = "mastodon-user-token";
const ACCOUNT_ID = "109412345678901234";
const STATUS_ID = "115000000000000001";
const CREATED_AT = "2026-10-04T00:00:00.000Z";
const CANARY = "SECRET_CANARY_TOKEN_123";
const CONNECTION_ID = "conn_0123456789abcdef0123456789abcdef";

const DEFAULT_ACCOUNT = { id: ACCOUNT_ID, username: "alice", display_name: "Alice" };
const DEFAULT_INSTANCE = {
  configuration: { statuses: { max_characters: 500, characters_reserved_per_url: 23 } },
};
const DEFAULT_STATUS = {
  id: STATUS_ID,
  url: `${TRUSTED_ORIGIN}/@alice/${STATUS_ID}`,
};

interface Route {
  readonly status: number;
  readonly body?: unknown;
  readonly raw?: string;
  readonly headers?: Record<string, string>;
}

/** A route may either return a body or take over the response itself. */
type RouteFactory = (
  request: RecordedRequest,
  response: ServerResponse,
) => Route | void;

const servers: FixtureServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
});

async function startServer(handler: FixtureHandler): Promise<FixtureServer> {
  const server = await startFixtureServer(handler);
  servers.push(server);

  return server;
}

/** Routes the three Mastodon endpoints; every other path is a 404. */
function mastodonFixture(
  routes: { account?: RouteFactory; instance?: RouteFactory; statuses?: RouteFactory } = {},
): FixtureHandler {
  return (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const factory =
      path === "/api/v1/accounts/verify_credentials"
        ? (routes.account ?? (() => ({ status: 200, body: DEFAULT_ACCOUNT })))
        : path === "/api/v2/instance"
          ? (routes.instance ?? (() => ({ status: 200, body: DEFAULT_INSTANCE })))
          : path === "/api/v1/statuses"
            ? (routes.statuses ?? (() => ({ status: 200, body: DEFAULT_STATUS })))
            : undefined;

    if (factory === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }

    const result: Route | void = factory(request, response);

    if (result === undefined) {
      return;
    }

    rawResponse(
      response,
      result.status,
      result.raw ?? JSON.stringify(result.body ?? null),
      result.headers ?? {},
    );
  };
}

function providerFor(server: FixtureServer, timeoutMs = 1_000): MastodonLocalProvider {
  return new MastodonLocalProvider({
    fetch: loopbackTransport(TRUSTED_ORIGIN, server.origin),
    timeoutMs,
  });
}

function credentials(overrides: Record<string, unknown> = {}): LocalCredentials {
  return {
    provider: "mastodon",
    instance: TRUSTED_ORIGIN,
    accessToken: ACCESS_TOKEN,
    ...overrides,
  } as LocalCredentials;
}

function target(overrides: Partial<TargetBinding> = {}): TargetBinding {
  return {
    provider: "mastodon",
    targetId: mastodonTargetId(TRUSTED_ORIGIN, ACCOUNT_ID),
    connectionId: CONNECTION_ID,
    bindingRevision: 1,
    ...overrides,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function deliveryFor(
  provider: MastodonLocalProvider,
  boundTarget: TargetBinding,
  content: string,
  overrides: {
    payload?: Record<string, unknown>;
    payloadVersion?: number;
    content?: string;
    target?: TargetBinding;
    deliveryId?: string;
  } = {},
): FrozenDelivery {
  const frozen = provider.freeze(content, CREATED_AT);

  return {
    deliveryId: overrides.deliveryId ?? "0".repeat(64),
    key: "syndroo-test-key",
    namespace: "default",
    target: overrides.target ?? boundTarget,
    content: overrides.content ?? content,
    payloadVersion: overrides.payloadVersion ?? frozen.payloadVersion,
    payloadHash: "0".repeat(64),
    payload: overrides.payload ?? frozen.payload,
  };
}

function statusRequests(server: FixtureServer) {
  return server.requests.filter(request => request.url === "/api/v1/statuses");
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(LocalProviderError);
  expect((error as LocalProviderError).code).toBe(code);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("identity", () => {
  it("returns the stable target, sanitized display name, and capabilities", async () => {
    const server = await startServer(mastodonFixture());
    const provider = providerFor(server);

    const identity = await provider.verifyIdentity(credentials(), signal());

    expect(identity).toEqual({
      targetId: mastodonTargetId(TRUSTED_ORIGIN, ACCOUNT_ID),
      displayName: "Alice",
      capabilities: { maxCharacters: 500, charactersReservedPerUrl: 23 },
    });
    expect(parseMastodonTargetId(identity.targetId)).toEqual({
      origin: TRUSTED_ORIGIN,
      accountId: ACCOUNT_ID,
    });
    expect(server.requests.map(request => request.url)).toEqual([
      "/api/v1/accounts/verify_credentials",
      "/api/v2/instance",
    ]);
    expect(headerOf(server.requests[0]!, "authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    // The public instance endpoint never receives the user token.
    expect(headerOf(server.requests[1]!, "authorization")).toBeUndefined();
  });

  it.each([
    { label: "another provider", value: { provider: "threads", accessToken: ACCESS_TOKEN } },
    { label: "a malformed token", value: credentials({ accessToken: "has space" }) },
    { label: "an empty token", value: credentials({ accessToken: "" }) },
    { label: "an http origin", value: credentials({ instance: "http://mastodon.test" }) },
    { label: "a non-443 port", value: credentials({ instance: "https://mastodon.test:8443" }) },
    { label: "userinfo", value: credentials({ instance: "https://user@mastodon.test" }) },
    { label: "a path", value: credentials({ instance: "https://mastodon.test/path" }) },
    { label: "a query", value: credentials({ instance: "https://mastodon.test?x=1" }) },
    { label: "a fragment", value: credentials({ instance: "https://mastodon.test#x" }) },
    { label: "a non-url", value: credentials({ instance: "not a url" }) },
  ])("rejects $label credentials before any request", async ({ value }) => {
    const server = await startServer(mastodonFixture());
    const provider = providerFor(server);
    let caught: unknown;

    try {
      await provider.verifyIdentity(value as LocalCredentials, signal());
    } catch (error) {
      caught = error;
    }

    expectCode(caught, "AUTH");
    expect(server.requestCount()).toBe(0);
  });

  it("fails an application-only token", async () => {
    const server = await startServer(
      mastodonFixture({ account: () => ({ status: 401, body: { error: "This action is not allowed" } }) }),
    );
    const provider = providerFor(server);
    let caught: unknown;

    try {
      await provider.verifyIdentity(credentials(), signal());
    } catch (error) {
      caught = error;
    }

    expectCode(caught, "AUTH");
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    { label: "a missing id", account: { username: "alice" } },
    { label: "a non-numeric id", account: { id: "acct-1", username: "alice" } },
    { label: "a zero id", account: { id: "0", username: "alice" } },
  ])("fails identity with $label", async ({ account }) => {
    const server = await startServer(mastodonFixture({ account: () => ({ status: 200, body: account }) }));
    const provider = providerFor(server);
    let caught: unknown;

    try {
      await provider.verifyIdentity(credentials(), signal());
    } catch (error) {
      caught = error;
    }

    expectCode(caught, "PROVIDER_UNAVAILABLE");
  });

  it("omits a display name that echoes the access token", async () => {
    const server = await startServer(
      mastodonFixture({
        account: () => ({ status: 200, body: { ...DEFAULT_ACCOUNT, display_name: `Alice ${ACCESS_TOKEN}` } }),
      }),
    );
    const provider = providerFor(server);
    const identity = await provider.verifyIdentity(credentials(), signal());

    expect(identity.displayName).toBeUndefined();
  });

  it("omits a display name that percent-encodes the access token", async () => {
    const server = await startServer(
      mastodonFixture({
        account: () => ({
          status: 200,
          body: { ...DEFAULT_ACCOUNT, display_name: "Alice mastodon%2Duser%2Dtoken" },
        }),
      }),
    );
    const provider = providerFor(server);
    const identity = await provider.verifyIdentity(credentials(), signal());

    expect(identity.displayName).toBeUndefined();
  });

  it.each([
    { label: "a missing configuration", body: {} },
    { label: "a missing statuses block", body: { configuration: {} } },
    { label: "a string max_characters", body: { configuration: { statuses: { max_characters: "500", characters_reserved_per_url: 23 } } } },
    { label: "a zero max_characters", body: { configuration: { statuses: { max_characters: 0, characters_reserved_per_url: 23 } } } },
    { label: "a fractional max_characters", body: { configuration: { statuses: { max_characters: 500.5, characters_reserved_per_url: 23 } } } },
    { label: "a missing reserved length", body: { configuration: { statuses: { max_characters: 500 } } } },
    { label: "a zero reserved length", body: { configuration: { statuses: { max_characters: 500, characters_reserved_per_url: 0 } } } },
  ])("fails identity with $label", async ({ body }) => {
    const server = await startServer(mastodonFixture({ instance: () => ({ status: 200, body }) }));
    const provider = providerFor(server);
    let caught: unknown;

    try {
      await provider.verifyIdentity(credentials(), signal());
    } catch (error) {
      caught = error;
    }

    expectCode(caught, "PROVIDER_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// Freeze and cached validation
// ---------------------------------------------------------------------------

describe("freeze", () => {
  it("produces the exact public payload", async () => {
    const server = await startServer(mastodonFixture());
    const provider = providerFor(server);

    expect(provider.freeze("hello", CREATED_AT)).toEqual({
      payloadVersion: 1,
      payload: { status: "hello", visibility: "public" },
    });
    expect(server.requestCount()).toBe(0);
  });

  it("rejects article options and empty content", async () => {
    const server = await startServer(mastodonFixture());
    const provider = providerFor(server);

    expect(() => provider.freeze("hello", CREATED_AT, { article: { title: "t" } })).toThrow(LocalProviderError);
    expect(() => provider.freeze("", CREATED_AT)).toThrow(LocalProviderError);
    expect(() => provider.freeze("a\u0000b", CREATED_AT)).toThrow(LocalProviderError);
  });

  it("validates cached content with the same counter as prepare", async () => {
    const server = await startServer(mastodonFixture());
    const provider = providerFor(server);
    const capabilities = { maxCharacters: 5, charactersReservedPerUrl: 23 };

    expect(() => provider.validateCachedContent("abcde", capabilities)).not.toThrow();
    expect(() => provider.validateCachedContent("abcdef", capabilities)).toThrow(LocalProviderError);
    expect(() => provider.validateCachedContent("https://a.test/p", capabilities)).toThrow(LocalProviderError);
  });
});

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

describe("target identity", () => {
  it("rejects a non-canonical base64url origin encoding", () => {
    const origin = "https://m.example";
    const encoded = Buffer.from(origin, "utf8").toString("base64url");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    // A lenient decoder accepts trailing-bit variants; the canonical form must
    // be the only accepted spelling.
    const variant = [...alphabet]
      .map(char => encoded.slice(0, -1) + char)
      .find(
        candidate =>
          candidate !== encoded &&
          Buffer.from(candidate, "base64url").toString("utf8") === origin,
      );

    expect(variant).toBeDefined();
    expect(parseMastodonTargetId(`mastodon:${encoded}:${ACCOUNT_ID}`)).toEqual({
      origin,
      accountId: ACCOUNT_ID,
    });
    expect(parseMastodonTargetId(`mastodon:${variant!}:${ACCOUNT_ID}`)).toBeNull();
  });
});

describe("prepare", () => {
  it("rejects a different account id in the same origin", async () => {
    const server = await startServer(mastodonFixture());
    const provider = providerFor(server);
    const bound = target({ targetId: mastodonTargetId(TRUSTED_ORIGIN, "999999999999999999") });
    let caught: unknown;

    try {
      await provider.prepare(credentials(), bound, signal(), deliveryFor(provider, bound, "hello"));
    } catch (error) {
      caught = error;
    }

    expectCode(caught, "ACCOUNT_MISMATCH");
    // The account mismatch is discovered from the identity response, so the two
    // read requests happen; the write never does.
    expect(statusRequests(server)).toHaveLength(0);
  });

  it("rejects the same account id under a different origin", async () => {
    const server = await startServer(mastodonFixture());
    const provider = providerFor(server);
    const bound = target({
      targetId: mastodonTargetId("https://other.test", ACCOUNT_ID),
    });
    let caught: unknown;

    try {
      await provider.prepare(credentials(), bound, signal(), deliveryFor(provider, bound, "hello"));
    } catch (error) {
      caught = error;
    }

    expectCode(caught, "ACCOUNT_MISMATCH");
    expect(server.requestCount()).toBe(0);
  });

  it("requires a frozen delivery", async () => {
    const server = await startServer(mastodonFixture());
    const provider = providerFor(server);
    let caught: unknown;

    try {
      await provider.prepare(credentials(), target(), signal());
    } catch (error) {
      caught = error;
    }

    expectCode(caught, "INVALID_CONTENT");
    expect(server.requestCount()).toBe(0);
  });

  it("rejects a frozen delivery that carries content options", async () => {
    const server = await startServer(mastodonFixture());
    const provider = providerFor(server);
    const bound = target();
    const valid = deliveryFor(provider, bound, "hello");
    const withOptions: FrozenDelivery = {
      ...valid,
      contentOptions: { article: { title: "t" } },
    };
    let caught: unknown;

    try {
      await provider.prepare(credentials(), bound, signal(), withOptions);
    } catch (error) {
      caught = error;
    }

    expectCode(caught, "INVALID_CONTENT");
    expect(statusRequests(server)).toHaveLength(0);

    // Publish must reject it too, not only prepare.
    const prepared = await provider.prepare(credentials(), bound, signal(), valid);
    const outcome = await prepared.publish(withOptions, signal());

    expect(outcome).toMatchObject({ kind: "failed", code: "PAYLOAD_MISMATCH" });
    expect(statusRequests(server)).toHaveLength(0);
  });

  it("rejects a limit violation before any POST", async () => {
    const server = await startServer(
      mastodonFixture({
        instance: () => ({
          status: 200,
          body: { configuration: { statuses: { max_characters: 5, characters_reserved_per_url: 23 } } },
        }),
      }),
    );
    const provider = providerFor(server);
    const bound = target();
    let caught: unknown;

    try {
      await provider.prepare(credentials(), bound, signal(), deliveryFor(provider, bound, "abcdefghij"));
    } catch (error) {
      caught = error;
    }

    expectCode(caught, "INVALID_CONTENT");
    expect(statusRequests(server)).toHaveLength(0);
  });

  it("re-reads the current instance limits instead of trusting an earlier call", async () => {
    let maxCharacters = 500;
    const server = await startServer(
      mastodonFixture({
        instance: () => ({
          status: 200,
          body: { configuration: { statuses: { max_characters: maxCharacters, characters_reserved_per_url: 23 } } },
        }),
      }),
    );
    const provider = providerFor(server);

    await provider.verifyIdentity(credentials(), signal());

    maxCharacters = 5;
    const bound = target();
    let caught: unknown;

    try {
      await provider.prepare(credentials(), bound, signal(), deliveryFor(provider, bound, "abcdefghij"));
    } catch (error) {
      caught = error;
    }

    expectCode(caught, "INVALID_CONTENT");
    expect(statusRequests(server)).toHaveLength(0);
  });

  it("fails prepare when the instance capability response becomes malformed", async () => {
    let malformed = false;
    const server = await startServer(
      mastodonFixture({
        instance: () =>
          malformed
            ? { status: 200, body: { configuration: {} } }
            : { status: 200, body: DEFAULT_INSTANCE },
      }),
    );
    const provider = providerFor(server);

    await provider.verifyIdentity(credentials(), signal());
    malformed = true;

    let caught: unknown;

    try {
      await provider.prepare(credentials(), target(), signal(), deliveryFor(provider, target(), "hello"));
    } catch (error) {
      caught = error;
    }

    expectCode(caught, "PROVIDER_UNAVAILABLE");
    expect(statusRequests(server)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

describe("publish", () => {
  it("sends one public status with the bearer header and the delivery key", async () => {
    const server = await startServer(mastodonFixture());
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound, "hello world");
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome).toEqual({
      kind: "succeeded",
      remoteId: STATUS_ID,
      url: `${TRUSTED_ORIGIN}/@alice/${STATUS_ID}`,
    });

    const posts = statusRequests(server);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.method).toBe("POST");
    expect(headerOf(posts[0]!, "authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headerOf(posts[0]!, "idempotency-key")).toBe(delivery.deliveryId);
    expect(JSON.parse(posts[0]!.body)).toEqual({ status: "hello world", visibility: "public" });
  });

  it("keeps the same idempotency key across calls", async () => {
    const server = await startServer(mastodonFixture());
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound, "hello");
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);

    await prepared.publish(delivery, signal());
    await prepared.publish(delivery, signal());

    const posts = statusRequests(server);

    expect(posts).toHaveLength(2);
    expect(headerOf(posts[0]!, "idempotency-key")).toBe(delivery.deliveryId);
    expect(headerOf(posts[1]!, "idempotency-key")).toBe(delivery.deliveryId);
  });

  it.each([
    { label: "an http url", url: `http://mastodon.test/@alice/${STATUS_ID}` },
    { label: "a userinfo url", url: `https://user:pass@mastodon.test/@alice/${STATUS_ID}` },
    { label: "a control-character url", url: `https://mastodon.test/@alice/${STATUS_ID}\u0000` },
    { label: "a token-bearing url", url: `https://mastodon.test/@alice/${STATUS_ID}?token=${ACCESS_TOKEN}` },
    { label: "a percent-encoded token url", url: `https://mastodon.test/@alice/${STATUS_ID}?token=mastodon%2Duser%2Dtoken` },
    { label: "a double-encoded token url", url: `https://mastodon.test/@alice/${STATUS_ID}?token=mastodon%252Duser%252Dtoken` },
    { label: "a non-url", url: "not a url" },
  ])("omits $label but still reports success by id", async ({ url }) => {
    const server = await startServer(
      mastodonFixture({ statuses: () => ({ status: 200, body: { id: STATUS_ID, url } }) }),
    );
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound, "hello");
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome).toEqual({ kind: "succeeded", remoteId: STATUS_ID, url: null });
  });

  it.each([
    { label: "a 2xx without an id", route: { status: 200, body: { url: "https://mastodon.test/x" } } },
    { label: "a 2xx with a contradictory error", route: { status: 200, body: { id: STATUS_ID, error: "nope" } } },
    { label: "a 2xx with a non-numeric id", route: { status: 200, body: { id: "status-1" } } },
    { label: "a truncated body", route: { status: 200, raw: `{"id":"${STATUS_ID}` } },
    { label: "an empty body", route: { status: 200, raw: "" } },
    { label: "a 5xx", route: { status: 503, body: { error: "unavailable" } } },
  ])("treats $label as unknown", async ({ route }) => {
    const server = await startServer(mastodonFixture({ statuses: () => route }));
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound, "hello");
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome.kind).toBe("unknown");
    expect((outcome as { writeDisposition: string }).writeDisposition).toBe("unknown");
    expect(statusRequests(server)).toHaveLength(1);
  });

  it("does not follow a redirect", async () => {
    const server = await startServer(
      mastodonFixture({
        statuses: (_request, response) => redirectResponse(response, 302, "https://elsewhere.test/steal"),
      }),
    );
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound, "hello");
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome.kind).toBe("unknown");
    expect(statusRequests(server)).toHaveLength(1);
  });

  it("accepts valid JSON above 64 KiB when it is inside the 1 MiB cap", async () => {
    const server = await startServer(
      mastodonFixture({
        statuses: () => ({
          status: 200,
          raw: JSON.stringify({ id: STATUS_ID, pad: "x".repeat(70_000) }),
        }),
      }),
    );
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound, "hello");
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome).toEqual({
      kind: "succeeded",
      remoteId: STATUS_ID,
      url: null,
    });
  });

  it("treats a response over the 1 MiB cap as unknown", async () => {
    const server = await startServer(
      mastodonFixture({
        statuses: () => ({
          status: 200,
          raw: JSON.stringify({ id: STATUS_ID, pad: "x".repeat(1_100_000) }),
        }),
      }),
    );
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound, "hello");
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome.kind).toBe("unknown");
  });

  it.each([
    {
      label: "a 401 with the Mastodon error envelope",
      route: { status: 401, body: { error: "The access token is invalid" } },
      expected: { kind: "failed", code: "AUTH", retryable: true },
    },
    {
      label: "a 403 with the Mastodon error envelope",
      route: { status: 403, body: { error: "This action is not allowed" } },
      expected: { kind: "failed", code: "PERMISSION", retryable: false },
    },
    {
      label: "a 422 with the Mastodon error envelope",
      route: { status: 422, body: { error: "Validation failed: Text is too long" } },
      expected: { kind: "failed", code: "INVALID_CONTENT", retryable: false },
    },
  ])("classifies $label as a definite rejection", async ({ route, expected }) => {
    const server = await startServer(mastodonFixture({ statuses: () => route }));
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound, "hello");
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome).toMatchObject(expected);
    expect(outcome).toMatchObject({ writeDisposition: "not_applied" });
  });

  it.each([
    { label: "a bare 401", route: { status: 401, body: {} } },
    { label: "a bare 403", route: { status: 403, raw: "" } },
    { label: "a bare 422", route: { status: 422, body: { error: 42 } } },
    { label: "a bare 429", route: { status: 429, body: {} } },
  ])("keeps $label unknown without structured evidence", async ({ route }) => {
    const server = await startServer(mastodonFixture({ statuses: () => route }));
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound, "hello");
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome.kind).toBe("unknown");
  });

  it("honors a bounded Retry-After and refuses an unsafe one", async () => {
    const bounded = await startServer(
      mastodonFixture({
        statuses: () => ({
          status: 429,
          body: { error: "Too many requests" },
          headers: { "retry-after": "120" },
        }),
      }),
    );
    const boundedProvider = providerFor(bounded);
    const boundedTarget = target();
    const boundedDelivery = deliveryFor(boundedProvider, boundedTarget, "hello");
    const boundedPrepared = await boundedProvider.prepare(credentials(), boundedTarget, signal(), boundedDelivery);
    const before = Date.now();
    const boundedOutcome = await boundedPrepared.publish(boundedDelivery, signal());

    expect(boundedOutcome).toMatchObject({
      kind: "failed",
      code: "RATE_LIMIT",
      retryable: true,
    });
    const retryNotBefore = (boundedOutcome as { retryNotBefore: string | null }).retryNotBefore;
    expect(typeof retryNotBefore).toBe("string");
    const at = Date.parse(retryNotBefore!);
    expect(at).toBeGreaterThanOrEqual(before + 119_000);
    expect(at).toBeLessThanOrEqual(before + 121_000);

    const unsafe = await startServer(
      mastodonFixture({
        statuses: () => ({
          status: 429,
          body: { error: "Too many requests" },
          headers: { "retry-after": "1.5" },
        }),
      }),
    );
    const unsafeProvider = providerFor(unsafe);
    const unsafeTarget = target();
    const unsafeDelivery = deliveryFor(unsafeProvider, unsafeTarget, "hello");
    const unsafePrepared = await unsafeProvider.prepare(credentials(), unsafeTarget, signal(), unsafeDelivery);
    const unsafeOutcome = await unsafePrepared.publish(unsafeDelivery, signal());

    expect(unsafeOutcome).toEqual({
      kind: "failed",
      code: "RATE_LIMIT",
      writeDisposition: "not_applied",
      retryable: false,
      retryNotBefore: null,
    });
  });

  it("returns not_applied for a pre-dispatch abort", async () => {
    const server = await startServer(mastodonFixture());
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound, "hello");
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const controller = new AbortController();
    controller.abort();
    const outcome = await prepared.publish(delivery, controller.signal);

    expect(outcome).toEqual({
      kind: "failed",
      code: "ABORTED",
      writeDisposition: "not_applied",
      retryable: false,
      retryNotBefore: null,
    });
    expect(statusRequests(server)).toHaveLength(0);
  });

  it("returns unknown for a post-dispatch timeout", async () => {
    const fixture = mastodonFixture();
    const server = await startServer((request, response, index) =>
      request.url === "/api/v1/statuses" ? hold() : fixture(request, response, index),
    );
    const provider = providerFor(server, 80);
    const bound = target();
    const delivery = deliveryFor(provider, bound, "hello");
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    await waitFor(() => statusRequests(server).length === 1);
    expect(outcome.kind).toBe("unknown");
    expect((outcome as { code: string }).code).toBe("TIMEOUT");
  });

  it("bounds an injected transport that ignores the abort signal", async () => {
    const server = await startServer(mastodonFixture());
    const base = loopbackTransport(TRUSTED_ORIGIN, server.origin);
    const hanging = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      return url.endsWith("/api/v1/statuses")
        ? new Promise<Response>(() => undefined)
        : base(input, init);
    }) as typeof fetch;
    const provider = new MastodonLocalProvider({ fetch: hanging, timeoutMs: 80 });
    const bound = target();
    const delivery = deliveryFor(provider, bound, "hello");
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome).toEqual({ kind: "unknown", code: "TIMEOUT", writeDisposition: "unknown" });
  });

  it("bounds a stalled response stream that never produces a byte", async () => {
    const server = await startServer(mastodonFixture());
    const base = loopbackTransport(TRUSTED_ORIGIN, server.origin);
    const stalled = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      if (!url.endsWith("/api/v1/statuses")) {
        return base(input, init);
      }

      const stream = new ReadableStream<Uint8Array>({
        start() {
          // Never enqueue and never close: only the deadline can end this.
        },
      });

      return Promise.resolve(new Response(stream, { status: 200 }));
    }) as typeof fetch;
    const provider = new MastodonLocalProvider({ fetch: stalled, timeoutMs: 80 });
    const bound = target();
    const delivery = deliveryFor(provider, bound, "hello");
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome).toEqual({ kind: "unknown", code: "TIMEOUT", writeDisposition: "unknown" });
  });

  it("returns unknown for a dropped connection after dispatch", async () => {
    const server = await startServer(
      mastodonFixture({
        statuses: (_request, response) => {
          response.destroy();
        },
      }),
    );
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound, "hello");
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome.kind).toBe("unknown");
    expect((outcome as { code: string }).code).toBe("NETWORK");
  });

  it.each([
    { label: "a wrong payload version", overrides: { payloadVersion: 2 } },
    { label: "a tampered target", overrides: { target: { provider: "mastodon" as const, targetId: mastodonTargetId(TRUSTED_ORIGIN, "999999999999999999"), connectionId: CONNECTION_ID, bindingRevision: 1 } } },
    { label: "a tampered payload status", overrides: { payload: { status: "other", visibility: "public" } } },
    { label: "a tampered content field", overrides: { content: "other" } },
    { label: "an extra payload key", overrides: { payload: { status: "hello", visibility: "public", scheduled_at: "later" } } },
    { label: "a private visibility", overrides: { payload: { status: "hello", visibility: "private" } } },
  ])("fails $label before any request", async ({ overrides }) => {
    const server = await startServer(mastodonFixture());
    const provider = providerFor(server);
    const bound = target();
    // Prepare with a valid delivery, then publish a tampered one: prepare must
    // not be the only gate.
    const valid = deliveryFor(provider, bound, "hello");
    const prepared = await provider.prepare(credentials(), bound, signal(), valid);
    const tampered = deliveryFor(provider, bound, "hello", overrides);
    const outcome = await prepared.publish(tampered, signal());

    expect(outcome.kind).toBe("failed");
    expect(statusRequests(server)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Constructor and description
// ---------------------------------------------------------------------------

describe("construction", () => {
  it("requires an injected transport and never falls back to global fetch", () => {
    expect(() => new MastodonLocalProvider({} as never)).toThrow(TypeError);
    expect(() => new MastodonLocalProvider(undefined as never)).toThrow(TypeError);
  });

  it("describes the provider as fixture-tested text-only", async () => {
    const server = await startServer(mastodonFixture());
    const provider = providerFor(server);

    expect(provider.describe()).toEqual({
      provider: "mastodon",
      maturity: "fixture-tested",
      localPublish: true,
      unavailableReason: null,
      contentTypes: ["text"],
      authMethods: ["user-token", "oauth"],
      media: false,
      scheduling: false,
    });
    expect(server.requestCount()).toBe(0);
  });
});
