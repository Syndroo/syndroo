/**
 * `@syndroo/provider-mastodon` — official architecture-v1 Provider for
 * Mastodon (and other ActivityPub servers speaking the Mastodon API).
 *
 * Scope and honesty of this implementation:
 *
 * - federated by construction: the instance host is user-supplied and is the
 *   origin of every request, the stored account identity and the connection.
 *   There is no global Mastodon host;
 * - text statuses only (`declaredCapabilities: ["text"]`), with a single
 *   `visibility` option. The post body is the shared `content.text`;
 * - authentication is a real Authorization Code flow with PKCE (S256), which
 *   the upstream docs require for native clients: app registration, an
 *   authorization action, then a callback exchange. The client secret and the
 *   PKCE verifier never leave the connect session's secret private state;
 * - the character limit is per instance. It is read from `/api/v2/instance`
 *   during connect/verify and enforced at freeze; it is never hardcoded, and an
 *   unreadable limit fails closed instead of assuming a default;
 * - publishing is one `POST /api/v1/statuses` with a deterministic
 *   `Idempotency-Key`. The provider still never retries and an unknown write is
 *   never reclassified — the key only lets the server recognise a replay.
 *
 * The module is inert on import. It reads no clock, no environment, no
 * filesystem and no network; every byte that leaves the process does so through
 * the injected `ProviderContext.transport`. `freeze` is a pure function of its
 * input plus the instance limit learned earlier in the same process, so the
 * same input produces byte-identical output. No secret — client secret, PKCE
 * verifier, authorization code or access token — is ever copied into a frozen
 * payload, a preview, a write outcome or a thrown error.
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
export const MASTODON_PROVIDER_VERSION = "0.7.0-rc.1";

/** Provider id. Also the package-name suffix and the registry key. */
export const MASTODON_PROVIDER_ID = "mastodon";

/** Display name registered with each instance's `/api/v1/apps`. */
export const DEFAULT_CLIENT_NAME = "Syndroo";

/** API paths, always resolved against the user-supplied instance origin. */
export const APP_REGISTRATION_PATH = "/api/v1/apps";
export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/oauth/token";
export const VERIFY_CREDENTIALS_PATH = "/api/v1/accounts/verify_credentials";
export const INSTANCE_PATH = "/api/v2/instance";
export const STATUSES_PATH = "/api/v1/statuses";

/** Header that lets the server recognise a replayed identical request. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/**
 * Stable failure codes raised by this provider. Never carries a secret.
 *
 * There is deliberately no character-limit constant here: the limit is
 * per-instance and is read at runtime.
 */
export type MastodonProviderErrorCode =
  | "input_invalid"
  | "instance_invalid"
  | "redirect_invalid"
  | "entropy_unavailable"
  | "oauth_material_invalid"
  | "app_registration_rejected"
  | "credential_rejected"
  | "callback_rejected"
  | "state_mismatch"
  | "redirect_mismatch"
  | "limit_unavailable"
  | "text_missing"
  | "visibility_missing"
  | "text_too_long"
  | "provider_unavailable";

/**
 * A stable, secret-free provider error.
 *
 * Every message is a fixed sentence. The only interpolated values are
 * non-negative integers this module measured, so no token, verifier, client
 * secret or authorization code can reach a log, an error serializer or a stack
 * trace through this type.
 */
export class MastodonProviderError extends Error {
  readonly code: MastodonProviderErrorCode;

  constructor(code: MastodonProviderErrorCode, message: string) {
    super(message);
    this.name = "MastodonProviderError";
    this.code = code;
  }
}

const INSTANCE_INVALID_MESSAGE =
  "The Mastodon instance must be an absolute https URL.";
const REDIRECT_INVALID_MESSAGE =
  "The Mastodon redirect URI must be an absolute URI without userinfo or a fragment.";
const ENTROPY_UNAVAILABLE_MESSAGE =
  "No cryptographic random source is available for the PKCE verifier and state.";
