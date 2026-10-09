import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderHttpRequest } from "@syndroo/provider-sdk";
import * as api from "../../../src/runtime/transport/index.js";
import { OK, ScriptedSocket } from "./support.js";

const ORIGIN = "https://provider.example";
const request = (patch: Partial<ProviderHttpRequest> = {}): ProviderHttpRequest => ({
  url: ORIGIN + "/post", method: "POST", body: "hello",
  signal: new AbortController().signal, ...patch,
});
const publicAnswer = [{ address: "93.184.216.34", family: 4 as const }];

function fixture(reply: ConstructorParameters<typeof ScriptedSocket>[0] = OK) {
  const socket = new ScriptedSocket(reply);
  const lookup = vi.fn(async () => publicAnswer);
  const connect = vi.fn(async (_target: api.ConnectTarget, _signal: AbortSignal) => socket);
  const transport = api.createNodeTransport({ allowedOrigins: [ORIGIN] }, { lookup, connect });
  return { socket, lookup, connect, transport };
}

afterEach(() => vi.useRealTimers());

describe("provider origin and request policy", () => {
  it("implements the host factory", () => expect(api.createNodeTransport).toBeTypeOf("function"));
  it.each([
    "https://other.example/post", "http://provider.example/post", "ftp://provider.example/post",
    "https://user:SECRET@provider.example/post", "https://provider.example/post#SECRET",
    "https://provider.example/post#", "https://provider.example:8443/post", "not a URL",
  ])("rejects %s before DNS or a socket", async url => {
    const f = fixture();
    expect(await f.transport.request(request({ url }))).toMatchObject({ type: "transport_error", stage: "before_request" });
    expect(f.lookup).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([
    { headers: { host: "internal.example" } }, { headers: { "accept-encoding": "gzip" } },
    { headers: { "transfer-encoding": "chunked" } }, { headers: { "content-length": "1" } },
    { headers: { authorization: "Bearer SECRET\r\nX-Injected: yes" } },
    { body: "x".repeat(65537) }, { body: "雨".repeat(21846) },
    { method: "CONNECT" }, { body: "\ud800" },
  ])("rejects unsafe request construction before I/O (%j)", async patch => {
    const f = fixture();
    const result = await f.transport.request(request(patch as Partial<ProviderHttpRequest>));
    expect(result).toEqual({ type: "transport_error", stage: "before_request", code: "INVALID_REQUEST" });
    expect(f.lookup).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it("does not mutate the request and transmits a body exactly at the byte bound", async () => {
    const f = fixture();
    const input = request({ body: "x".repeat(65536), headers: { authorization: "Bearer FIXTURE" } });
    const snapshot = { ...input, headers: { ...input.headers } };
    expect(await f.transport.request(input)).toMatchObject({ type: "response", status: 200, body: "ok" });
    expect(input).toEqual(snapshot);
    expect(f.socket.sent).toContain("Content-Length: 65536\r\n");
    expect(f.socket.sent).toContain("accept-encoding: identity\r\n");
    expect(f.socket.sent.endsWith(input.body!)).toBe(true);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.socket.destroyed).toBe(true);
  });
});

describe("IP policy and DNS pinning", () => {
  const blocked = [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254",
    "172.16.0.1", "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1",
    "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "fc00::1", "fe80::1",
    "fec0::1", "ff02::1", "64:ff9b::a00:1", "2001::1", "2001:db8::1", "2002:a00:1::1", "3fff::1",
  ];
  it.each(blocked)("rejects DNS answer %s before connect", async address => {
    const connect = vi.fn(async () => new ScriptedSocket(OK, address));
    const transport = api.createNodeTransport({ allowedOrigins: [ORIGIN] }, {
      lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }], connect,
    });
    expect(await transport.request(request())).toEqual({ type: "transport_error", stage: "before_request", code: "ADDRESS_NOT_ALLOWED" });
    expect(connect).not.toHaveBeenCalled();
  });
  it.each(["127.1", "0x7f000001", "[::ffff:7f00:1]", "[::1]", "169.254.169.254"])("rejects literal %s without DNS", async host => {
    const origin = "https://" + host;
    const lookup = vi.fn(async () => publicAnswer);
    const connect = vi.fn(async () => new ScriptedSocket(OK));
    const transport = api.createNodeTransport({ allowedOrigins: [origin] }, { lookup, connect });
    expect(await transport.request(request({ url: origin }))).toMatchObject({ type: "transport_error", stage: "before_request", code: "ADDRESS_NOT_ALLOWED" });
    expect(lookup).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
  it("rejects mixed public/private answers instead of picking the public one", async () => {
    const f = fixture();
    f.lookup.mockResolvedValue([...publicAnswer, { address: "127.0.0.1", family: 4 }]);
    expect(await f.transport.request(request())).toMatchObject({ stage: "before_request", code: "ADDRESS_NOT_ALLOWED" });
    expect(f.connect).not.toHaveBeenCalled();
  });
  it("pins the approved numeric address so a second rebinding lookup is never used", async () => {
    const f = fixture();
    f.lookup.mockResolvedValueOnce(publicAnswer).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    expect(await f.transport.request(request())).toMatchObject({ type: "response", status: 200 });
    expect(f.lookup).toHaveBeenCalledTimes(1);
    expect(f.connect.mock.calls[0]?.[0]).toMatchObject({ address: "93.184.216.34", hostname: "provider.example", port: 443, secure: true });
  });
  it("rejects an actual peer mismatch before writing headers or credentials", async () => {
    const f = fixture();
    const rebound = new ScriptedSocket(OK, "127.0.0.1");
    f.connect.mockResolvedValue(rebound);
    expect(await f.transport.request(request({ headers: { authorization: "Bearer SECRET" } })))
      .toEqual({ type: "transport_error", stage: "possibly_sent", code: "PEER_MISMATCH" });
    expect(rebound.sent).toBe("");
    expect(rebound.destroyed).toBe(true);
  });
  it("rejects an unauthenticated TLS socket before sending an HTTP request", async () => {
    const f = fixture();
    const unauthenticated = new ScriptedSocket(OK, "93.184.216.34", false);
    f.connect.mockResolvedValue(unauthenticated);
    expect(await f.transport.request(request())).toMatchObject({ stage: "possibly_sent", code: "TLS_FAILED" });
    expect(unauthenticated.sent).toBe("");
    expect(unauthenticated.destroyed).toBe(true);
  });
});

describe("conservative failures, response bounds and redaction", () => {
  it("maps DNS failure to before_request without reflecting the exception", async () => {
    const f = fixture();
    f.lookup.mockRejectedValue(new Error("Bearer SECRET cookie=SECRET request-body"));
    expect(await f.transport.request(request())).toEqual({ type: "transport_error", stage: "before_request", code: "DNS_FAILED" });
    expect(f.connect).not.toHaveBeenCalled();
  });
  it("never claims a connector failure proved no request was sent", async () => {
    const f = fixture();
    f.connect.mockRejectedValue(new Error("Bearer SECRET request-body"));
    expect(await f.transport.request(request())).toEqual({ type: "transport_error", stage: "possibly_sent", code: "CONNECT_FAILED" });
    expect(f.connect).toHaveBeenCalledTimes(1);
  });
  it("reset after write is possibly_sent and is not retried", async () => {
    const f = fixture(socket => socket.destroy(new Error("SECRET_BODY cookie=SECRET")));
    expect(await f.transport.request(request({ body: "SECRET_BODY" }))).toEqual({ type: "transport_error", stage: "possibly_sent", code: "REQUEST_FAILED" });
    expect(f.socket.sent).toContain("SECRET_BODY");
    expect(f.connect).toHaveBeenCalledTimes(1);
  });
  it("truncated response is possibly_sent, never a successful response", async () => {
    const f = fixture("HTTP/1.1 200 OK\r\nContent-Length: 30\r\n\r\nshort");
    expect(await f.transport.request(request())).toMatchObject({ type: "transport_error", stage: "possibly_sent", code: "RESPONSE_TRUNCATED" });
  });
  it.each([
    "HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\n\r\n",
    "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" + "x".repeat(1048577),
  ])("aborts declared or streamed oversized bodies", async wire => {
    const f = fixture(wire);
    expect(await f.transport.request(request())).toEqual({ type: "transport_error", stage: "possibly_sent", code: "RESPONSE_TOO_LARGE" });
    expect(f.socket.destroyed).toBe(true);
  });
  it("accepts the complete response at exactly 1 MiB", async () => {
    const f = fixture("HTTP/1.1 200 OK\r\nContent-Length: 1048576\r\n\r\n" + "x".repeat(1048576));
    const result = await f.transport.request(request());
    expect(result.type).toBe("response");
    if (result.type === "response") expect(result.body.length).toBe(1048576);
  });
  it("refuses compressed responses without attempting decompression", async () => {
    const f = fixture("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 4\r\n\r\nbomb");
    expect(await f.transport.request(request())).toEqual({ type: "transport_error", stage: "possibly_sent", code: "UNSUPPORTED_ENCODING" });
    expect(f.socket.destroyed).toBe(true);
  });
  it("rejects a content-write redirect without a second request or leaking its headers", async () => {
    const f = fixture("HTTP/1.1 302 Found\r\nContent-Length: 0\r\nLocation: https://127.0.0.1/private?token=SECRET\r\nSet-Cookie: SECRET\r\n\r\n");
    expect(await f.transport.request(request())).toEqual({
      type: "transport_error", stage: "possibly_sent", code: "INVALID_RESPONSE",
    });
    expect(f.connect).toHaveBeenCalledTimes(1);
  });
  it("returns GET redirects once, strips cookies/hop-by-hop/unknown headers", async () => {
    const f = fixture("HTTP/1.1 302 Found\r\nContent-Length: 0\r\nLocation: https://127.0.0.1/private?token=SECRET\r\nSet-Cookie: SECRET\r\nCookie: SECRET\r\nAuthorization: SECRET\r\nConnection: retry-after\r\nRetry-After: 5\r\nX-Diagnostic: SECRET\r\n\r\n");
    expect(await f.transport.request({ url: ORIGIN + "/post", method: "GET", signal: new AbortController().signal }))
      .toEqual({ type: "response", status: 302, headers: { "content-length": "0" }, body: "" });
    expect(f.connect).toHaveBeenCalledTimes(1);
  });
});

describe("deadline and cancellation", () => {
  it("pre-cancellation prevents DNS/connect", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort("SECRET");
    expect(await f.transport.request(request({ signal: controller.signal }))).toEqual({ type: "transport_error", stage: "before_request", code: "ABORTED" });
    expect(f.lookup).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  });
  it("bounds a stalled DNS lookup without ever starting a connection", async () => {
    const connect = vi.fn(async () => new ScriptedSocket(OK));
    const transport = api.createNodeTransport({ allowedOrigins: [ORIGIN], deadlineMs: 20 }, { lookup: () => new Promise(() => {}), connect });
    expect(await transport.request(request())).toMatchObject({ stage: "before_request", code: "DEADLINE_EXCEEDED" });
    expect(connect).not.toHaveBeenCalled();
  });
  it("aborts a stalled connector and destroys a socket returned too late", async () => {
    let finish!: (socket: ScriptedSocket) => void;
    let received: AbortSignal | undefined;
    const transport = api.createNodeTransport({ allowedOrigins: [ORIGIN], connectTimeoutMs: 20 }, {
      lookup: async () => publicAnswer,
      connect: (_target, signal) => { received = signal; return new Promise(resolve => { finish = resolve; }); },
    });
    expect(await transport.request(request())).toMatchObject({ stage: "possibly_sent", code: "CONNECT_TIMEOUT" });
    expect(received?.aborted).toBe(true);
    const late = new ScriptedSocket(OK); finish(late); await new Promise(setImmediate);
    expect(late.destroyed).toBe(true);
  });
  it.each(["headers", "body"] as const)("overall deadline aborts a stalled %s phase", async phase => {
    const socket = new ScriptedSocket(phase === "body" ? s => { s.push(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nx")); } : undefined);
    const transport = api.createNodeTransport({ allowedOrigins: [ORIGIN], deadlineMs: 20 }, { lookup: async () => publicAnswer, connect: async () => socket });
    expect(await transport.request(request())).toMatchObject({ stage: "possibly_sent", code: "DEADLINE_EXCEEDED" });
    expect(socket.destroyed).toBe(true);
  });
  it("header timeout aborts the socket after the request was sent", async () => {
    const socket = new ScriptedSocket();
    const transport = api.createNodeTransport({ allowedOrigins: [ORIGIN], headersTimeoutMs: 20 }, { lookup: async () => publicAnswer, connect: async () => socket });
    expect(await transport.request(request())).toMatchObject({ stage: "possibly_sent", code: "HEADERS_TIMEOUT" });
    expect(socket.sent).toContain("POST /post HTTP/1.1"); expect(socket.destroyed).toBe(true);
  });
  it("caller cancellation after write aborts the socket and stays possibly_sent", async () => {
    const controller = new AbortController();
    const f = fixture(() => controller.abort("SECRET"));
    expect(await f.transport.request(request({ signal: controller.signal }))).toEqual({ type: "transport_error", stage: "possibly_sent", code: "ABORTED" });
    expect(f.socket.destroyed).toBe(true);
  });
});

describe("federated egress mode", () => {
  const instance = "https://instance.example/statuses";

  it("denies an undeclared origin in fixed mode and permits it only when the policy is federated", async () => {
    const socket = new ScriptedSocket(OK);
    const dependencies = { lookup: async () => publicAnswer, connect: async () => socket };
    const fixed = api.createNodeTransport({ allowedOrigins: [ORIGIN] }, dependencies);
    const federated = api.createNodeTransport({ allowedOrigins: [], allowAnyPublicOrigin: true }, dependencies);

    expect(await fixed.request(request({ url: instance })))
      .toEqual({ type: "transport_error", stage: "before_request", code: "ORIGIN_NOT_ALLOWED" });
    expect(await federated.request(request({ url: instance })))
      .toMatchObject({ type: "response", status: 200, body: "ok" });
  });

  it("keeps the address policy, scheme rule and flag type in federated mode", async () => {
    const connect = vi.fn(async () => new ScriptedSocket(OK));
    const internal = api.createNodeTransport(
      { allowedOrigins: [], allowAnyPublicOrigin: true },
      { lookup: async () => [{ address: "127.0.0.1", family: 4 as const }], connect },
    );
    expect(await internal.request(request({ url: instance })))
      .toEqual({ type: "transport_error", stage: "before_request", code: "ADDRESS_NOT_ALLOWED" });
    expect(connect).not.toHaveBeenCalled();

    const cleartext = api.createNodeTransport(
      { allowedOrigins: [], allowAnyPublicOrigin: true },
      { lookup: async () => publicAnswer, connect },
    );
    expect(await cleartext.request(request({ url: "http://instance.example/statuses" })))
      .toEqual({ type: "transport_error", stage: "before_request", code: "INVALID_REQUEST" });
    expect(connect).not.toHaveBeenCalled();

    expect(() => api.createNodeTransport(
      { allowedOrigins: [], allowAnyPublicOrigin: "yes" as unknown as boolean },
    )).toThrow("INVALID_TRANSPORT_CONFIG");
  });
});
