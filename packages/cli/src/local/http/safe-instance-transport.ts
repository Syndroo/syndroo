/**
 * R3 A2 safe instance transport.
 *
 * Local providers such as Mastodon take a user-supplied instance origin. That
 * origin is attacker-controlled input, so this module owns the entire outbound
 * path instead of handing a URL to the global `fetch`:
 *
 * - the origin must be plain `https:` on port 443 with no credentials, path,
 *   query, or fragment, and the host must not be an IP literal (including the
 *   obfuscated IPv4 forms that `URL` canonicalizes);
 * - every address the resolver returns must be public. IPv4 is checked against
 *   the special ranges; IPv6 is allow-listed to 2000::/3 global unicast and then
 *   filtered for special ranges inside it, so IPv4-mapped/translated, site-local,
 *   unique-local, link-local, multicast, and unassigned space all fail. One
 *   non-public answer fails the whole lookup;
 * - the approved address is pinned into the socket `lookup`, so the socket
 *   cannot re-resolve to a different address after the check (DNS rebinding);
 *   TLS keeps the real hostname for SNI and certificate verification;
 * - redirects are never followed, there is no retry, and the request body is
 *   restricted to bounded strings and `URLSearchParams`;
 * - one 15 s deadline covers DNS and body, the response is capped at 1 MiB, and
 *   the body is buffered before a `Response` is returned so callers cannot
 *   stream past the budget;
 * - every failure is a static, sanitized error: no URL, query, or token ever
 *   reaches a message.
 */

import { lookup as resolveAddresses } from "node:dns/promises";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { URL } from "node:url";

/** One request may spend this long on DNS plus the full response body. */
export const SAFE_INSTANCE_TOTAL_TIMEOUT_MS = 15_000;
/** A response body larger than this fails the request instead of truncating. */
export const SAFE_INSTANCE_MAX_RESPONSE_BYTES = 1_048_576;
/** A request body larger than this is refused before any socket is opened. */
export const SAFE_INSTANCE_MAX_REQUEST_BODY_BYTES = 1_048_576;

export type SafeInstanceTransportFailure =
  | "invalid_origin"
  | "invalid_request_url"
  | "invalid_request"
  | "unsupported_request_body"
  | "request_body_too_large"
  | "forbidden_request_header"
  | "dns_resolution_failed"
  | "non_public_address"
  | "request_failed"
  | "response_failed"
  | "response_too_large"
  | "unknown_response_status"
  | "redirect_not_allowed"
  | "timeout"
  | "aborted";

/**
 * Static messages only. A message must never carry the request URL, its query,
 * a header value, or any credential, so there is no interpolation here.
 */
const FAILURE_MESSAGES: Record<SafeInstanceTransportFailure, string> = {
  invalid_origin:
    "instance origin must be an https origin on port 443 with no credentials, path, query, or fragment",
  invalid_request_url: "request URL is not a valid instance endpoint",
  invalid_request: "request could not be prepared safely",
  unsupported_request_body:
    "request body must be a string or URLSearchParams; streaming bodies are not supported",
  request_body_too_large: "request body exceeds the supported size",
  forbidden_request_header: "request header is not allowed by the safe instance transport",
  dns_resolution_failed: "instance host could not be resolved",
  non_public_address: "instance host resolves to a non-public address",
  request_failed: "instance request failed",
  response_failed: "instance response failed",
  response_too_large: "instance response exceeds the supported size",
  unknown_response_status: "instance response status is unknown",
  redirect_not_allowed: "instance redirects are not allowed",
  timeout: "instance request timed out",
  aborted: "instance request was aborted",
};

/** Sanitized transport error. `code` is safe to branch on; `message` is static. */
export class SafeInstanceTransportError extends Error {
  readonly code: SafeInstanceTransportFailure;

  constructor(code: SafeInstanceTransportFailure) {
    super(FAILURE_MESSAGES[code]);
    this.name = "SafeInstanceTransportError";
    this.code = code;
  }
}

function failure(code: SafeInstanceTransportFailure): SafeInstanceTransportError {
  return new SafeInstanceTransportError(code);
}

/**
 * The factory converts anything that is not already a sanitized transport error
 * into a static error, so a raw `TypeError` from `Headers`/`Request`/`Response`
 * construction can never echo a header value or URL.
 */
