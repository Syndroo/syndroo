import { Agent } from "@atproto/api";

import {
  LocalProviderError,
  type FrozenDelivery,
  type LocalCredentials,
  type LocalProvider,
  type LocalProviderDescription,
  type PreparedTarget,
  type ProviderOutcome,
  type TargetBinding,
} from "@syndroo/core";

import { createLinkFacets } from "./facets.js";
import {
  DEFAULT_TIMEOUT_MS,
  LocalTransportError,
  createDeadline,
  readRetryHint,
  requestBounded,
  type Deadline,
  type RetryHint,
} from "./local-transport.js";

/** The only production destination a local Bluesky credential may reach. */
const TRUSTED_HOST = "bsky.social";
const XRPC_ORIGIN = "https://bsky.social";
const COLLECTION = "app.bsky.feed.post";
const PAYLOAD_VERSION = 1;
const MAX_CODE_POINTS = 300;
const MAX_BYTES = 3_000;

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const AT_URI_PATTERN =
  /^at:\/\/(did:[a-z0-9]+:[A-Za-z0-9._:%-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._~:-]{1,512})$/;
const CID_PATTERN = /^\S{1,512}$/;

const BLUESKY_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "$type",
  "text",
  "createdAt",
  "facets",
]);

/** XRPC error names that mean the credential, not the content, was refused. */
const AUTH_ERROR_NAMES: ReadonlySet<string> = new Set([
  "AuthMissing",
  "InvalidToken",
  "ExpiredToken",
  "AuthenticationRequired",
  "AccountTakedown",
  "AuthFactorTokenRequired",
]);

export interface BlueskyLocalProviderOptions {
  /** Test-only transport seam. Production callers must omit this. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

interface BlueskyAuth {
  readonly identifier: string;
  readonly password: string;
}

interface BlueskySession {
  readonly did: string;
  readonly accessJwt: string;
}

class XrpcRejection extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly retryAfter: string | null,
  ) {
    super("xrpc rejection");
    this.name = "XrpcRejection";
  }
}

/**
 * Local Bluesky provider.
 *
 * The constructor performs no network work. Identity and session lookups only
 * happen inside `verifyIdentity` and `prepare`; `publish` sends exactly one
 * content record and never retries, refreshes, or follows a redirect.
 */
export class BlueskyLocalProvider implements LocalProvider {
  readonly provider = "bluesky" as const;

  private readonly transport: typeof fetch | undefined;
  private readonly timeoutMs: number;

