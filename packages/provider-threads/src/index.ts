/**
 * `@syndroo/provider-threads` — official architecture-v1 Provider for Threads.
 *
 * Scope and honesty of this implementation:
 *
 * - text posts only (`declaredCapabilities: ["text"]`), published through the
 *   single-call path the evidence documents: `POST {api_host}/me/threads` with
 *   `media_type=TEXT` and `auto_publish_text=true` collapses container creation
 *   and publishing into one request, and the returned id is the published post
 *   id. The two-step container flow is deliberately **not** implemented in v1:
 *   the frozen-payload contract has no place to carry an intermediate container
 *   id, and inventing a reconciliation step is forbidden;
 * - authentication is the Threads authorization-code flow. `threads_basic` is
 *   required for the token exchange and refresh; `threads_content_publish` is
 *   required to post. Both are asked for by default;
 * - **the API host is an explicit connect input.** Meta's own artifacts
 *   disagree: the published Postman collection uses
 *   `authorization_host = https://www.threads.net` and
 *   `api_host = https://graph.threads.net`, while the sample application builds
 *   `https://www.threads.com` and `https://graph.threads.com`. This provider
 *   therefore never hardcodes either from the evidence: it exports the
 *   collection's `.net` pair as the default and accepts both hosts as connect
 *   options, so a caller can pin whichever pair Meta confirms;
 * - the short-lived token lifetime is UNRESOLVED and is not asserted. The
 *   cited 60-day (`expires_in: 5184000`) value belongs to the long-lived token
 *   and is not re-asserted here either, because it is a response field, not a
 *   provider constant;
 * - no Threads error-code table is available, so classification uses the HTTP
 *   status only, never an invented error code. The cited container statuses
 *   (`FINISHED`, `EXPIRED`, `ERROR`) and the 24-hour container window are
 *   **not used**, because v1 never creates a bare container;
 * - the text maximum length is UNRESOLVED upstream and is not modelled. Freeze
 *   enforces only non-empty text and a whole-payload byte ceiling, which is a
 *   transport-safety bound, not a platform limit. Over-limit content is
 *   rejected, never truncated.
 *
 * The module is inert on import. It reads no clock, no environment, no
 * filesystem and no network; every byte that leaves the process does so through
 * the injected `ProviderContext.transport`. `freeze` is a pure function of its
 * input, so the same input produces byte-identical output. The client secret and
 * every token stay out of frozen payloads, previews, write outcomes and thrown
 * errors.
 */

import { defineProvider } from "@syndroo/provider-sdk";
import type {
  AccountIdentity,
  CallbackEvidence,
  ConnectAction,
  CredentialBundle,
  FreezeInput,
  FrozenProviderPayload,
  IsoTime,
  JsonObject,
  OAuthMaterial,
  PreviewField,
  ProviderConnectInput,
  ProviderConnectResult,
  ProviderContext,
  ProviderFailureReason,
  ProviderHttpRequest,
  ProviderHttpResult,
  ProviderManifest,
  ProviderPlugin,
  ProviderPublishInput,
  ProviderWriteOutcome,
  VerifiedIdentity,
} from "@syndroo/provider-sdk";

/**
 * Package version. Must stay identical to `package.json` `version`; the test
 * suite reads the manifest file and fails the build on drift.
 */
export const THREADS_PROVIDER_VERSION = "0.7.0-rc.1";

/** Provider id. Also the package-name suffix and the registry key. */
export const THREADS_PROVIDER_ID = "threads";

/**
 * The default authorization host, taken from the Meta-published Postman
 * collection (`authorization_host`).
 *
 * DISCREPANCY: Meta's own sample application builds
 * `https://www.threads.com` instead. Both are Meta-owned and they disagree on
 * `.net` versus `.com`, so this default is only a default: the connect input
 * accepts `authorizationHost` and `apiHost` so a caller can pin the pair Meta
 * confirms. The provider never silently mixes the two.
 */
export const THREADS_DEFAULT_AUTHORIZATION_HOST = "https://www.threads.net";

