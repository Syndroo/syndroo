/**
 * Local Mastodon provider.
 *
 * Web-platform only: no Node imports, no global `fetch` fallback. The caller
 * must inject the transport; the production CLI injects the accepted safe
 * instance transport, which owns DNS/address policy and the 15 s / 1 MiB budget.
 * This adapter still bounds every response it reads so a test-injected or
 * stalled transport cannot hang the caller.
 *
 * Endpoints are always derived from the captured bound origin, never from a
 * response URL. `publish` performs exactly one write and never retries, follows
 * a redirect, or searches for the post.
 */

import {
  LocalProviderError,
  localDisplayName,
  type FrozenDelivery,
  type LocalContentOptions,
  type LocalCredentials,
  type LocalIdentity,
  type LocalInstanceCapabilities,
  type LocalProvider,
  type LocalProviderDescription,
  type PreparedTarget,
  type ProviderOutcome,
  type TargetBinding,
} from "@syndroo/core";

import {
  assertMastodonContentFits,
  assertMastodonStatusText,
} from "./count.js";
import {
  DEFAULT_TIMEOUT_MS,
  LocalTransportError,
  createDeadline,
  mastodonErrorEvidence,
  readRetryHint,
  requestBounded,
  type BoundedResponse,
  type Deadline,
  type RetryHint,
} from "./local-transport.js";

export const MASTODON_PAYLOAD_VERSION = 1;

const ACCOUNT_PATH = "/api/v1/accounts/verify_credentials";
const INSTANCE_PATH = "/api/v2/instance";
const STATUSES_PATH = "/api/v1/statuses";

/** Mastodon account and status ids are positive numeric strings. */
const ID_PATTERN = /^[1-9][0-9]{0,63}$/;

/** Opaque bearer token: printable ASCII, bounded, never whitespace. */
const TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/;

const FORBIDDEN_URL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_URL_LENGTH = 2048;

const PAYLOAD_KEYS: ReadonlySet<string> = new Set(["status", "visibility"]);

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export interface MastodonLocalProviderOptions {
  /** Required injected transport. There is no global `fetch` fallback. */
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}

export interface MastodonTargetIdentity {
  readonly origin: string;
  readonly accountId: string;
}

/**
 * Local Mastodon provider.
 *
 * The constructor performs no network work. Identity and capabilities are read
 * only inside `verifyIdentity`/`prepare`; `publish` sends exactly one
 * `POST /api/v1/statuses`.
 */
export class MastodonLocalProvider implements LocalProvider {
  readonly provider = "mastodon" as const;

