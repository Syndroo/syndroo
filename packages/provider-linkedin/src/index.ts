/**
 * `@syndroo/provider-linkedin` — official architecture-v1 Provider for LinkedIn
 * (the REST Posts API, not the legacy `ugcPosts` shape).
 *
 * Scope and honesty of this implementation:
 *
 * - text posts only (`declaredCapabilities: ["text"]`), published immediately
 *   with `lifecycleState: PUBLISHED` through `POST /rest/posts`;
 * - authentication is the LinkedIn three-legged authorization-code flow. **PKCE
 *   is deliberately absent**: the evidence found no primary documentation of a
 *   `code_challenge` on LinkedIn's token endpoint, so no PKCE parameter is ever
 *   sent or advertised;
 * - the posting author is `urn:li:person:{id}`, and the member `id` is resolved
 *   by `GET /v2/me`, which LinkedIn documents as deprecated. `GET /v2/userinfo`
 *   is deliberately *not* used for the author: its `sub` is unique per app, not
 *   a stable global member id, so reading it as the author id would be a guess.
 *   When `/v2/me` cannot yield an id the connection fails closed;
 * - `LinkedIn-Version` is a pinned package constant, not a clock or a config, so
 *   the compiled request is reproducible byte for byte;
 * - the commentary maximum length is UNRESOLVED upstream and is not modelled.
 *   Freeze enforces only a non-empty commentary and a whole-payload byte ceiling
 *   (a transport-safety bound, not a platform limit). Over-limit content is
 *   rejected, never truncated.
 *
 * The module is inert on import. It reads no clock, no environment, no
 * filesystem and no network; every byte that leaves the process does so through
 * the injected `ProviderContext.transport`. `freeze` is a pure function of its
 * input, so the same input produces byte-identical output. The client secret and
 * the access token are never copied into a frozen payload, a preview, a write
 * outcome or a thrown error.
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
  Json,
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
export const LINKEDIN_PROVIDER_VERSION = "0.7.0-rc.1";

/** Provider id. Also the package-name suffix and the registry key. */
export const LINKEDIN_PROVIDER_ID = "linkedin";

/** The member-facing origin this provider binds an account to. */
export const LINKEDIN_ORIGIN = "https://www.linkedin.com";

/**
 * The pinned REST API version sent as `LinkedIn-Version`, in `YYYYMM` form.
 *
 * This is a package constant, chosen and reviewed here, never read from a clock
 * or the environment. Bumping it is a code change a reviewer sees.
 */
export const LINKEDIN_VERSION = "202601";

/** The header LinkedIn requires the pinned version in. */
export const LINKEDIN_VERSION_HEADER = "LinkedIn-Version";

/** Hosts and paths. All are global; LinkedIn has no per-connection instance. */
export const LINKEDIN_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
export const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
export const LINKEDIN_MEMBER_URL = "https://api.linkedin.com/v2/me";
export const LINKEDIN_POSTS_URL = "https://api.linkedin.com/rest/posts";

/**
 * The scopes the flow asks for by default. `w_member_social` posts as the
 * member; `openid` and `profile` are OIDC scopes. All are evidence-backed.
 */
export const LINKEDIN_DEFAULT_SCOPES = ["w_member_social", "openid", "profile"] as const;

/** `lifecycleState: PUBLISHED` publishes immediately; that is the only state. */
export const LIFECYCLE_STATE_PUBLISHED = "PUBLISHED";

/** The only author selection implemented. Organizations are not supported. */
export const AUTHOR_SELECTOR_MEMBER = "member";

/**
 * A transport-safety ceiling on the serialized request body, in UTF-8 bytes.
 *
 * This is deliberately **not** a platform limit: LinkedIn's commentary maximum
 * is UNRESOLVED in the evidence, so no character or byte bound is modelled as
 * one. This number only stops one submission from building an unbounded body.
 */