const OAUTH_MATERIAL_INVALID_MESSAGE =
  "The Mastodon connect session is missing its OAuth material.";
const REGISTRATION_REJECTED_MESSAGE =
  "The Mastodon instance rejected the app registration.";
const CREDENTIAL_REJECTED_MESSAGE =
  "The Mastodon instance rejected the supplied access token.";
const CALLBACK_REJECTED_MESSAGE =
  "The Mastodon instance rejected the authorization callback.";
const STATE_MISMATCH_MESSAGE =
  "The authorization callback state does not match this connect session.";
const REDIRECT_MISMATCH_MESSAGE =
  "The authorization callback redirect URI does not match this connect session.";
const LIMIT_UNAVAILABLE_MESSAGE =
  "The Mastodon instance did not report a status character limit.";
const UNAVAILABLE_MESSAGE =
  "The Mastodon request could not be completed.";
const TEXT_MISSING_MESSAGE =
  "The Mastodon status needs non-empty text.";
const VISIBILITY_MISSING_MESSAGE =
  "The Mastodon status needs a non-empty visibility option.";
const CONNECT_INPUT_MISSING_MESSAGE =
  "The Mastodon connection is missing its instance or access token.";

/**
 * Per-instance status character limits learned at connect/verify time, keyed by
 * instance origin. `freeze` is synchronous and performs no I/O, so the limit it
 * enforces must have been read earlier in the same process; a cold entry fails
 * closed rather than assuming a number.
 */
const INSTANCE_LIMITS = new Map<string, number>();

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

/** Normalise a user-supplied instance to its https origin, or reject it. */
function instanceOrigin(value: string | undefined): string | undefined {
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
 * private-use scheme (the shapes a native OAuth client can actually receive).
 * The value is stored verbatim, because the server compares it with the
 * registration byte for byte.
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

/** Encode bytes as base64url without padding (RFC 7636 / RFC 4648 §5). */
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
    throw new MastodonProviderError("entropy_unavailable", ENTROPY_UNAVAILABLE_MESSAGE);
  }
  const bytes = new Uint8Array(length);
  bag.getRandomValues(bytes);
  return bytes;
}

/** base64url(SHA-256(ascii(value))): the S256 PKCE challenge. */
async function s256Challenge(value: string): Promise<string> {
  const bag = (globalThis as { crypto?: Crypto }).crypto;
  if (bag === undefined || bag.subtle === undefined) {
    throw new MastodonProviderError("entropy_unavailable", ENTROPY_UNAVAILABLE_MESSAGE);
  }
  const digest = await bag.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

/** Character count used against the instance limit: Unicode code points. */
export function characterCount(value: string): number {
  let count = 0;
  for (const _character of value) {
    count += 1;
  }
  return count;
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
 * - 2xx is a definite acceptance, so the outcome is `succeeded` and carries the
 *   status id and, when present, its public URL;
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
    const parsed = parseJsonObject(result.body);
    const remoteId = readString(parsed, "id");
    const url = readString(parsed, "url");
    return {
      status: "succeeded",
      ...(remoteId === undefined ? {} : { remoteId }),
      ...(url === undefined || !url.startsWith("https://") ? {} : { url }),
    };
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
    throw new MastodonProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
  }
}

/** Register a client application, or reject with a stable code. */
async function registerApp(
  instance: string,
  redirectUri: string,
  scopes: readonly string[],
  context: ProviderContext,
): Promise<{ clientId: string; clientSecret: string }> {
  const result = await send(context, {
    url: `${instance}${APP_REGISTRATION_PATH}`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: DEFAULT_CLIENT_NAME,
      redirect_uris: redirectUri,
      scopes: scopes.join(" "),
    }),
    signal: context.signal,
  });

  if (result.type === "transport_error") {
    throw new MastodonProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
  }
  if (result.status >= 200 && result.status < 300) {
    const parsed = parseJsonObject(result.body);
    const clientId = readString(parsed, "client_id");
    const clientSecret = readString(parsed, "client_secret");
    if (clientId === undefined || clientSecret === undefined) {
      throw new MastodonProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
    }
    return { clientId, clientSecret };
  }
  if (result.status >= 400 && result.status < 500) {
    throw new MastodonProviderError("app_registration_rejected", REGISTRATION_REJECTED_MESSAGE);
  }
  throw new MastodonProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
}

