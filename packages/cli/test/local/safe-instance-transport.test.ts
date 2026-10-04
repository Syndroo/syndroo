import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import type { RequestOptions } from "node:https";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SafeInstanceTransportError,
  createSafeInstanceFetch,
  normalizeInstanceOrigin,
  type SafeInstanceAddress,
  type SafeInstanceRequest,
  type SafeInstanceRequestHandle,
} from "../../src/local/http/safe-instance-transport.js";

const INSTANCE = "https://instance.test";
const PUBLIC_V4 = "93.184.216.34";

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "safe-transport",
);

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

interface RecordedRequest {
  readonly options: RequestOptions;
  body: Uint8Array | null;
}

class FakeRequest extends EventEmitter implements SafeInstanceRequestHandle {
  ended = false;
  destroyed = false;
  body: Uint8Array | null = null;
  respond: (() => void) | null = null;

  end(body?: Uint8Array): void {
    this.ended = true;
    this.body = body ?? null;
    this.respond?.();
  }

  destroy(_error?: Error): void {
    this.destroyed = true;
  }
}

type Outcome = IncomingMessage | Error | null;

function createRecordingRequest(behaviour: (call: { options: RequestOptions; index: number }) => Outcome): {
  request: SafeInstanceRequest;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];

  const request: SafeInstanceRequest = (options, onResponse) => {
    const index = calls.length;
    const record: RecordedRequest = { options, body: null };
    calls.push(record);

    const handle = new FakeRequest();
    handle.respond = () => {
      record.body = handle.body;
      const outcome = behaviour({ options, index });

      if (outcome instanceof Error) {
        handle.emit("error", outcome);
      } else if (outcome !== null) {
        onResponse(outcome);
      }
    };

    return handle;
  };

  return { request, calls };
}

function responseStream(
  chunks: readonly (string | Buffer)[],
  init: { status: number | undefined; statusMessage?: string; headers?: Record<string, string> },
): IncomingMessage {
  const stream = Readable.from(chunks, { objectMode: false }) as unknown as Readable & IncomingMessage;
  stream.statusCode = init.status;
  stream.statusMessage = init.statusMessage ?? "OK";
  stream.headers = init.headers ?? {};
  return stream as unknown as IncomingMessage;
}

function stalledResponse(init: { status: number }): IncomingMessage {
  const stream = new Readable({ read() {} }) as unknown as Readable & IncomingMessage;
  stream.statusCode = init.status;
  stream.statusMessage = "OK";
  stream.headers = {};
  return stream as unknown as IncomingMessage;
}

function publicLookup(address: string, family: number): () => Promise<readonly SafeInstanceAddress[]> {
  return async () => [{ address, family }];
}

function invokeLookup(
  lookup: NonNullable<RequestOptions["lookup"]>,
  hostname: string,
  all: boolean,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const options = all ? { all: true as const } : {};

    lookup(hostname, options, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(all ? address : { address, family });
    });
  });
}

const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function startTlsServer(
  cert: Buffer,
  key: Buffer,
): Promise<{ port: number; servernames: (string | false | null | undefined)[] }> {
  const servernames: (string | false | null | undefined)[] = [];

  const server = createHttpsServer({ cert, key }, (incoming, response) => {
    servernames.push((incoming.socket as TLSSocket).servername);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });

  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));

  return { port: (server.address() as AddressInfo).port, servernames };
}

/**
 * The request seam stands in for the socket layer. It first executes the
 * transport's own pinned lookup, then dials the local fixture while keeping
 * every TLS setting the transport chose.
 */
function tlsFixtureRequest(input: {
  port: number;
  ca: Buffer;
  onPinned: (value: unknown) => void;
}): SafeInstanceRequest {
  return (options, onResponse) => {
    const handle = new FakeRequest();

    handle.respond = () => {
      const lookup = options.lookup!;

      lookup("instance.test", { all: true }, (error, addresses) => {
        input.onPinned(error ?? addresses);

        const real = httpsRequest({
          ...options,
          lookup: (_hostname, _lookupOptions, callback) => callback(null, "127.0.0.1", 4),
          port: input.port,
          ca: input.ca,
        });

        real.on("response", onResponse);
        real.on("error", realError => handle.emit("error", realError));
        real.end();
      });
    };

    return handle;
  };
}

