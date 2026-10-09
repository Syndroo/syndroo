import { lookup as dnsLookup } from "node:dns/promises";
import { Agent, request as httpRequest, validateHeaderName, validateHeaderValue } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { connect as tcpConnect, isIP } from "node:net";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import type { ProviderHttpRequest, ProviderHttpResult, ProviderTransport } from "@syndroo/provider-sdk";
import { addressKey, isLoopbackAddress, isPublicAddress } from "./address-policy.js";

export interface NodeTransportOptions {
  /** One host-created transport per provider, with explicit canonical origins. */
  readonly allowedOrigins: readonly string[];
  /**
   * Federated provider mode: the operator supplies the instance host, so the
   * exact origin is not known in advance. Every other rule (public HTTPS only,
   * pinned DNS, no cross-origin redirect, bounded response) still applies.
   */
  readonly allowAnyPublicOrigin?: boolean;
  readonly deadlineMs?: number;
  readonly connectTimeoutMs?: number;
  readonly headersTimeoutMs?: number;
  /** Host-only escape hatch: localhost/loopback HTTP and ports for isolated tests. */
  readonly loopbackTestMode?: boolean;
  /** Extra safe response headers needed by a provider, e.g. a remote record ID. */
  readonly responseHeaderNames?: readonly string[];
}

export interface ConnectTarget {
  readonly address: string;
  readonly family: 4 | 6;
  readonly hostname: string;
  readonly port: number;
  readonly secure: boolean;
}

export type ConnectedSocket = Duplex & {
  readonly remoteAddress?: string | undefined;
  readonly encrypted?: boolean | undefined;
  readonly authorized?: boolean | undefined;
  readonly alpnProtocol?: string | false | undefined;
};

/** Trusted host/testing seam only; never accepted in ProviderHttpRequest. */
export interface NodeTransportDependencies {
  readonly lookup?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
  readonly connect?: (target: ConnectTarget, signal: AbortSignal) => Promise<ConnectedSocket>;
}

type Code = "INVALID_REQUEST" | "ORIGIN_NOT_ALLOWED" | "ADDRESS_NOT_ALLOWED" | "DNS_FAILED"
  | "ABORTED" | "DEADLINE_EXCEEDED" | "CONNECT_TIMEOUT" | "CONNECT_FAILED" | "PEER_MISMATCH"
  | "TLS_FAILED" | "HEADERS_TIMEOUT" | "REQUEST_FAILED" | "RESPONSE_TOO_LARGE"
  | "RESPONSE_TRUNCATED" | "UNSUPPORTED_ENCODING" | "INVALID_RESPONSE";

class Failure extends Error {
  constructor(readonly code: Code) { super(code); }
}

const BODY_LIMIT = 65536;
const RESPONSE_LIMIT = 1048576;
const HEADER_LIMIT = 16384;
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "proxy-connection"]);
const SAFE_RESPONSE_HEADERS = ["content-type", "content-length", "retry-after", "ratelimit-limit",
  "ratelimit-remaining", "ratelimit-reset", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"];
const sensitiveHeader = (name: string): boolean => /auth|cookie|token|secret|credential/i.test(name);

function deadline(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 60000) throw new Error("INVALID_TRANSPORT_CONFIG");
  return result;
}

function checkedUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.length > 8192 || /[\x00-\x20\x7f\\#]/.test(raw)) throw new Failure("INVALID_REQUEST");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Failure("INVALID_REQUEST"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || /@/.test(raw.split("/")[2] ?? "")) {
    throw new Failure("INVALID_REQUEST");
  }
  return url;
}

function hostname(url: URL): string { return url.hostname.replace(/^\[|\]$/g, ""); }

function testTarget(url: URL, enabled: boolean): boolean {
  return enabled && (hostname(url) === "localhost" || isLoopbackAddress(hostname(url)));
}