/**
 * The default API host, taken from the Meta-published Postman collection
 * (`api_host`). The same `.net`/`.com` discrepancy note above applies: the
 * sample application builds `https://graph.threads.com`.
 */
export const THREADS_DEFAULT_API_HOST = "https://graph.threads.net";

/**
 * The public profile origin. The evidence derives profile URLs as
 * `https://www.threads.net/@{username}`, so that is the account's bound origin,
 * independent of which API host a connection uses.
 */
export const THREADS_PROFILE_ORIGIN = "https://www.threads.net";

/** Paths, always resolved against the chosen host. */
export const THREADS_AUTHORIZE_PATH = "/oauth/authorize";
export const THREADS_ACCESS_TOKEN_PATH = "/oauth/access_token";
export const THREADS_LONG_LIVED_TOKEN_PATH = "/access_token";
export const THREADS_ME_PATH = "/me";
export const THREADS_ME_FIELDS = "id,username";
export const THREADS_CREATE_PATH = "/me/threads";

/** The single text media type this version supports. */
export const THREADS_MEDIA_TYPE_TEXT = "TEXT";

/** The flag both Meta artifacts document as publishing text in one call. */
export const THREADS_AUTO_PUBLISH_TEXT = true;

/**
 * The scopes the flow asks for by default: `threads_basic` is required for the
 * token exchange and refresh, `threads_content_publish` to publish.
 */
export const THREADS_DEFAULT_SCOPES = ["threads_basic", "threads_content_publish"] as const;

/**
 * A transport-safety ceiling on the serialized request parameters, in UTF-8
 * bytes.
 *
 * This is deliberately **not** a platform limit: no Threads text maximum is
 * evidenced (the widely repeated 500-character figure is absent from both Meta
 * artifacts), so no character bound is modelled as one. This number only stops
 * one submission from building an unbounded request.
 */
export const MAX_PAYLOAD_BYTES = 1_000_000;

/**
 * Stable failure codes raised by this provider. Never carries a secret.
 */
export type ThreadsProviderErrorCode =
  | "input_invalid"
  | "redirect_invalid"
  | "host_invalid"
  | "entropy_unavailable"
  | "oauth_material_invalid"
  | "credential_rejected"
  | "callback_rejected"
  | "state_mismatch"
  | "redirect_mismatch"
  | "token_exchange_rejected"
  | "identity_unavailable"
  | "text_missing"
  | "payload_too_large"
  | "provider_unavailable";

/**
 * A stable, secret-free provider error.
 *
 * Every message is a fixed sentence. The only interpolated value is a byte count
 * this module measured, so no client secret and no token can reach a log, an
 * error serializer or a stack trace through this type.
 */
export class ThreadsProviderError extends Error {
  readonly code: ThreadsProviderErrorCode;

  constructor(code: ThreadsProviderErrorCode, message: string) {
    super(message);
    this.name = "ThreadsProviderError";
    this.code = code;
  }
}

const REDIRECT_INVALID_MESSAGE = "The Threads redirect URI must be an absolute URI without userinfo or a fragment.";
const HOST_INVALID_MESSAGE = "The Threads host must be an absolute https origin without a path, userinfo or query.";
const ENTROPY_UNAVAILABLE_MESSAGE = "No cryptographic random source is available for the OAuth state.";
const OAUTH_MATERIAL_INVALID_MESSAGE = "The Threads connect session is missing its OAuth material.";
const CREDENTIAL_MISSING_MESSAGE = "The Threads connection is missing its app client credentials.";
const CREDENTIAL_REJECTED_MESSAGE = "Threads rejected the supplied credentials.";
const CALLBACK_REJECTED_MESSAGE = "Threads rejected the authorization callback.";
const STATE_MISMATCH_MESSAGE = "The authorization callback state does not match this connect session.";
const REDIRECT_MISMATCH_MESSAGE = "The authorization callback redirect URI does not match this connect session.";
const TOKEN_EXCHANGE_REJECTED_MESSAGE = "Threads rejected the token exchange.";
const IDENTITY_UNAVAILABLE_MESSAGE = "Threads did not report the account id this provider needs.";
const TEXT_MISSING_MESSAGE = "The Threads post needs non-empty text.";
const UNAVAILABLE_MESSAGE = "The Threads request could not be completed.";