export const MAX_PAYLOAD_BYTES = 1_000_000;

/** Where the posting identity came from, deprecation included. */
export const MEMBER_ID_EVIDENCE_SOURCE = "https://api.linkedin.com/v2/me (deprecated)";

/**
 * Stable failure codes raised by this provider. Never carries a secret.
 */
export type LinkedinProviderErrorCode =
  | "input_invalid"
  | "redirect_invalid"
  | "entropy_unavailable"
  | "oauth_material_invalid"
  | "credential_rejected"
  | "callback_rejected"
  | "state_mismatch"
  | "redirect_mismatch"
  | "member_id_unavailable"
  | "commentary_missing"
  | "visibility_missing"
  | "author_unsupported"
  | "distribution_invalid"
  | "payload_too_large"
  | "provider_unavailable";

/**
 * A stable, secret-free provider error.
 *
 * Every message is a fixed sentence. The only interpolated value is a byte count
 * this module measured, so no client secret or access token can reach a log, an
 * error serializer or a stack trace through this type.
 */
export class LinkedinProviderError extends Error {
  readonly code: LinkedinProviderErrorCode;

  constructor(code: LinkedinProviderErrorCode, message: string) {
    super(message);
    this.name = "LinkedinProviderError";
    this.code = code;
  }
}

const REDIRECT_INVALID_MESSAGE = "The LinkedIn redirect URI must be an absolute URI without userinfo or a fragment.";
const ENTROPY_UNAVAILABLE_MESSAGE = "No cryptographic random source is available for the OAuth state.";
const OAUTH_MATERIAL_INVALID_MESSAGE = "The LinkedIn connect session is missing its OAuth material.";
const CREDENTIAL_MISSING_MESSAGE = "The LinkedIn connection is missing its app client credentials.";
const CREDENTIAL_REJECTED_MESSAGE = "LinkedIn rejected the supplied credentials.";
const CALLBACK_REJECTED_MESSAGE = "LinkedIn rejected the authorization callback.";
const STATE_MISMATCH_MESSAGE = "The authorization callback state does not match this connect session.";
const REDIRECT_MISMATCH_MESSAGE = "The authorization callback redirect URI does not match this connect session.";
const MEMBER_ID_MISSING_MESSAGE = "LinkedIn did not report the member id this provider needs to author a post.";
const COMMENTARY_MISSING_MESSAGE = "The LinkedIn post needs non-empty commentary.";
const VISIBILITY_MISSING_MESSAGE = "The LinkedIn post needs a non-empty visibility.";
const AUTHOR_UNSUPPORTED_MESSAGE = "Only the member author selection is implemented.";
const DISTRIBUTION_INVALID_MESSAGE = "The LinkedIn distribution option must be a JSON object.";
const ACCOUNT_MISSING_MESSAGE = "The LinkedIn account is missing its member id.";
const UNAVAILABLE_MESSAGE = "The LinkedIn request could not be completed.";

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

/** True for a JSON object that is not an array and not `null`. */
function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/**
 * Accept an absolute redirect URI: https anywhere, http only on loopback, or a
 * private-use scheme (the shapes a desktop OAuth client can actually receive).
 * The value is stored verbatim, because LinkedIn compares it with the app's
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
    throw new LinkedinProviderError("entropy_unavailable", ENTROPY_UNAVAILABLE_MESSAGE);
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
 * - 2xx is a definite acceptance. The created post URN arrives in the
 *   `x-restli-id` response header, so it is reported as the remote id when the
 *   header is present;
 * - 429 is a definite, non-applied, retryable rejection with the wait time the
 *   server asked for;
 * - other 4xx is a definite rejection and never retried here;
 * - 5xx, an unexpected status, and a `possibly_sent` transport error are
 *   ambiguous, so they stay `unknown` and are never reported as `not_applied`.
 *   A 201 whose response was lost in transit is exactly that case: the post may
 *   exist and its URN is unknowable, so the outcome stays `unknown`.
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
    const urn = headerValue(result.headers, "x-restli-id");
    return { status: "succeeded", ...(urn === undefined ? {} : { remoteId: urn }) };
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
    throw new LinkedinProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
  }
}

/** Build the authorize URL the human opens. No PKCE parameter is ever added. */
function authorizeUrl(
  clientId: string,
  redirectUri: string,
  scopes: readonly string[],
  state: string,
): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: scopes.join(" "),
  });
  return `${LINKEDIN_AUTHORIZE_URL}?${query.toString()}`;
}