function validateRequest(input: ProviderHttpRequest): { url: URL; headers: Record<string, string>; body: string | undefined } {
  if (!input || (input.method !== "GET" && input.method !== "POST") || !(input.signal instanceof AbortSignal)) {
    throw new Failure("INVALID_REQUEST");
  }
  const url = checkedUrl(input.url);
  const body = input.body;
  if (body !== undefined && (typeof body !== "string" || body.length > BODY_LIMIT || !body.isWellFormed()
    || Buffer.byteLength(body) > BODY_LIMIT || input.method === "GET")) throw new Failure("INVALID_REQUEST");
  const headers: Record<string, string> = Object.create(null);
  let bytes = 0;
  if (input.headers !== undefined) {
    if (!input.headers || Array.isArray(input.headers) || ![Object.prototype, null].includes(Object.getPrototypeOf(input.headers))) {
      throw new Failure("INVALID_REQUEST");
    }
    for (const name of Reflect.ownKeys(input.headers)) {
      if (typeof name !== "string") throw new Failure("INVALID_REQUEST");
      const property = Object.getOwnPropertyDescriptor(input.headers, name)!;
      if (!("value" in property) || typeof property.value !== "string") throw new Failure("INVALID_REQUEST");
      const value: string = property.value;
      const key = name.toLowerCase();
      if (key in headers || HOP_HEADERS.has(key) || ["host", "content-length", "expect", "accept-encoding"].includes(key)) {
        throw new Failure("INVALID_REQUEST");
      }
      try { validateHeaderName(name); validateHeaderValue(name, value); } catch { throw new Failure("INVALID_REQUEST"); }
      bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
      if (bytes > HEADER_LIMIT) throw new Failure("INVALID_REQUEST");
      headers[key] = value;
    }
  }
  headers["accept-encoding"] = "identity";
  return { url, headers, body };
}

function abortFailure(signal: AbortSignal): Failure {
  return signal.reason instanceof Failure ? signal.reason : new Failure("ABORTED");
}

/** Detach from unabortable DNS; late connected sockets must still be destroyed. */
function untilAbort<T>(work: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const abort = () => { finished = true; reject(abortFailure(signal)); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(value => {
      signal.removeEventListener("abort", abort);
      if (finished) late?.(value);
      else { finished = true; resolve(value); }
    }, () => {
      signal.removeEventListener("abort", abort);
      if (!finished) { finished = true; reject(new Failure("CONNECT_FAILED")); }
    });
  });
}

