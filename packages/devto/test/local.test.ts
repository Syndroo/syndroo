/// <reference types="node" />

import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  LocalProviderError,
  type FrozenDelivery,
  type LocalCredentials,
  type TargetBinding,
} from "@syndroo/core";

import { DevtoLocalProvider, devtoTargetId, parseDevtoTargetId } from "../src/index.js";
import {
  headerOf,
  hold,
  loopbackTransport,
  rawResponse,
  redirectResponse,
  startFixtureServer,
  type FixtureHandler,
  type FixtureServer,
  type RecordedRequest,
} from "./support/loopback.js";

const TRUSTED_ORIGIN = "https://dev.to";
const API_KEY = "devto-api-key-1234";
const USER_ID = 1234567;
const ARTICLE_ID = 987654;
const CREATED_AT = "2026-10-04T00:00:00.000Z";
const CANARY = "SECRET_CANARY_VALUE_123";
const CONNECTION_ID = "conn_0123456789abcdef0123456789abcdef";
const V1_MEDIA_TYPE = "application/vnd.forem.api-v1+json";

const BODY = "# Safe publishing\n\nVerify the target first.";
const TITLE = "A bounded article";

const DEFAULT_USER = { id: USER_ID, username: "alice", name: "Alice" };
const DEFAULT_ARTICLE = { id: ARTICLE_ID, url: `${TRUSTED_ORIGIN}/alice/example-${ARTICLE_ID}` };

interface Route {
  readonly status: number;
  readonly body?: unknown;
  readonly raw?: string;
  readonly headers?: Record<string, string>;
}

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

