/// <reference types="node" />

import { afterEach, describe, expect, it } from "vitest";

import {
  LocalProviderError,
  type FrozenDelivery,
  type LocalCredentials,
  type ProviderOutcome,
  type TargetBinding,
} from "@syndroo/core";

import { BlueskyLocalProvider } from "../src/index.js";
import {
  hold,
  headerOf,
  jsonResponse,
  loopbackTransport,
  rawResponse,
  redirectResponse,
  startFixtureServer,
  waitFor,
  type FixtureHandler,
  type FixtureServer,
} from "./support/loopback.js";

const TRUSTED_ORIGIN = "https://bsky.social";
const SESSION_PATH = "/xrpc/com.atproto.server.createSession";
const RECORD_PATH = "/xrpc/com.atproto.repo.createRecord";
const IDENTIFIER = "alice.bsky.social";
const PASSWORD = "app-password-secret";
const ACCESS_JWT = "access-jwt-secret";
const DID = "did:plc:alice";
const CID = "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const CREATED_AT = "2026-09-24T00:00:00.000Z";

type Respond = (response: Parameters<FixtureHandler>[1]) => void;

const servers: FixtureServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startServer(handler: FixtureHandler): Promise<FixtureServer> {
  const server = await startFixtureServer(handler);
  servers.push(server);

  return server;
}

function providerFor(
  server: FixtureServer,
  timeoutMs = 1_000,
): BlueskyLocalProvider {
  return new BlueskyLocalProvider({
    fetch: loopbackTransport(TRUSTED_ORIGIN, server.origin),
    timeoutMs,
  });
}

function credentials(host = "bsky.social"): LocalCredentials {
  return { provider: "bluesky", identifier: IDENTIFIER, password: PASSWORD, host };
}