/** Recursively freeze a JSON value this module built. No cycles by construction. */
function deepFreezeJson<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreezeJson((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Read a non-empty string field from a JSON object without trusting the shape. */
function readString(record: JsonObject | undefined, key: string): string | undefined {
  if (record === undefined) {
    return undefined;
  }
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read a non-empty array of non-empty strings, or `undefined`. */
function readStringArray(record: JsonObject | undefined, key: string): string[] | undefined {
  const value = record?.[key];
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const values: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      return undefined;
    }
    values.push(entry);
  }
  return values;
}

/** Parse a JSON object body, or `undefined` when it is absent or not an object. */
function parseJsonObject(body: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(body);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return value as JsonObject;
  } catch {
    return undefined;
  }
}

/** UTF-8 byte length without touching a platform encoder. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** Normalise a user-supplied host to its https origin, or reject it. */
function httpsOrigin(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return undefined;
  }
  return url.origin;
}

/**
 * Accept an absolute redirect URI: https anywhere, http only on loopback, or a
 * private-use scheme (the shapes a desktop OAuth client can actually receive).
 * The value is stored verbatim, because Threads compares it with the app's
 * registered redirect URI byte for byte.
 */
function absoluteRedirectUri(value: string | undefined): string | undefined {
  if (value === undefined || /\s/.test(value)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    return undefined;
  }
  if (url.protocol === "https:") {
    return value;
  }
  if (url.protocol === "http:") {
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]"
      ? value
      : undefined;
  }
  return url.protocol.length > 1 ? value : undefined;
}

/** Encode bytes as base64url without padding (RFC 4648 §5). */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Fill bytes from the ambient Web Crypto source, or fail closed. */
function randomBytes(length: number): Uint8Array {
  const bag = (globalThis as { crypto?: Crypto }).crypto;
  if (bag === undefined || typeof bag.getRandomValues !== "function") {
    throw new ThreadsProviderError("entropy_unavailable", ENTROPY_UNAVAILABLE_MESSAGE);
  }
  const bytes = new Uint8Array(length);
  bag.getRandomValues(bytes);
  return bytes;
}

/** Case-insensitive header lookup over the transport's plain header record. */
function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) {
    return direct;
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return headers[key];
    }
  }
  return undefined;
}

/**
 * Turn a `retry-after` header into an ISO instant.
 *
 * `Date` is used only to do calendar arithmetic on instants the caller supplied
 * (`context.now` and the header value); no current-time source is read.
 */