/** Exchange an authorization code for an access token, or reject stably. */
async function exchangeCode(
  instance: string,
  form: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: readonly string[];
    codeVerifier: string;
  },
  context: ProviderContext,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: form.code,
    client_id: form.clientId,
    client_secret: form.clientSecret,
    redirect_uri: form.redirectUri,
    scope: form.scopes.join(" "),
    code_verifier: form.codeVerifier,
  });

  const result = await send(context, {
    url: `${instance}${TOKEN_PATH}`,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: context.signal,
  });

  if (result.type === "transport_error") {
    throw new MastodonProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
  }
  if (result.status >= 200 && result.status < 300) {
    const accessToken = readString(parseJsonObject(result.body), "access_token");
    if (accessToken === undefined) {
      throw new MastodonProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
    }
    return accessToken;
  }
  // A rejected or already-used authorization code lands here.
  if (result.status >= 400 && result.status < 500) {
    throw new MastodonProviderError("callback_rejected", CALLBACK_REJECTED_MESSAGE);
  }
  throw new MastodonProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
}

/** Verify an access token and return the instance-local account id. */
async function verifyToken(
  instance: string,
  accessToken: string,
  context: ProviderContext,
): Promise<string> {
  const result = await send(context, {
    url: `${instance}${VERIFY_CREDENTIALS_PATH}`,
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}` },
    signal: context.signal,
  });

  if (result.type === "transport_error") {
    throw new MastodonProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
  }
  if (result.status >= 200 && result.status < 300) {
    const parsed = parseJsonObject(result.body);
    const id = readString(parsed, "id") ?? readNumericId(parsed);
    if (id === undefined) {
      throw new MastodonProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
    }
    return id;
  }
  if (result.status === 401 || result.status === 403) {
    throw new MastodonProviderError("credential_rejected", CREDENTIAL_REJECTED_MESSAGE);
  }
  throw new MastodonProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
}

function readNumericId(record: JsonObject | undefined): string | undefined {
  const value = record?.["id"];
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

/**
 * Read the instance's status character limit and cache it for `freeze`.
 *
 * Fails closed: an instance that does not report a positive integer limit is an
 * error, never a default of 500.
 */
async function loadInstanceLimit(instance: string, context: ProviderContext): Promise<number> {
  const result = await send(context, {
    url: `${instance}${INSTANCE_PATH}`,
    method: "GET",
    signal: context.signal,
  });

  if (result.type === "transport_error" || result.status < 200 || result.status >= 300) {
    throw new MastodonProviderError("limit_unavailable", LIMIT_UNAVAILABLE_MESSAGE);
  }

  const parsed = parseJsonObject(result.body);
  const configuration = parsed?.["configuration"];
  const statuses =
    configuration !== null && typeof configuration === "object" && !Array.isArray(configuration)
      ? (configuration as JsonObject)["statuses"]
      : undefined;
  const maxCharacters =
    statuses !== null && typeof statuses === "object" && !Array.isArray(statuses)
      ? (statuses as JsonObject)["max_characters"]
      : undefined;

  if (
    typeof maxCharacters !== "number" ||
    !Number.isSafeInteger(maxCharacters) ||
    maxCharacters <= 0
  ) {
    throw new MastodonProviderError("limit_unavailable", LIMIT_UNAVAILABLE_MESSAGE);
  }

  INSTANCE_LIMITS.set(instance, maxCharacters);
  return maxCharacters;
}

/** The verified identity for one account, keyed by the instance-local id. */
function identityFor(accountId: string, instance: string, now: IsoTime): VerifiedIdentity {
  const account: AccountIdentity = {
    provider: MASTODON_PROVIDER_ID,
    accountId,
    origin: instance,
  };
  return {
    account,
    evidence: [
      { capability: "identity", value: "supported", source: instance, verifiedAt: now },
    ],
  };
}

type ConnectState = {
  instance: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeVerifier: string;
  codeChallenge: string;
};

/** Read the private connect state Core stored for this connect session. */
function connectStateOf(privateState: JsonObject): ConnectState | undefined {
  const instance = instanceOrigin(readString(privateState, "instance"));
  const clientId = readString(privateState, "clientId");
  const clientSecret = readString(privateState, "clientSecret");
  const redirectUri = absoluteRedirectUri(readString(privateState, "redirectUri"));
  const scopes = readStringArray(privateState, "scopes");
  const state = readString(privateState, "state");
  const codeVerifier = readString(privateState, "codeVerifier");
  const codeChallenge = readString(privateState, "codeChallenge");
  if (
    instance === undefined ||
    clientId === undefined ||
    clientSecret === undefined ||
    redirectUri === undefined ||
    scopes === undefined ||
    state === undefined ||
    codeVerifier === undefined ||
    codeChallenge === undefined
  ) {
    return undefined;
  }
  return { instance, clientId, clientSecret, redirectUri, scopes, state, codeVerifier, codeChallenge };
}

/** Build the authorization URL the human opens in a browser. */
function authorizeUrl(
  instance: string,
  clientId: string,
  redirectUri: string,
  scopes: readonly string[],
  state: string,
  codeChallenge: string,
): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${instance}${AUTHORIZE_PATH}?${query.toString()}`;
}

/**
 * Step one: register the application (unless a client was supplied) and return
 * the authorization action.
 *
 * The client secret and PKCE verifier live only in the returned `privateState`,
 * which Core stores as a connect-session secret and never renders. The action
 * URL carries the challenge, never the verifier or the secret.
 */
async function runConnect(
  input: ProviderConnectInput,
  context: ProviderContext,
): Promise<ProviderConnectResult> {
  if (input.type === "start") {
    const instance = instanceOrigin(readString(input.options, "instance"));
    if (instance === undefined) {
      throw new MastodonProviderError("instance_invalid", INSTANCE_INVALID_MESSAGE);
    }

    const upstream: OAuthMaterial | undefined = context.oauth;
    const redirectUri = absoluteRedirectUri(
      upstream?.redirectUri ?? readString(input.options, "redirectUri"),
    );
    if (redirectUri === undefined) {
      throw new MastodonProviderError("redirect_invalid", REDIRECT_INVALID_MESSAGE);
    }
    const scopes = readStringArray(input.options, "scopes");
    if (scopes === undefined) {
      throw new MastodonProviderError("input_invalid", "The Mastodon connection needs at least one scope.");
    }

    const suppliedId = readString(input.options, "clientId");
    const suppliedSecret = readString(input.options, "clientSecret");
    if ((suppliedId === undefined) !== (suppliedSecret === undefined)) {
      throw new MastodonProviderError("input_invalid", "A pre-registered client needs both clientId and clientSecret.");
    }
    const client =
      suppliedId !== undefined && suppliedSecret !== undefined
        ? { clientId: suppliedId, clientSecret: suppliedSecret }
        : await registerApp(instance, redirectUri, scopes, context);

    const verifier = upstream?.codeVerifier ?? base64Url(randomBytes(32));
    if (upstream?.codeChallenge !== undefined && upstream.codeVerifier === undefined) {
      throw new MastodonProviderError("oauth_material_invalid", OAUTH_MATERIAL_INVALID_MESSAGE);
    }
    const challenge = upstream?.codeChallenge ?? (await s256Challenge(verifier));
    const state = upstream?.state ?? base64Url(randomBytes(32));

    const privateState = deepFreezeJson({
      instance,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri,
      scopes,
      state,
      codeVerifier: verifier,
      codeChallenge: challenge,
    });

    const action: ConnectAction = Object.freeze({
      type: "open_url",
      url: authorizeUrl(instance, client.clientId, redirectUri, scopes, state, challenge),
    });
    return { status: "action_required", action, privateState };
  }

  if (input.input.type !== "callback") {
    // A credentials resume carries nothing this flow needs; ask for the
    // authorization action again rather than inventing a token import.
    return { status: "action_required", action: CREDENTIALLESS_ACTION, privateState: input.privateState };
  }

  const material = connectStateOf(input.privateState);
  if (material === undefined) {
    throw new MastodonProviderError("oauth_material_invalid", OAUTH_MATERIAL_INVALID_MESSAGE);
  }

  const evidence: CallbackEvidence = input.input.evidence;
  if (evidence.state !== material.state) {
    throw new MastodonProviderError("state_mismatch", STATE_MISMATCH_MESSAGE);
  }
  if (evidence.redirectUri !== material.redirectUri) {
    throw new MastodonProviderError("redirect_mismatch", REDIRECT_MISMATCH_MESSAGE);
  }
  const code = readString({ code: evidence.code }, "code");
  if (code === undefined) {
    throw new MastodonProviderError("callback_rejected", CALLBACK_REJECTED_MESSAGE);
  }
  if (context.oauth !== undefined) {
    if (context.oauth.state !== material.state) {
      throw new MastodonProviderError("state_mismatch", STATE_MISMATCH_MESSAGE);
    }
    if (context.oauth.redirectUri !== material.redirectUri) {
      throw new MastodonProviderError("redirect_mismatch", REDIRECT_MISMATCH_MESSAGE);
    }
  }

  const accessToken = await exchangeCode(
    material.instance,
    {
      code,
      clientId: material.clientId,
      clientSecret: material.clientSecret,
      redirectUri: material.redirectUri,
      scopes: material.scopes,
      codeVerifier: material.codeVerifier,
    },
    context,
  );
  const accountId = await verifyToken(material.instance, accessToken, context);
  await loadInstanceLimit(material.instance, context);

  return {
    status: "done",
    // The bundle Core persists: the instance binding and the access token. It
    // never leaves the secret store.
    credentials: { instance: material.instance, accessToken },
    identity: identityFor(accountId, material.instance, context.now),
  };
}

const CREDENTIALLESS_ACTION: ConnectAction = Object.freeze({ type: "wait_for_callback" });

/**
 * Re-verify a stored connection: the token still works, and the instance still
 * reports a character limit we can enforce.
 */
async function verifyConnect(
  credentials: CredentialBundle,
  context: ProviderContext,
): Promise<VerifiedIdentity> {
  const instance = instanceOrigin(readString(credentials, "instance"));
  const accessToken = readString(credentials, "accessToken");
  if (instance === undefined || accessToken === undefined) {
    throw new MastodonProviderError("input_invalid", CONNECT_INPUT_MISSING_MESSAGE);
  }
  const accountId = await verifyToken(instance, accessToken, context);
  await loadInstanceLimit(instance, context);
  return identityFor(accountId, instance, context.now);
}

/**
 * Compile the frozen payload: the exact `POST /api/v1/statuses` body.
 *
 * Deterministic from the freeze input alone, apart from the instance character
 * limit read at connect/verify time. That limit is never hardcoded: a cold entry
 * fails closed, and an over-limit status is rejected rather than truncated.
 */
function freezeStatus(input: FreezeInput): FrozenProviderPayload {
  const text = readString(input.content, "text");
  if (text === undefined) {
    throw new MastodonProviderError("text_missing", TEXT_MISSING_MESSAGE);
  }
  const visibility = readString(input.options, "visibility");
  if (visibility === undefined) {
    throw new MastodonProviderError("visibility_missing", VISIBILITY_MISSING_MESSAGE);
  }
  const instance = instanceOrigin(input.account.origin);
  if (instance === undefined) {
    throw new MastodonProviderError("instance_invalid", INSTANCE_INVALID_MESSAGE);
  }

  const limit = INSTANCE_LIMITS.get(instance);
  if (limit === undefined) {
    throw new MastodonProviderError("limit_unavailable", LIMIT_UNAVAILABLE_MESSAGE);
  }
  const length = characterCount(text);
  if (length > limit) {
    throw new MastodonProviderError(
      "text_too_long",
      `status text is ${length} characters; ${instance} allows ${limit}`,
    );
  }

  const effectiveContent: { text: string } = { text };
  const effectiveOptions: JsonObject = { visibility };
  const payload: JsonObject = { status: text, visibility };
  const fields: PreviewField[] = [
    { name: "visibility", value: visibility },
    { name: "max_characters", value: limit },
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
 * Publish the compiled status with the access token and a deterministic
 * idempotency key. This provider never retries: exactly one request leaves the
 * process per publish call.
 */
async function publishStatus(input: ProviderPublishInput): Promise<ProviderWriteOutcome> {
  const accessToken = readString(input.credentials, "accessToken");
  if (accessToken === undefined) {
    return { status: "failed", disposition: "not_applied", retryable: false, reason: "auth" };
  }
  const instance = instanceOrigin(input.account.origin);
  if (instance === undefined) {
    return { status: "failed", disposition: "not_applied", retryable: false, reason: "validation" };
  }

  const submissionId = readString({ submissionId: input.submissionId }, "submissionId");
  const idempotencyKey = submissionId === undefined ? undefined : `syndroo-${submissionId}`;

  let result: ProviderHttpResult;
  try {
    const request: ProviderHttpRequest = {
      url: `${instance}${STATUSES_PATH}`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        ...(idempotencyKey === undefined ? {} : { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey }),
      },
      body: JSON.stringify(input.frozen.payload),
      signal: input.context.signal,
    };
    result = await input.context.transport.request(request);
  } catch {
    // A write that may already have been sent must not be reported as applied or
    // not applied; the outcome stays unknown.
    return { status: "unknown", disposition: "unknown", reason: "network" };
  }

  return classifyWrite(result, input.context.now);
}

/**
 * Schema for the whole declaration. Unknown keys are rejected everywhere
 * (`additionalProperties: false`) and nothing is coerced.
 *
 * `connectOptions` carries the instance host and everything the OAuth flow
 * needs: where the callback lands, which scopes to register, and optionally an
 * already-registered client. Scope names are supplied by the caller; this
 * provider does not invent them, and the server rejects ones it does not know.
 *
 * `publishOptions` is the single status field this first version supports
 * beyond the text. Visibility is required rather than defaulted, because the
 * instance/account default is not knowable here and the preview must show the
 * visibility the status will publish with.
 */
const manifest: ProviderManifest = {
  id: MASTODON_PROVIDER_ID,
  name: "Mastodon",
  version: MASTODON_PROVIDER_VERSION,
  apiVersion: 1,
  declaredCapabilities: ["text"],
  // The instance origin is operator-supplied, so no fixed origin can be declared.
  egress: { fixedOrigins: [], federated: true },
  schemas: {
    connectOptions: {
      type: "object",
      additionalProperties: false,
      required: ["instance", "redirectUri", "scopes"],
      properties: {
        instance: { type: "string", minLength: 1, pattern: "^https://[^\\s]+$" },
        redirectUri: { type: "string", minLength: 1 },
        scopes: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        clientId: { type: "string", minLength: 1 },
        clientSecret: { type: "string", minLength: 1 },
      },
    },
    credentialInput: { type: "object", additionalProperties: false },
    content: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", minLength: 1 } },
    },
    publishOptions: {
      type: "object",
      additionalProperties: false,
      required: ["visibility"],
      properties: { visibility: { type: "string", minLength: 1 } },
    },
  },
};

/** The provider plugin, validated structurally by `defineProvider`. */
const plugin: ProviderPlugin = defineProvider({
  manifest,
  connect: { run: runConnect, verify: verifyConnect },
  freeze: freezeStatus,
  publish: publishStatus,
});

export default plugin;