function target(overrides: Partial<TargetBinding> = {}): TargetBinding {
  return {
    provider: "bluesky",
    targetId: DID,
    connectionId: "conn_0123456789abcdef0123456789abcdef",
    bindingRevision: 1,
    ...overrides,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function sessionBody(): unknown {
  return {
    accessJwt: ACCESS_JWT,
    refreshJwt: "refresh-jwt",
    handle: IDENTIFIER,
    did: DID,
  };
}

function deliveryFor(
  provider: BlueskyLocalProvider,
  boundTarget: TargetBinding,
  content: string,
  payloadOverrides: Record<string, unknown> = {},
  payloadVersion = 1,
): FrozenDelivery {
  const frozen = provider.freeze(content, CREATED_AT);

  return {
    deliveryId: "0".repeat(64),
    key: "syndroo-test-key",
    namespace: "default",
    target: boundTarget,
    content,
    payloadVersion,
    payloadHash: "0".repeat(64),
    payload: { ...frozen.payload, ...payloadOverrides },
  };
}

async function prepareAndPublish(
  provider: BlueskyLocalProvider,
  content: string,
  publishSignal: AbortSignal = signal(),
): Promise<ProviderOutcome> {
  const prepared = await provider.prepare(credentials(), target(), signal());
  const delivery = deliveryFor(provider, prepared.target, content);

  return prepared.publish(delivery, publishSignal);
}

function recordCount(server: FixtureServer): number {
  return server.requests.filter((request) => request.url === RECORD_PATH).length;
}

function sessionThenRecord(record: Respond): FixtureHandler {
  return (request, response) => {
    if (request.url === SESSION_PATH) {
      jsonResponse(response, 200, sessionBody());
      return;
    }

    record(response);
  };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function pad(value: number, width = 2): string {
  return value.toString().padStart(width, "0");
}

function rfc850Date(at: Date): string {
  return `${WEEKDAYS_LONG[at.getUTCDay()]}, ${pad(at.getUTCDate())}-${MONTHS[at.getUTCMonth()]}-${pad(at.getUTCFullYear() % 100)} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())} GMT`;
}

function asctimeDate(at: Date): string {
  return `${WEEKDAYS[at.getUTCDay()]} ${MONTHS[at.getUTCMonth()]} ${at.getUTCDate().toString().padStart(2, " ")} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())} ${at.getUTCFullYear()}`;
}

describe("BlueskyLocalProvider", () => {
  it("constructs and freezes with zero network access", async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 500, {});
    });
    const provider = providerFor(server);

    expect(provider.describe()).toEqual({
      provider: "bluesky",
      maturity: "fixture-tested",
      localPublish: true,
      unavailableReason: null,
    });

    const content = "中文 https://grant-dai.com/posts/example";
    const frozen = provider.freeze(content, CREATED_AT);
    const byteStart = new TextEncoder().encode("中文 ").byteLength;
    const uri = "https://grant-dai.com/posts/example";

    expect(frozen).toEqual({
      payloadVersion: 1,
      payload: {
        $type: "app.bsky.feed.post",
        text: content,
        createdAt: CREATED_AT,
        facets: [
          {
            index: {
              byteStart,
              byteEnd: byteStart + new TextEncoder().encode(uri).byteLength,
            },
            features: [{ $type: "app.bsky.richtext.facet#link", uri }],
          },
        ],
      },
    });
    expect(server.requestCount()).toBe(0);
  });

  it("verifies identity through createSession", async () => {
    const server = await startServer(
      sessionThenRecord((response) => {
        jsonResponse(response, 200, { uri: "at://x", cid: CID });
      }),
    );
    const provider = providerFor(server);

    await expect(provider.verifyIdentity(credentials(), signal())).resolves.toEqual({
      targetId: DID,
    });
    expect(server.requestCount()).toBe(1);

    const request = server.requests[0];

    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(SESSION_PATH);
    expect(JSON.parse(request?.body ?? "{}")).toEqual({
      identifier: IDENTIFIER,
      password: PASSWORD,
    });
    expect(headerOf(request!, "authorization")).toBeUndefined();
  });

  it("rejects a binding for another provider without any request", async () => {
    const server = await startServer(
      sessionThenRecord((response) => {
        jsonResponse(response, 200, { uri: "at://x", cid: CID });
      }),
    );
    const provider = providerFor(server);

    await expect(
      provider.prepare(credentials(), target({ provider: "threads" }), signal()),
    ).rejects.toMatchObject({ name: "LocalProviderError", code: "ACCOUNT_MISMATCH" });
    expect(server.requestCount()).toBe(0);
  });

  it("rejects an account mismatch before any content write", async () => {
    const server = await startServer(
      sessionThenRecord((response) => {
        jsonResponse(response, 200, { uri: "at://x", cid: CID });
      }),
    );
    const provider = providerFor(server);

    await expect(
      provider.prepare(
        credentials(),
        target({ targetId: "did:plc:mallory" }),
        signal(),
      ),
    ).rejects.toMatchObject({ name: "LocalProviderError", code: "ACCOUNT_MISMATCH" });
    expect(server.requestCount()).toBe(1);
    expect(recordCount(server)).toBe(0);
  });

  it("rejects a refused credential before any content write", async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 401, {
        error: "AuthMissing",
        message: `bad app password ${PASSWORD}`,
      });
    });
    const provider = providerFor(server);

    const failure = await provider
      .prepare(credentials(), target(), signal())
      .then(() => null)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LocalProviderError);
    expect((failure as LocalProviderError).code).toBe("AUTH");
    expect((failure as LocalProviderError).message).not.toContain(PASSWORD);
    expect(server.requestCount()).toBe(1);
    expect(recordCount(server)).toBe(0);
  });

  it("rejects an untrusted host credential without any request", async () => {
    const server = await startServer(
      sessionThenRecord((response) => {
        jsonResponse(response, 200, { uri: "at://x", cid: CID });
      }),
    );
    const provider = providerFor(server);
    const hosts = [
      "example.com",
      "https://bsky.social",
      "bsky.social:443",
      "user@bsky.social",
      "bsky.social/xrpc",
      "bsky.social.",
      "",
      " ",
    ];

    for (const host of hosts) {
      await expect(
        provider.verifyIdentity(credentials(host), signal()),
      ).rejects.toMatchObject({ name: "LocalProviderError", code: "AUTH" });
    }

    expect(server.requestCount()).toBe(0);
  });

  it("accepts a case-normalized trusted host", async () => {
    const server = await startServer(
      sessionThenRecord((response) => {
        jsonResponse(response, 200, { uri: "at://x", cid: CID });
      }),
    );
    const provider = providerFor(server);

    await expect(
      provider.verifyIdentity(credentials("BSKY.SOCIAL"), signal()),
    ).resolves.toEqual({ targetId: DID });
  });

  it("publishes the frozen record with the prepared repo DID in one request", async () => {
    const server = await startServer(
      sessionThenRecord((response) => {
        jsonResponse(response, 200, {
          uri: `at://${DID}/app.bsky.feed.post/3example`,
          cid: CID,
        });
      }),
    );
    const provider = providerFor(server);

    await expect(prepareAndPublish(provider, "Hello from Syndroo")).resolves.toEqual({
      kind: "succeeded",
      remoteId: `at://${DID}/app.bsky.feed.post/3example`,
      url: `https://bsky.app/profile/${encodeURIComponent(DID)}/post/3example`,
    });
    expect(recordCount(server)).toBe(1);

    const record = server.requests.find((request) => request.url === RECORD_PATH);
    const body = JSON.parse(record?.body ?? "{}") as {
      repo?: unknown;
      collection?: unknown;
      record?: unknown;
    };

    expect(body.repo).toBe(DID);
    expect(body.collection).toBe("app.bsky.feed.post");
    expect(body.record).toEqual({
      $type: "app.bsky.feed.post",
      text: "Hello from Syndroo",
      createdAt: CREATED_AT,
    });
    expect(headerOf(record!, "authorization")).toBe(`Bearer ${ACCESS_JWT}`);
  });

  it("sends the frozen text and facets without regenerating them", async () => {
    const server = await startServer(
      sessionThenRecord((response) => {
        jsonResponse(response, 200, {
          uri: `at://${DID}/app.bsky.feed.post/3example`,
          cid: CID,
        });
      }),
    );
    const provider = providerFor(server);
    const content = "中文 https://grant-dai.com/posts/example";
    const frozen = provider.freeze(content, CREATED_AT);
    const prepared = await provider.prepare(credentials(), target(), signal());

    await prepared.publish(deliveryFor(provider, prepared.target, content), signal());

    const record = server.requests.find((request) => request.url === RECORD_PATH);
    const body = JSON.parse(record?.body ?? "{}") as { record?: unknown };

    expect(body.record).toEqual(frozen.payload);
  });

  it("reports unknown and keeps one content request when the connection drops", async () => {
    const server = await startServer(
      sessionThenRecord((response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.destroy();
      }),
    );
    const provider = providerFor(server);

    const outcome = await prepareAndPublish(provider, "Hello");

    expect(outcome).toMatchObject({
      kind: "unknown",
      writeDisposition: "unknown",
    });
    expect(recordCount(server)).toBe(1);
  });

  it("reports unknown for an unusable 2xx response", async () => {
    const cases: Array<[string, Respond]> = [
      [
        "missing cid",
        (response) =>
          jsonResponse(response, 200, { uri: `at://${DID}/app.bsky.feed.post/3x` }),
      ],
      ["missing uri", (response) => jsonResponse(response, 200, { cid: CID })],
      [
        "wrong did",
        (response) =>
          jsonResponse(response, 200, {
            uri: "at://did:plc:mallory/app.bsky.feed.post/3x",
            cid: CID,
          }),
      ],
      [
        "wrong collection",
        (response) =>
          jsonResponse(response, 200, {
            uri: `at://${DID}/app.bsky.feed.like/3x`,
            cid: CID,
          }),
      ],
      ["empty body", (response) => rawResponse(response, 200, "")],
      ["invalid json", (response) => rawResponse(response, 200, "{not json")],
      [
        "oversized body",
        (response) =>
          rawResponse(
            response,
            200,
            `{"uri":"at://x","cid":"${"c".repeat(70_000)}"}`,
          ),
      ],
      [
        "contradictory string error",
        (response) =>
          jsonResponse(response, 200, {
            uri: `at://${DID}/app.bsky.feed.post/3example`,
            cid: CID,
            error: "InvalidRequest",
          }),
      ],
      [
        "contradictory object error",
        (response) =>
          jsonResponse(response, 200, {
            uri: `at://${DID}/app.bsky.feed.post/3example`,
            cid: CID,
            error: { message: "contradiction" },
          }),
      ],
    ];

    for (const [name, respond] of cases) {
      const server = await startServer(sessionThenRecord(respond));
      const outcome = await prepareAndPublish(providerFor(server), "Hello");

      expect(outcome, name).toMatchObject({
        kind: "unknown",
        writeDisposition: "unknown",
      });
      expect(recordCount(server), name).toBe(1);
    }
  });

  it("enforces the total deadline on delayed headers", async () => {
    const server = await startServer(sessionThenRecord(() => hold()));
    const provider = providerFor(server, 150);

    const outcome = await prepareAndPublish(provider, "Hello");

    expect(outcome).toEqual({
      kind: "unknown",
      code: "TIMEOUT",
      writeDisposition: "unknown",
    });
    expect(recordCount(server)).toBe(1);
  });

  it("enforces the total deadline on a slow body", async () => {
    const server = await startServer(
      sessionThenRecord((response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"uri":"at://');

        return hold();
      }),
    );
    const provider = providerFor(server, 150);

    const outcome = await prepareAndPublish(provider, "Hello");

    expect(outcome).toMatchObject({ kind: "unknown", code: "TIMEOUT" });
    expect(recordCount(server)).toBe(1);
  });

  it("returns not_applied when the signal is already aborted", async () => {
    const server = await startServer(
      sessionThenRecord((response) => {
        jsonResponse(response, 200, { uri: "at://x", cid: CID });
      }),
    );
    const provider = providerFor(server);
    const prepared = await provider.prepare(credentials(), target(), signal());
    const aborted = new AbortController();

    aborted.abort();

    const outcome = await prepared.publish(
      deliveryFor(provider, prepared.target, "Hello"),
      aborted.signal,
    );

    expect(outcome).toEqual({
      kind: "failed",
      code: "ABORTED",
      writeDisposition: "not_applied",
      retryable: false,
      retryNotBefore: null,
    });
    expect(recordCount(server)).toBe(0);
  });

  it("reports unknown when the signal aborts after the write is dispatched", async () => {
    const server = await startServer(sessionThenRecord(() => hold()));
    const provider = providerFor(server);
    const prepared = await provider.prepare(credentials(), target(), signal());
    const controller = new AbortController();

    const pending = prepared.publish(
      deliveryFor(provider, prepared.target, "Hello"),
      controller.signal,
    );

    await waitFor(() => recordCount(server) === 1);
    controller.abort();

    const outcome = await pending;

    expect(outcome).toEqual({
      kind: "unknown",
      code: "ABORTED",
      writeDisposition: "unknown",
    });
    expect(recordCount(server)).toBe(1);
  });

  it("never follows a redirect and never contacts the redirect target", async () => {
    const collector = await startServer((_request, response) => {
      jsonResponse(response, 200, { uri: "at://x", cid: CID });
    });
    const server = await startServer(
      sessionThenRecord((response) => {
        redirectResponse(response, 302, `${collector.origin}/collect`);
      }),
    );
    const provider = providerFor(server);

    const outcome = await prepareAndPublish(provider, "Hello");

    expect(outcome).toMatchObject({
      kind: "unknown",
      writeDisposition: "unknown",
    });
    expect(recordCount(server)).toBe(1);
    expect(collector.requestCount()).toBe(0);
  });

  it("never echoes the access token in an outcome", async () => {
    const server = await startServer(
      sessionThenRecord((response) => {
        jsonResponse(response, 400, {
          error: "InvalidRequest",
          message: `token ${ACCESS_JWT} rejected`,
        });
      }),
    );
    const provider = providerFor(server);

    const outcome = await prepareAndPublish(provider, "Hello");

    expect(JSON.stringify(outcome)).not.toContain(ACCESS_JWT);
    expect(outcome).toEqual({
      kind: "failed",
      code: "INVALID_CONTENT",
      writeDisposition: "not_applied",
      retryable: false,
      retryNotBefore: null,
    });
  });

  it("classifies only structured platform rejections", async () => {
    const structured: Array<[string, number, unknown, string, boolean]> = [
      ["auth missing", 401, { error: "AuthMissing", message: "no token" }, "AUTH", true],
      ["invalid token", 400, { error: "InvalidToken", message: "bad" }, "AUTH", true],
      ["expired token", 400, { error: "ExpiredToken", message: "old" }, "AUTH", true],
      ["takedown", 400, { error: "AccountTakedown", message: "gone" }, "AUTH", true],
      ["rate limit", 429, { error: "RateLimitExceeded", message: "slow" }, "RATE_LIMIT", true],
      ["invalid request", 400, { error: "InvalidRequest", message: "bad" }, "INVALID_CONTENT", false],
    ];
    const unknown: Array<[string, number, unknown]> = [
      ["bare status", 400, { message: "bad" }],
      ["unknown name", 400, { error: "SomethingWeird", message: "?" }],
      ["object error name", 400, { error: { message: "?" } }],
      ["empty error name", 400, { error: "", message: "?" }],
      ["server error", 503, { error: "InvalidRequest", message: "down" }],
      ["redirect", 302, { error: "AuthMissing", message: "moved" }],
    ];

    for (const [name, status, body, code, retryable] of structured) {
      const server = await startServer(
        sessionThenRecord((response) => {
          jsonResponse(response, status, body);
        }),
      );
      const outcome = await prepareAndPublish(providerFor(server), "Hello");

      expect(outcome, name).toMatchObject({
        kind: "failed",
        code,
        writeDisposition: "not_applied",
        retryable,
      });
      expect(recordCount(server), name).toBe(1);
    }

    for (const [name, status, body] of unknown) {
      const server = await startServer(
        sessionThenRecord((response) => {
          jsonResponse(response, status, body);
        }),
      );
      const outcome = await prepareAndPublish(providerFor(server), "Hello");

      expect(outcome, name).toMatchObject({
        kind: "unknown",
        writeDisposition: "unknown",
      });
      expect(recordCount(server), name).toBe(1);
    }
  });

  it("keeps a retry hint safe when the header is missing, long, or unparseable", async () => {
    const cases: Array<[string, string | null, boolean, boolean]> = [
      ["no header", null, true, false],
      ["seconds", "30", true, true],
      ["zero seconds", "0", true, true],
      ["long wait", "1209600", false, false],
      ["malformed", "not-a-date", false, false],
      ["negative", "-5", false, false],
      ["signed delta", "+1", false, false],
      ["hex delta", "0x10", false, false],
      ["exponent delta", "1e2", false, false],
      ["fractional delta", "1.5", false, false],
      ["iso date", "2026-09-25T07:00:00Z", false, false],
      ["past date", new Date(Date.now() - 60_000).toUTCString(), false, false],
    ];

    for (const [name, header, retryable, hasDate] of cases) {
      const server = await startServer(
        sessionThenRecord((response) => {
          rawResponse(
            response,
            429,
            JSON.stringify({ error: "RateLimitExceeded", message: "slow" }),
            header === null ? {} : { "retry-after": header },
          );
        }),
      );
      const outcome = await prepareAndPublish(providerFor(server), "Hello");

      if (outcome.kind !== "failed") {
        throw new Error(`${name}: expected a failed outcome`);
      }

      expect(outcome.code, name).toBe("RATE_LIMIT");
      expect(outcome.retryable, name).toBe(retryable);
      expect(outcome.retryNotBefore !== null, name).toBe(hasDate);
    }
  });

  it("reads each accepted HTTP-date grammar into retryNotBefore", async () => {
    const at = new Date(Date.now() + 60_000);
    const formats: Array<[string, string]> = [
      ["imf-fixdate", at.toUTCString()],
      ["rfc850", rfc850Date(at)],
      ["asctime", asctimeDate(at)],
    ];

    for (const [name, header] of formats) {
      const server = await startServer(
        sessionThenRecord((response) => {
          rawResponse(
            response,
            429,
            JSON.stringify({ error: "RateLimitExceeded", message: "slow" }),
            { "retry-after": header },
          );
        }),
      );
      const before = Date.now();
      const outcome = await prepareAndPublish(providerFor(server), "Hello");

      if (outcome.kind !== "failed") {
        throw new Error(`${name}: expected a failed outcome`);
      }

      expect(outcome.retryable, name).toBe(true);

      const retryAt = Date.parse(outcome.retryNotBefore ?? "");

      expect(retryAt, name).toBeGreaterThanOrEqual(before + 59_000);
      expect(retryAt, name).toBeLessThanOrEqual(Date.now() + 60_000);
    }
  });

  it("fails closed on a tampered frozen delivery before any request", async () => {
    const server = await startServer(
      sessionThenRecord((response) => {
        jsonResponse(response, 200, { uri: "at://x", cid: CID });
      }),
    );
    const provider = providerFor(server);
    const prepared = await provider.prepare(credentials(), target(), signal());
    const cases: FrozenDelivery[] = [
      deliveryFor(provider, prepared.target, "Hello", {}, 2),
      deliveryFor(provider, prepared.target, "Hello", { extra: true }),
      deliveryFor(provider, prepared.target, "Hello", {
        $type: "app.bsky.feed.like",
      }),
      deliveryFor(
        provider,
        target({ connectionId: "conn_ffffffffffffffffffffffffffffffff" }),
        "Hello",
      ),
    ];

    for (const delivery of cases) {
      await expect(prepared.publish(delivery, signal())).resolves.toEqual({
        kind: "failed",
        code: "PAYLOAD_MISMATCH",
        writeDisposition: "not_applied",
        retryable: false,
        retryNotBefore: null,
      });
    }

    expect(recordCount(server)).toBe(0);
  });

  it("rejects content outside the frozen limits", () => {
    const provider = new BlueskyLocalProvider();

    expect(() => provider.freeze("a".repeat(300), CREATED_AT)).not.toThrow();
    expect(() => provider.freeze("a".repeat(301), CREATED_AT)).toThrow(
      LocalProviderError,
    );
    expect(() => provider.freeze("中".repeat(300), CREATED_AT)).not.toThrow();
    expect(() => provider.freeze("中".repeat(301), CREATED_AT)).toThrow(
      LocalProviderError,
    );
    expect(() => provider.freeze("   \n\t ", CREATED_AT)).toThrow(
      LocalProviderError,
    );
  });
});
