/// <reference types="node" />

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerResponse } from "node:http";

import {
  LocalProviderError,
  type FrozenDelivery,
  type LocalCredentials,
  type ProviderOutcome,
  type TargetBinding,
} from "@syndroo/core";

import { ThreadsLocalProvider } from "../src/index.js";
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

type Respond = (response: ServerResponse) => void;

const TRUSTED_ORIGIN = "https://graph.threads.net";
const ACCESS_TOKEN = "threads-access-token";
const TARGET_ID = "1234567890";
const CREATED_AT = "2026-09-24T00:00:00.000Z";

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
): ThreadsLocalProvider {
  return new ThreadsLocalProvider({
    fetch: loopbackTransport(TRUSTED_ORIGIN, server.origin),
    timeoutMs,
  });
}

function credentials(): LocalCredentials {
  return { provider: "threads", accessToken: ACCESS_TOKEN };
}

function target(overrides: Partial<TargetBinding> = {}): TargetBinding {
  return {
    provider: "threads",
    targetId: TARGET_ID,
    connectionId: "conn_0123456789abcdef0123456789abcdef",
    bindingRevision: 1,
    ...overrides,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function deliveryFor(
  provider: ThreadsLocalProvider,
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
  provider: ThreadsLocalProvider,
  content: string,
  publishSignal: AbortSignal = signal(),
): Promise<ProviderOutcome> {
  const prepared = await provider.prepare(credentials(), target(), signal());
  const delivery = deliveryFor(provider, prepared.target, content);

  return prepared.publish(delivery, publishSignal);
}

function postCount(server: FixtureServer): number {
  return server.requests.filter((request) => request.method === "POST").length;
}

function identityThenPublish(
  publish: Respond,
): FixtureHandler {
  return (request, response) => {
    if (request.url === "/me?fields=id") {
      jsonResponse(response, 200, { id: TARGET_ID });
      return;
    }

    publish(response);
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

describe("ThreadsLocalProvider", () => {
  it("constructs and freezes with zero network access", async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 500, {});
    });
    const provider = providerFor(server);

    expect(provider.describe()).toEqual({
      provider: "threads",
      maturity: "fixture-tested",
      localPublish: true,
      unavailableReason: null,
    });
    expect(provider.freeze("Hello", CREATED_AT)).toEqual({
      payloadVersion: 1,
      payload: {
        media_type: "TEXT",
        text: "Hello",
        auto_publish_text: true,
      },
    });
    expect(server.requestCount()).toBe(0);
  });

  it("verifies identity through the documented profile endpoint", async () => {
    const server = await startServer(identityThenPublish((response) => {
      jsonResponse(response, 200, { id: "1" });
    }));
    const provider = providerFor(server);

    await expect(provider.verifyIdentity(credentials(), signal())).resolves.toEqual(
      { targetId: TARGET_ID },
    );
    expect(server.requestCount()).toBe(1);

    const request = server.requests[0];

    expect(request?.method).toBe("GET");
    expect(request?.url).toBe("/me?fields=id");
    expect(headerOf(request!, "authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("rejects a binding for another provider without any request", async () => {
    const server = await startServer(identityThenPublish((response) => {
      jsonResponse(response, 200, { id: TARGET_ID });
    }));
    const provider = providerFor(server);

    await expect(
      provider.prepare(credentials(), target({ provider: "bluesky" }), signal()),
    ).rejects.toMatchObject({ name: "LocalProviderError", code: "ACCOUNT_MISMATCH" });
    expect(server.requestCount()).toBe(0);
  });

  it("rejects an account mismatch before any content write", async () => {
    const server = await startServer(identityThenPublish((response) => {
      jsonResponse(response, 200, { id: "1" });
    }));
    const provider = providerFor(server);

    await expect(
      provider.prepare(credentials(), target({ targetId: "999" }), signal()),
    ).rejects.toMatchObject({ name: "LocalProviderError", code: "ACCOUNT_MISMATCH" });
    expect(server.requestCount()).toBe(1);
    expect(postCount(server)).toBe(0);
  });

  it("rejects a refused credential before any content write", async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 401, {
        error: {
          message: `Invalid OAuth access token ${ACCESS_TOKEN}`,
          type: "OAuthException",
          code: 190,
        },
      });
    });
    const provider = providerFor(server);

    const failure = await provider
      .prepare(credentials(), target(), signal())
      .then(() => null)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LocalProviderError);
    expect((failure as LocalProviderError).code).toBe("AUTH");
    expect((failure as LocalProviderError).message).not.toContain(ACCESS_TOKEN);
    expect(server.requestCount()).toBe(1);
    expect(postCount(server)).toBe(0);
  });

  it("publishes the frozen text in exactly one auto-publish request", async () => {
    const server = await startServer(identityThenPublish((response) => {
      jsonResponse(response, 200, { id: "17890000000000000" });
    }));
    const provider = providerFor(server);

    await expect(
      prepareAndPublish(provider, "Hello from Syndroo"),
    ).resolves.toEqual({
      kind: "succeeded",
      remoteId: "17890000000000000",
      url: null,
    });
    expect(postCount(server)).toBe(1);

    const post = server.requests.find((request) => request.method === "POST");

    expect(post?.url).toBe("/me/threads");
    expect(post?.body).toBe(
      "media_type=TEXT&text=Hello+from+Syndroo&auto_publish_text=true",
    );
    expect(headerOf(post!, "authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headerOf(post!, "content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("sends the frozen text byte-for-byte instead of regenerating it", async () => {
    const server = await startServer(identityThenPublish((response) => {
      jsonResponse(response, 200, { id: "42" });
    }));
    const provider = providerFor(server);
    const content = "中文 与 emoji 😀\n换行  ";

    await prepareAndPublish(provider, content);

    const post = server.requests.find((request) => request.method === "POST");
    const form = new URLSearchParams(post?.body);

    expect(form.get("text")).toBe(content);
    expect(form.get("media_type")).toBe("TEXT");
    expect(form.get("auto_publish_text")).toBe("true");
  });

  it("reports unknown and keeps one content request when the connection drops", async () => {
    const server = await startServer(identityThenPublish((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.destroy();
    }));
    const provider = providerFor(server);

    const outcome = await prepareAndPublish(provider, "Hello");

    expect(outcome).toMatchObject({
      kind: "unknown",
      writeDisposition: "unknown",
    });
    expect(postCount(server)).toBe(1);
    expect(server.requestCount()).toBe(2);
  });

  it("reports unknown for an unusable 2xx response", async () => {
    const cases: Array<[string, Respond]> = [
      ["empty object", (response) => jsonResponse(response, 200, {})],
      ["blank id", (response) => jsonResponse(response, 200, { id: "   " })],
      ["non-numeric id", (response) => jsonResponse(response, 200, { id: "abc" })],
      ["empty body", (response) => rawResponse(response, 200, "")],
      ["invalid json", (response) => rawResponse(response, 200, "{not json")],
      [
        "oversized body",
        (response) =>
          rawResponse(response, 200, `{"id":"1","pad":"${"x".repeat(70_000)}"}`),
      ],
      [
        "padded id",
        (response) => jsonResponse(response, 200, { id: " 17890000000000000 " }),
      ],
      ["zero id", (response) => jsonResponse(response, 200, { id: "0" })],
      [
        "contradictory error envelope",
        (response) =>
          jsonResponse(response, 200, {
            id: "17890000000000000",
            error: { message: "contradiction", code: 190 },
          }),
      ],
    ];

    for (const [name, respond] of cases) {
      const server = await startServer(identityThenPublish(respond));
      const provider = providerFor(server);

      const outcome = await prepareAndPublish(provider, "Hello");

      expect(outcome, name).toMatchObject({
        kind: "unknown",
        writeDisposition: "unknown",
      });
      expect(postCount(server), name).toBe(1);
    }
  });

  it("enforces the total deadline on delayed headers", async () => {
    const server = await startServer(identityThenPublish(() => hold()));
    const provider = providerFor(server, 150);

    const outcome = await prepareAndPublish(provider, "Hello");

    expect(outcome).toEqual({
      kind: "unknown",
      code: "TIMEOUT",
      writeDisposition: "unknown",
    });
    expect(postCount(server)).toBe(1);
  });

  it("enforces the total deadline on a slow body", async () => {
    const server = await startServer(identityThenPublish((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"id":"1');

      return hold();
    }));
    const provider = providerFor(server, 150);

    const outcome = await prepareAndPublish(provider, "Hello");

    expect(outcome).toMatchObject({ kind: "unknown", code: "TIMEOUT" });
    expect(postCount(server)).toBe(1);
  });

  it("returns not_applied when the signal is already aborted", async () => {
    const server = await startServer(identityThenPublish((response) => {
      jsonResponse(response, 200, { id: "1" });
    }));
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
    expect(postCount(server)).toBe(0);
  });

  it("reports unknown when the signal aborts after the write is dispatched", async () => {
    const server = await startServer(identityThenPublish(() => hold()));
    const provider = providerFor(server);
    const prepared = await provider.prepare(credentials(), target(), signal());
    const controller = new AbortController();

    const pending = prepared.publish(
      deliveryFor(provider, prepared.target, "Hello"),
      controller.signal,
    );

    await waitFor(() => postCount(server) === 1);
    controller.abort();

    const outcome = await pending;

    expect(outcome).toEqual({
      kind: "unknown",
      code: "ABORTED",
      writeDisposition: "unknown",
    });
    expect(postCount(server)).toBe(1);
  });

  it("never follows a redirect and never contacts the redirect target", async () => {
    const collector = await startServer((_request, response) => {
      jsonResponse(response, 200, { id: "1" });
    });
    const server = await startServer(
      identityThenPublish((response) => {
        redirectResponse(response, 302, `${collector.origin}/collect`);
      }),
    );
    const provider = providerFor(server);

    const outcome = await prepareAndPublish(provider, "Hello");

    expect(outcome).toMatchObject({ kind: "unknown", writeDisposition: "unknown" });
    expect(postCount(server)).toBe(1);
    expect(collector.requestCount()).toBe(0);
  });

  it("never echoes the access token in an outcome", async () => {
    const server = await startServer(
      identityThenPublish((response) => {
        jsonResponse(response, 401, {
          error: {
            message: `token ${ACCESS_TOKEN} rejected`,
            type: "OAuthException",
            code: 190,
          },
        });
      }),
    );
    const provider = providerFor(server);

    const outcome = await prepareAndPublish(provider, "Hello");

    expect(JSON.stringify(outcome)).not.toContain(ACCESS_TOKEN);
    expect(outcome).toEqual({
      kind: "failed",
      code: "AUTH",
      writeDisposition: "not_applied",
      retryable: true,
      retryNotBefore: null,
    });
  });

  it("classifies only structured platform rejections", async () => {
    const structured: Array<[string, number, unknown, string, boolean]> = [
      [
        "oauth exception",
        401,
        { error: { message: "expired", type: "OAuthException", code: 190 } },
        "AUTH",
        true,
      ],
      [
        "session code",
        400,
        { error: { message: "session", code: 102 } },
        "AUTH",
        true,
      ],
      [
        "throttling code",
        429,
        { error: { message: "slow down", code: 4 } },
        "RATE_LIMIT",
        true,
      ],
      [
        "duplicate post",
        400,
        { error: { message: "duplicate", code: 506 } },
        "INVALID_CONTENT",
        false,
      ],
      [
        "link scrape failure",
        400,
        { error: { message: "link", code: 1_609_005 } },
        "INVALID_CONTENT",
        false,
      ],
      [
        "permission denied",
        403,
        { error: { message: "denied", code: 10 } },
        "PERMISSION",
        false,
      ],
      [
        "permission range",
        403,
        { error: { message: "denied", code: 250 } },
        "PERMISSION",
        false,
      ],
      [
        "oauth type with permission code",
        403,
        { error: { message: "denied", type: "OAuthException", code: 10 } },
        "PERMISSION",
        false,
      ],
      [
        "oauth type with permission range",
        403,
        { error: { message: "denied", type: "OAuthException", code: 250 } },
        "PERMISSION",
        false,
      ],
    ];

    for (const [name, status, body, code, retryable] of structured) {
      const server = await startServer(
        identityThenPublish((response) => {
          jsonResponse(response, status, body);
        }),
      );
      const provider = providerFor(server);
      const outcome = await prepareAndPublish(provider, "Hello");

      expect(outcome, name).toMatchObject({
        kind: "failed",
        code,
        writeDisposition: "not_applied",
        retryable,
      });
      expect(postCount(server), name).toBe(1);
    }
  });

  it("leaves a rejection without recognizable evidence unknown", async () => {
    const cases: Array<[string, number, unknown]> = [
      ["bare status", 400, { message: "bad request" }],
      ["error without code", 400, { error: { message: "bad request" } }],
      ["unknown code", 400, { error: { message: "weird", code: 9_999_999 } }],
      ["ambiguous server error", 503, { error: { message: "down", code: 2 } }],
      ["redirect", 302, { error: { message: "moved", code: 190 } }],
      ["oauth type without code", 400, { error: { message: "?", type: "OAuthException" } }],
      [
        "oauth type with unknown code",
        400,
        { error: { message: "?", type: "OAuthException", code: 9_999_999 } },
      ],
      ["string code", 400, { error: { message: "?", code: "190" } }],
      ["null code", 400, { error: { message: "?", code: null } }],
      [
        "unknown code with auth subcode",
        400,
        { error: { message: "?", code: 9_999_999, error_subcode: 463 } },
      ],
      ["auth subcode only", 400, { error: { message: "?", error_subcode: 463 } }],
    ];

    for (const [name, status, body] of cases) {
      const server = await startServer(
        identityThenPublish((response) => {
          jsonResponse(response, status, body);
        }),
      );
      const provider = providerFor(server);
      const outcome = await prepareAndPublish(provider, "Hello");

      expect(outcome, name).toMatchObject({
        kind: "unknown",
        writeDisposition: "unknown",
      });
      expect(postCount(server), name).toBe(1);
    }
  });

  it("reads Retry-After into a bounded retryNotBefore", async () => {
    const server = await startServer(
      identityThenPublish((response) => {
        rawResponse(
          response,
          429,
          JSON.stringify({ error: { message: "slow down", code: 4 } }),
          { "retry-after": "30" },
        );
      }),
    );
    const provider = providerFor(server);
    const before = Date.now();

    const outcome = await prepareAndPublish(provider, "Hello");

    expect(outcome.kind).toBe("failed");

    if (outcome.kind !== "failed") {
      throw new Error("expected a failed outcome");
    }

    expect(outcome.code).toBe("RATE_LIMIT");
    expect(outcome.retryable).toBe(true);

    const retryAt = Date.parse(outcome.retryNotBefore ?? "");

    expect(retryAt).toBeGreaterThanOrEqual(before + 29_000);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 30_000);
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
        identityThenPublish((response) => {
          rawResponse(
            response,
            429,
            JSON.stringify({ error: { message: "slow down", code: 4 } }),
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
        identityThenPublish((response) => {
          rawResponse(
            response,
            429,
            JSON.stringify({ error: { message: "slow down", code: 4 } }),
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

  it("treats a bare 401 admission as an auth failure without a structured code", async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 401, { error: { message: "no token" } });
    });
    const provider = providerFor(server);

    await expect(
      provider.verifyIdentity(credentials(), signal()),
    ).rejects.toMatchObject({ name: "LocalProviderError", code: "AUTH" });
    expect(postCount(server)).toBe(0);
  });

  it("fails closed on a tampered frozen delivery before any request", async () => {
    const server = await startServer(identityThenPublish((response) => {
      jsonResponse(response, 200, { id: "1" });
    }));
    const provider = providerFor(server);
    const prepared = await provider.prepare(credentials(), target(), signal());
    const cases: FrozenDelivery[] = [
      deliveryFor(provider, prepared.target, "Hello", {}, 2),
      deliveryFor(provider, prepared.target, "Hello", { extra: true }),
      deliveryFor(provider, prepared.target, "Hello", { media_type: "IMAGE" }),
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

    expect(postCount(server)).toBe(0);
  });

  it("rejects content outside the frozen limits", async () => {
    const provider = new ThreadsLocalProvider();
    const family = "👨‍👩‍👧‍👦";

    expect(() => provider.freeze("a".repeat(500), CREATED_AT)).not.toThrow();
    expect(() => provider.freeze("a".repeat(501), CREATED_AT)).toThrow(
      LocalProviderError,
    );
    expect(() => provider.freeze("中".repeat(500), CREATED_AT)).not.toThrow();
    expect(() => provider.freeze("中".repeat(501), CREATED_AT)).toThrow(
      LocalProviderError,
    );
    expect(() => provider.freeze("😀".repeat(125), CREATED_AT)).not.toThrow();
    expect(() => provider.freeze("😀".repeat(126), CREATED_AT)).toThrow(
      LocalProviderError,
    );
    expect(() => provider.freeze(family.repeat(20), CREATED_AT)).not.toThrow();
    expect(() => provider.freeze(family.repeat(21), CREATED_AT)).toThrow(
      LocalProviderError,
    );
    expect(() => provider.freeze("🇯🇵".repeat(62), CREATED_AT)).not.toThrow();
    expect(() => provider.freeze("🇯🇵".repeat(63), CREATED_AT)).toThrow(
      LocalProviderError,
    );
    expect(() => provider.freeze("1️⃣".repeat(71), CREATED_AT)).not.toThrow();
    expect(() => provider.freeze("1️⃣".repeat(72), CREATED_AT)).toThrow(
      LocalProviderError,
    );
    expect(() => provider.freeze("   \n\t ", CREATED_AT)).toThrow(
      LocalProviderError,
    );
  });

  it("does not construct a grapheme segmenter at module load", async () => {
    vi.resetModules();
    const spy = vi.spyOn(Intl, "Segmenter");

    try {
      await import("../src/index.js");

      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
