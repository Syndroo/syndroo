/**
 * `@syndroo/provider-bluesky` — the first official architecture-v1 Provider.
 *
 * Scope and honesty of this implementation:
 *
 * - text posts only (`declaredCapabilities: ["text"]`), through the AT Protocol
 *   record `app.bsky.feed.post` published with a single `createRecord` call;
 * - authentication is an app password exchanged for an access token with
 *   `com.atproto.server.createSession` sent as an `application/json` body. This
 *   endpoint does **not** use HTTP basic auth; the credentials are `identifier`
 *   and `password` in the JSON body;
 * - the returned session token is passed to `createRecord` as an HTTPS
 *   `Authorization: Bearer …` header, never in a request body.
 *
 * The module is inert on import. It reads no clock, no environment, no
 * filesystem and no network; every byte that leaves the process does so through
 * the injected `ProviderContext.transport`. `freeze` is a pure function of its
 * input, so the same input always produces byte-identical output. No secret
 * — app password or access token — is ever copied into a frozen payload, a
 * preview, a write outcome or a thrown error.
 */

import { defineProvider } from "@syndroo/provider-sdk";
import type {
  AccountIdentity,
  ConnectAction,
  Content,
  CredentialBundle,
  FreezeInput,
  FrozenProviderPayload,
  IsoTime,
  JsonObject,
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
 * suite reads the manifest file and fails the build on drift, which is what the
 * architecture requires of every Provider.
 */
export const BLUESKY_PROVIDER_VERSION = "0.7.0-rc.1";

/** Provider id. Also the package-name suffix and the registry key. */
export const BLUESKY_PROVIDER_ID = "bluesky";

/** Hosted AT Protocol entryway that serves the XRPC methods used here. */
export const BLUESKY_API_HOST = "https://bsky.social";

/** Public application origin a verified account is keyed to. */
export const BLUESKY_ORIGIN = "https://bsky.app";

/** Session creation endpoint (JSON body, not HTTP basic auth). */
export const CREATE_SESSION_URL = `${BLUESKY_API_HOST}/xrpc/com.atproto.server.createSession`;

/** Record creation endpoint (Bearer access token). */
export const CREATE_RECORD_URL = `${BLUESKY_API_HOST}/xrpc/com.atproto.repo.createRecord`;

/** Collection a post record is written to. */
export const POST_COLLECTION = "app.bsky.feed.post";

/** Lexicon NSID stored as the record `$type`. */
export const POST_RECORD_TYPE = "app.bsky.feed.post";

/**
 * AT Protocol post-text limits, both verified in the `app.bsky.feed.post`
 * lexicon: `text` is at most 3000 bytes and at most 300 graphemes. Both must be
 * enforced; the smaller in effect wins for any given string.
 */
export const MAX_TEXT_BYTES = 3000;
export const MAX_TEXT_GRAPHEMES = 300;

/** Stable failure codes raised by this provider. Never carries a secret. */
export type BlueskyProviderErrorCode =
  | "credential_rejected"
  | "provider_unavailable"
  | "text_too_many_bytes"
  | "text_too_many_graphemes";

/**
 * A stable, secret-free provider error.
 *
 * The message is chosen from fixed sentences and the only interpolated values
 * are non-negative integers this module measured. The two credential fields and
 * the access token are never passed in, so nothing sensitive can reach a log, an
 * error serializer or a stack trace through this type.
 */
export class BlueskyProviderError extends Error {
  readonly code: BlueskyProviderErrorCode;

  constructor(code: BlueskyProviderErrorCode, message: string) {
    super(message);
    this.name = "BlueskyProviderError";
    this.code = code;
  }
}

const CREDENTIAL_REJECTED_MESSAGE =
  "Bluesky rejected the supplied identifier and app password.";
const SESSION_UNAVAILABLE_MESSAGE =
  "The Bluesky session request could not be completed.";
const SESSION_INCOMPLETE_MESSAGE =
  "The Bluesky session response did not carry an access token and a DID.";
const CONNECT_INPUT_MISSING_MESSAGE =
  "Bluesky connect requires a non-empty identifier and app password.";

/** Credential fields the CLI prompts for on a controlling terminal. */
const CREDENTIAL_FIELDS: readonly { name: string; label: string; secret: boolean }[] = [
  { name: "identifier", label: "Bluesky handle or email", secret: false },
  { name: "password", label: "App password", secret: true },
];

const CREDENTIAL_ACTION: ConnectAction = Object.freeze({
  type: "credential_input",
  fields: Object.freeze(CREDENTIAL_FIELDS),
});

/**
 * UTF-8 byte length, computed by hand so this module depends on no Node-only
 * `Buffer` and picks up no `node:` import.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/**
 * User-perceived grapheme count. `Intl.Segmenter` follows the Unicode text
 * segmentation rules the AT Protocol lexicon's "grapheme" bound refers to, so a
 * combining sequence or an emoji ZWJ family counts once, not once per code unit.
 */
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

export function graphemeCount(value: string): number {
  let count = 0;
  for (const _segment of GRAPHEME_SEGMENTER.segment(value)) {
    count += 1;
  }
  return count;
}

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

type SessionMaterial = { readonly accessJwt: string; readonly did: string };

/** The verified identity for one session, keyed by the immutable DID. */
function identityFor(session: SessionMaterial, now: IsoTime): VerifiedIdentity {
  const account: AccountIdentity = {
    provider: BLUESKY_PROVIDER_ID,
    accountId: session.did,
    origin: BLUESKY_ORIGIN,
  };
  return {
    account,
    evidence: [
      { capability: "identity", value: "supported", source: BLUESKY_API_HOST, verifiedAt: now },
    ],
  };
}

/**
 * Exchange an identifier and app password for a session through the injected
 * transport. Success yields the session token and the immutable DID; 400/401/403
 * is a stable credential failure; anything else is a stable provider failure.
 *
 * A thrown error carries a fixed sentence only. The typed credentials and the
 * access token stay inside this function.
 */
async function requestSession(
  identifier: string,
  password: string,
  context: ProviderContext,
): Promise<SessionMaterial> {
  let result: ProviderHttpResult;
  try {
    result = await context.transport.request({
      url: CREATE_SESSION_URL,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier, password }),
      signal: context.signal,
    });
  } catch {
    // The transport contract returns errors rather than throwing; a throw here
    // is ambiguous, so it becomes the same stable unavailable failure.
    throw new BlueskyProviderError("provider_unavailable", SESSION_UNAVAILABLE_MESSAGE);
  }

  if (result.type === "transport_error") {
    throw new BlueskyProviderError("provider_unavailable", SESSION_UNAVAILABLE_MESSAGE);
  }

  if (result.status >= 200 && result.status < 300) {
    const parsed = parseJsonObject(result.body);
    const accessJwt = readString(parsed, "accessJwt");
    const did = readString(parsed, "did");
    if (accessJwt === undefined || did === undefined) {
      throw new BlueskyProviderError("provider_unavailable", SESSION_INCOMPLETE_MESSAGE);
    }
    return { accessJwt, did };
  }

  if (result.status === 400 || result.status === 401 || result.status === 403) {
    throw new BlueskyProviderError("credential_rejected", CREDENTIAL_REJECTED_MESSAGE);
  }

  throw new BlueskyProviderError("provider_unavailable", SESSION_UNAVAILABLE_MESSAGE);
}