/** Opens exactly the pinned numeric address; no second lookup, proxy or pool. */
export function connectPinnedSocket(target: ConnectTarget, signal: AbortSignal): Promise<ConnectedSocket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortFailure(signal)); return; }
    const connection = { host: target.address, port: target.port, family: target.family, autoSelectFamily: false };
    const socket = target.secure ? tlsConnect({
      ...connection, rejectUnauthorized: true, minVersion: "TLSv1.2", ALPNProtocols: ["http/1.1"],
      ...(isIP(target.hostname) ? {} : { servername: target.hostname }),
      checkServerIdentity: (_name, certificate) => checkServerIdentity(target.hostname, certificate),
    }) : tcpConnect(connection);
    const abort = () => { socket.destroy(); reject(abortFailure(signal)); };
    const ready = () => { signal.removeEventListener("abort", abort); resolve(socket); };
    socket.once(target.secure ? "secureConnect" : "connect", ready);
    // Keep an error listener attached between connect completion and HTTP setup.
    socket.on("error", () => { signal.removeEventListener("abort", abort); reject(new Failure("CONNECT_FAILED")); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function responseHeaders(source: IncomingHttpHeaders, allowed: ReadonlySet<string>): Record<string, string> {
  const blocked = new Set([...HOP_HEADERS, ...(source.connection ?? "").toLowerCase().split(",").map(s => s.trim())]);
  const result: Record<string, string> = {};
  for (const name of allowed) {
    if (blocked.has(name) || sensitiveHeader(name)) continue;
    const value = source[name];
    if (typeof value === "string") result[name] = value;
    else if (Array.isArray(value)) result[name] = value.join(", ");
  }
  return result;
}

function exchange(socket: ConnectedSocket, input: ReturnType<typeof validateRequest>, method: "GET" | "POST",
  signal: AbortSignal, timeoutMs: number, allowedHeaders: ReadonlySet<string>): Promise<ProviderHttpResult> {
  return new Promise((resolve, reject) => {
    // HTTP/1.1 framing over an already authenticated TLS stream (or test TCP).
    // A private one-socket agent cannot re-resolve, reuse connections or proxy.
    const agent = new Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = () => socket;
    let response: IncomingMessage | undefined;
    let finished = false;
    const timer = setTimeout(() => finish(new Failure("HEADERS_TIMEOUT")), timeoutMs);
    const abort = () => finish(abortFailure(signal));
    const req = httpRequest({
      hostname: hostname(input.url), port: input.url.port || (input.url.protocol === "https:" ? 443 : 80),
      path: input.url.pathname + input.url.search, method, agent,
      maxHeaderSize: HEADER_LIMIT,
      headers: { ...input.headers, host: input.url.host, ...(input.body === undefined ? {} : { "Content-Length": Buffer.byteLength(input.body) }) },
    });
    function finish(error?: Failure, result?: ProviderHttpResult): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      response?.destroy();
      req.destroy();
      agent.destroy();
      if (error) reject(error);
      else resolve(result!);
    }
    req.on("error", () => finish(new Failure("REQUEST_FAILED")));
    req.on("upgrade", () => finish(new Failure("INVALID_RESPONSE")));
    req.on("response", incoming => {
      response = incoming;
      clearTimeout(timer);
      if (method === "POST" && incoming.statusCode !== undefined
        && incoming.statusCode >= 300 && incoming.statusCode < 400) {
        finish(new Failure("INVALID_RESPONSE"));
        return;
      }
      incoming.on("error", () => finish(new Failure("RESPONSE_TRUNCATED")));
      incoming.on("aborted", () => finish(new Failure("RESPONSE_TRUNCATED")));
      incoming.on("close", () => { if (!incoming.complete) finish(new Failure("RESPONSE_TRUNCATED")); });
      const encoding = incoming.headers["content-encoding"];
      if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
        finish(new Failure("UNSUPPORTED_ENCODING")); return;
      }
      const length = incoming.headers["content-length"];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > RESPONSE_LIMIT)) {
        finish(new Failure("RESPONSE_TOO_LARGE")); return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      incoming.on("data", (chunk: Buffer) => {
        if (finished) return;
        bytes += chunk.length;
        if (bytes > RESPONSE_LIMIT) finish(new Failure("RESPONSE_TOO_LARGE"));
        else chunks.push(chunk);
      });
      incoming.on("end", () => {
        if (finished) return;
        if (!incoming.complete) { finish(new Failure("RESPONSE_TRUNCATED")); return; }
        let body: string;
        try { body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
        catch { finish(new Failure("INVALID_RESPONSE")); return; }
        finish(undefined, { type: "response", status: incoming.statusCode!, headers: responseHeaders(incoming.headers, allowedHeaders), body });
      });
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    req.end(input.body);
  });
}

export function createNodeTransport(options: NodeTransportOptions, dependencies: NodeTransportDependencies = {}): ProviderTransport {
  const allowed = new Set<string>();
  try {
    if (!Array.isArray(options.allowedOrigins) || options.allowedOrigins.length > 100) throw new Error();
    if (options.allowAnyPublicOrigin !== undefined && typeof options.allowAnyPublicOrigin !== "boolean") throw new Error();
    for (const origin of options.allowedOrigins) {
      const url = checkedUrl(origin);
      if (url.pathname !== "/" || url.search) throw new Error();
      allowed.add(url.origin);
    }
  } catch { throw new Error("INVALID_TRANSPORT_CONFIG"); }
  const overallMs = deadline(options.deadlineMs, 60000);
  const connectMs = deadline(options.connectTimeoutMs, 10000);
  const headersMs = deadline(options.headersTimeoutMs, 10000);
  const allowedHeaders = new Set(SAFE_RESPONSE_HEADERS);
  for (const header of options.responseHeaderNames ?? []) {
    const name = header.toLowerCase();
    if (!/^[a-z0-9-]{1,128}$/.test(name) || HOP_HEADERS.has(name) || sensitiveHeader(name) || name === "location") {
      throw new Error("INVALID_TRANSPORT_CONFIG");
    }
    allowedHeaders.add(name);
  }
  const lookup = dependencies.lookup ?? (name => dnsLookup(name, { all: true, verbatim: true }));
  const connect = dependencies.connect ?? connectPinnedSocket;
  const testMode = options.loopbackTestMode === true;
  const federated = options.allowAnyPublicOrigin === true;
  return {
    async request(input) {
      let validated: ReturnType<typeof validateRequest>;
      try {
        validated = validateRequest(input);
        if (!allowed.has(validated.url.origin) && !federated) throw new Failure("ORIGIN_NOT_ALLOWED");
        if (!testTarget(validated.url, testMode) && (validated.url.protocol !== "https:" || (validated.url.port && validated.url.port !== "443"))) {
          throw new Failure("INVALID_REQUEST");
        }
      } catch (error) {
        return { type: "transport_error", stage: "before_request", code: error instanceof Failure ? error.code : "INVALID_REQUEST" };
      }
      const controller = new AbortController();
      const abort = () => controller.abort(new Failure("ABORTED"));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      const overall = setTimeout(() => controller.abort(new Failure("DEADLINE_EXCEEDED")), overallMs);
      let socket: ConnectedSocket | undefined;
      let stage: "before_request" | "possibly_sent" = "before_request";
      try {
        if (controller.signal.aborted) throw abortFailure(controller.signal);
        const host = hostname(validated.url);
        const family = isIP(host);
        let answers: readonly { address: string; family: number }[];
        if (family) answers = [{ address: host, family }];
        else {
          try { answers = await untilAbort(Promise.resolve().then(() => {
            if (controller.signal.aborted) throw abortFailure(controller.signal);
            return lookup(host);
          }), controller.signal); }
          catch (error) {
            if (controller.signal.aborted) throw abortFailure(controller.signal);
            throw new Failure("DNS_FAILED");
          }
        }
        const loopback = testTarget(validated.url, testMode);
        if (!answers.length || answers.length > 64 || answers.some(a => isIP(a.address) !== a.family || a.family === 0
          || !(loopback ? isLoopbackAddress(a.address) : isPublicAddress(a.address)))) throw new Failure("ADDRESS_NOT_ALLOWED");
        const pinned = answers[0]!;
        if (controller.signal.aborted) throw abortFailure(controller.signal);
        stage = "possibly_sent";
        const timer = setTimeout(() => controller.abort(new Failure("CONNECT_TIMEOUT")), connectMs);
        try {
          socket = await untilAbort<ConnectedSocket>(Promise.resolve().then(() => {
            if (controller.signal.aborted) throw abortFailure(controller.signal);
            return connect({
            address: pinned.address, family: pinned.family as 4 | 6, hostname: host,
            port: Number(validated.url.port || (validated.url.protocol === "https:" ? 443 : 80)), secure: validated.url.protocol === "https:",
            }, controller.signal);
          }), controller.signal, late => { late.destroy(); });
        } finally { clearTimeout(timer); }
        if (!socket.remoteAddress || addressKey(socket.remoteAddress) !== addressKey(pinned.address)) throw new Failure("PEER_MISMATCH");
        if (validated.url.protocol === "https:" && (!socket.encrypted || socket.authorized !== true
          || (socket.alpnProtocol && socket.alpnProtocol !== "http/1.1"))) throw new Failure("TLS_FAILED");
        return await exchange(socket, validated, input.method, controller.signal, headersMs, allowedHeaders);
      } catch (error) {
        return { type: "transport_error", stage, code: error instanceof Failure ? error.code : "REQUEST_FAILED" };
      } finally {
        clearTimeout(overall);
        input.signal.removeEventListener("abort", abort);
        socket?.destroy();
      }
    },
  };
}
