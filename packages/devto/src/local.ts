/**
 * Local DEV.to provider.
 *
 * Runtime-neutral: no Node imports. The only destination is the hardcoded
 * `https://dev.to` origin; there is no configurable Forem host or service. The
 * constructor performs no network work and only stores the injected transport.
 *
 * `prepare` reverifies the numeric account, and `publish` sends at most one
 * `POST /api/articles` built from the frozen payload. Nothing is re-read from a
 * source file, no canonical URL is fetched, and no post is searched for or
 * deduplicated.
 */

import {
  LocalProviderError,
  localDisplayName,
  type FrozenDelivery,
  type LocalContentOptions,
  type LocalCredentials,
  type LocalIdentity,
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
  foremErrorEvidence,
  readRetryHint,
  requestBounded,
  type BoundedResponse,
  type Deadline,
  type RetryHint,
} from "./local-transport.js";
import {
  DEVTO_PAYLOAD_VERSION,
  buildDevtoArticlePayload,
  devtoPayloadMatches,
  devtoTargetId,
  parseDevtoTargetId,
  readDevtoUserId,
  validateDevtoApiKey,
  validateDevtoContentOptions,
} from "./validation.js";

/** The only origin this adapter may reach. */
const ORIGIN = "https://dev.to";
const USERS_PATH = "/api/users/me";
const ARTICLES_PATH = "/api/articles";
const V1_MEDIA_TYPE = "application/vnd.forem.api-v1+json";