function parseRetryAfter(value: string | undefined, now: IsoTime): IsoTime | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const base = Date.parse(now);
  if (Number.isNaN(base)) {
    return undefined;
  }
  if (/^\d{1,9}$/.test(trimmed)) {
    const at = new Date(base + Number(trimmed) * 1000);
    return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/** Normalized, non-secret reason for a definite 4xx rejection. */
function reasonForRejection(status: number): ProviderFailureReason {
  if (status === 401) {
    return "auth";
  }
  if (status === 403) {
    return "permission";
  }
  return "validation";
}

/**
 * Classify one returned transport result.
 *
 * No Threads error-code table is available, so the status is the only signal:
 *
 * - 2xx is a definite acceptance, and the response body's `id` is the published
 *   post id on the `auto_publish_text=true` path;
 * - 429 is a definite, non-applied, retryable rejection with the wait time the
 *   server asked for;
 * - other 4xx is a definite rejection and never retried here;
 * - 5xx, an unexpected status, and a `possibly_sent` transport error are
 *   ambiguous, so they stay `unknown` and are never reported as `not_applied`.
 */
function classifyWrite(result: ProviderHttpResult, now: IsoTime): ProviderWriteOutcome {
  if (result.type === "transport_error") {
    if (result.stage === "possibly_sent") {
      return { status: "unknown", disposition: "unknown", reason: "network" };
    }
    return { status: "failed", disposition: "not_applied", retryable: true, reason: "network" };
  }

  const status = result.status;

  if (status >= 200 && status < 300) {
    const remoteId = readString(parseJsonObject(result.body), "id");
    return { status: "succeeded", ...(remoteId === undefined ? {} : { remoteId }) };
  }

  if (status === 429) {
    const retryAfter = parseRetryAfter(headerValue(result.headers, "retry-after"), now);
    return {
      status: "failed",
      disposition: "not_applied",
      retryable: true,
      reason: "rate_limited",
      ...(retryAfter === undefined ? {} : { retryAfter }),
    };
  }

  if (status >= 400 && status < 500) {
    return {
      status: "failed",
      disposition: "not_applied",
      retryable: false,
      reason: reasonForRejection(status),
    };
  }

  if (status >= 500) {
    return { status: "unknown", disposition: "unknown", reason: "provider_unavailable" };
  }

  return { status: "unknown", disposition: "unknown", reason: "unknown" };
}

async function send(
  context: ProviderContext,
  request: ProviderHttpRequest,
): Promise<ProviderHttpResult> {
  try {
    return await context.transport.request(request);
  } catch {
    // The transport contract returns errors rather than throwing; a throw here
    // is ambiguous, so it becomes the same stable unavailable failure.
    throw new ThreadsProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
  }
}

/** Build the authorize URL the human opens. */
function authorizeUrl(
  authorizationHost: string,
  clientId: string,
  redirectUri: string,
  scopes: readonly string[],
  state: string,
): string {
  const query = new URLSearchParams({
    scope: scopes.join(","),
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });
  return `${authorizationHost}${THREADS_AUTHORIZE_PATH}?${query.toString()}`;
}

/**
 * Exchange the authorization code for a short-lived token, then trade that for
 * the long-lived token.
 *
 * Both calls follow the collection: parameters travel in the query string on the
 * documented methods (`POST` for the code exchange, `GET` for the long-lived
 * trade). The short-lived token is passed to the trade as `access_token`, the
 * one parameter the evidence line abbreviates but the call cannot work without.
 */
async function exchangeTokens(
  apiHost: string,
  form: { code: string; clientId: string; clientSecret: string; redirectUri: string },
  context: ProviderContext,
): Promise<string> {
  const exchangeQuery = new URLSearchParams({
    client_id: form.clientId,
    client_secret: form.clientSecret,
    code: form.code,
    grant_type: "authorization_code",
    redirect_uri: form.redirectUri,
  });
  const exchanged = await send(context, {
    url: `${apiHost}${THREADS_ACCESS_TOKEN_PATH}?${exchangeQuery.toString()}`,
    method: "POST",
    signal: context.signal,
  });
  if (exchanged.type === "transport_error") {
    throw new ThreadsProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
  }
  if (exchanged.status >= 400 && exchanged.status < 500) {
    throw new ThreadsProviderError("callback_rejected", CALLBACK_REJECTED_MESSAGE);
  }
  if (exchanged.status < 200 || exchanged.status >= 300) {
    throw new ThreadsProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
  }
  const shortLived = readString(parseJsonObject(exchanged.body), "access_token");
  if (shortLived === undefined) {
    throw new ThreadsProviderError("token_exchange_rejected", TOKEN_EXCHANGE_REJECTED_MESSAGE);
  }

  const longQuery = new URLSearchParams({
    grant_type: "th_exchange_token",
    client_secret: form.clientSecret,
    access_token: shortLived,
  });
  const traded = await send(context, {
    url: `${apiHost}${THREADS_LONG_LIVED_TOKEN_PATH}?${longQuery.toString()}`,
    method: "GET",
    signal: context.signal,
  });
  if (traded.type === "transport_error") {
    throw new ThreadsProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
  }
  if (traded.status < 200 || traded.status >= 300) {
    throw new ThreadsProviderError("token_exchange_rejected", TOKEN_EXCHANGE_REJECTED_MESSAGE);
  }
  const longLived = readString(parseJsonObject(traded.body), "access_token");
  if (longLived === undefined) {
    throw new ThreadsProviderError("token_exchange_rejected", TOKEN_EXCHANGE_REJECTED_MESSAGE);
  }
  return longLived;
}

/** Resolve the account id and username through `GET {api_host}/me`. */
async function resolveAccount(
  apiHost: string,
  accessToken: string,
  context: ProviderContext,
): Promise<{ id: string; username?: string }> {
  const query = new URLSearchParams({ fields: THREADS_ME_FIELDS });
  const result = await send(context, {
    url: `${apiHost}${THREADS_ME_PATH}?${query.toString()}`,
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}` },
    signal: context.signal,
  });
  if (result.type === "transport_error") {
    throw new ThreadsProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
  }
  if (result.status === 401 || result.status === 403) {
    throw new ThreadsProviderError("credential_rejected", CREDENTIAL_REJECTED_MESSAGE);
  }
  if (result.status >= 200 && result.status < 300) {
    const parsed = parseJsonObject(result.body);
    const id = readString(parsed, "id");
    if (id !== undefined) {
      const username = readString(parsed, "username");
      return username === undefined ? { id } : { id, username };
    }
  }
  throw new ThreadsProviderError("identity_unavailable", IDENTITY_UNAVAILABLE_MESSAGE);
}

/** The verified identity for one account, keyed by the Threads account id. */
function identityFor(accountId: string, apiHost: string, now: IsoTime): VerifiedIdentity {
  const account: AccountIdentity = {
    provider: THREADS_PROVIDER_ID,
    accountId,
    origin: THREADS_PROFILE_ORIGIN,
  };
  return {
    account,
    evidence: [
      {
        capability: "identity",
        value: "supported",
        source: `${apiHost}${THREADS_ME_PATH}?fields=${THREADS_ME_FIELDS}`,
        verifiedAt: now,
      },
    ],
  };
}

/** The state a connect session needs before an app client is known. */
type PendingState = {
  redirectUri: string;
  apiHost: string;
  authorizationHost: string;
  scopes: string[];
};

/** The state a connect session needs to finish the authorization code flow. */
type AuthorizationState = PendingState & {
  clientId: string;
  clientSecret: string;
  state: string;
};

/** Read the pre-client private state, or `undefined` when it is incomplete. */
function pendingStateOf(privateState: JsonObject): PendingState | undefined {
  const redirectUri = absoluteRedirectUri(readString(privateState, "redirectUri"));
  const apiHost = httpsOrigin(readString(privateState, "apiHost"));
  const authorizationHost = httpsOrigin(readString(privateState, "authorizationHost"));
  const scopes = readStringArray(privateState, "scopes");
  if (
    redirectUri === undefined ||
    apiHost === undefined ||
    authorizationHost === undefined ||
    scopes === undefined
  ) {
    return undefined;
  }
  return { redirectUri, apiHost, authorizationHost, scopes };
}

/** Read the authorization private state, or `undefined` when it is incomplete. */
function authorizationStateOf(privateState: JsonObject): AuthorizationState | undefined {
  const pending = pendingStateOf(privateState);
  const clientId = readString(privateState, "clientId");
  const clientSecret = readString(privateState, "clientSecret");
  const state = readString(privateState, "state");
  if (pending === undefined || clientId === undefined || clientSecret === undefined || state === undefined) {
    return undefined;
  }
  return { ...pending, clientId, clientSecret, state };
}

/** The credential-input action asking for the app client id and secret. */
const CLIENT_CREDENTIAL_ACTION: ConnectAction = Object.freeze({
  type: "credential_input",
  fields: Object.freeze([
    Object.freeze({ name: "client_id", label: "Threads client id", secret: false }),
    Object.freeze({ name: "client_secret", label: "Threads client secret", secret: true }),
  ]),
});

/**
 * Run one step of the connect protocol.
 *
 * `start` either builds the authorization action straight away, when the app's
 * client id and secret were supplied as options, or asks for them with a
 * `credential_input` action whose secret field the CLI reads with echo disabled.
 * A `credentials` resume turns the pending hosts/redirect/scopes into the
 * authorization action; a `callback` resume exchanges the code for a short-lived
 * token, trades it for the long-lived token, and resolves the account.
 *
 * The client secret lives only in the returned `privateState`, which Core stores
 * as a connect-session secret and never renders. The action URL carries the
 * client id and the state, never the secret.
 */
async function runConnect(
  input: ProviderConnectInput,
  context: ProviderContext,
): Promise<ProviderConnectResult> {
  if (input.type === "start") {
    const upstream: OAuthMaterial | undefined = context.oauth;
    const redirectUri = absoluteRedirectUri(
      upstream?.redirectUri ?? readString(input.options, "redirectUri"),
    );
    if (redirectUri === undefined) {
      throw new ThreadsProviderError("redirect_invalid", REDIRECT_INVALID_MESSAGE);
    }

    const requestedApiHost = readString(input.options, "apiHost");
    const requestedAuthorizationHost = readString(input.options, "authorizationHost");
    const apiHost = requestedApiHost === undefined ? THREADS_DEFAULT_API_HOST : httpsOrigin(requestedApiHost);
    const authorizationHost =
      requestedAuthorizationHost === undefined
        ? THREADS_DEFAULT_AUTHORIZATION_HOST
        : httpsOrigin(requestedAuthorizationHost);
    if (apiHost === undefined || authorizationHost === undefined) {
      throw new ThreadsProviderError("host_invalid", HOST_INVALID_MESSAGE);
    }

    const scopes = readStringArray(input.options, "scopes") ?? [...THREADS_DEFAULT_SCOPES];

    const suppliedId = readString(input.options, "clientId");
    const suppliedSecret = readString(input.options, "clientSecret");
    if ((suppliedId === undefined) !== (suppliedSecret === undefined)) {
      throw new ThreadsProviderError(
        "input_invalid",
        "A pre-registered app needs both clientId and clientSecret.",
      );
    }

    if (suppliedId === undefined || suppliedSecret === undefined) {
      const privateState = deepFreezeJson({ redirectUri, apiHost, authorizationHost, scopes });
      return { status: "action_required", action: CLIENT_CREDENTIAL_ACTION, privateState };
    }

    const state = upstream?.state ?? base64Url(randomBytes(32));
    const privateState = deepFreezeJson({
      clientId: suppliedId,
      clientSecret: suppliedSecret,
      redirectUri,
      apiHost,
      authorizationHost,
      scopes,
      state,
    });
    const action: ConnectAction = Object.freeze({
      type: "open_url",
      url: authorizeUrl(authorizationHost, suppliedId, redirectUri, scopes, state),
    });
    return { status: "action_required", action, privateState };
  }

  if (input.input.type === "credentials") {
    const pending = pendingStateOf(input.privateState);
    if (pending === undefined) {
      throw new ThreadsProviderError("oauth_material_invalid", OAUTH_MATERIAL_INVALID_MESSAGE);
    }
    const clientId = readString(input.input.credentials, "client_id");
    const clientSecret = readString(input.input.credentials, "client_secret");
    if (clientId === undefined || clientSecret === undefined) {
      throw new ThreadsProviderError("credential_rejected", CREDENTIAL_MISSING_MESSAGE);
    }
    const state = context.oauth?.state ?? base64Url(randomBytes(32));
    const privateState = deepFreezeJson({
      clientId,
      clientSecret,
      redirectUri: pending.redirectUri,
      apiHost: pending.apiHost,
      authorizationHost: pending.authorizationHost,
      scopes: pending.scopes,
      state,
    });
    const action: ConnectAction = Object.freeze({
      type: "open_url",
      url: authorizeUrl(pending.authorizationHost, clientId, pending.redirectUri, pending.scopes, state),
    });
    return { status: "action_required", action, privateState };
  }

  const material = authorizationStateOf(input.privateState);
  if (material === undefined) {
    throw new ThreadsProviderError("oauth_material_invalid", OAUTH_MATERIAL_INVALID_MESSAGE);
  }

  const evidence: CallbackEvidence = input.input.evidence;
  if (evidence.state !== material.state) {
    throw new ThreadsProviderError("state_mismatch", STATE_MISMATCH_MESSAGE);
  }
  if (evidence.redirectUri !== material.redirectUri) {
    throw new ThreadsProviderError("redirect_mismatch", REDIRECT_MISMATCH_MESSAGE);
  }
  const code = readString({ code: evidence.code }, "code");
  if (code === undefined) {
    throw new ThreadsProviderError("callback_rejected", CALLBACK_REJECTED_MESSAGE);
  }
  if (context.oauth !== undefined) {
    if (context.oauth.state !== material.state) {
      throw new ThreadsProviderError("state_mismatch", STATE_MISMATCH_MESSAGE);
    }
    if (context.oauth.redirectUri !== material.redirectUri) {
      throw new ThreadsProviderError("redirect_mismatch", REDIRECT_MISMATCH_MESSAGE);
    }
  }

  const accessToken = await exchangeTokens(
    material.apiHost,
    {
      code,
      clientId: material.clientId,
      clientSecret: material.clientSecret,
      redirectUri: material.redirectUri,
    },
    context,
  );
  const account = await resolveAccount(material.apiHost, accessToken, context);

  return {
    status: "done",
    // The bundle Core persists: the host binding, the long-lived token, and the
    // username used to derive the evidence-backed profile URL. Never rendered.
    credentials: {
      apiHost: material.apiHost,
      accessToken,
      ...(account.username === undefined ? {} : { username: account.username }),
    },
    identity: identityFor(account.id, material.apiHost, context.now),
  };
}

/** Re-verify a stored connection: the token still resolves the account. */
async function verifyConnect(
  credentials: CredentialBundle,
  context: ProviderContext,
): Promise<VerifiedIdentity> {
  const apiHost = httpsOrigin(readString(credentials, "apiHost")) ?? THREADS_DEFAULT_API_HOST;
  const accessToken = readString(credentials, "accessToken");
  if (accessToken === undefined) {
    throw new ThreadsProviderError("credential_rejected", CREDENTIAL_MISSING_MESSAGE);
  }
  const account = await resolveAccount(apiHost, accessToken, context);
  return identityFor(account.id, apiHost, context.now);
}

/**
 * Compile the frozen request parameters: the single `POST /me/threads` call.
 *
 * Deterministic from the freeze input alone. `media_type` is pinned to `TEXT`
 * and `auto_publish_text` to `true`, the one-call path both Meta artifacts
 * document. There is no container step in v1, so no intermediate container id
 * exists to carry.
 *
 * The text maximum is UNRESOLVED upstream, so the only bounds here are
 * non-empty text and a transport-safety byte ceiling on the whole request.
 */
function freezePost(input: FreezeInput): FrozenProviderPayload {
  const text = readString(input.options, "text");
  if (text === undefined) {
    throw new ThreadsProviderError("text_missing", TEXT_MISSING_MESSAGE);
  }

  const payload: JsonObject = {
    text,
    media_type: THREADS_MEDIA_TYPE_TEXT,
    auto_publish_text: THREADS_AUTO_PUBLISH_TEXT,
  };

  const serialized = JSON.stringify(payload);
  const bytes = utf8ByteLength(serialized);
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new ThreadsProviderError(
      "payload_too_large",
      `the compiled Threads request is ${bytes} bytes; this provider allows ${MAX_PAYLOAD_BYTES}`,
    );
  }

  const sharedText = readString(input.content, "text");
  const effectiveContent: { text?: string } = sharedText === undefined ? {} : { text: sharedText };
  const effectiveOptions: JsonObject = { text };
  const fields: PreviewField[] = [
    { name: "text", value: text },
    { name: "media_type", value: THREADS_MEDIA_TYPE_TEXT },
    { name: "auto_publish_text", value: THREADS_AUTO_PUBLISH_TEXT },
  ];

  return deepFreezeJson({
    payloadVersion: 1 as const,
    payload,
    effectiveContent,
    effectiveOptions,
    preview: { content: { ...effectiveContent }, fields },
  });
}

/**
 * Publish the compiled text post in one request. This provider never retries:
 * exactly one request leaves the process per publish call, and there is no
 * second container-publish call to make.
 */
async function publishPost(input: ProviderPublishInput): Promise<ProviderWriteOutcome> {
  const accessToken = readString(input.credentials, "accessToken");
  if (accessToken === undefined) {
    return { status: "failed", disposition: "not_applied", retryable: false, reason: "auth" };
  }
  const apiHost = httpsOrigin(readString(input.credentials, "apiHost"));
  if (apiHost === undefined) {
    return { status: "failed", disposition: "not_applied", retryable: false, reason: "validation" };
  }
  const text = readString(input.frozen.payload, "text");
  if (text === undefined) {
    return { status: "failed", disposition: "not_applied", retryable: false, reason: "validation" };
  }

  const query = new URLSearchParams({
    text,
    media_type: THREADS_MEDIA_TYPE_TEXT,
    auto_publish_text: String(THREADS_AUTO_PUBLISH_TEXT),
  });

  let result: ProviderHttpResult;
  try {
    const request: ProviderHttpRequest = {
      url: `${apiHost}${THREADS_CREATE_PATH}?${query.toString()}`,
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
      signal: input.context.signal,
    };
    result = await input.context.transport.request(request);
  } catch {
    // A write that may already have been sent must not be reported as applied or
    // not applied; the outcome stays unknown.
    return { status: "unknown", disposition: "unknown", reason: "network" };
  }

  const outcome = classifyWrite(result, input.context.now);
  if (outcome.status !== "succeeded") {
    return outcome;
  }

  // The only evidence-backed URL for an account is its profile URL. No post
  // permalink format is evidenced, so none is invented.
  const username = readString(input.credentials, "username");
  const url = username === undefined ? undefined : `${THREADS_PROFILE_ORIGIN}/@${username}`;
  return { ...outcome, ...(url === undefined ? {} : { url }) };
}

/**
 * Schema for the whole declaration. Unknown keys are rejected everywhere
 * (`additionalProperties: false`) and nothing is coerced.
 *
 * `connectOptions` carries the registered redirect URI, the two hosts (each
 * defaulting to the collection's `.net` value so the pair is never silently
 * mixed), an optional scope list, and optionally the app client so a machine
 * caller can skip the interactive prompt.
 *
 * `credentialInput` is the interactive app client: the non-secret client id and
 * the client secret the CLI reads with echo disabled.
 *
 * `publishOptions` is the text the provider actually sends. `media_type` and
 * `auto_publish_text` are pinned by the provider, not caller options.
 */
const manifest: ProviderManifest = {
  id: THREADS_PROVIDER_ID,
  name: "Threads",
  version: THREADS_PROVIDER_VERSION,
  apiVersion: 1,
  declaredCapabilities: ["text"],
  // The Meta-published default pair; a caller that pins another pair must be
  // reflected in the deployment's egress policy, because the transport
  // allowlist is built from this declaration.
  egress: { fixedOrigins: [THREADS_DEFAULT_AUTHORIZATION_HOST, THREADS_DEFAULT_API_HOST] },
  schemas: {
    connectOptions: {
      type: "object",
      additionalProperties: false,
      required: ["redirectUri"],
      properties: {
        redirectUri: { type: "string", minLength: 1 },
        apiHost: { type: "string", minLength: 1 },
        authorizationHost: { type: "string", minLength: 1 },
        scopes: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        clientId: { type: "string", minLength: 1 },
        clientSecret: { type: "string", minLength: 1 },
      },
    },
    credentialInput: {
      type: "object",
      additionalProperties: false,
      required: ["client_id", "client_secret"],
      properties: {
        client_id: { type: "string", minLength: 1 },
        client_secret: { type: "string", minLength: 1 },
      },
    },
    content: {
      type: "object",
      additionalProperties: false,
      properties: { text: { type: "string", minLength: 1 } },
    },
    publishOptions: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", minLength: 1 } },
    },
  },
};

/** The provider plugin, validated structurally by `defineProvider`. */
const plugin: ProviderPlugin = defineProvider({
  manifest,
  connect: { run: runConnect, verify: verifyConnect },
  freeze: freezePost,
  publish: publishPost,
});

export default plugin;
