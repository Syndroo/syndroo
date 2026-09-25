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

import {
  DEFAULT_TIMEOUT_MS,
  LocalTransportError,
  createDeadline,
  readRetryHint,
  requestBounded,
  type Deadline,
  type RetryHint,
} from "./local-transport.js";

/** The only production destination a local Threads credential may reach. */
const API_ORIGIN = "https://graph.threads.net";
const IDENTITY_PATH = "/me?fields=id";
const PUBLISH_PATH = "/me/threads";
const PAYLOAD_VERSION = 1;

/**
 * Threads limits a text post to 500 characters, and counts emoji as their
 * UTF-8 byte length. Both budgets are enforced.
 */
const MAX_CODE_POINTS = 500;
const MAX_EMOJI_UNITS = 500;

const THREADS_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "media_type",
  "text",
  "auto_publish_text",
]);

/** Graph API error codes that mean the credential was refused. */
const AUTH_CODES: ReadonlySet<number> = new Set([102, 190]);
const PERMISSION_CODES: ReadonlySet<number> = new Set([3, 10]);
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 341, 368]);
const CONTENT_CODES: ReadonlySet<number> = new Set([506, 1_609_005]);

const EMOJI_GRAPHEME =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u20E3/u;

/**
 * Built on first use. This module is re-exported from the package barrel and
 * therefore evaluated by the legacy remote Worker bundle, so module load must
 * not initialize local-only behavior.
 */
let graphemeSegmenter: Intl.Segmenter | null = null;

export interface ThreadsLocalProviderOptions {
  /** Test-only transport seam. Production callers must omit this. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

interface GraphErrorEvidence {
  readonly code: number | null;
}

/**
 * Local Threads provider.
 *
 * The constructor performs no network work. Identity is only read inside
 * `verifyIdentity` and `prepare`; `publish` sends exactly one auto-publishing
 * text request and never retries or follows a redirect.
 */
export class ThreadsLocalProvider implements LocalProvider {
  readonly provider = "threads" as const;

  private readonly transport: typeof fetch | undefined;
  private readonly timeoutMs: number;

  constructor(options: ThreadsLocalProviderOptions = {}) {
    this.transport = options.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  describe(): LocalProviderDescription {
    return {
      provider: "threads",
      maturity: "fixture-tested",
      localPublish: true,
      unavailableReason: null,
    };
  }

  freeze(
    content: string,
    createdAt: string,
  ): { payloadVersion: number; payload: Readonly<Record<string, unknown>> } {
    assertThreadsContent(content);

    if (typeof createdAt !== "string" || createdAt.length === 0) {
      throw new LocalProviderError("INVALID_CONTENT");
    }

    return {
      payloadVersion: PAYLOAD_VERSION,
      payload: {
        media_type: "TEXT",
        text: content,
        auto_publish_text: true,
      },
    };
  }

  async verifyIdentity(
    credentials: LocalCredentials,
    signal: AbortSignal,
  ): Promise<{ targetId: string }> {
    const accessToken = readAccessToken(credentials);
    const targetId = await this.fetchIdentity(accessToken, signal);

    return { targetId };
  }

  async prepare(
    credentials: LocalCredentials,
    target: TargetBinding,
    signal: AbortSignal,
  ): Promise<PreparedTarget> {
    if (target.provider !== "threads") {
      throw new LocalProviderError("ACCOUNT_MISMATCH");
    }

    const accessToken = readAccessToken(credentials);
    const targetId = await this.fetchIdentity(accessToken, signal);

    if (targetId !== target.targetId) {
      throw new LocalProviderError("ACCOUNT_MISMATCH");
    }

    // Snapshot the binding and the credential so nothing is re-read later.
    const frozenTarget = freezeTarget(target);
    const frozenToken = accessToken;

    return {
      target: frozenTarget,
      publish: (delivery, publishSignal) =>
        this.publishPost(frozenToken, frozenTarget, delivery, publishSignal),
    };
  }

  private async fetchIdentity(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) {
      throw new LocalProviderError("ABORTED");
    }

    const deadline = createDeadline(signal, this.timeoutMs);

    try {
      const response = await requestBounded(
        this.transport ?? globalThis.fetch,
        `${API_ORIGIN}${IDENTITY_PATH}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${accessToken}` },
        },
        deadline.signal,
      );