  private readonly transport: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: MastodonLocalProviderOptions) {
    if (options === null || typeof options !== "object" || typeof options.fetch !== "function") {
      throw new TypeError("MastodonLocalProvider requires an injected fetch");
    }

    this.transport = options.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError("Mastodon timeout must be positive");
    }
  }

  describe(): LocalProviderDescription {
    return {
      provider: "mastodon",
      maturity: "fixture-tested",
      localPublish: true,
      unavailableReason: null,
      contentTypes: ["text"],
      authMethods: ["user-token", "oauth"],
      media: false,
      scheduling: false,
    };
  }

  freeze(
    content: string,
    createdAt: string,
    options?: LocalContentOptions,
  ): { payloadVersion: number; payload: Readonly<Record<string, unknown>> } {
    // Mastodon publishes plain public statuses: any article metadata is an
    // inappropriate option and is refused rather than silently dropped.
    if (options !== undefined && Object.keys(options).length > 0) {
      throw new LocalProviderError("INVALID_CONTENT");
    }

    assertMastodonStatusText(content);

    if (typeof createdAt !== "string" || createdAt.length === 0) {
      throw new LocalProviderError("INVALID_CONTENT");
    }

    return {
      payloadVersion: MASTODON_PAYLOAD_VERSION,
      payload: { status: content, visibility: "public" },
    };
  }

  validateCachedContent(
    content: string,
    capabilities: LocalInstanceCapabilities,
  ): void {
    assertMastodonContentFits(content, capabilities);
  }

  async verifyIdentity(
    credentials: LocalCredentials,
    signal: AbortSignal,
  ): Promise<LocalIdentity> {
    const credential = readCredentials(credentials);

    if (signal.aborted) {
      throw new LocalProviderError("ABORTED");
    }

    // `/accounts/verify_credentials` is the user-token proof: an application
    // token is refused by the platform with 401/403. It never proves the
    // account may publish, only which account the token belongs to.
    const account = await this.fetchAccount(credential, signal);
    const capabilities = await this.fetchCapabilities(credential, signal);
    const displayName = sanitizeDisplayName(account.displayName, credential.accessToken);

    return {
      targetId: mastodonTargetId(credential.instance, account.id),
      capabilities,
      ...(displayName === undefined ? {} : { displayName }),
    };
  }

  async prepare(
    credentials: LocalCredentials,
    target: TargetBinding,
    signal: AbortSignal,
    delivery?: FrozenDelivery,
  ): Promise<PreparedTarget> {
    const credential = readCredentials(credentials);
    const parsed = parseMastodonTargetId(target.targetId);

    if (
      target.provider !== "mastodon" ||
      parsed === null ||
      parsed.origin !== credential.instance
    ) {
      throw new LocalProviderError("ACCOUNT_MISMATCH");
    }

    if (delivery === undefined) {
      throw new LocalProviderError("INVALID_CONTENT");
    }

    const identity = await this.verifyIdentity(credential, signal);

    if (identity.targetId !== target.targetId) {
      throw new LocalProviderError("ACCOUNT_MISMATCH");
    }

    const capabilities = identity.capabilities;

    if (capabilities === undefined) {
      throw new LocalProviderError("PROVIDER_UNAVAILABLE");
    }

    // Snapshot the binding, credential, and current limits so nothing is
    // re-read between the limit check and the single write.
    const frozenTarget = freezeTarget(target);
    const check = checkDelivery(delivery, frozenTarget, capabilities);

    if ("code" in check) {
      throw new LocalProviderError("INVALID_CONTENT");
    }

    const frozenToken = credential.accessToken;
    const frozenOrigin = credential.instance;

    return {
      target: frozenTarget,
      publish: (frozenDelivery, publishSignal) =>
        this.publishStatus(
          frozenOrigin,
          frozenToken,
          frozenTarget,
          capabilities,
          frozenDelivery,
          publishSignal,
        ),
    };
  }

  private async fetchAccount(
    credential: { readonly instance: string; readonly accessToken: string },
    signal: AbortSignal,
  ): Promise<{ readonly id: string; readonly displayName: unknown }> {
    const deadline = createDeadline(signal, this.timeoutMs);

    try {
      const response = await requestBounded(
        this.transport,
        `${credential.instance}${ACCOUNT_PATH}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${credential.accessToken}`,
            accept: "application/json",
          },
        },
        deadline.signal,
      );

      if (response.status >= 200 && response.status < 300) {
        const body = response.body;

        if (!isRecord(body) || "error" in body) {
          throw new LocalProviderError("PROVIDER_UNAVAILABLE");
        }

        const id = readPositiveId(body.id);

        if (id === null) {
          throw new LocalProviderError("PROVIDER_UNAVAILABLE");
        }

        return { id, displayName: body.display_name ?? body.username };
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

  private async fetchCapabilities(
    credential: { readonly instance: string },
    signal: AbortSignal,
  ): Promise<LocalInstanceCapabilities> {
    const deadline = createDeadline(signal, this.timeoutMs);

    try {
      // `/api/v2/instance` is public metadata; the user token is not sent.
      const response = await requestBounded(
        this.transport,
        `${credential.instance}${INSTANCE_PATH}`,
        { method: "GET", headers: { accept: "application/json" } },
        deadline.signal,
      );

      if (response.status >= 200 && response.status < 300) {
        const body = response.body;

        if (!isRecord(body)) {
          throw new LocalProviderError("PROVIDER_UNAVAILABLE");
        }

        const configuration = body.configuration;
        const statuses = isRecord(configuration) ? configuration.statuses : undefined;

        if (!isRecord(statuses)) {
          throw new LocalProviderError("PROVIDER_UNAVAILABLE");
        }

        const maxCharacters = positiveSafeInteger(statuses.max_characters);
        const charactersReservedPerUrl = positiveSafeInteger(
          statuses.characters_reserved_per_url,
        );

        if (maxCharacters === null || charactersReservedPerUrl === null) {
          throw new LocalProviderError("PROVIDER_UNAVAILABLE");
        }

        return { maxCharacters, charactersReservedPerUrl };
      }

      throw new LocalProviderError("PROVIDER_UNAVAILABLE");
    } catch (error) {
      throw admissionFailure(error, signal);
    } finally {
      deadline.cleanup();
    }
  }

  private async publishStatus(
    origin: string,
    accessToken: string,
    target: TargetBinding,
    capabilities: LocalInstanceCapabilities,
    delivery: FrozenDelivery,
    signal: AbortSignal,
  ): Promise<ProviderOutcome> {
    const check = checkDelivery(delivery, target, capabilities);

    if ("code" in check) {
      return failedOutcome(check.code, false, null);
    }

    if (signal.aborted) {
      return failedOutcome("ABORTED", false, null);
    }

    const deadline = createDeadline(signal, this.timeoutMs);
    let dispatched = false;

    try {
      const body = JSON.stringify({
        status: check.text,
        visibility: "public",
      });

      dispatched = true;

      const response = await requestBounded(
        this.transport,
        `${origin}${STATUSES_PATH}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: "application/json",
            "content-type": "application/json",
            // Derived directly from the immutable delivery id: the same
            // delivery always presents the same key, and no retry is attempted.
            "Idempotency-Key": delivery.deliveryId,
          },
          body,
        },
        deadline.signal,
      );

      return classifyPublishResponse(response, accessToken);
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
// Origin, credentials, and target identity
// ---------------------------------------------------------------------------

/**
 * Structural instance origin: HTTPS on 443 with no userinfo, path, query, or
 * fragment. Address policy (public DNS, pinned socket) belongs to the injected
 * transport, not to this platform-neutral module.
 */
export function normalizeMastodonOrigin(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new LocalProviderError("AUTH");
  }

  let url: URL;

  try {
    url = new URL(input);
  } catch {
    throw new LocalProviderError("AUTH");
  }

  if (url.protocol !== "https:") {
    throw new LocalProviderError("AUTH");
  }

  if (url.username !== "" || url.password !== "") {
    throw new LocalProviderError("AUTH");
  }

  // `URL` drops an explicit `:443`; any remaining port is a non-443 port.
  if (url.port !== "") {
    throw new LocalProviderError("AUTH");
  }

  if (url.search !== "" || url.hash !== "") {
    throw new LocalProviderError("AUTH");
  }

  if (url.pathname !== "" && url.pathname !== "/") {
    throw new LocalProviderError("AUTH");
  }

  const host = url.hostname.endsWith(".")
    ? url.hostname.slice(0, -1)
    : url.hostname;

  if (host === "" || host.length > 253) {
    throw new LocalProviderError("AUTH");
  }

  return `https://${host}`;
}

/** `mastodon:<base64url(origin)>:<accountId>` — platform-neutral encoding. */
export function mastodonTargetId(origin: string, accountId: string): string {
  if (!ID_PATTERN.test(accountId)) {
    throw new LocalProviderError("ACCOUNT_MISMATCH");
  }

  return `mastodon:${base64UrlEncode(origin)}:${accountId}`;
}

export function parseMastodonTargetId(targetId: unknown): MastodonTargetIdentity | null {
  if (typeof targetId !== "string") {
    return null;
  }

  const parts = targetId.split(":");

  if (parts.length !== 3 || parts[0] !== "mastodon") {
    return null;
  }

  const origin = base64UrlDecode(parts[1]!);
  const accountId = parts[2]!;

  if (origin === null || !ID_PATTERN.test(accountId)) {
    return null;
  }

  // Reject non-canonical base64url variants that decode to the same bytes.
  if (base64UrlEncode(origin) !== parts[1]) {
    return null;
  }

  let canonical: string;

  try {
    canonical = normalizeMastodonOrigin(origin);
  } catch {
    return null;
  }

  return canonical === origin ? { origin, accountId } : null;
}

function readCredentials(
  value: LocalCredentials,
): Extract<LocalCredentials, { provider: "mastodon" }> {
  if (value === null || typeof value !== "object" || value.provider !== "mastodon") {
    throw new LocalProviderError("AUTH");
  }

  const instance = normalizeMastodonOrigin(value.instance);
  const accessToken = value.accessToken;

  if (typeof accessToken !== "string" || !TOKEN_PATTERN.test(accessToken)) {
    throw new LocalProviderError("AUTH");
  }

  return { provider: "mastodon", instance, accessToken };
}

function freezeTarget(target: TargetBinding): TargetBinding {
  return {
    provider: target.provider,
    targetId: target.targetId,
    connectionId: target.connectionId,
    bindingRevision: target.bindingRevision,
  };
}

// ---------------------------------------------------------------------------
// Payload and response handling
// ---------------------------------------------------------------------------

type DeliveryCheck = { readonly text: string } | { readonly code: string };

/**
 * Revalidates the frozen payload at prepare and publish time. Text is never
 * regenerated; anything unexpected fails closed before a request is made.
 */
function checkDelivery(
  delivery: FrozenDelivery,
  target: TargetBinding,
  capabilities: LocalInstanceCapabilities,
): DeliveryCheck {
  if (delivery.payloadVersion !== MASTODON_PAYLOAD_VERSION) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  // Mastodon publishes plain public statuses; a frozen delivery that carries
  // article metadata is not a delivery this provider may send.
  if (delivery.contentOptions !== undefined) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  if (
    delivery.target.provider !== "mastodon" ||
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

  const keys = Object.keys(payload);

  if (keys.length !== PAYLOAD_KEYS.size || !keys.every(key => PAYLOAD_KEYS.has(key))) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  if (payload.visibility !== "public") {
    return { code: "PAYLOAD_MISMATCH" };
  }

  const text = payload.status;

  if (typeof text !== "string" || text !== delivery.content) {
    return { code: "PAYLOAD_MISMATCH" };
  }

  try {
    assertMastodonStatusText(text);
    assertMastodonContentFits(text, capabilities);
  } catch {
    return { code: "INVALID_CONTENT" };
  }

  return { text };
}

function classifyPublishResponse(
  response: BoundedResponse,
  accessToken: string,
): ProviderOutcome {
  const { status, body } = response;

  if (status >= 200 && status < 300) {
    // A success status that also carries an error object is contradictory
    // evidence: the id alone is not enough to claim the status was published.
    if (!isRecord(body) || "error" in body) {
      return unknownOutcome("UNRECOGNIZED_RESPONSE");
    }

    const id = readPositiveId(body.id);

    return id === null
      ? unknownOutcome("UNRECOGNIZED_RESPONSE")
      : { kind: "succeeded", remoteId: id, url: sanitizeStatusUrl(body.url, accessToken) };
  }

  // A definite rejection needs the documented Mastodon error envelope. A bare
  // status could come from a proxy or a truncated body and stays unknown.
  if (status === 401 || status === 403) {
    if (!mastodonErrorEvidence(body)) {
      return unknownOutcome("UNRECOGNIZED_RESPONSE");
    }

    return status === 401
      ? failedOutcome("AUTH", true, null)
      : failedOutcome("PERMISSION", false, null);
  }

  if (status === 422) {
    return mastodonErrorEvidence(body)
      ? failedOutcome("INVALID_CONTENT", false, null)
      : unknownOutcome("UNRECOGNIZED_RESPONSE");
  }

  if (status === 429) {
    return mastodonErrorEvidence(body)
      ? rateLimitOutcome(readRetryHint(response.retryAfter))
      : unknownOutcome("UNRECOGNIZED_RESPONSE");
  }

  // 3xx, 5xx, and every other status: the write may have reached the platform.
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

/** HTTPS, no userinfo, no controls, bounded, and never echoing the token. */
function sanitizeStatusUrl(value: unknown, accessToken: string): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_URL_LENGTH ||
    FORBIDDEN_URL_CONTROL.test(value) ||
    containsCredential(value, accessToken)
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

function sanitizeDisplayName(value: unknown, accessToken: string): string | undefined {
  const name = localDisplayName(value);

  return name === undefined || containsCredential(name, accessToken) ? undefined : name;
}

/**
 * True when the token appears literally or after up to three rounds of
 * percent-decoding, so a credential-encoded query or display name is never
 * echoed back to the caller.
 */
function containsCredential(value: string, accessToken: string): boolean {
  if (accessToken === "") {
    return false;
  }

  let current = value;

  for (let round = 0; round < 3; round += 1) {
    if (current.includes(accessToken)) {
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

  return current.includes(accessToken);
}

function readPositiveId(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Platform-neutral base64url
// ---------------------------------------------------------------------------

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const block = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    output += BASE64URL_ALPHABET[(block >> 18) & 0x3f]!;
    output += BASE64URL_ALPHABET[(block >> 12) & 0x3f]!;
    output += second === undefined ? "" : BASE64URL_ALPHABET[(block >> 6) & 0x3f]!;
    output += third === undefined ? "" : BASE64URL_ALPHABET[block & 0x3f]!;
  }

  return output;
}

function base64UrlDecode(value: string): string | null {
  if (value.length === 0 || value.length % 4 === 1) {
    return null;
  }

  const bytes: number[] = [];
  let block = 0;
  let bits = 0;

  for (const character of value) {
    const digit = BASE64URL_ALPHABET.indexOf(character);

    if (digit === -1) {
      return null;
    }

    block = (block << 6) | digit;
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      bytes.push((block >> bits) & 0xff);
    }
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}