function staticError(error: unknown, fallback: SafeInstanceTransportFailure): SafeInstanceTransportError {
  return error instanceof SafeInstanceTransportError ? error : failure(fallback);
}

/**
 * Canonical instance origin: `https://host` with a lower-case host, the default
 * 443 port, no credentials, and no path beyond an optional `/`.
 */
export function normalizeInstanceOrigin(input: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw failure("invalid_origin");
  }

  let url: URL;

  try {
    url = new URL(input);
  } catch {
    throw failure("invalid_origin");
  }

  if (url.protocol !== "https:") {
    throw failure("invalid_origin");
  }

  if (url.username !== "" || url.password !== "") {
    throw failure("invalid_origin");
  }

  // `URL` drops an explicit `:443`, so any remaining port is a non-443 port.
  if (url.port !== "") {
    throw failure("invalid_origin");
  }

  if (url.search !== "" || url.hash !== "") {
    throw failure("invalid_origin");
  }

  if (url.pathname !== "" && url.pathname !== "/") {
    throw failure("invalid_origin");
  }

  return `https://${canonicalHost(url.hostname)}`;
}

function canonicalHost(rawHostname: string): string {
  // IPv6 literals arrive bracketed; any remaining colon is still a literal.
  if (rawHostname === "" || rawHostname.startsWith("[") || rawHostname.includes(":")) {
    throw failure("invalid_origin");
  }

  // A trailing dot is the same DNS name; normalize it away so resolution,
  // pinning, and SNI all use one spelling.
  const host = rawHostname.endsWith(".") ? rawHostname.slice(0, -1) : rawHostname;

  if (host === "" || host.length > 253) {
    throw failure("invalid_origin");
  }

  // `URL` canonicalizes obfuscated IPv4 (decimal, octal, hex, short forms) into
  // dotted-quad, so this single check covers the whole family.
  if (isIP(host) !== 0) {
    throw failure("invalid_origin");
  }

  if (/^[0-9]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    throw failure("invalid_origin");
  }

  if (!/^[a-z0-9.-]+$/.test(host)) {
    throw failure("invalid_origin");
  }

  for (const label of host.split(".")) {
    if (label === "" || label.length > 63) {
      throw failure("invalid_origin");
    }

    if (label.startsWith("-") || label.endsWith("-")) {
      throw failure("invalid_origin");
    }
  }

  return host;
}

// ---------------------------------------------------------------------------
// Public-address policy
// ---------------------------------------------------------------------------

const IPV4_BLOCKED: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation (TEST-NET-1)
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation (TEST-NET-2)
  ["203.0.113.0", 24], // documentation (TEST-NET-3)
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including broadcast
];

/**
 * IPv6 is allow-listed: only 2000::/3 global unicast may pass, and the special
 * ranges inside it are then excluded. Everything outside that block is refused
 * by construction, which covers unspecified, loopback, IPv4-compatible,
 * IPv4-mapped and IPv4-translated, NAT64, discard-only, unique-local, site-local
 * (fec0::/10), link-local, multicast, and unassigned/reserved space.
 */
const IPV6_GLOBAL_UNICAST_PREFIX = "2000::";
const IPV6_GLOBAL_UNICAST_BITS = 3;

const IPV6_BLOCKED_WITHIN_GLOBAL_UNICAST: readonly (readonly [string, number])[] = [
  ["2001::", 23], // IETF protocol assignments, including Teredo and benchmarking
  ["2001:20::", 28], // ORCHIDv2
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["3fff::", 20], // documentation
];

function parseIpv4(address: string): number | null {
  const parts = address.split(".");

  if (parts.length !== 4) {
    return null;
  }

  let value = 0;

  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) {
      return null;
    }

    const octet = Number(part);

    if (octet > 255) {
      return null;
    }

    value = value * 256 + octet;
  }

  return value >>> 0;
}