      if (response.status >= 200 && response.status < 300) {
        if (hasErrorEnvelope(response.body)) {
          throw new LocalProviderError("PROVIDER_UNAVAILABLE");
        }

        const id = readNumericId(response.body);

        if (id === null) {
          throw new LocalProviderError("PROVIDER_UNAVAILABLE");
        }

        return id;
      }

      throw new LocalProviderError(
        classifyAdmissionFailure(response.status, response.body),
      );
    } catch (error) {
      throw admissionFailure(error, signal);
    } finally {
      deadline.cleanup();
    }
  }

  private async publishPost(
    accessToken: string,
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

    try {
      const body = new URLSearchParams({
        media_type: "TEXT",
        text: check.text,
        auto_publish_text: "true",
      });

      dispatched = true;

      const response = await requestBounded(
        this.transport ?? globalThis.fetch,
        `${API_ORIGIN}${PUBLISH_PATH}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        },
        deadline.signal,
      );

      return classifyResponse(response);
    } catch (error) {
      if (!dispatched) {
        return failedOutcome("REQUEST_NOT_SENT", false, null);
      }

      return transportOutcome(error, signal, deadline);
    } finally {
      deadline.cleanup();
    }
  }
}

function readAccessToken(credentials: LocalCredentials): string {
  if (credentials.provider !== "threads") {
    throw new LocalProviderError("AUTH");
  }

  const { accessToken } = credentials;

  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new LocalProviderError("AUTH");
  }

  return accessToken;
}

function freezeTarget(target: TargetBinding): TargetBinding {
  return {
    provider: target.provider,
    targetId: target.targetId,
    connectionId: target.connectionId,
    bindingRevision: target.bindingRevision,
  };
}

/**
 * Enforces both Threads budgets: 500 Unicode code points, and 500
 * emoji-weighted units where a grapheme containing an emoji code point costs
 * its UTF-8 byte length and every other grapheme costs its code point count.
 * Grapheme clustering keeps ZWJ sequences, flags, and keycaps as one unit.
 */
function assertThreadsContent(content: unknown): asserts content is string {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new LocalProviderError("INVALID_CONTENT");
  }

  if ([...content].length > MAX_CODE_POINTS) {
    throw new LocalProviderError("INVALID_CONTENT");
  }

  if (emojiWeightedUnits(content) > MAX_EMOJI_UNITS) {
    throw new LocalProviderError("INVALID_CONTENT");
  }
}

function emojiWeightedUnits(content: string): number {
  const segmenter =
    graphemeSegmenter ??
    (graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" }));
  const encoder = new TextEncoder();
  let units = 0;

  for (const { segment } of segmenter.segment(content)) {
    units += EMOJI_GRAPHEME.test(segment)
      ? encoder.encode(segment).byteLength
      : [...segment].length;
  }

  return units;
}

type DeliveryCheck =
  | { readonly text: string }
  | { readonly code: string };

/**
 * Revalidates the frozen payload at publish time. Text is never regenerated;
 * anything unexpected fails closed before a request is made.
 */
function checkDelivery(
  delivery: FrozenDelivery,
  target: TargetBinding,
): DeliveryCheck {
  if (delivery.payloadVersion !== PAYLOAD_VERSION) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  if (
    delivery.target.provider !== "threads" ||
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
    if (!THREADS_PAYLOAD_KEYS.has(key)) {
      return { code: "PAYLOAD_MISMATCH" };
    }
  }

  if (payload.media_type !== "TEXT" || payload.auto_publish_text !== true) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  const text = payload.text;

  if (typeof text !== "string" || text !== delivery.content) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  try {
    assertThreadsContent(text);
  } catch {
    return { code: "INVALID_CONTENT" };
  }

  return { text };
}

function classifyResponse(response: {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfter: string | null;
}): ProviderOutcome {
  const { status } = response;

  if (status >= 200 && status < 300) {
    // A success status that also carries an error object is contradictory
    // evidence: the id alone is not enough to claim the post was published.
    if (hasErrorEnvelope(response.body)) {
      return unknownOutcome("UNRECOGNIZED_RESPONSE");
    }

    const id = readNumericId(response.body);

    return id === null
      ? unknownOutcome("UNRECOGNIZED_RESPONSE")
      : { kind: "succeeded", remoteId: id, url: null };
  }

  if (status < 400 || status >= 500) {
    return unknownOutcome("UNRECOGNIZED_RESPONSE");
  }

  return classifyRejection(response) ?? unknownOutcome("UNRECOGNIZED_RESPONSE");
}

function classifyRejection(response: {
  readonly body: unknown;
  readonly retryAfter: string | null;
}): ProviderOutcome | null {
  const evidence = readGraphError(response.body);

  if (evidence === null) {
    return null;
  }

  // A Graph permission denial reuses `OAuthException`, so permission evidence
  // is decided before any auth evidence.
  if (isPermissionEvidence(evidence)) {
    return failedOutcome("PERMISSION", false, null);
  }

  if (evidence.code !== null && RATE_LIMIT_CODES.has(evidence.code)) {
    return rateLimitOutcome(readRetryHint(response.retryAfter));
  }

  if (evidence.code !== null && CONTENT_CODES.has(evidence.code)) {
    return failedOutcome("INVALID_CONTENT", false, null);
  }

  if (isAuthEvidence(evidence)) {
    return failedOutcome("AUTH", true, null);
  }

  return null;
}

function classifyAdmissionFailure(
  status: number,
  body: unknown,
): "AUTH" | "PROVIDER_UNAVAILABLE" {
  if (status === 401 || status === 403) {
    return "AUTH";
  }

  const evidence = readGraphError(body);

  return evidence !== null && isAuthEvidence(evidence)
    ? "AUTH"
    : "PROVIDER_UNAVAILABLE";
}

/**
 * Only the explicit Graph auth codes count. Neither `OAuthException` nor a
 * documented auth subcode may classify a body on its own: the type is also
 * used for permission denials, and a subcode must never override a top-level
 * code that is missing or unrecognized.
 */
function isAuthEvidence(evidence: GraphErrorEvidence): boolean {
  return evidence.code !== null && AUTH_CODES.has(evidence.code);
}

function isPermissionEvidence(evidence: GraphErrorEvidence): boolean {
  if (evidence.code === null) {
    return false;
  }

  return (
    PERMISSION_CODES.has(evidence.code) ||
    (evidence.code >= 200 && evidence.code <= 299)
  );
}

function rateLimitOutcome(hint: RetryHint): ProviderOutcome {
  if (hint.kind === "unsafe") {
    return failedOutcome("RATE_LIMIT", false, null);
  }

  return hint.kind === "at"
    ? failedOutcome("RATE_LIMIT", true, hint.retryNotBefore)
    : failedOutcome("RATE_LIMIT", true, null);
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

  return new LocalProviderError("PROVIDER_UNAVAILABLE");
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

function readGraphError(body: unknown): GraphErrorEvidence | null {
  if (!isRecord(body)) {
    return null;
  }

  const error = body.error;

  if (!isRecord(error)) {
    return null;
  }

  const code =
    typeof error.code === "number" && Number.isFinite(error.code)
      ? error.code
      : null;
  // `type` is deliberately not evidence: Graph reuses `OAuthException` for
  // permanent permission denials, so only the top-level code classifies.
  // `error_subcode` is likewise ignored so it can never override that code.
  return code === null ? null : { code };
}

function readNumericId(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }

  const id = body.id;

  if (typeof id !== "string" || !/^[0-9]{1,64}$/.test(id)) {
    return null;
  }

  return Number(id) > 0 ? id : null;
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