async function runConnect(
  input: ProviderConnectInput,
  context: ProviderContext,
): Promise<ProviderConnectResult> {
  if (input.type === "resume" && input.input.type === "credentials") {
    const identifier = readString(input.input.credentials, "identifier");
    const password = readString(input.input.credentials, "password");
    if (identifier === undefined || password === undefined) {
      throw new BlueskyProviderError("credential_rejected", CONNECT_INPUT_MISSING_MESSAGE);
    }
    const session = await requestSession(identifier, password, context);
    return {
      status: "done",
      // The bundle Core persists: the app password to re-authenticate later and
      // the session token this connect produced. It never leaves the secret store.
      credentials: { identifier, password, accessJwt: session.accessJwt },
      identity: identityFor(session, context.now),
    };
  }

  // `start`, and any resume this provider does not model, ask for the fields.
  return { status: "action_required", action: CREDENTIAL_ACTION, privateState: {} };
}

async function verifyConnect(
  credentials: CredentialBundle,
  context: ProviderContext,
): Promise<VerifiedIdentity> {
  const identifier = readString(credentials, "identifier");
  const password = readString(credentials, "password");
  if (identifier === undefined || password === undefined) {
    throw new BlueskyProviderError("credential_rejected", CONNECT_INPUT_MISSING_MESSAGE);
  }
  const session = await requestSession(identifier, password, context);
  return identityFor(session, context.now);
}

/**
 * Compile the frozen payload: the exact `createRecord` parameters, with the
 * repo set to the account's DID and a single post record. Deterministic from the
 * freeze input alone — `createdAt` comes from `input.now`, never a clock.
 */