// ---------------------------------------------------------------------------
// Origin contract
// ---------------------------------------------------------------------------

describe("normalizeInstanceOrigin", () => {
  it.each([
    ["https://instance.test", "https://instance.test"],
    ["https://instance.test/", "https://instance.test"],
    ["https://INSTANCE.test:443/", "https://instance.test"],
    ["https://instance.test./", "https://instance.test"],
  ])("accepts %s as %s", (input, expected) => {
    expect(normalizeInstanceOrigin(input)).toBe(expected);
  });

  it.each([
    "http://instance.test",
    "ftp://instance.test",
    "https://instance.test:8443",
    "https://user@instance.test",
    "https://user:pass@instance.test",
    "https://instance.test/api",
    "https://instance.test?x=1",
    "https://instance.test#frag",
    "https://127.0.0.1",
    "https://127.1",
    "https://1.1.1.1.",
    "https://2130706433",
    "https://0x7f000001",
    "https://0x7f.1",
    "https://0177.0.0.1",
    "https://0",
    "https://[::1]",
    "https://[0:0:0:0:0:0:0:1]",
    "https://[::ffff:127.0.0.1]",
    "https://-bad.test",
    "https://bad-.test",
    "https://instance..test",
    "instance.test",
    "",
    "   ",
    "https://",
  ])("rejects %s", input => {
    let caught: unknown;

    try {
      normalizeInstanceOrigin(input);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SafeInstanceTransportError);
    expect((caught as SafeInstanceTransportError).code).toBe("invalid_origin");
  });
});

// ---------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------

const NON_PUBLIC: readonly { address: string; family: number }[] = [
  { address: "0.0.0.0", family: 4 },
  { address: "10.0.0.1", family: 4 },
  { address: "100.64.0.1", family: 4 },
  { address: "127.0.0.1", family: 4 },
  { address: "169.254.169.254", family: 4 },
  { address: "172.16.5.5", family: 4 },
  { address: "192.0.0.1", family: 4 },
  { address: "192.0.2.10", family: 4 },
  { address: "192.88.99.1", family: 4 },
  { address: "192.168.1.1", family: 4 },
  { address: "198.18.0.1", family: 4 },
  { address: "198.51.100.1", family: 4 },
  { address: "203.0.113.1", family: 4 },
  { address: "224.0.0.1", family: 4 },
  { address: "240.0.0.1", family: 4 },
  { address: "255.255.255.255", family: 4 },
  { address: "::", family: 6 },
  { address: "::1", family: 6 },
  { address: "::ffff:10.0.0.1", family: 6 },
  { address: "::ffff:192.168.1.1", family: 6 },
  { address: "::ffff:169.254.169.254", family: 6 },
  { address: "::ffff:93.184.216.34", family: 6 },
  { address: "64:ff9b::10.0.0.1", family: 6 },
  { address: "64:ff9b:1::a00:1", family: 6 },
  { address: "100::1", family: 6 },
  { address: "0100::1", family: 6 },
  { address: "2001::1", family: 6 },
  { address: "2001:2::1", family: 6 },
  { address: "2001:20::1", family: 6 },
  { address: "2001:db8::1", family: 6 },
  { address: "2002:c0a8:101::1", family: 6 },
  { address: "3fff::1", family: 6 },
  { address: "4000::1", family: 6 },
  { address: "5f00::1", family: 6 },
  { address: "6000::1", family: 6 },
  { address: "8000::1", family: 6 },
  { address: "a000::1", family: 6 },
  { address: "c000::1", family: 6 },
  { address: "e000::1", family: 6 },
  { address: "fc00::1", family: 6 },
  { address: "fd00::1", family: 6 },
  { address: "fe80::1", family: 6 },
  { address: "fec0::1", family: 6 },
  { address: "ff02::1", family: 6 },
  { address: "::ffff:0:0:0", family: 6 },
];