function parseIpv6(address: string): number[] | null {
  let text = address.toLowerCase();

  if (text.startsWith("[") && text.endsWith("]")) {
    text = text.slice(1, -1);
  }

  const zone = text.indexOf("%");

  if (zone !== -1) {
    text = text.slice(0, zone);
  }

  if (text === "") {
    return null;
  }

  // Rewrite a trailing dotted-quad into two hex groups before splitting.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);

  if (tail.includes(".")) {
    const embedded = parseIpv4(tail);

    if (embedded === null || lastColon === -1) {
      return null;
    }

    const high = ((embedded >>> 16) & 0xffff).toString(16);
    const low = (embedded & 0xffff).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const firstDouble = text.indexOf("::");

  if (firstDouble !== -1 && text.indexOf("::", firstDouble + 2) !== -1) {
    return null;
  }

  let groups: string[];

  if (firstDouble !== -1) {
    const head = text.slice(0, firstDouble);
    const rest = text.slice(firstDouble + 2);
    const headGroups = head === "" ? [] : head.split(":");
    const restGroups = rest === "" ? [] : rest.split(":");
    const missing = 8 - headGroups.length - restGroups.length;

    if (missing < 0) {
      return null;
    }

    groups = [...headGroups, ...new Array<string>(missing).fill("0"), ...restGroups];
  } else {
    groups = text.split(":");

    if (groups.length !== 8) {
      return null;
    }
  }

  const bytes: number[] = [];

  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) {
      return null;
    }

    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }

  return bytes.length === 16 ? bytes : null;
}

function isBlockedIpv4(value: number): boolean {
  for (const [base, bits] of IPV4_BLOCKED) {
    const baseValue = parseIpv4(base);

    if (baseValue === null) {
      continue;
    }

    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;

    if ((value & mask) === (baseValue & mask)) {
      return true;
    }
  }

  return false;
}

function matchesPrefix(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  const fullBytes = bits >> 3;
  const remainder = bits & 7;

  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== prefix[index]) {
      return false;
    }
  }

  if (remainder === 0) {
    return true;
  }

  const mask = (0xff << (8 - remainder)) & 0xff;
  return (bytes[fullBytes]! & mask) === (prefix[fullBytes]! & mask);
}

function isPublicAddress(address: string, family: 4 | 6): boolean {
  if (family === 4) {
    const value = parseIpv4(address);
    return value !== null && !isBlockedIpv4(value);
  }

  const bytes = parseIpv6(address);

  if (bytes === null) {
    return false;
  }

  // Allow-list first: anything outside 2000::/3 is refused, including
  // IPv4-mapped/translated, NAT64, site-local, and unassigned space.
  const globalUnicast = parseIpv6(IPV6_GLOBAL_UNICAST_PREFIX);

  if (globalUnicast === null || !matchesPrefix(bytes, globalUnicast, IPV6_GLOBAL_UNICAST_BITS)) {
    return false;
  }

  for (const [prefix, bits] of IPV6_BLOCKED_WITHIN_GLOBAL_UNICAST) {
    const prefixBytes = parseIpv6(prefix);

    if (prefixBytes === null) {
      continue;
    }

    if (matchesPrefix(bytes, prefixBytes, bits)) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Fetch factory
// ---------------------------------------------------------------------------

export interface SafeInstanceAddress {
  readonly address: string;
  readonly family: number | string;
}

/** Minimal surface of a `ClientRequest` the transport needs to drive. */
export interface SafeInstanceRequestHandle {
  on(event: "error", listener: (error: Error) => void): unknown;
  end(body?: Uint8Array): unknown;
  destroy(error?: Error): unknown;
}

export type SafeInstanceRequest = (
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => SafeInstanceRequestHandle;

/**
 * Test seams. They replace the resolver and the request implementation; they
 * cannot disable the origin rules, the address policy, the deadline, the body
 * cap, or the redirect refusal.
 */
export interface SafeInstanceFetchOptions {
  readonly lookup?: (hostname: string) => Promise<readonly SafeInstanceAddress[]>;
  readonly request?: SafeInstanceRequest;
}

async function defaultLookup(hostname: string): Promise<readonly SafeInstanceAddress[]> {
  const resolved = await resolveAddresses(hostname, { all: true, verbatim: true });

  return resolved.map(entry => ({ address: entry.address, family: entry.family }));
}

interface RequestPlan {
  readonly hostname: string;
  readonly path: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Uint8Array | null;
  readonly signal: AbortSignal | null;
}

function buildRequestPlan(input: string | URL | Request, init?: RequestInit): RequestPlan {
  const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
  const signal = init?.signal ?? request?.signal ?? null;

  if (signal !== null && signal.aborted) {
    throw failure("aborted");
  }

  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : request?.url;

  if (raw === undefined || raw === "") {
    throw failure("invalid_request_url");
  }

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw failure("invalid_request_url");
  }

  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    throw failure("invalid_request_url");
  }

  // Reuses the origin contract, including the IP-literal rejection. The full
  // URL may still carry a path and query, which are the endpoint only.
  let origin: string;

  try {
    origin = normalizeInstanceOrigin(url.origin);
  } catch {
    throw failure("invalid_request_url");
  }

  const hostname = origin.slice("https://".length);

  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers ?? request?.headers ?? undefined);

  for (const forbidden of ["host", "connection", "transfer-encoding", "upgrade"]) {
    if (headers.has(forbidden)) {
      throw failure("forbidden_request_header");
    }
  }

  // Node sets Content-Length from the buffered body; a caller-supplied value
  // could disagree with the bytes we actually send.
  headers.delete("content-length");

  const body = readBody(init, request, headers);

  return {
    hostname,
    path: `${url.pathname}${url.search}`,
    method,
    headers,
    body,
    signal,
  };
}