const MAX_URL_LENGTH = 2_048;
const URL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export interface DevtoLocalProviderOptions {
  /** Test seam; the default is the runtime's native `fetch`. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Local DEV.to provider.
 *
 * The constructor performs no network work. Identity is read only inside
 * `verifyIdentity`/`prepare`; `publish` sends exactly one article write.
 */
export class DevtoLocalProvider implements LocalProvider {
  readonly provider = "devto" as const;

  private readonly transport: typeof fetch | undefined;
  private readonly timeoutMs: number;

  constructor(options: DevtoLocalProviderOptions = {}) {
    this.transport = options.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError("DEV.to timeout must be positive");
    }
  }

  describe(): LocalProviderDescription {
    return {
      provider: "devto",
      maturity: "fixture-tested",
      localPublish: true,
      unavailableReason: null,
      contentTypes: ["article"],
      authMethods: ["api-key"],
      media: false,
      scheduling: false,
    };
  }

  freeze(
    content: string,
    createdAt: string,
    options?: LocalContentOptions,
  ): { payloadVersion: number; payload: Readonly<Record<string, unknown>> } {
    // A DEV.to target always requires an explicit article; a plain text post is
    // never promoted into one.
    if (options === undefined) {
      throw new LocalProviderError("INVALID_CONTENT");
    }

    const article = validateDevtoContentOptions(options);
    const payload = buildDevtoArticlePayload(content, article);

    if (typeof createdAt !== "string" || createdAt.length === 0) {
      throw new LocalProviderError("INVALID_CONTENT");
    }

    return { payloadVersion: DEVTO_PAYLOAD_VERSION, payload };
  }

  async verifyIdentity(
    credentials: LocalCredentials,
    signal: AbortSignal,
  ): Promise<LocalIdentity> {
    const apiKey = readApiKey(credentials);

    if (signal.aborted) {
      throw new LocalProviderError("ABORTED");
    }

    return this.fetchIdentity(apiKey, signal);
  }

  async prepare(
    credentials: LocalCredentials,
    target: TargetBinding,
    signal: AbortSignal,
    delivery?: FrozenDelivery,
  ): Promise<PreparedTarget> {
    const apiKey = readApiKey(credentials);
    const userId = parseDevtoTargetId(target.targetId);

    if (target.provider !== "devto" || userId === null) {
      throw new LocalProviderError("ACCOUNT_MISMATCH");
    }

    if (delivery === undefined) {
      throw new LocalProviderError("INVALID_CONTENT");
    }

    const identity = await this.fetchIdentity(apiKey, signal);

    if (identity.targetId !== target.targetId) {
      throw new LocalProviderError("ACCOUNT_MISMATCH");
    }

    // Snapshot the binding and the credential so nothing is re-read later.
    const frozenTarget = freezeTarget(target);
    const check = checkDelivery(delivery, frozenTarget);

    if ("code" in check) {
      throw new LocalProviderError("INVALID_CONTENT");
    }

    const frozenKey = apiKey;

    return {
      target: frozenTarget,
      publish: (frozenDelivery, publishSignal) =>
        this.publishArticle(frozenKey, frozenTarget, frozenDelivery, publishSignal),
    };
  }

  private transportFor(): typeof fetch {
    const transport = this.transport ?? globalThis.fetch;

    if (typeof transport !== "function") {
      throw new LocalProviderError("PROVIDER_UNAVAILABLE");
    }

    return transport;
  }

  private async fetchIdentity(apiKey: string, signal: AbortSignal): Promise<LocalIdentity> {
    const deadline = createDeadline(signal, this.timeoutMs);

    try {
      const response = await requestBounded(
        this.transportFor(),
        `${ORIGIN}${USERS_PATH}`,
        {
          method: "GET",
          headers: { "api-key": apiKey, accept: V1_MEDIA_TYPE },
        },
        deadline.signal,
      );

      if (response.status >= 200 && response.status < 300) {
        const body = response.body;

        if (!isRecord(body) || "error" in body || "errors" in body) {
          throw new LocalProviderError("PROVIDER_UNAVAILABLE");
        }

        const id = readDevtoUserId(body.id);

        if (id === null) {
          throw new LocalProviderError("PROVIDER_UNAVAILABLE");
        }

        const displayName = sanitizeDisplayName(body.name ?? body.username, apiKey);

        return {
          targetId: devtoTargetId(id),
          ...(displayName === undefined ? {} : { displayName }),
        };
      }

      if (response.status === 401 || response.status === 403) {
        throw new LocalProviderError("AUTH");
      }

      throw new LocalProviderError("PROVIDER_UNAVAILABLE");
    } catch (error) {
      throw admissionFailure(error, signal);
    } finally {
      deadline.cleanup();
    }
  }

  private async publishArticle(
    apiKey: string,
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
      const transport = this.transportFor();
      const body = JSON.stringify(check.payload);

      dispatched = true;

      const response = await requestBounded(
        transport,
        `${ORIGIN}${ARTICLES_PATH}`,
        {
          method: "POST",
          headers: {
            "api-key": apiKey,
            accept: V1_MEDIA_TYPE,
            "content-type": "application/json",
          },
          body,
        },
        deadline.signal,
      );

      return classifyPublishResponse(response, apiKey);
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

// ---------------------------------------------------------------------------
// Credentials, targets, and delivery checks
// ---------------------------------------------------------------------------

function readApiKey(value: LocalCredentials): string {
  if (value === null || typeof value !== "object" || value.provider !== "devto") {
    throw new LocalProviderError("AUTH");
  }

  return validateDevtoApiKey(value.apiKey);
}

function freezeTarget(target: TargetBinding): TargetBinding {
  return {
    provider: target.provider,
    targetId: target.targetId,
    connectionId: target.connectionId,
    bindingRevision: target.bindingRevision,
  };
}

type DeliveryCheck =
  | { readonly payload: Readonly<Record<string, unknown>> }
  | { readonly code: string };

/**
 * Revalidates the frozen payload and its frozen options at prepare and publish
 * time. Anything unexpected fails closed before a request is made.
 */
function checkDelivery(delivery: FrozenDelivery, target: TargetBinding): DeliveryCheck {
  if (delivery.payloadVersion !== DEVTO_PAYLOAD_VERSION) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  if (
    delivery.target.provider !== "devto" ||
    delivery.target.targetId !== target.targetId ||
    delivery.target.connectionId !== target.connectionId ||
    delivery.target.bindingRevision !== target.bindingRevision
  ) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  if (delivery.contentOptions === undefined) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  let article;

  try {
    article = validateDevtoContentOptions(delivery.contentOptions);
  } catch {
    return { code: "INVALID_CONTENT" };
  }

  let payload: Readonly<Record<string, unknown>>;

  try {
    payload = buildDevtoArticlePayload(delivery.content, article);
  } catch {
    return { code: "INVALID_CONTENT" };
  }

  if (!devtoPayloadMatches(delivery.payload, delivery.content, article)) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  return { payload };
}

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

function classifyPublishResponse(
  response: BoundedResponse,
  apiKey: string,
): ProviderOutcome {
  const { status, body } = response;

  if (status >= 200 && status < 300) {
    // A success status that also carries an error object is contradictory
    // evidence: the id alone is not enough to claim the article was created.
    if (!isRecord(body) || "error" in body || "errors" in body) {
      return unknownOutcome("UNRECOGNIZED_RESPONSE");
    }

    const id = readDevtoUserId(body.id);

    return id === null
      ? unknownOutcome("UNRECOGNIZED_RESPONSE")
      : {
          kind: "succeeded",
          remoteId: String(id),
          url: sanitizeArticleUrl(body.url, apiKey),
        };
  }

  // A definite rejection needs the documented Forem error envelope. A bare
  // status could come from a proxy or a truncated body and stays unknown.
  if (status === 401) {
    return foremErrorEvidence(body)
      ? failedOutcome("AUTH", true, null)
      : unknownOutcome("UNRECOGNIZED_RESPONSE");
  }

  if (status === 403) {
    return foremErrorEvidence(body)
      ? failedOutcome("PERMISSION", false, null)
      : unknownOutcome("UNRECOGNIZED_RESPONSE");
  }

  if (status === 400 || status === 422) {
    return foremErrorEvidence(body)
      ? failedOutcome("INVALID_CONTENT", false, null)
      : unknownOutcome("UNRECOGNIZED_RESPONSE");
  }

  if (status === 429) {
    return foremErrorEvidence(body)
      ? rateLimitOutcome(readRetryHint(response.retryAfter))
      : unknownOutcome("UNRECOGNIZED_RESPONSE");
  }

  // 3xx (redirect:"error" makes fetch reject), 5xx, and every other status.
  return unknownOutcome("UNRECOGNIZED_RESPONSE");
}

function rateLimitOutcome(hint: RetryHint): ProviderOutcome {
  if (hint.kind === "unsafe") {
    // An unrepresentable hint must never schedule an early retry.
    return failedOutcome("RATE_LIMIT", false, null);
  }

  return hint.kind === "at"
    ? failedOutcome("RATE_LIMIT", true, hint.retryNotBefore)
    : failedOutcome("RATE_LIMIT", true, null);
}

function admissionFailure(error: unknown, signal: AbortSignal): LocalProviderError {
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

/** HTTPS, no userinfo, no controls, bounded, and never echoing the API key. */
function sanitizeArticleUrl(value: unknown, apiKey: string): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_URL_LENGTH ||
    URL_CONTROL.test(value) ||
    containsCredential(value, apiKey)
  ) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return null;
  }

  return url.toString();
}

function sanitizeDisplayName(value: unknown, apiKey: string): string | undefined {
  const name = localDisplayName(value);

  return name === undefined || containsCredential(name, apiKey) ? undefined : name;
}

/**
 * True when the key appears literally or after up to three rounds of
 * percent-decoding, so a credential-encoded value is never echoed back.
 */
function containsCredential(value: string, apiKey: string): boolean {
  if (apiKey === "") {
    return false;
  }

  let current = value;

  for (let round = 0; round < 3; round += 1) {
    if (current.includes(apiKey)) {
      return true;
    }

    try {
      const decoded = decodeURIComponent(current);

      if (decoded === current) {
        return false;
      }

      current = decoded;
    } catch {
      return false;
    }
  }

  return current.includes(apiKey);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