/** Routes the two DEV.to endpoints; every other path is a 404. */
function devtoFixture(
  routes: { users?: RouteFactory; articles?: RouteFactory } = {},
): FixtureHandler {
  return (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const factory =
      path === "/api/users/me"
        ? (routes.users ?? (() => ({ status: 200, body: DEFAULT_USER })))
        : path === "/api/articles"
          ? (routes.articles ?? (() => ({ status: 201, body: DEFAULT_ARTICLE })))
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

function providerFor(server: FixtureServer, timeoutMs = 1_000): DevtoLocalProvider {
  return new DevtoLocalProvider({
    fetch: loopbackTransport(TRUSTED_ORIGIN, server.origin),
    timeoutMs,
  });
}

function credentials(overrides: Record<string, unknown> = {}): LocalCredentials {
  return { provider: "devto", apiKey: API_KEY, ...overrides } as LocalCredentials;
}

function target(overrides: Partial<TargetBinding> = {}): TargetBinding {
  return {
    provider: "devto",
    targetId: devtoTargetId(USER_ID),
    connectionId: CONNECTION_ID,
    bindingRevision: 1,
    ...overrides,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function deliveryFor(
  provider: DevtoLocalProvider,
  boundTarget: TargetBinding,
  content = BODY,
  article: { title: string; tags?: readonly string[]; canonicalUrl?: string } = { title: TITLE },
  overrides: {
    payload?: Record<string, unknown>;
    payloadVersion?: number;
    content?: string;
    target?: TargetBinding;
    contentOptions?: unknown;
    omitOptions?: boolean;
  } = {},
): FrozenDelivery {
  const frozen = provider.freeze(content, CREATED_AT, { article });
  const base: FrozenDelivery = {
    deliveryId: "0".repeat(64),
    key: "syndroo-test-key",
    namespace: "default",
    target: overrides.target ?? boundTarget,
    content: overrides.content ?? content,
    contentOptions: { article },
    payloadVersion: overrides.payloadVersion ?? frozen.payloadVersion,
    payloadHash: "0".repeat(64),
    payload: overrides.payload ?? frozen.payload,
  };

  if (overrides.omitOptions === true) {
    const { contentOptions: _omitted, ...withoutOptions } = base;
    return withoutOptions;
  }

  return overrides.contentOptions === undefined
    ? base
    : {
        ...base,
        contentOptions: overrides.contentOptions as NonNullable<FrozenDelivery["contentOptions"]>,
      };
}

function articleRequests(server: FixtureServer) {
  return server.requests.filter(request => request.url === "/api/articles");
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(LocalProviderError);
  expect((error as LocalProviderError).code).toBe(code);
}

// ---------------------------------------------------------------------------
// Construction and description
// ---------------------------------------------------------------------------

describe("construction", () => {
  it("describes the provider as fixture-tested article-only", async () => {
    const server = await startServer(devtoFixture());
    const provider = providerFor(server);

    expect(provider.describe()).toEqual({
      provider: "devto",
      maturity: "fixture-tested",
      localPublish: true,
      unavailableReason: null,
      contentTypes: ["article"],
      authMethods: ["api-key"],
      media: false,
      scheduling: false,
    });
    expect(server.requestCount()).toBe(0);
  });

  it("rejects a non-positive timeout", () => {
    expect(() => new DevtoLocalProvider({ timeoutMs: 0 })).toThrow(TypeError);
    expect(() => new DevtoLocalProvider({ timeoutMs: -1 })).toThrow(TypeError);
  });

  it("does not import Node modules or a configurable host", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/local.ts", import.meta.url)),
      "utf8",
    );

    expect(source).not.toMatch(/node:/);
    expect(source).toContain('const ORIGIN = "https://dev.to"');
    expect(source).not.toMatch(/process\.env|devto\.test|foremHost/i);
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("identity", () => {
  it("reads the numeric account with the v1 media type", async () => {
    const server = await startServer(devtoFixture());
    const provider = providerFor(server);

    const identity = await provider.verifyIdentity(credentials(), signal());

    expect(identity).toEqual({ targetId: `devto:${USER_ID}`, displayName: "Alice" });
    expect(parseDevtoTargetId(identity.targetId)).toBe(USER_ID);
    expect(server.requests.map(request => request.url)).toEqual(["/api/users/me"]);
    expect(headerOf(server.requests[0]!, "api-key")).toBe(API_KEY);
    expect(headerOf(server.requests[0]!, "accept")).toBe(V1_MEDIA_TYPE);
    expect(headerOf(server.requests[0]!, "authorization")).toBeUndefined();
  });

  it.each([
    { label: "another provider", value: { provider: "mastodon", instance: "https://x.test", accessToken: "t" } },
    { label: "an empty key", value: credentials({ apiKey: "" }) },
    { label: "a whitespace key", value: credentials({ apiKey: "has space" }) },
    { label: "a non-string key", value: credentials({ apiKey: 42 }) },
    { label: "an oversized key", value: credentials({ apiKey: "k".repeat(4_097) }) },
  ])("rejects $label credentials before any request", async ({ value }) => {
    const server = await startServer(devtoFixture());
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

  it.each([
    { label: "a numeric string", body: { id: "1234567", username: "alice" } },
    { label: "a fraction", body: { id: 1234.5, username: "alice" } },
    { label: "zero", body: { id: 0, username: "alice" } },
    { label: "a negative id", body: { id: -5, username: "alice" } },
    { label: "an unsafe integer", body: { id: Number.MAX_SAFE_INTEGER + 1, username: "alice" } },
    { label: "a missing id", body: { username: "alice" } },
  ])("fails identity with $label", async ({ body }) => {
    const server = await startServer(devtoFixture({ users: () => ({ status: 200, body }) }));
    const provider = providerFor(server);
    let caught: unknown;

    try {
      await provider.verifyIdentity(credentials(), signal());
    } catch (error) {
      caught = error;
    }

    expectCode(caught, "PROVIDER_UNAVAILABLE");
  });

  it.each([
    { label: "a 401", status: 401 },
    { label: "a 403", status: 403 },
  ])("fails identity with $label", async ({ status }) => {
    const server = await startServer(
      devtoFixture({ users: () => ({ status, body: { error: "unauthorized" } }) }),
    );
    const provider = providerFor(server);
    let caught: unknown;

    try {
      await provider.verifyIdentity(credentials(), signal());
    } catch (error) {
      caught = error;
    }

    expectCode(caught, "AUTH");
  });

  it.each([
    { label: "a literal key", name: `Alice ${API_KEY}` },
    { label: "a percent-encoded key", name: "Alice devto%2Dapi%2Dkey%2D1234" },
  ])("omits a display name that echoes $label", async ({ name }) => {
    const server = await startServer(
      devtoFixture({ users: () => ({ status: 200, body: { ...DEFAULT_USER, name } }) }),
    );
    const provider = providerFor(server);
    const identity = await provider.verifyIdentity(credentials(), signal());

    expect(identity.displayName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Freeze
// ---------------------------------------------------------------------------

describe("freeze", () => {
  it("requires explicit article options", async () => {
    const server = await startServer(devtoFixture());
    const provider = providerFor(server);

    expect(() => provider.freeze(BODY, CREATED_AT)).toThrow(LocalProviderError);
    expect(() => provider.freeze(BODY, CREATED_AT, {})).toThrow(LocalProviderError);
    expect(server.requestCount()).toBe(0);
  });

  it("builds the exact public payload with optional omission", async () => {
    const server = await startServer(devtoFixture());
    const provider = providerFor(server);

    expect(provider.freeze(BODY, CREATED_AT, { article: { title: TITLE } })).toEqual({
      payloadVersion: 1,
      payload: { article: { title: TITLE, body_markdown: BODY, published: true } },
    });
    expect(
      provider.freeze(BODY, CREATED_AT, {
        article: { title: TITLE, tags: [], canonicalUrl: "https://example.com/a" },
      }),
    ).toEqual({
      payloadVersion: 1,
      payload: {
        article: {
          title: TITLE,
          body_markdown: BODY,
          published: true,
          tags: [],
          canonical_url: "https://example.com/a",
        },
      },
    });
    expect(server.requestCount()).toBe(0);
  });

  it("rejects inappropriate metadata", async () => {
    const server = await startServer(devtoFixture());
    const provider = providerFor(server);

    expect(() =>
      provider.freeze(BODY, CREATED_AT, { article: { title: TITLE, series: "x" } as never }),
    ).toThrow(LocalProviderError);
    expect(() =>
      provider.freeze(BODY, CREATED_AT, { article: { title: TITLE }, organization: "x" } as never),
    ).toThrow(LocalProviderError);
  });
});

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

describe("prepare", () => {
  it("rejects an unparseable target id before any request", async () => {
    const server = await startServer(devtoFixture());
    const provider = providerFor(server);
    const bound = target({ targetId: "mastodon:5" });
    let caught: unknown;

    try {
      await provider.prepare(credentials(), bound, signal(), deliveryFor(provider, bound));
    } catch (error) {
      caught = error;
    }

    expectCode(caught, "ACCOUNT_MISMATCH");
    expect(server.requestCount()).toBe(0);
  });

  it("requires a frozen delivery", async () => {
    const server = await startServer(devtoFixture());
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

  it("rejects a changed account after reverifying identity", async () => {
    const server = await startServer(
      devtoFixture({ users: () => ({ status: 200, body: { ...DEFAULT_USER, id: 7654321 } }) }),
    );
    const provider = providerFor(server);
    const bound = target();
    let caught: unknown;

    try {
      await provider.prepare(credentials(), bound, signal(), deliveryFor(provider, bound));
    } catch (error) {
      caught = error;
    }

    expectCode(caught, "ACCOUNT_MISMATCH");
    expect(articleRequests(server)).toHaveLength(0);
  });

  it("rejects a delivery without frozen options", async () => {
    const server = await startServer(devtoFixture());
    const provider = providerFor(server);
    const bound = target();
    let caught: unknown;

    try {
      await provider.prepare(
        credentials(),
        bound,
        signal(),
        deliveryFor(provider, bound, BODY, { title: TITLE }, { omitOptions: true }),
      );
    } catch (error) {
      caught = error;
    }

    expectCode(caught, "INVALID_CONTENT");
    expect(articleRequests(server)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

describe("publish", () => {
  it("sends one article with the v1 media type and the exact frozen payload", async () => {
    const server = await startServer(devtoFixture());
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound, BODY, {
      title: TITLE,
      tags: ["typescript", "opensource"],
      canonicalUrl: "https://example.com/a",
    });
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome).toEqual({
      kind: "succeeded",
      remoteId: String(ARTICLE_ID),
      url: DEFAULT_ARTICLE.url,
    });

    const posts = articleRequests(server);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.method).toBe("POST");
    expect(headerOf(posts[0]!, "api-key")).toBe(API_KEY);
    expect(headerOf(posts[0]!, "accept")).toBe(V1_MEDIA_TYPE);
    expect(headerOf(posts[0]!, "content-type")).toBe("application/json");
    expect(JSON.parse(posts[0]!.body)).toEqual({
      article: {
        title: TITLE,
        body_markdown: BODY,
        published: true,
        tags: ["typescript", "opensource"],
        canonical_url: "https://example.com/a",
      },
    });
  });

  it("performs no content request unless publish is called", async () => {
    const server = await startServer(devtoFixture());
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound);

    await provider.prepare(credentials(), bound, signal(), delivery);

    // A reused success is handled by the CLI receipt; the adapter itself never
    // performs a hidden search, GET, or write during prepare.
    expect(server.requests.map(request => request.url)).toEqual(["/api/users/me"]);
    expect(articleRequests(server)).toHaveLength(0);
  });

  it("does not treat a reused canonical URL as success", async () => {
    let call = 0;
    const server = await startServer(
      devtoFixture({
        articles: () => {
          call += 1;

          return call === 1
            ? { status: 201, body: DEFAULT_ARTICLE }
            : { status: 201, body: { url: `${TRUSTED_ORIGIN}/alice/same-canonical` } };
        },
      }),
    );
    const provider = providerFor(server);
    const bound = target();
    const article = { title: TITLE, canonicalUrl: "https://example.com/a" };
    const prepared = await provider.prepare(
      credentials(),
      bound,
      signal(),
      deliveryFor(provider, bound, BODY, article),
    );

    const first = await prepared.publish(deliveryFor(provider, bound, BODY, article), signal());
    const second = await prepared.publish(deliveryFor(provider, bound, BODY, article), signal());

    expect(first.kind).toBe("succeeded");
    // A 2xx without a usable id stays unknown even though the canonical URL was
    // seen before; the adapter never deduplicates or searches.
    expect(second.kind).toBe("unknown");
    expect(articleRequests(server)).toHaveLength(2);
  });

  it.each([
    { label: "an http url", url: `http://dev.to/alice/${ARTICLE_ID}` },
    { label: "a userinfo url", url: `https://user:pass@dev.to/alice/${ARTICLE_ID}` },
    { label: "a control-character url", url: `https://dev.to/alice/${ARTICLE_ID}\u0000` },
    { label: "a key-bearing url", url: `https://dev.to/alice/${ARTICLE_ID}?key=${API_KEY}` },
    { label: "a percent-encoded key url", url: `https://dev.to/alice/${ARTICLE_ID}?key=devto%2Dapi%2Dkey%2D1234` },
    { label: "a non-url", url: "not a url" },
  ])("omits $label but still reports success by id", async ({ url }) => {
    const server = await startServer(
      devtoFixture({ articles: () => ({ status: 201, body: { id: ARTICLE_ID, url } }) }),
    );
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound);
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome).toEqual({ kind: "succeeded", remoteId: String(ARTICLE_ID), url: null });
  });

  it.each([
    { label: "a 2xx without an id", route: { status: 201, body: { url: `${TRUSTED_ORIGIN}/x` } } },
    { label: "a 2xx with a string id", route: { status: 201, body: { id: String(ARTICLE_ID) } } },
    { label: "a 2xx with an error", route: { status: 201, body: { id: ARTICLE_ID, error: "nope" } } },
    { label: "a truncated body", route: { status: 201, raw: `{"id":${ARTICLE_ID}` } },
    { label: "an empty body", route: { status: 201, raw: "" } },
    { label: "a 5xx", route: { status: 503, body: { error: "unavailable" } } },
  ])("treats $label as unknown", async ({ route }) => {
    const server = await startServer(devtoFixture({ articles: () => route }));
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound);
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome.kind).toBe("unknown");
    expect(articleRequests(server)).toHaveLength(1);
  });

  it("treats a redirect as unknown and never follows it", async () => {
    const server = await startServer(
      devtoFixture({
        articles: (_request, response) => redirectResponse(response, 302, "https://elsewhere.test/x"),
      }),
    );
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound);
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome.kind).toBe("unknown");
    expect(articleRequests(server)).toHaveLength(1);
  });

  it("accepts a valid JSON body above 64 KiB inside the 1 MiB cap", async () => {
    const server = await startServer(
      devtoFixture({
        articles: () => ({
          status: 201,
          raw: JSON.stringify({ id: ARTICLE_ID, pad: "x".repeat(70_000) }),
        }),
      }),
    );
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound);
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome).toEqual({ kind: "succeeded", remoteId: String(ARTICLE_ID), url: null });
  });

  it("treats a response over the 1 MiB cap as unknown", async () => {
    const server = await startServer(
      devtoFixture({
        articles: () => ({
          status: 201,
          raw: JSON.stringify({ id: ARTICLE_ID, pad: "x".repeat(1_100_000) }),
        }),
      }),
    );
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound);
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome.kind).toBe("unknown");
  });

  it.each([
    {
      label: "a 400 with a Forem error",
      route: { status: 400, body: { error: "Bad request" } },
      expected: { kind: "failed", code: "INVALID_CONTENT", retryable: false },
    },
    {
      label: "a 401 with a Forem error",
      route: { status: 401, body: { error: "Unauthorized" } },
      expected: { kind: "failed", code: "AUTH", retryable: true },
    },
    {
      label: "a 403 with a Forem error",
      route: { status: 403, body: { errors: ["forbidden"] } },
      expected: { kind: "failed", code: "PERMISSION", retryable: false },
    },
    {
      label: "a 422 with a Forem error",
      route: { status: 422, body: { errors: { title: ["is too long"] } } },
      expected: { kind: "failed", code: "INVALID_CONTENT", retryable: false },
    },
  ])("classifies $label as a definite rejection", async ({ route, expected }) => {
    const server = await startServer(devtoFixture({ articles: () => route }));
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound);
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome).toMatchObject(expected);
    expect(outcome).toMatchObject({ writeDisposition: "not_applied" });
  });

  it.each([
    { label: "a bare 400", route: { status: 400, body: {} } },
    { label: "a bare 401", route: { status: 401, raw: "" } },
    { label: "a bare 403", route: { status: 403, body: { error: 42 } } },
    { label: "a bare 422", route: { status: 422, body: { errors: [] } } },
    { label: "a bare 429", route: { status: 429, body: {} } },
  ])("keeps $label unknown without structured evidence", async ({ route }) => {
    const server = await startServer(devtoFixture({ articles: () => route }));
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound);
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome.kind).toBe("unknown");
  });

  it("honors a bounded Retry-After and refuses an unsafe one", async () => {
    const bounded = await startServer(
      devtoFixture({
        articles: () => ({
          status: 429,
          body: { error: "Too many requests" },
          headers: { "retry-after": "120" },
        }),
      }),
    );
    const boundedProvider = providerFor(bounded);
    const boundedTarget = target();
    const boundedDelivery = deliveryFor(boundedProvider, boundedTarget);
    const boundedPrepared = await boundedProvider.prepare(
      credentials(),
      boundedTarget,
      signal(),
      boundedDelivery,
    );
    const before = Date.now();
    const boundedOutcome = await boundedPrepared.publish(boundedDelivery, signal());

    expect(boundedOutcome).toMatchObject({ kind: "failed", code: "RATE_LIMIT", retryable: true });
    const retryNotBefore = (boundedOutcome as { retryNotBefore: string | null }).retryNotBefore;
    expect(typeof retryNotBefore).toBe("string");
    const at = Date.parse(retryNotBefore!);
    expect(at).toBeGreaterThanOrEqual(before + 119_000);
    expect(at).toBeLessThanOrEqual(before + 121_000);

    const unsafe = await startServer(
      devtoFixture({
        articles: () => ({
          status: 429,
          body: { error: "Too many requests" },
          headers: { "retry-after": "1.5" },
        }),
      }),
    );
    const unsafeProvider = providerFor(unsafe);
    const unsafeTarget = target();
    const unsafeDelivery = deliveryFor(unsafeProvider, unsafeTarget);
    const unsafePrepared = await unsafeProvider.prepare(
      credentials(),
      unsafeTarget,
      signal(),
      unsafeDelivery,
    );
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
    const server = await startServer(devtoFixture());
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound);
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
    expect(articleRequests(server)).toHaveLength(0);
  });

  it("returns unknown for a post-dispatch timeout", async () => {
    const fixture = devtoFixture();
    const server = await startServer((request, response, index) =>
      request.url === "/api/articles" ? hold() : fixture(request, response, index),
    );
    const provider = providerFor(server, 80);
    const bound = target();
    const delivery = deliveryFor(provider, bound);
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome).toEqual({ kind: "unknown", code: "TIMEOUT", writeDisposition: "unknown" });
  });

  it("bounds an injected transport that ignores the abort signal", async () => {
    const server = await startServer(devtoFixture());
    const base = loopbackTransport(TRUSTED_ORIGIN, server.origin);
    const hanging = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      return url.endsWith("/api/articles")
        ? new Promise<Response>(() => undefined)
        : base(input, init);
    }) as typeof fetch;
    const provider = new DevtoLocalProvider({ fetch: hanging, timeoutMs: 80 });
    const bound = target();
    const delivery = deliveryFor(provider, bound);
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome).toEqual({ kind: "unknown", code: "TIMEOUT", writeDisposition: "unknown" });
  });

  it("bounds a stalled response stream that never produces a byte", async () => {
    const server = await startServer(devtoFixture());
    const base = loopbackTransport(TRUSTED_ORIGIN, server.origin);
    const stalled = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      if (!url.endsWith("/api/articles")) {
        return base(input, init);
      }

      const stream = new ReadableStream<Uint8Array>({
        start() {
          // Never enqueue and never close: only the deadline can end this.
        },
      });

      return Promise.resolve(new Response(stream, { status: 201 }));
    }) as typeof fetch;
    const provider = new DevtoLocalProvider({ fetch: stalled, timeoutMs: 80 });
    const bound = target();
    const delivery = deliveryFor(provider, bound);
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome).toEqual({ kind: "unknown", code: "TIMEOUT", writeDisposition: "unknown" });
  });

  it("returns unknown for a dropped connection after dispatch", async () => {
    const server = await startServer(
      devtoFixture({
        articles: (_request, response) => {
          response.destroy();
        },
      }),
    );
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound);
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());

    expect(outcome.kind).toBe("unknown");
    expect((outcome as { code: string }).code).toBe("NETWORK");
  });

  it.each([
    { label: "a wrong payload version", overrides: { payloadVersion: 2 } },
    {
      label: "a tampered target",
      overrides: {
        target: {
          provider: "devto" as const,
          targetId: "devto:9999999",
          connectionId: CONNECTION_ID,
          bindingRevision: 1,
        },
      },
    },
    { label: "a tampered body", overrides: { payload: { article: { title: TITLE, body_markdown: "other", published: true } } } },
    { label: "a tampered content field", overrides: { content: "other" } },
    { label: "a draft flag", overrides: { payload: { article: { title: TITLE, body_markdown: BODY, published: false } } } },
    { label: "an extra payload key", overrides: { payload: { article: { title: TITLE, body_markdown: BODY, published: true, series: "x" } } } },
    { label: "changed frozen options", overrides: { contentOptions: { article: { title: "Other title" } } } },
  ])("fails $label before any request", async ({ overrides }) => {
    const server = await startServer(devtoFixture());
    const provider = providerFor(server);
    const bound = target();
    const valid = deliveryFor(provider, bound);
    const prepared = await provider.prepare(credentials(), bound, signal(), valid);
    const tampered = deliveryFor(provider, bound, BODY, { title: TITLE }, overrides);
    const outcome = await prepared.publish(tampered, signal());

    expect(outcome.kind).toBe("failed");
    expect(articleRequests(server)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Secret canaries
// ---------------------------------------------------------------------------

describe("secret hygiene", () => {
  it("never puts the API key in an outcome code or message", async () => {
    const server = await startServer(
      devtoFixture({ articles: () => ({ status: 500, body: { error: `failed ${API_KEY}` } }) }),
    );
    const provider = providerFor(server);
    const bound = target();
    const delivery = deliveryFor(provider, bound);
    const prepared = await provider.prepare(credentials(), bound, signal(), delivery);
    const outcome = await prepared.publish(delivery, signal());
    const serialized = JSON.stringify(outcome);

    expect(outcome.kind).toBe("unknown");
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain(CANARY);
  });
});