  constructor(options: BlueskyLocalProviderOptions = {}) {
    this.transport = options.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  describe(): LocalProviderDescription {
    return {
      provider: "bluesky",
      maturity: "fixture-tested",
      localPublish: true,
      unavailableReason: null,
    };
  }

  freeze(
    content: string,
    createdAt: string,
  ): { payloadVersion: number; payload: Readonly<Record<string, unknown>> } {
    assertBlueskyContent(content);

    if (typeof createdAt !== "string" || createdAt.length === 0) {
      throw new LocalProviderError("INVALID_CONTENT");
    }

    const facets = createLinkFacets(content);

    return {
      payloadVersion: PAYLOAD_VERSION,
      payload: {
        $type: COLLECTION,
        text: content,
        createdAt,
        ...(facets.length > 0 ? { facets } : {}),
      },
    };
  }

  async verifyIdentity(
    credentials: LocalCredentials,
    signal: AbortSignal,
  ): Promise<{ targetId: string }> {
    const auth = readBlueskyCredentials(credentials);
    const session = await this.createSession(auth, signal);

    return { targetId: session.did };
  }

  async prepare(
    credentials: LocalCredentials,
    target: TargetBinding,
    signal: AbortSignal,
  ): Promise<PreparedTarget> {
    if (target.provider !== "bluesky") {
      throw new LocalProviderError("ACCOUNT_MISMATCH");
    }

    const auth = readBlueskyCredentials(credentials);
    const session = await this.createSession(auth, signal);

    if (session.did !== target.targetId) {
      throw new LocalProviderError("ACCOUNT_MISMATCH");
    }

    // Snapshot the binding and the session so nothing is re-read later.
    const frozenTarget = freezeTarget(target);
    const frozenSession: BlueskySession = {
      did: session.did,
      accessJwt: session.accessJwt,
    };

    return {
      target: frozenTarget,
      publish: (delivery, publishSignal) =>
        this.publishRecord(frozenSession, frozenTarget, delivery, publishSignal),
    };
  }

  private async createSession(
    auth: BlueskyAuth,
    signal: AbortSignal,
  ): Promise<BlueskySession> {
    if (signal.aborted) {
      throw new LocalProviderError("ABORTED");
    }

    const deadline = createDeadline(signal, this.timeoutMs);
    let rejection: unknown;

    try {
      const agent = new Agent(async (path, init) => {
        const url = xrpcUrl(path);

        try {
          return await this.xrpc(url, init, deadline.signal);
        } catch (error) {
          rejection = error;
          throw error;
        }
      });
      const result = await agent.com.atproto.server.createSession({
        identifier: auth.identifier,
        password: auth.password,
      });
      const data = result.data as { did?: unknown; accessJwt?: unknown };
      const did = typeof data?.did === "string" ? data.did : null;
      const accessJwt =
        typeof data?.accessJwt === "string" && data.accessJwt.length > 0
          ? data.accessJwt
          : null;

      if (did === null || !DID_PATTERN.test(did) || accessJwt === null) {
        throw new LocalProviderError("PROVIDER_UNAVAILABLE");
      }

      return { did, accessJwt };
    } catch (error) {
      throw admissionFailure(rejection ?? error, signal);
    } finally {
      deadline.cleanup();
    }
  }

  private async publishRecord(
    session: BlueskySession,
    target: TargetBinding,
    delivery: FrozenDelivery,
    signal: AbortSignal,
  ): Promise<ProviderOutcome> {
    const check = checkDelivery(delivery, target);

    if ("code" in check) {
      return failedOutcome(check.code, false, null);
    }

    if (signal.aborted) {
      return failedOutcome("ABORTED", false, null);
    }

    const deadline = createDeadline(signal, this.timeoutMs);
    let dispatched = false;
    let rejection: unknown;

    try {
      const agent = new Agent(async (path, init) => {
        const url = xrpcUrl(path);

        dispatched = true;

        try {
          return await this.xrpc(url, init, deadline.signal);
        } catch (error) {
          rejection = error;
          throw error;
        }
      });
      const result = await agent.com.atproto.repo.createRecord(
        {
          repo: session.did,
          collection: COLLECTION,
          record: { ...check.record },
        },
        { headers: { authorization: `Bearer ${session.accessJwt}` } },
      );
      const data = result.data as { uri?: unknown; cid?: unknown };
      const cid =
        typeof data?.cid === "string" && CID_PATTERN.test(data.cid)
          ? data.cid
          : null;
      const uri = typeof data?.uri === "string" ? data.uri : null;
      const match = uri === null ? null : AT_URI_PATTERN.exec(uri);

      if (cid === null || uri === null || match === null) {
        return unknownOutcome("UNRECOGNIZED_RESPONSE");
      }

      const [, uriDid, recordKey] = match;

      if (uriDid !== session.did || recordKey === undefined) {
        return unknownOutcome("UNRECOGNIZED_RESPONSE");
      }

      return {
        kind: "succeeded",
        // The AT URI locates the record; the CID is only a content digest.
        remoteId: uri,
        url: `https://bsky.app/profile/${encodeURIComponent(session.did)}/post/${encodeURIComponent(recordKey)}`,
      };
    } catch (error) {
      const cause = rejection ?? error;

      if (cause instanceof XrpcRejection) {
        return classifyXrpcRejection(cause);
      }

      if (!dispatched) {
        return failedOutcome("REQUEST_NOT_SENT", false, null);
      }

      return transportOutcome(cause, signal, deadline);
    } finally {
      deadline.cleanup();
    }
  }

  private async xrpc(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    const response = await requestBounded(
      this.transport ?? globalThis.fetch,
      url,
      init,
      signal,
    );

    if (response.status < 200 || response.status >= 300) {
      throw new XrpcRejection(response.status, response.body, response.retryAfter);
    }

    // A success status that also carries an error object is contradictory
    // evidence; the record fields alone cannot prove the write succeeded.
    if (hasErrorEnvelope(response.body)) {
      throw new XrpcRejection(response.status, response.body, response.retryAfter);
    }

    return Response.json(response.body ?? null, { status: 200 });
  }
}

/**
 * The SDK hands back a path, not an absolute URL. The origin is re-checked here
 * so a normalized or absolute path can never move the Authorization header to
 * another host.
 */
function xrpcUrl(path: string): string {
  const url = new URL(`${XRPC_ORIGIN}${path}`);

  if (!path.startsWith("/") || url.origin !== XRPC_ORIGIN) {
    throw new Error("refused an xrpc path outside the trusted origin");
  }

  return url.href;
}

function readBlueskyCredentials(credentials: LocalCredentials): BlueskyAuth {
  if (credentials.provider !== "bluesky") {
    throw new LocalProviderError("AUTH");
  }

  const { identifier, password, host } = credentials;

  if (
    typeof identifier !== "string" ||
    identifier.trim().length === 0 ||
    typeof password !== "string" ||
    password.trim().length === 0
  ) {
    throw new LocalProviderError("AUTH");
  }

  assertTrustedHost(host);

  return { identifier, password };
}

/**
 * The host credential must be exactly `bsky.social` (case-normalized). Any
 * scheme, port, path, or userinfo is rejected before a socket is opened.
 */
function assertTrustedHost(host: unknown): void {
  if (typeof host !== "string" || host.trim().toLowerCase() !== TRUSTED_HOST) {
    throw new LocalProviderError("AUTH");
  }
}

function freezeTarget(target: TargetBinding): TargetBinding {
  return {
    provider: target.provider,
    targetId: target.targetId,
    connectionId: target.connectionId,
    bindingRevision: target.bindingRevision,
  };
}

function assertBlueskyContent(content: unknown): asserts content is string {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new LocalProviderError("INVALID_CONTENT");
  }