function readBody(init: RequestInit | undefined, request: Request | null, headers: Headers): Uint8Array | null {
  const provided = init !== undefined && Object.prototype.hasOwnProperty.call(init, "body");

  if (!provided && request !== null && request.body !== null) {
    // A Request body is always a stream; only explicit string/form bodies are
    // supported so the size is known before anything is sent.
    throw failure("unsupported_request_body");
  }

  const body: unknown = provided ? init?.body : undefined;

  if (body === undefined || body === null) {
    return null;
  }

  let bytes: Uint8Array;

  if (typeof body === "string") {
    bytes = Buffer.from(body, "utf8");
  } else if (body instanceof URLSearchParams) {
    bytes = Buffer.from(body.toString(), "utf8");

    if (!headers.has("content-type")) {
      headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    }
  } else {
    throw failure("unsupported_request_body");
  }

  if (bytes.byteLength > SAFE_INSTANCE_MAX_REQUEST_BODY_BYTES) {
    throw failure("request_body_too_large");
  }

  return bytes;
}

function normalizeResolvedAddress(entry: SafeInstanceAddress): { address: string; family: 4 | 6 } | null {
  const address = entry?.address;

  if (typeof address !== "string" || address === "") {
    return null;
  }

  const detected = isIP(address);

  if (detected !== 4 && detected !== 6) {
    return null;
  }

  const family: 4 | 6 = detected === 6 ? 6 : 4;

  if (entry.family !== 4 && entry.family !== 6 && entry.family !== "IPv4" && entry.family !== "IPv6") {
    return null;
  }

  const declared: 4 | 6 = entry.family === 6 || entry.family === "IPv6" ? 6 : 4;

  if (declared !== family) {
    return null;
  }

  return { address, family };
}

function pinnedLookup(chosen: { address: string; family: 4 | 6 }): NonNullable<RequestOptions["lookup"]> {
  return (_hostname, options, callback) => {
    const wantsAll = typeof options === "object" && options !== null && options.all === true;

    if (wantsAll) {
      callback(null, [{ address: chosen.address, family: chosen.family }]);
      return;
    }

    callback(null, chosen.address, chosen.family);
  };
}

function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort: () => SafeInstanceTransportError,
  onReject: SafeInstanceTransportFailure,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      signal.removeEventListener("abort", handleAbort);
      action();
    };

    const handleAbort = (): void => {
      finish(() => reject(onAbort()));
    };

    if (signal.aborted) {
      handleAbort();
      return;
    }

    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      value => finish(() => resolve(value)),
      () => finish(() => reject(failure(onReject))),
    );
  });
}

function toOutgoingHeaders(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function toResponseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(key, item);
      }
    } else {
      result.set(key, value);
    }
  }

  // The body is buffered here, so the original transfer framing no longer
  // describes it.
  for (const framing of ["transfer-encoding", "connection", "keep-alive", "upgrade"]) {
    result.delete(framing);
  }

  return result;
}

export function createSafeInstanceFetch(options: SafeInstanceFetchOptions = {}): typeof fetch {
  const lookupImpl = options.lookup ?? defaultLookup;
  const requestImpl: SafeInstanceRequest =
    options.request ?? ((requestOptions, onResponse) => httpsRequest(requestOptions, onResponse));

  const safeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let plan: RequestPlan;

    try {
      plan = buildRequestPlan(input, init);
    } catch (error) {
      throw staticError(error, "invalid_request");
    }

    try {
      return await executeRequest(plan, lookupImpl, requestImpl);
    } catch (error) {
      throw staticError(error, "request_failed");
    }
  };

  return safeFetch as typeof fetch;
}

