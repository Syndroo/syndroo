import { Agent } from "@atproto/api";

import {
  PublishError,
  type PlatformAdapter,
  type Publisher,
  type PublishRequest,
  type PublishResult,
} from "@syndroo/core";
import {
  TransportError,
  boundedRequest,
  parseRetryAfter,
  type TransportRequest,
} from "@syndroo/transport";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_POST_BYTES = 3_000;
const MAX_POST_CODE_POINTS = 300;
const DEFAULT_HOST = "bsky.social";

export interface BlueskyPublisherOptions {
  identifier: string;
  password: string;
  host: string;
  timeoutMs?: number;
}

/** Exact typed credential the Bluesky publisher needs. */
export interface BlueskyCredential {
  readonly identifier: string;
  readonly password: string;
  readonly host: string;
}

interface BlueskyFacet {
  index: {
    byteStart: number;
    byteEnd: number;
  };
  features: Array<{
    $type: "app.bsky.richtext.facet#link";
    uri: string;
  }>;
}

type BlueskyStage = "session" | "publish";

const PRIVATE_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];
const PRIVATE_IPV4_PREFIXES = [
  "0.",
  "10.",
  "127.",
  "169.254.",
  "192.168.",
  "172.16.",
  "172.17.",
  "172.18.",
  "172.19.",
  "172.20.",
  "172.21.",
  "172.22.",
  "172.23.",
  "172.24.",
  "172.25.",
  "172.26.",
  "172.27.",
  "172.28.",
  "172.29.",
  "172.30.",
  "172.31.",
];

/**
 * Validates the operator-supplied Bluesky host.
 *
 * Only a normalized HTTPS hostname is accepted: no protocol, path, query,
 * fragment, userinfo, or non-443 port, and no default private, loopback, or
 * link-local literal. String validation alone does not defeat DNS rebinding;
 * this rejects the unintended defaults, it does not claim to prove identity.
 */
export function validateBlueskyHost(host: string): string {
  if (typeof host !== "string" || host.trim() === "") {
    throw new TypeError("Bluesky host is required");
  }

  const value = host.trim();

  if (/[/@?#]/.test(value)) {
    throw new TypeError("Bluesky host must be a hostname without protocol or path");
  }

  let url: URL;

  try {
    url = new URL(`https://${value}`);
  } catch {
    throw new TypeError("Invalid Bluesky host");
  }

  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("Invalid Bluesky host");
  }

  if (url.port !== "" && url.port !== "443") {
    throw new TypeError("Bluesky host must use the default HTTPS port");
  }

  const hostname = url.hostname.toLowerCase();

  if (isPrivateHostname(hostname)) {
    throw new TypeError("Bluesky host must not be a private or loopback address");
  }

  return `https://${hostname}`;
}

function isPrivateHostname(hostname: string): boolean {
  // A trailing dot is the same name; URL normalisation also folds alternative
  // IPv4 notations (127.1, 0x7f000001, 0177.0.0.1) into dotted-quad form.
  const bare = (hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname
  )
    .toLowerCase()
    .replace(/\.$/, "");

  if (bare === "localhost" || bare === "::" || bare === "::1") {
    return true;
  }

  // IPv4-mapped and compressed IPv6 forms that carry an IPv4 address
  // (::ffff:127.0.0.1, ::ffff:c0a8:101, ::127.0.0.1).
  const embedded = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare)?.[1];

  if (embedded !== undefined && isPrivateIpv4(embedded)) {
    return true;
  }

  // URL normalisation rewrites ::ffff:127.0.0.1 as ::ffff:7f00:1, so the hex
  // form must be decoded back to dotted-quad before the private check.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);

  if (mapped !== null && mapped[1] !== undefined && mapped[2] !== undefined) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    const dotted = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

    if (isPrivateIpv4(dotted)) {
      return true;
    }
  }

  if (PRIVATE_HOST_SUFFIXES.some(suffix => bare.endsWith(suffix))) {
    return true;
  }

  if (isPrivateIpv4(bare)) {
    return true;
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  return /^f[cd][0-9a-f]{2}:/.test(bare) || /^fe[89ab][0-9a-f]:/.test(bare);
}