  if ([...content].length > MAX_CODE_POINTS) {
    throw new LocalProviderError("INVALID_CONTENT");
  }

  if (new TextEncoder().encode(content).byteLength > MAX_BYTES) {
    throw new LocalProviderError("INVALID_CONTENT");
  }
}

type DeliveryCheck =
  | { readonly record: Readonly<Record<string, unknown>> }
  | { readonly code: string };

/**
 * Revalidates the frozen payload at publish time. Timestamps and text are never
 * regenerated; anything unexpected fails closed before a request is made.
 */
function checkDelivery(
  delivery: FrozenDelivery,
  target: TargetBinding,
): DeliveryCheck {
  if (delivery.payloadVersion !== PAYLOAD_VERSION) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  if (
    delivery.target.provider !== "bluesky" ||
    delivery.target.targetId !== target.targetId ||
    delivery.target.connectionId !== target.connectionId ||
    delivery.target.bindingRevision !== target.bindingRevision
  ) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  const payload = delivery.payload;

  if (!isRecord(payload)) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  for (const key of Object.keys(payload)) {
    if (!BLUESKY_PAYLOAD_KEYS.has(key)) {
      return { code: "PAYLOAD_MISMATCH" };
    }
  }

  if (payload.$type !== COLLECTION) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  const text = payload.text;

  if (typeof text !== "string" || text !== delivery.content) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  const createdAt = payload.createdAt;

  if (typeof createdAt !== "string" || createdAt.length === 0) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  if ("facets" in payload && !Array.isArray(payload.facets)) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  try {
    assertBlueskyContent(text);
  } catch {
    return { code: "INVALID_CONTENT" };
  }

  return { record: payload };
}

function admissionFailure(
  error: unknown,
  signal: AbortSignal,
): LocalProviderError {
  if (error instanceof LocalProviderError) {
    return error;
  }

  if (signal.aborted) {
    return new LocalProviderError("ABORTED");
  }

  if (error instanceof XrpcRejection) {
    const name = readXrpcError(error.body);

    if (name !== null && AUTH_ERROR_NAMES.has(name)) {
      return new LocalProviderError("AUTH");
    }

    if (error.status === 400 && name === "InvalidRequest") {
      return new LocalProviderError("AUTH");
    }

    if (error.status === 401 || error.status === 403) {
      return new LocalProviderError("AUTH");
    }
  }

  return new LocalProviderError("PROVIDER_UNAVAILABLE");
}

function classifyXrpcRejection(rejection: XrpcRejection): ProviderOutcome {
  const { status } = rejection;

  if (status < 400 || status >= 500) {
    return unknownOutcome("UNRECOGNIZED_RESPONSE");
  }

  const name = readXrpcError(rejection.body);

  if (name === null) {
    return unknownOutcome("UNRECOGNIZED_RESPONSE");
  }

  if (AUTH_ERROR_NAMES.has(name)) {
    return failedOutcome("AUTH", true, null);
  }

  if (name === "RateLimitExceeded") {
    return rateLimitOutcome(readRetryHint(rejection.retryAfter));
  }

  if (name === "InvalidRequest") {
    return failedOutcome("INVALID_CONTENT", false, null);
  }

  return unknownOutcome("UNRECOGNIZED_RESPONSE");
}

function rateLimitOutcome(hint: RetryHint): ProviderOutcome {
  if (hint.kind === "unsafe") {
    return failedOutcome("RATE_LIMIT", false, null);
  }

  return hint.kind === "at"
    ? failedOutcome("RATE_LIMIT", true, hint.retryNotBefore)
    : failedOutcome("RATE_LIMIT", true, null);
}

function transportOutcome(
  error: unknown,
  signal: AbortSignal,
  deadline: Deadline,
): ProviderOutcome {
  if (signal.aborted) {
    return unknownOutcome("ABORTED");
  }

  if (deadline.timedOut()) {
    return unknownOutcome("TIMEOUT");
  }

  if (error instanceof LocalTransportError) {
    return unknownOutcome("UNRECOGNIZED_RESPONSE");
  }

  if (error instanceof TypeError) {
    return unknownOutcome("NETWORK");
  }

  return unknownOutcome("UNRECOGNIZED_RESPONSE");
}

function readXrpcError(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }

  const error = body.error;

  return typeof error === "string" && error.length > 0 && error.length <= 64
    ? error
    : null;
}

function hasErrorEnvelope(value: unknown): boolean {
  return isRecord(value) && "error" in value;
}

function failedOutcome(
  code: string,
  retryable: boolean,
  retryNotBefore: string | null,
): ProviderOutcome {
  return {
    kind: "failed",
    code,
    writeDisposition: "not_applied",
    retryable,
    retryNotBefore,
  };
}

function unknownOutcome(code: string): ProviderOutcome {
  return { kind: "unknown", code, writeDisposition: "unknown" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