async function executeRequest(
  plan: RequestPlan,
  lookupImpl: (hostname: string) => Promise<readonly SafeInstanceAddress[]>,
  requestImpl: SafeInstanceRequest,
): Promise<Response> {
  const internal = new AbortController();
  let timedOut = false;
  let callerAborted = false;

  const callerSignal = plan.signal;
  const onCallerAbort = (): void => {
    callerAborted = true;
    internal.abort();
  };

  if (callerSignal !== null) {
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    internal.abort();
  }, SAFE_INSTANCE_TOTAL_TIMEOUT_MS);

  const abortFailure = (): SafeInstanceTransportError =>
    failure(timedOut ? "timeout" : callerAborted ? "aborted" : "request_failed");

  try {
    const resolved = await raceWithSignal(
      lookupImpl(plan.hostname),
      internal.signal,
      abortFailure,
      "dns_resolution_failed",
    );

    const addresses = Array.isArray(resolved)
      ? resolved.map(normalizeResolvedAddress)
      : [];

    if (addresses.length === 0 || addresses.some(entry => entry === null)) {
      throw failure("dns_resolution_failed");
    }

    // Any non-public answer fails the request: a split-horizon or multi-record
    // response must not be able to smuggle an internal destination in.
    if (addresses.some(entry => !isPublicAddress(entry!.address, entry!.family))) {
      throw failure("non_public_address");
    }

    const chosen = addresses[0]!;

    const requestOptions: RequestOptions & { autoSelectFamily?: boolean } = {
      protocol: "https:",
      hostname: plan.hostname,
      port: 443,
      path: plan.path,
      method: plan.method,
      headers: toOutgoingHeaders(plan.headers),
      agent: false,
      servername: plan.hostname,
      rejectUnauthorized: true,
      autoSelectFamily: false,
      lookup: pinnedLookup(chosen),
    };

    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      let settled = false;
      let handle: SafeInstanceRequestHandle | null = null;

      const finish = (action: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        internal.signal.removeEventListener("abort", handleAbort);
        action();
      };

      const handleAbort = (): void => {
        handle?.destroy();
        finish(() => reject(abortFailure()));
      };

      internal.signal.addEventListener("abort", handleAbort, { once: true });

      try {
        if (internal.signal.aborted) {
          handleAbort();
          return;
        }

        handle = requestImpl(requestOptions, incoming => finish(() => resolve(incoming)));
        handle.on("error", () => finish(() => reject(failure("request_failed"))));

        if (internal.signal.aborted) {
          handleAbort();
          return;
        }

        if (plan.body === null) {
          handle.end();
        } else {
          handle.end(plan.body);
        }
      } catch {
        handle?.destroy();
        finish(() => reject(failure("request_failed")));
      }
    });

    const status = response.statusCode ?? 0;

    if (status >= 300 && status < 400) {
      response.destroy();
      throw failure("redirect_not_allowed");
    }

    // A missing or impossible status is left conservative: the provider sees a
    // distinct unknown-status error instead of a fabricated 502.
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      response.destroy();
      throw failure("unknown_response_status");
    }

    const chunks: Buffer[] = [];
    let total = 0;

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = (action: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        internal.signal.removeEventListener("abort", handleAbort);
        action();
      };

      const handleAbort = (): void => {
        response.destroy();
        finish(() => reject(abortFailure()));
      };

      const handleData = (chunk: Buffer | string): void => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        total += bytes.byteLength;

        if (total > SAFE_INSTANCE_MAX_RESPONSE_BYTES) {
          response.destroy();
          finish(() => reject(failure("response_too_large")));
          return;
        }

        chunks.push(bytes);
      };

      response.on("data", handleData);
      response.on("end", () => finish(() => resolve()));
      response.on("error", () => finish(() => reject(failure("response_failed"))));
      response.on("aborted", () => finish(() => reject(failure("response_failed"))));
      internal.signal.addEventListener("abort", handleAbort, { once: true });

      if (internal.signal.aborted) {
        handleAbort();
      }
    });

    const nullBody = status === 204 || status === 205;

    return new Response(nullBody ? null : Buffer.concat(chunks), {
      status,
      statusText: response.statusMessage ?? "",
      headers: toResponseHeaders(response.headers),
    });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