function isPrivateIpv4(value: string): boolean {
  return PRIVATE_IPV4_PREFIXES.some(prefix => value.startsWith(prefix));
}

/**
 * Typed decoder for a Bluesky credential record.
 *
 * The host falls back to the documented default service, never to another
 * account's credential; identifier and password must both be present.
 */
export function decodeBlueskyCredential(input: unknown): BlueskyCredential {
  const record = asRecord(input);
  const identifier = readString(record, "identifier");
  const password = readString(record, "password");
  const host = readString(record, "host") ?? DEFAULT_HOST;

  if (!identifier || !password) {
    throw new PublishError(
      "Bluesky credential is incomplete (identifier, password)",
      "AUTH",
    );
  }

  return { identifier, password, host: validatedHostname(host) };
}

/** The credential keeps a bare hostname; the publisher builds the HTTPS origin. */
function validatedHostname(host: string): string {
  return validateBlueskyHost(host).replace("https://", "");
}

/** Pure construction: no network, no credential resolution, no side effects. */
export function buildBlueskyPublisher(
  credential: BlueskyCredential,
  config: Pick<BlueskyPublisherOptions, "timeoutMs"> = {},
): BlueskyPublisher {
  return new BlueskyPublisher({ ...config, ...credential });
}

class BlueskyRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly stage: BlueskyStage,
    readonly retryAfter: string | null,
  ) {
    super(message);
    this.name = "BlueskyRequestError";
  }
}

export class BlueskyPublisher implements Publisher {
  readonly name = "bluesky-native";

  private readonly identifier: string;
  private readonly password: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: BlueskyPublisherOptions) {
    if (!options.identifier || !options.password) {
      throw new TypeError("Bluesky identifier and password are required");
    }

    this.identifier = options.identifier;
    this.password = options.password;
    this.baseUrl = validateBlueskyHost(options.host);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    if (request.platform !== "bluesky") {
      throw new PublishError(
        `Bluesky publisher does not support platform: ${request.platform}`,
        "INVALID_CONTENT",
      );
    }

    if (!request.content) {
      throw new PublishError("Bluesky content must not be empty", "INVALID_CONTENT");
    }

    if (
      new TextEncoder().encode(request.content).byteLength > MAX_POST_BYTES ||
      [...request.content].length > MAX_POST_CODE_POINTS
    ) {
      throw new PublishError("Bluesky content exceeds post limits", "INVALID_CONTENT");
    }

    let stage: BlueskyStage = "session";
    let transportError: unknown;
    // A fresh, stateless SDK client avoids token-refresh retries of a write.
    const agent = new Agent(async (path, init) => {
      try {
        return await this.request(path, init, stage);
      } catch (error) {
        transportError = error;
        throw error;
      }
    });

    try {
      const session = (await agent.com.atproto.server.createSession({
        identifier: this.identifier,
        password: this.password,
      })).data;

      if (!session.accessJwt || !session.did) {
        throw new PublishError("Invalid Bluesky session response", "UNKNOWN");
      }

      stage = "publish";
      const facets = createLinkFacets(request.content);
      const response = (await agent.com.atproto.repo.createRecord({
        repo: session.did,
        collection: "app.bsky.feed.post",
        record: {
          $type: "app.bsky.feed.post",
          text: request.content,
          createdAt: new Date().toISOString(),
          ...(facets.length > 0 ? { facets } : {}),
        },
      }, { headers: { authorization: `Bearer ${session.accessJwt}` } })).data;
      const recordKey = response.uri.split("/").at(-1);

      if (!recordKey) {
        throw new PublishError(
          "Bluesky response did not include a record key",
          "UNKNOWN",
          true,
        );
      }

      return {
        externalId: response.cid,
        externalUrl: `https://bsky.app/profile/${encodeURIComponent(session.did)}/post/${encodeURIComponent(recordKey)}`,
      };
    } catch (error) {
      throw normalizeError(transportError ?? error, stage);
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    stage: BlueskyStage,
  ): Promise<Response> {
    let response;

    try {
      const body = transportBody(init.body, stage);
      const outbound: TransportRequest = {
        url: `${this.baseUrl}${path}`,
        method: init.method === "GET" ? "GET" : "POST",
        headers: headerRecord(init.headers),
        timeoutMs: this.timeoutMs,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        ...(body === undefined ? {} : { body }),
      };

      response = await boundedRequest(outbound);
    } catch (error) {
      throw toPublishError(error, stage);
    }

    if (response.status < 200 || response.status >= 300) {
      throw new BlueskyRequestError(
        `Bluesky request failed (HTTP ${response.status})`,
        response.status,
        stage,
        response.headers.get("retry-after"),
      );
    }

    const text = response.text();
    let body: unknown;

    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        throw new PublishError(
          "Bluesky returned invalid JSON",
          "UNKNOWN",
          stage === "publish",
        );
      }
    }

    return Response.json(body ?? null);
  }
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  return headers === undefined ? {} : Object.fromEntries(new Headers(headers));
}