/**
 * Exchange an authorization code for an access token, or reject stably.
 *
 * The form carries only parameters the evidence documents: `grant_type`,
 * `code`, `client_id`, `client_secret` and `redirect_uri`. No `code_verifier`
 * and no `code_challenge` are sent, because PKCE is an assumption upstream, not
 * a verified fact.
 */
async function exchangeCode(
  form: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  },
  context: ProviderContext,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: form.code,
    client_id: form.clientId,
    client_secret: form.clientSecret,
    redirect_uri: form.redirectUri,
  });

  const result = await send(context, {
    url: LINKEDIN_TOKEN_URL,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: context.signal,
  });

  if (result.type === "transport_error") {
    throw new LinkedinProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
  }
  if (result.status >= 200 && result.status < 300) {
    const accessToken = readString(parseJsonObject(result.body), "access_token");
    if (accessToken === undefined) {
      throw new LinkedinProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
    }
    return accessToken;
  }
  // A rejected or already-used authorization code lands here.
  if (result.status >= 400 && result.status < 500) {
    throw new LinkedinProviderError("callback_rejected", CALLBACK_REJECTED_MESSAGE);
  }
  throw new LinkedinProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
}

/**
 * Resolve the posting member id through the deprecated `/v2/me` endpoint.
 *
 * Reading `id` from this response is the only place a member id is accepted.
 * `userinfo.sub` is deliberately never read as an author id: it is app-scoped,
 * and treating it as the member id would be a guess the evidence warns against.
 * When the endpoint cannot yield an id, the connection fails closed.
 */