function freezeBluesky(input: FreezeInput): FrozenProviderPayload {
  const text = input.content.text ?? "";

  const bytes = utf8ByteLength(text);
  if (bytes > MAX_TEXT_BYTES) {
    throw new BlueskyProviderError(
      "text_too_many_bytes",
      `post text is ${bytes} UTF-8 bytes; the AT Protocol limit is ${MAX_TEXT_BYTES} bytes`,
    );
  }
  const graphemes = graphemeCount(text);
  if (graphemes > MAX_TEXT_GRAPHEMES) {
    throw new BlueskyProviderError(
      "text_too_many_graphemes",
      `post text is ${graphemes} graphemes; the AT Protocol limit is ${MAX_TEXT_GRAPHEMES} graphemes`,
    );
  }

  // Effective content mirrors the supplied content exactly (Core compares the
  // two canonically); a missing `text` simply publishes an empty record body.
  const effectiveContent: Content =
    input.content.text === undefined ? {} : { text: input.content.text };

  const record: JsonObject = {
    type: POST_RECORD_TYPE,
    text,
    createdAt: input.now,
  };
  const payload: JsonObject = {
    repo: input.account.accountId,
    collection: POST_COLLECTION,
    record,
  };

  const previewFields: PreviewField[] = [{ name: "text", value: text }];

  return deepFreezeJson({
    payloadVersion: 1 as const,
    payload,
    effectiveContent,
    effectiveOptions: {},
    preview: { content: { ...effectiveContent }, fields: previewFields },
  });
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

const AT_URI_PATTERN = /^at:\/\/([^/]+)\/([^/]+)\/([^/?#]+)$/;
const SAFE_AUTHORITY = /^[A-Za-z0-9._:%+-]{1,256}$/;
const SAFE_RECORD_KEY = /^[A-Za-z0-9._~:-]{1,512}$/;

/** Public web URL for a created post, or `undefined` when the URI is unfamiliar. */
function postUrl(uri: string): string | undefined {
  const match = AT_URI_PATTERN.exec(uri);
  if (match === null) {
    return undefined;
  }
  const authority = match[1];
  const collection = match[2];
  const recordKey = match[3];
  if (authority === undefined || collection !== POST_COLLECTION || recordKey === undefined) {
    return undefined;
  }
  if (!SAFE_AUTHORITY.test(authority) || !SAFE_RECORD_KEY.test(recordKey)) {
    return undefined;
  }
  return `${BLUESKY_ORIGIN}/profile/${authority}/post/${recordKey}`;
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
 * - 2xx is a definite acceptance: the record exists, so the outcome is
 *   `succeeded` and carries the record URI and, when parseable, its public URL;
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
    const uri = readString(parsed, "uri");
    const cid = readString(parsed, "cid");
    const remoteId = uri ?? cid;
    const url = uri === undefined ? undefined : postUrl(uri);
    return {
      status: "succeeded",
      ...(remoteId === undefined ? {} : { remoteId }),
      ...(url === undefined ? {} : { url }),
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

/**
 * Publish the compiled record with the session token as a Bearer credential.
 *
 * A missing token is a stable `auth` failure and sends nothing. This provider
 * never retries: exactly one request leaves the process per publish call.
 */
async function publishBluesky(input: ProviderPublishInput): Promise<ProviderWriteOutcome> {
  const token = readString(input.credentials, "accessJwt");
  if (token === undefined) {
    return { status: "failed", disposition: "not_applied", retryable: false, reason: "auth" };
  }

  let result: ProviderHttpResult;
  try {
    const request: ProviderHttpRequest = {
      url: CREATE_RECORD_URL,
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
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
 * (`additionalProperties: false`) and nothing is coerced. `publishOptions` is
 * intentionally empty: this Provider supports no post options beyond the text
 * body, so it claims none.
 */
const manifest: ProviderManifest = {
  id: BLUESKY_PROVIDER_ID,
  name: "Bluesky",
  version: BLUESKY_PROVIDER_VERSION,
  apiVersion: 1,
  declaredCapabilities: ["text"],
  // The only host this provider calls: the public Bluesky API origin.
  egress: { fixedOrigins: [BLUESKY_API_HOST] },
  schemas: {
    connectOptions: { type: "object", additionalProperties: false },
    credentialInput: {
      type: "object",
      additionalProperties: false,
      required: ["identifier", "password"],
      properties: {
        identifier: { type: "string", minLength: 1 },
        password: { type: "string", minLength: 1 },
      },
    },
    content: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string" } },
    },
    publishOptions: { type: "object", additionalProperties: false },
  },
};

/** The provider plugin, validated structurally by `defineProvider`. */
const plugin: ProviderPlugin = defineProvider({
  manifest,
  connect: { run: runConnect, verify: verifyConnect },
  freeze: freezeBluesky,
  publish: publishBluesky,
});

export default plugin;