function transportBody(
  body: BodyInit | null | undefined,
  stage: BlueskyStage,
): string | Uint8Array | URLSearchParams | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (
    typeof body === "string" ||
    body instanceof Uint8Array ||
    body instanceof URLSearchParams
  ) {
    return body;
  }

  throw new PublishError(
    "Bluesky request body type is not supported",
    "UNKNOWN",
    stage === "publish",
  );
}

function createLinkFacets(content: string): BlueskyFacet[] {
  const encoder = new TextEncoder();
  const facets: BlueskyFacet[] = [];
  const pattern = /https?:\/\/[^\s<>"']+/gu;

  for (const match of content.matchAll(pattern)) {
    const matchedUrl = match[0];
    const uri = matchedUrl.replace(/[.,!?;:]+$/u, "");

    if (!uri || match.index === undefined) {
      continue;
    }

    try {
      new URL(uri);
    } catch {
      continue;
    }

    const byteStart = encoder.encode(content.slice(0, match.index)).byteLength;
    facets.push({
      index: {
        byteStart,
        byteEnd: byteStart + encoder.encode(uri).byteLength,
      },
      features: [
        {
          $type: "app.bsky.richtext.facet#link",
          uri,
        },
      ],
    });
  }

  return facets;
}

function toPublishError(error: unknown, stage: BlueskyStage): PublishError {
  if (error instanceof PublishError) {
    return error;
  }

  if (error instanceof TransportError) {
    // Only the publish stage can have written a record.
    const ambiguous = stage === "publish" && error.requestDispatched;

    if (error.code === "network" || error.code === "timeout" || error.code === "aborted") {
      return new PublishError("Bluesky network failure", "NETWORK", ambiguous);
    }

    if (error.code === "response_too_large") {
      return new PublishError("Bluesky response exceeded size limit", "UNKNOWN", ambiguous);
    }

    return new PublishError("Bluesky request was not completed", "UNKNOWN", ambiguous);
  }

  return new PublishError("Invalid Bluesky SDK response", "UNKNOWN", stage === "publish");
}

function normalizeError(error: unknown, stage: BlueskyStage): PublishError {
  if (error instanceof PublishError) {
    return error;
  }

  if (!(error instanceof BlueskyRequestError)) {
    return new PublishError("Invalid Bluesky SDK response", "UNKNOWN", stage === "publish");
  }

  const ambiguous = error.stage === "publish" && error.status >= 500;

  if (error.status === 401 || error.status === 403) {
    return new PublishError(error.message, "AUTH", false);
  }

  if (error.status === 429) {
    const retryAfterAt = parseRetryAfter(error.retryAfter, { now: new Date() });
    return new PublishError(
      error.message,
      "RATE_LIMIT",
      false,
      retryAfterAt === undefined ? undefined : { retryAfterAt },
    );
  }

  if (error.status === 400 || error.status === 413 || error.status === 422) {
    return new PublishError(error.message, "INVALID_CONTENT", false);
  }

  if (error.status >= 500) {
    return new PublishError(error.message, "PROVIDER_UNAVAILABLE", ambiguous);
  }

  return new PublishError(error.message, "UNKNOWN", error.stage === "publish");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Platform adapter
// ---------------------------------------------------------------------------

export const blueskyAdapter: PlatformAdapter = {
  providerName: "bluesky-native",

  buildPublisher: (cred) => buildBlueskyPublisher(decodeBlueskyCredential(cred)),
};