async function resolveMemberId(accessToken: string, context: ProviderContext): Promise<string> {
  const result = await send(context, {
    url: LINKEDIN_MEMBER_URL,
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}` },
    signal: context.signal,
  });

  if (result.type === "transport_error") {
    throw new LinkedinProviderError("provider_unavailable", UNAVAILABLE_MESSAGE);
  }
  if (result.status === 401 || result.status === 403) {
    throw new LinkedinProviderError("credential_rejected", CREDENTIAL_REJECTED_MESSAGE);
  }
  if (result.status >= 200 && result.status < 300) {
    const id = readString(parseJsonObject(result.body), "id");
    if (id !== undefined) {
      return id;
    }
  }
  throw new LinkedinProviderError("member_id_unavailable", MEMBER_ID_MISSING_MESSAGE);
}

/** The verified identity for one member, keyed by the member id. */
function identityFor(memberId: string, now: IsoTime): VerifiedIdentity {
  const account: AccountIdentity = {
    provider: LINKEDIN_PROVIDER_ID,
    accountId: memberId,
    origin: LINKEDIN_ORIGIN,
  };
  return {
    account,
    evidence: [
      { capability: "identity", value: "supported", source: MEMBER_ID_EVIDENCE_SOURCE, verifiedAt: now },
    ],
  };
}

/** The state a connect session needs before an app client is known. */
type PendingState = { redirectUri: string; scopes: string[] };

/** The state a connect session needs to finish the authorization code flow. */
type AuthorizationState = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  state: string;
};

/** Read the pre-client private state, or `undefined` when it is incomplete. */
function pendingStateOf(privateState: JsonObject): PendingState | undefined {
  const redirectUri = absoluteRedirectUri(readString(privateState, "redirectUri"));
  const scopes = readStringArray(privateState, "scopes");
  if (redirectUri === undefined || scopes === undefined) {
    return undefined;
  }
  return { redirectUri, scopes };
}

/** Read the authorization private state, or `undefined` when it is incomplete. */
function authorizationStateOf(privateState: JsonObject): AuthorizationState | undefined {
  const clientId = readString(privateState, "clientId");
  const clientSecret = readString(privateState, "clientSecret");
  const redirectUri = absoluteRedirectUri(readString(privateState, "redirectUri"));
  const scopes = readStringArray(privateState, "scopes");
  const state = readString(privateState, "state");
  if (
    clientId === undefined ||
    clientSecret === undefined ||
    redirectUri === undefined ||
    scopes === undefined ||
    state === undefined
  ) {
    return undefined;
  }
  return { clientId, clientSecret, redirectUri, scopes, state };
}

/** The credential-input action asking for the app client id and secret. */
const CLIENT_CREDENTIAL_ACTION: ConnectAction = Object.freeze({
  type: "credential_input",
  fields: Object.freeze([
    Object.freeze({ name: "client_id", label: "LinkedIn client id", secret: false }),
    Object.freeze({ name: "client_secret", label: "LinkedIn client secret", secret: true }),
  ]),
});

/**
 * Run one step of the connect protocol.
 *
 * `start` either builds the authorization action straight away, when the app's
 * client id and secret were supplied as options, or asks for them with a
 * `credential_input` action whose secret field the CLI reads with echo disabled.
 * A `credentials` resume turns the pending redirect/scopes into the
 * authorization action; a `callback` resume exchanges the code and resolves the
 * posting identity.
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
      throw new LinkedinProviderError("redirect_invalid", REDIRECT_INVALID_MESSAGE);
    }
    const scopes = readStringArray(input.options, "scopes") ?? [...LINKEDIN_DEFAULT_SCOPES];

    const suppliedId = readString(input.options, "clientId");
    const suppliedSecret = readString(input.options, "clientSecret");
    if ((suppliedId === undefined) !== (suppliedSecret === undefined)) {
      throw new LinkedinProviderError(
        "input_invalid",
        "A pre-registered app needs both clientId and clientSecret.",
      );
    }

    if (suppliedId === undefined || suppliedSecret === undefined) {
      const privateState = deepFreezeJson({ redirectUri, scopes });
      return { status: "action_required", action: CLIENT_CREDENTIAL_ACTION, privateState };
    }

    const state = upstream?.state ?? base64Url(randomBytes(32));
    const privateState = deepFreezeJson({
      clientId: suppliedId,
      clientSecret: suppliedSecret,
      redirectUri,
      scopes,
      state,
    });
    const action: ConnectAction = Object.freeze({
      type: "open_url",
      url: authorizeUrl(suppliedId, redirectUri, scopes, state),
    });
    return { status: "action_required", action, privateState };
  }

  if (input.input.type === "credentials") {
    const pending = pendingStateOf(input.privateState);
    if (pending === undefined) {
      throw new LinkedinProviderError("oauth_material_invalid", OAUTH_MATERIAL_INVALID_MESSAGE);
    }
    const clientId = readString(input.input.credentials, "client_id");
    const clientSecret = readString(input.input.credentials, "client_secret");
    if (clientId === undefined || clientSecret === undefined) {
      throw new LinkedinProviderError("credential_rejected", CREDENTIAL_MISSING_MESSAGE);
    }
    const state = context.oauth?.state ?? base64Url(randomBytes(32));
    const privateState = deepFreezeJson({
      clientId,
      clientSecret,
      redirectUri: pending.redirectUri,
      scopes: pending.scopes,
      state,
    });
    const action: ConnectAction = Object.freeze({
      type: "open_url",
      url: authorizeUrl(clientId, pending.redirectUri, pending.scopes, state),
    });
    return { status: "action_required", action, privateState };
  }

  const material = authorizationStateOf(input.privateState);
  if (material === undefined) {
    throw new LinkedinProviderError("oauth_material_invalid", OAUTH_MATERIAL_INVALID_MESSAGE);
  }

  const evidence: CallbackEvidence = input.input.evidence;
  if (evidence.state !== material.state) {
    throw new LinkedinProviderError("state_mismatch", STATE_MISMATCH_MESSAGE);
  }
  if (evidence.redirectUri !== material.redirectUri) {
    throw new LinkedinProviderError("redirect_mismatch", REDIRECT_MISMATCH_MESSAGE);
  }
  const code = readString({ code: evidence.code }, "code");
  if (code === undefined) {
    throw new LinkedinProviderError("callback_rejected", CALLBACK_REJECTED_MESSAGE);
  }
  if (context.oauth !== undefined) {
    if (context.oauth.state !== material.state) {
      throw new LinkedinProviderError("state_mismatch", STATE_MISMATCH_MESSAGE);
    }
    if (context.oauth.redirectUri !== material.redirectUri) {
      throw new LinkedinProviderError("redirect_mismatch", REDIRECT_MISMATCH_MESSAGE);
    }
  }

  const accessToken = await exchangeCode(
    {
      code,
      clientId: material.clientId,
      clientSecret: material.clientSecret,
      redirectUri: material.redirectUri,
    },
    context,
  );
  const memberId = await resolveMemberId(accessToken, context);

  return {
    status: "done",
    // The bundle Core persists: the access token. The member id is the account
    // identity, not a secret.
    credentials: { accessToken },
    identity: identityFor(memberId, context.now),
  };
}

/** Re-verify a stored connection: the token still resolves the member id. */
async function verifyConnect(
  credentials: CredentialBundle,
  context: ProviderContext,
): Promise<VerifiedIdentity> {
  const accessToken = readString(credentials, "accessToken");
  if (accessToken === undefined) {
    throw new LinkedinProviderError("credential_rejected", CREDENTIAL_MISSING_MESSAGE);
  }
  const memberId = await resolveMemberId(accessToken, context);
  return identityFor(memberId, context.now);
}

/**
 * Compile the frozen request body: the exact `POST /rest/posts` JSON.
 *
 * Deterministic from the freeze input alone. The pinned `LinkedIn-Version` is
 * carried in the effective options and the preview so the compiled request's
 * version is visible and auditable; publish sends it as the header. The
 * commentary maximum is UNRESOLVED, so the only bounds here are a non-empty
 * commentary and a transport-safety byte ceiling on the whole body.
 */
function freezePost(input: FreezeInput): FrozenProviderPayload {
  const commentary = readString(input.options, "commentary");
  if (commentary === undefined) {
    throw new LinkedinProviderError("commentary_missing", COMMENTARY_MISSING_MESSAGE);
  }
  const visibility = readString(input.options, "visibility");
  if (visibility === undefined) {
    throw new LinkedinProviderError("visibility_missing", VISIBILITY_MISSING_MESSAGE);
  }
  const authorSelector = readString(input.options, "author") ?? AUTHOR_SELECTOR_MEMBER;
  if (authorSelector !== AUTHOR_SELECTOR_MEMBER) {
    throw new LinkedinProviderError("author_unsupported", AUTHOR_UNSUPPORTED_MESSAGE);
  }
  const memberId = readString({ accountId: input.account.accountId }, "accountId");
  if (memberId === undefined) {
    throw new LinkedinProviderError("input_invalid", ACCOUNT_MISSING_MESSAGE);
  }

  const distribution = input.options["distribution"];
  if (distribution !== undefined && !isJsonObject(distribution)) {
    throw new LinkedinProviderError("distribution_invalid", DISTRIBUTION_INVALID_MESSAGE);
  }

  const author = `urn:li:person:${memberId}`;
  const payload: JsonObject = {
    author,
    commentary,
    visibility,
    lifecycleState: LIFECYCLE_STATE_PUBLISHED,
    // The distribution value is UNRESOLVED upstream, so nothing is invented:
    // the field is sent only when the operator supplied it.
    ...(isJsonObject(distribution) ? { distribution } : {}),
  };

  const serialized = JSON.stringify(payload);
  const bytes = utf8ByteLength(serialized);
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new LinkedinProviderError(
      "payload_too_large",
      `the compiled LinkedIn request body is ${bytes} bytes; this provider allows ${MAX_PAYLOAD_BYTES}`,
    );
  }

  const text = readString(input.content, "text");
  const effectiveContent: { text?: string } = text === undefined ? {} : { text };
  const effectiveOptions: JsonObject = {
    commentary,
    visibility,
    author: authorSelector,
    linkedinVersion: LINKEDIN_VERSION,
    ...(isJsonObject(distribution) ? { distribution } : {}),
  };
  const fields: PreviewField[] = [
    { name: "commentary", value: commentary },
    { name: "visibility", value: visibility },
    { name: "author", value: authorSelector },
    { name: "author_urn", value: author },
    { name: "lifecycle_state", value: LIFECYCLE_STATE_PUBLISHED },
    { name: "linkedinVersion", value: LINKEDIN_VERSION },
    ...(isJsonObject(distribution)
      ? [{ name: "distribution", value: distribution } satisfies PreviewField]
      : []),
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
 * Publish the compiled post with the pinned version header. This provider never
 * retries: exactly one request leaves the process per publish call.
 */
async function publishPost(input: ProviderPublishInput): Promise<ProviderWriteOutcome> {
  const accessToken = readString(input.credentials, "accessToken");
  if (accessToken === undefined) {
    return { status: "failed", disposition: "not_applied", retryable: false, reason: "auth" };
  }
  if (readString({ accountId: input.account.accountId }, "accountId") === undefined) {
    return { status: "failed", disposition: "not_applied", retryable: false, reason: "validation" };
  }

  let result: ProviderHttpResult;
  try {
    const request: ProviderHttpRequest = {
      url: LINKEDIN_POSTS_URL,
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        [LINKEDIN_VERSION_HEADER]: LINKEDIN_VERSION,
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
 * `connectOptions` carries the redirect URI the app registered, an optional
 * scope list (defaulting to the verified set), and optionally the app client id
 * and secret so a machine caller can skip the interactive prompt.
 *
 * `credentialInput` is the interactive app client: the non-secret client id and
 * the client secret the CLI reads with echo disabled.
 *
 * `publishOptions` is the verified `rest/posts` body surface this version
 * supports. `distribution` is an explicit pass-through because its value is
 * UNRESOLVED upstream; `linkedinVersion` is pinned by the schema (`const`) and
 * may not be overridden. Only the member author selector is accepted.
 */
const manifest: ProviderManifest = {
  id: LINKEDIN_PROVIDER_ID,
  name: "LinkedIn",
  version: LINKEDIN_PROVIDER_VERSION,
  apiVersion: 1,
  declaredCapabilities: ["text"],
  // Two hosts: the OAuth endpoints on www.linkedin.com and the REST API on api.linkedin.com.
  egress: { fixedOrigins: ["https://www.linkedin.com", "https://api.linkedin.com"] },
  schemas: {
    connectOptions: {
      type: "object",
      additionalProperties: false,
      required: ["redirectUri"],
      properties: {
        redirectUri: { type: "string", minLength: 1 },
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
      required: ["commentary", "visibility"],
      properties: {
        commentary: { type: "string", minLength: 1 },
        visibility: { type: "string", minLength: 1 },
        author: { type: "string", enum: [AUTHOR_SELECTOR_MEMBER] },
        distribution: { type: "object" },
        linkedinVersion: { type: "string", const: LINKEDIN_VERSION },
      },
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