describe("public-address policy", () => {
  it.each(NON_PUBLIC)("rejects $address before opening a socket", async ({ address, family }) => {
    const { request, calls } = createRecordingRequest(() => null);
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(address, family), request });

    await expect(safeFetch(`${INSTANCE}/api/v1/statuses`)).rejects.toMatchObject({
      code: "non_public_address",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects a mixed answer instead of picking the public one", async () => {
    const { request, calls } = createRecordingRequest(() => null);
    const safeFetch = createSafeInstanceFetch({
      lookup: async () => [
        { address: PUBLIC_V4, family: 4 },
        { address: "10.0.0.7", family: 4 },
      ],
      request,
    });

    await expect(safeFetch(`${INSTANCE}/api/v1/statuses`)).rejects.toMatchObject({
      code: "non_public_address",
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    { address: PUBLIC_V4, family: 4 },
    { address: "1.1.1.1", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
    { address: "2000::1", family: 6 },
    { address: "2001:4860::1", family: 6 },
    { address: "2400:cb00::1", family: 6 },
  ])("accepts the public address $address", async ({ address, family }) => {
    const { request, calls } = createRecordingRequest(() => responseStream(["ok"], { status: 200 }));
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(address, family), request });

    const response = await safeFetch(`${INSTANCE}/api/v1/statuses`);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("sanitizes a resolver failure without echoing the hostname", async () => {
    const { request } = createRecordingRequest(() => null);
    const safeFetch = createSafeInstanceFetch({
      lookup: async () => {
        throw new Error("getaddrinfo ENOTFOUND instance.test");
      },
      request,
    });

    let caught: unknown;

    try {
      await safeFetch(`${INSTANCE}/api/v1/statuses`);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SafeInstanceTransportError);
    expect((caught as SafeInstanceTransportError).code).toBe("dns_resolution_failed");
    expect(`${(caught as Error).message}${(caught as Error).stack ?? ""}`).not.toContain("instance.test");
  });
});

// ---------------------------------------------------------------------------
// Socket pinning and TLS
// ---------------------------------------------------------------------------

describe("socket pinning", () => {
  it("pins the resolver-selected address into the socket lookup and keeps SNI", async () => {
    const { request, calls } = createRecordingRequest(() =>
      responseStream(["pong"], { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const safeFetch = createSafeInstanceFetch({
      lookup: async () => [
        { address: PUBLIC_V4, family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ],
      request,
    });

    const response = await safeFetch(`${INSTANCE}/api/v1/statuses?limit=20`, {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: "hello",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("pong");
    expect(calls).toHaveLength(1);

    const options = calls[0]!.options;

    expect(options.hostname).toBe("instance.test");
    expect(options.servername).toBe("instance.test");
    expect(options.port).toBe(443);
    expect(options.path).toBe("/api/v1/statuses?limit=20");
    expect(options.method).toBe("POST");
    expect(options.agent).toBe(false);
    expect(options.rejectUnauthorized).toBe(true);
    expect((options as { autoSelectFamily?: boolean }).autoSelectFamily).toBe(false);
    expect((options.headers as Record<string, string>).authorization).toBe("Bearer test-token");
    expect(Buffer.from(calls[0]!.body ?? [])).toEqual(Buffer.from("hello"));

    // Executing the installed lookup proves the socket layer cannot re-resolve:
    // it returns exactly the approved address for any hostname.
    expect(await invokeLookup(options.lookup!, "instance.test", true)).toEqual([
      { address: PUBLIC_V4, family: 4 },
    ]);
    expect(await invokeLookup(options.lookup!, "rebind.attacker.test", true)).toEqual([
      { address: PUBLIC_V4, family: 4 },
    ]);
    expect(await invokeLookup(options.lookup!, "instance.test", false)).toEqual({
      address: PUBLIC_V4,
      family: 4,
    });
  });

  it("preserves TLS SNI and hostname verification through a real handshake", async () => {
    const cert = readFileSync(join(FIXTURE_ROOT, "instance-cert.pem"));
    const key = readFileSync(join(FIXTURE_ROOT, "instance-key.pem"));
    const { port, servernames } = await startTlsServer(cert, key);
    let pinned: unknown = null;
    const request = tlsFixtureRequest({ port, ca: cert, onPinned: value => { pinned = value; } });
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    const response = await safeFetch(`${INSTANCE}/api/v1/statuses`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(pinned).toEqual([{ address: PUBLIC_V4, family: 4 }]);
    expect(servernames).toEqual(["instance.test"]);
  });

  it("fails when the certificate does not match the instance hostname", async () => {
    const cert = readFileSync(join(FIXTURE_ROOT, "wrong-host-cert.pem"));
    const key = readFileSync(join(FIXTURE_ROOT, "wrong-host-key.pem"));
    const { port } = await startTlsServer(cert, key);
    const request = tlsFixtureRequest({ port, ca: cert, onPinned: () => {} });
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    await expect(safeFetch(`${INSTANCE}/api/v1/statuses`)).rejects.toMatchObject({
      code: "request_failed",
    });
  });
});

// ---------------------------------------------------------------------------
// Redirects, budgets, deadlines
// ---------------------------------------------------------------------------

describe("redirects and budgets", () => {
  it("never follows a redirect or forwards authorization to another origin", async () => {
    const { request, calls } = createRecordingRequest(() =>
      responseStream([], {
        status: 302,
        statusMessage: "Found",
        headers: { location: "https://attacker.test/steal" },
      }),
    );
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    await expect(
      safeFetch(`${INSTANCE}/api/v1/statuses`, {
        method: "POST",
        headers: { authorization: "Bearer secret-token" },
        body: "x",
      }),
    ).rejects.toMatchObject({ code: "redirect_not_allowed" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.hostname).toBe("instance.test");
    expect((calls[0]!.options.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
    expect(calls.some(call => call.options.hostname === "attacker.test")).toBe(false);
  });

  it("refuses a response body larger than 1 MiB", async () => {
    const tooLarge = Buffer.alloc(1_048_577, 0x61);
    const { request } = createRecordingRequest(() => responseStream([tooLarge], { status: 200 }));
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    await expect(safeFetch(`${INSTANCE}/api/v1/statuses`)).rejects.toMatchObject({
      code: "response_too_large",
    });
  });

  it("returns a fully buffered response at the cap", async () => {
    const exact = Buffer.alloc(1_048_576, 0x62);
    const { request } = createRecordingRequest(() => responseStream([exact], { status: 200 }));
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    const response = await safeFetch(`${INSTANCE}/api/v1/statuses`);
    const body = await response.arrayBuffer();

    expect(body.byteLength).toBe(1_048_576);
  });

  it("keeps an unknown response status conservative instead of inventing a 502", async () => {
    const { request } = createRecordingRequest(() => responseStream(["x"], { status: undefined }));
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    await expect(safeFetch(`${INSTANCE}/api/v1/statuses`)).rejects.toMatchObject({
      code: "unknown_response_status",
    });
  });

  it("returns provider error statuses unchanged", async () => {
    const { request } = createRecordingRequest(() =>
      responseStream(["nope"], { status: 503, statusMessage: "Service Unavailable" }),
    );
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    const response = await safeFetch(`${INSTANCE}/api/v1/statuses`);

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("nope");
  });

  it("times out a stalled DNS lookup on the shared deadline", async () => {
    vi.useFakeTimers();
    const { request, calls } = createRecordingRequest(() => null);
    const safeFetch = createSafeInstanceFetch({
      lookup: () => new Promise<readonly SafeInstanceAddress[]>(() => {}),
      request,
    });

    const pending = safeFetch(`${INSTANCE}/api/v1/statuses`);
    const expectation = expect(pending).rejects.toMatchObject({ code: "timeout" });

    await vi.advanceTimersByTimeAsync(15_000);
    await expectation;
    expect(calls).toHaveLength(0);
  });

  it("times out a stalled response body on the shared deadline", async () => {
    vi.useFakeTimers();
    const { request, calls } = createRecordingRequest(() => stalledResponse({ status: 200 }));
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    const pending = safeFetch(`${INSTANCE}/api/v1/statuses`);
    const expectation = expect(pending).rejects.toMatchObject({ code: "timeout" });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await expectation;
  });

  it("counts DNS time against the same 15 s budget as the body", async () => {
    vi.useFakeTimers();
    const { request, calls } = createRecordingRequest(() => stalledResponse({ status: 200 }));
    const safeFetch = createSafeInstanceFetch({
      lookup: () =>
        new Promise<readonly SafeInstanceAddress[]>(resolve => {
          setTimeout(() => resolve([{ address: PUBLIC_V4, family: 4 }]), 14_000);
        }),
      request,
    });

    const pending = safeFetch(`${INSTANCE}/api/v1/statuses`);
    const expectation = expect(pending).rejects.toMatchObject({ code: "timeout" });

    await vi.advanceTimersByTimeAsync(14_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expectation;
  });

  it("rejects a pre-aborted signal before any lookup", async () => {
    let lookups = 0;
    const { request, calls } = createRecordingRequest(() => null);
    const safeFetch = createSafeInstanceFetch({
      lookup: async () => {
        lookups += 1;
        return [{ address: PUBLIC_V4, family: 4 }];
      },
      request,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      safeFetch(`${INSTANCE}/api/v1/statuses`, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });

    expect(lookups).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("aborts an in-flight lookup", async () => {
    const { request } = createRecordingRequest(() => null);
    const safeFetch = createSafeInstanceFetch({
      lookup: () => new Promise<readonly SafeInstanceAddress[]>(() => {}),
      request,
    });
    const controller = new AbortController();

    const pending = safeFetch(`${INSTANCE}/api/v1/statuses`, { signal: controller.signal });
    const expectation = expect(pending).rejects.toMatchObject({ code: "aborted" });
    controller.abort();
    await expectation;
  });
});

// ---------------------------------------------------------------------------
// Request input and body rules
// ---------------------------------------------------------------------------

describe("request rules", () => {
  it.each([
    "http://instance.test/api",
    "https://instance.test:8443/api",
    "https://user:pass@instance.test/api",
    "https://127.0.0.1/api",
    "https://[::1]/api",
    "https://2130706433/api",
    "https://0x7f000001/api",
    "not a url",
  ])("rejects unsafe request URL %s", async url => {
    const { request, calls } = createRecordingRequest(() => null);
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    await expect(safeFetch(url)).rejects.toMatchObject({ code: "invalid_request_url" });
    expect(calls).toHaveLength(0);
  });

  it("validates a Request input and refuses a streaming Request body", async () => {
    const { request, calls } = createRecordingRequest(() => responseStream(["ok"], { status: 200 }));
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    const response = await safeFetch(
      new Request(`${INSTANCE}/api/v1/statuses`, {
        method: "GET",
        headers: { accept: "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    expect(calls[0]!.options.method).toBe("GET");
    expect((calls[0]!.options.headers as Record<string, string>).accept).toBe("application/json");

    await expect(safeFetch(new Request("https://127.0.0.1/api"))).rejects.toMatchObject({
      code: "invalid_request_url",
    });

    await expect(
      safeFetch(new Request(`${INSTANCE}/api/v1/statuses`, { method: "POST", body: "x" })),
    ).rejects.toMatchObject({ code: "unsupported_request_body" });
  });

  it("sends a bounded URLSearchParams body as a form", async () => {
    const { request, calls } = createRecordingRequest(() => responseStream([], { status: 200 }));
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    await safeFetch(`${INSTANCE}/api/v1/statuses`, {
      method: "POST",
      body: new URLSearchParams({ status: "hello" }),
    });

    expect((calls[0]!.options.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded;charset=UTF-8",
    );
    expect(Buffer.from(calls[0]!.body ?? []).toString("utf8")).toBe("status=hello");
  });

  it("refuses an unsupported streaming body and an oversized body", async () => {
    const { request, calls } = createRecordingRequest(() => responseStream([], { status: 200 }));
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    await expect(
      safeFetch(`${INSTANCE}/api/v1/statuses`, {
        method: "POST",
        body: new ReadableStream() as unknown as NonNullable<RequestInit["body"]>,
      }),
    ).rejects.toMatchObject({ code: "unsupported_request_body" });

    await expect(
      safeFetch(`${INSTANCE}/api/v1/statuses`, { method: "POST", body: "a".repeat(1_048_577) }),
    ).rejects.toMatchObject({ code: "request_body_too_large" });

    expect(calls).toHaveLength(0);
  });

  it("refuses a caller-supplied Host header", async () => {
    const { request, calls } = createRecordingRequest(() => responseStream([], { status: 200 }));
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    await expect(
      safeFetch(`${INSTANCE}/api/v1/statuses`, { headers: { host: "attacker.test" } }),
    ).rejects.toMatchObject({ code: "forbidden_request_header" });
    expect(calls).toHaveLength(0);
  });

  it("converts a raw Headers TypeError into a static error without the header value", async () => {
    const canary = "SECRET_CANARY_HEADER_VALUE";
    const { request, calls } = createRecordingRequest(() => responseStream([], { status: 200 }));
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    let caught: unknown;

    try {
      await safeFetch(`${INSTANCE}/api/v1/statuses`, {
        headers: { "x-canary": `${canary}\ninjected` },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SafeInstanceTransportError);
    const error = caught as SafeInstanceTransportError;
    const serialized = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;

    expect(error.code).toBe("invalid_request");
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("instance.test");
    expect(calls).toHaveLength(0);
  });

  it("destroys the request handle when the request implementation throws on end", async () => {
    const handle = new FakeRequest();
    handle.respond = () => {
      throw new Error("end failed");
    };
    const request: SafeInstanceRequest = () => handle;
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    await expect(
      safeFetch(`${INSTANCE}/api/v1/statuses`, { method: "POST", body: "x" }),
    ).rejects.toMatchObject({ code: "request_failed" });
    expect(handle.destroyed).toBe(true);
  });

  it("converts a throwing request implementation into a static error", async () => {
    const canary = "SECRET_CANARY_REQUEST_CTOR";
    const request: SafeInstanceRequest = () => {
      throw new Error(`boom ${canary}`);
    };
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    let caught: unknown;

    try {
      await safeFetch(`${INSTANCE}/api/v1/statuses`);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SafeInstanceTransportError);
    expect((caught as SafeInstanceTransportError).code).toBe("request_failed");
    expect(`${(caught as Error).message}${(caught as Error).stack ?? ""}`).not.toContain(canary);
  });

  it("ignores proxy environment variables and never enables an agent", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:9");
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:9");
    vi.stubEnv("ALL_PROXY", "http://127.0.0.1:9");

    const { request, calls } = createRecordingRequest(() => responseStream(["ok"], { status: 200 }));
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    const response = await safeFetch(`${INSTANCE}/api/v1/statuses`);

    expect(response.status).toBe(200);
    expect(calls[0]!.options.hostname).toBe("instance.test");
    expect(calls[0]!.options.agent).toBe(false);
    expect(calls[0]!.options.createConnection).toBeUndefined();
  });

  it("never leaks the URL, query, or token in a failure message", async () => {
    const canary = "SECRET_CANARY_TOKEN_123";
    const { request } = createRecordingRequest(() => new Error(`boom ${canary}`));
    const safeFetch = createSafeInstanceFetch({ lookup: publicLookup(PUBLIC_V4, 4), request });

    let caught: unknown;

    try {
      await safeFetch(`https://instance.test/api/v1/statuses?access_token=${canary}`, {
        method: "POST",
        headers: { authorization: `Bearer ${canary}` },
        body: "x",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SafeInstanceTransportError);
    const error = caught as SafeInstanceTransportError;
    const serialized = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;

    expect(error.code).toBe("request_failed");
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("instance.test");
    expect(serialized).not.toContain("/api/v1/statuses");
  });
});
