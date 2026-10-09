/**
 * `@syndroo/provider-devto` — official architecture-v1 Provider for DEV.to
 * (Forem).
 *
 * Scope and honesty of this implementation:
 *
 * - markdown articles only (`declaredCapabilities: ["article"]`). The article
 *   body is the explicit `body_markdown` option, so a target that publishes an
 *   article is allowed an empty shared `content` (architecture §3.1). No HTML
 *   body, no `main_image`, no `series`, no `organization_id`, and no update
 *   escape hatch in this first version;
 * - authentication is a per-user API key sent in the `api-key` header — not
 *   Bearer, not OAuth. Identity is `GET /api/users/me`;
 * - publishing is a single `POST /api/articles` with the article body shape
 *   `{ article: { title, body_markdown, published, tags?, canonical_url?,
 *   description? } }`.
 *
 * The module is inert on import. It reads no clock, no environment, no
 * filesystem and no network; every byte that leaves the process does so through
 * the injected `ProviderContext.transport`. `freeze` is a pure function of its
 * input, so the same input always produces byte-identical output. No secret —
 * the API key — is ever copied into a frozen payload, a preview, a write
 * outcome or a thrown error.
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
  Json,
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
 * suite reads the manifest file and fails the build on drift.
 */
export const DEVTO_PROVIDER_VERSION = "0.7.0-rc.1";

/** Provider id. Also the package-name suffix and the registry key. */
export const DEVTO_PROVIDER_ID = "devto";

/** Application origin a verified account is keyed to. */
export const DEVTO_ORIGIN = "https://dev.to";

/** API host. DEV.to serves the published site and the API from one origin. */
export const DEVTO_API_HOST = "https://dev.to";

/** Identity endpoint. */
export const USERS_ME_URL = `${DEVTO_API_HOST}/api/users/me`;

/** Article creation endpoint. */
export const CREATE_ARTICLE_URL = `${DEVTO_API_HOST}/api/articles`;

/** Authentication header name. */
export const API_KEY_HEADER = "api-key";

/**
 * Stable failure codes raised by this provider. Never carries a secret.
 *
 * There is deliberately no title-length or rate-limit code here: the evidence
 * leaves the exact title maximum and the v1 rate limits unresolved, so this
 * provider invents neither.
 */
export type DevtoProviderErrorCode =
  | "credential_rejected"
  | "provider_unavailable"
  | "title_missing"
  | "body_missing"
  | "tags_invalid"
  | "draft_not_supported";

/**
 * A stable, secret-free provider error.
 *
 * The message is chosen from fixed sentences; the API key is never passed in,
 * so nothing sensitive can reach a log, an error serializer or a stack trace
 * through this type.
 */
export class DevtoProviderError extends Error {
  readonly code: DevtoProviderErrorCode;

  constructor(code: DevtoProviderErrorCode, message: string) {
    super(message);
    this.name = "DevtoProviderError";
    this.code = code;
  }
}

const CREDENTIAL_REJECTED_MESSAGE =
  "DEV.to rejected the supplied API key.";
const IDENTITY_UNAVAILABLE_MESSAGE =
  "The DEV.to identity request could not be completed.";
const IDENTITY_INCOMPLETE_MESSAGE =
  "The DEV.to user response did not carry a user id or username.";
const CONNECT_INPUT_MISSING_MESSAGE =
  "DEV.to connect requires a non-empty API key.";
const TITLE_MISSING_MESSAGE =
  "The DEV.to article needs a non-empty title.";
const BODY_MISSING_MESSAGE =
  "The DEV.to article needs a non-empty body_markdown.";
const DRAFT_NOT_SUPPORTED_MESSAGE =
  "published: false is not supported; Syndroo publishes articles, it does not store drafts.";
const TAGS_INVALID_MESSAGE =
  "The DEV.to article option `tags` must be an array of non-empty strings.";

/** Credential fields the CLI prompts for on a controlling terminal. */
const CREDENTIAL_FIELDS: readonly { name: string; label: string; secret: boolean }[] = [
  { name: "apiKey", label: "DEV.to API key", secret: true },
];

const CREDENTIAL_ACTION: ConnectAction = Object.freeze({
  type: "credential_input",
  fields: Object.freeze(CREDENTIAL_FIELDS),
});

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

/**
 * The account id for a DEV.to user: the immutable numeric id rendered as a
 * string, falling back to the username only when the id is absent.
 */
function accountIdFor(user: JsonObject | undefined): string | undefined {
  const id = readString(user, "id") ?? readIdNumber(user);
  return id ?? readString(user, "username");
}

function readIdNumber(record: JsonObject | undefined): string | undefined {
  const value = record?.["id"];
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

/** The verified identity for one user, keyed by the stable user id. */
function identityFor(accountId: string, now: IsoTime): VerifiedIdentity {
  const account: AccountIdentity = {
    provider: DEVTO_PROVIDER_ID,
    accountId,
    origin: DEVTO_ORIGIN,
  };
  return {
    account,
    evidence: [
      { capability: "identity", value: "supported", source: DEVTO_API_HOST, verifiedAt: now },
    ],
  };
}

/**
 * Resolve the API key into an identity through the injected transport.
 *
 * Success yields the stable account id; 401/403 is a stable credential failure;
 * anything else is a stable provider failure. A thrown error carries a fixed
 * sentence only — the API key stays inside this function.
 */
async function requestIdentity(apiKey: string, context: ProviderContext): Promise<string> {
  let result: ProviderHttpResult;
  try {
    result = await context.transport.request({
      url: USERS_ME_URL,
      method: "GET",
      headers: { [API_KEY_HEADER]: apiKey },
      signal: context.signal,
    });
  } catch {
    // The transport contract returns errors rather than throwing; a throw here
    // is ambiguous, so it becomes the same stable unavailable failure.
    throw new DevtoProviderError("provider_unavailable", IDENTITY_UNAVAILABLE_MESSAGE);
  }

  if (result.type === "transport_error") {
    throw new DevtoProviderError("provider_unavailable", IDENTITY_UNAVAILABLE_MESSAGE);
  }

  if (result.status >= 200 && result.status < 300) {
    const accountId = accountIdFor(parseJsonObject(result.body));
    if (accountId === undefined) {
      throw new DevtoProviderError("provider_unavailable", IDENTITY_INCOMPLETE_MESSAGE);
    }
    return accountId;
  }

  if (result.status === 401 || result.status === 403) {
    throw new DevtoProviderError("credential_rejected", CREDENTIAL_REJECTED_MESSAGE);
  }

  throw new DevtoProviderError("provider_unavailable", IDENTITY_UNAVAILABLE_MESSAGE);
}

async function runConnect(
  input: ProviderConnectInput,
  context: ProviderContext,
): Promise<ProviderConnectResult> {
  if (input.type === "resume" && input.input.type === "credentials") {
    const apiKey = readString(input.input.credentials, "apiKey");
    if (apiKey === undefined) {
      throw new DevtoProviderError("credential_rejected", CONNECT_INPUT_MISSING_MESSAGE);
    }
    const accountId = await requestIdentity(apiKey, context);
    return {
      status: "done",
      // The bundle Core persists: the API key that re-authenticates later. It
      // never leaves the secret store.
      credentials: { apiKey },
      identity: identityFor(accountId, context.now),
    };
  }

  // `start`, and any resume this provider does not model, ask for the field.
  return { status: "action_required", action: CREDENTIAL_ACTION, privateState: {} };
}

async function verifyConnect(
  credentials: CredentialBundle,
  context: ProviderContext,
): Promise<VerifiedIdentity> {
  const apiKey = readString(credentials, "apiKey");
  if (apiKey === undefined) {
    throw new DevtoProviderError("credential_rejected", CONNECT_INPUT_MISSING_MESSAGE);
  }
  const accountId = await requestIdentity(apiKey, context);
  return identityFor(accountId, context.now);
}

/** Read the article title, rejecting a missing or empty one. */
function titleOf(options: JsonObject): string {
  const title = readString(options, "title");
  if (title === undefined) {
    throw new DevtoProviderError("title_missing", TITLE_MISSING_MESSAGE);
  }
  return title;
}

/** Read the article body, rejecting a missing or empty one. */
function bodyOf(options: JsonObject): string {
  const body = readString(options, "body_markdown");
  if (body === undefined) {
    throw new DevtoProviderError("body_missing", BODY_MISSING_MESSAGE);
  }
  return body;
}

/** Read an optional non-empty string option. */
function optionalString(options: JsonObject, key: string): string | undefined {
  return readString(options, key);
}

/**
 * Read the optional tag list, or `undefined` when it was not supplied.
 *
 * The evidence does not state a tag count or tag-length limit, so none is
 * invented here; an item that is not a non-empty string is rejected rather than
 * coerced.
 */
function tagsOf(options: JsonObject): Json[] | undefined {
  const value = options["tags"];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new DevtoProviderError("tags_invalid", TAGS_INVALID_MESSAGE);
  }
  const tags: Json[] = [];
  for (const tag of value) {
    if (typeof tag !== "string" || tag.length === 0) {
      throw new DevtoProviderError("tags_invalid", TAGS_INVALID_MESSAGE);
    }
    tags.push(tag);
  }
  return tags;
}

/**
 * Compile the frozen payload: the exact create-article request, deterministic
 * from the freeze input alone. `published` is always true; a request for a
 * draft is rejected here rather than silently upgraded.
 */
function freezeDevto(input: FreezeInput): FrozenProviderPayload {
  const title = titleOf(input.options);
  const body = bodyOf(input.options);

  if (input.options["published"] === false) {
    throw new DevtoProviderError("draft_not_supported", DRAFT_NOT_SUPPORTED_MESSAGE);
  }

  const tags = tagsOf(input.options);
  const canonicalUrl = optionalString(input.options, "canonical_url");
  const description = optionalString(input.options, "description");

  // Effective content mirrors the supplied content exactly (Core compares the
  // two canonically). For an article target the shared content carries no
  // article body, so it is preserved verbatim and shown in the preview.
  const effectiveContent: Content =
    input.content.text === undefined ? {} : { text: input.content.text };

  const article: JsonObject = {
    title,
    body_markdown: body,
    published: true,
    ...(tags === undefined ? {} : { tags }),
    ...(canonicalUrl === undefined ? {} : { canonical_url: canonicalUrl }),
    ...(description === undefined ? {} : { description }),
  };
  const payload: JsonObject = { article };

  // Every effective option is exposed, in a fixed order, in the preview.
  const effectiveOptions: JsonObject = { title, body_markdown: body, published: true };
  const fields: PreviewField[] = [
    { name: "title", value: title },
    { name: "body_markdown", value: body },
    { name: "published", value: true },
  ];
  if (tags !== undefined) {
    effectiveOptions["tags"] = tags;
    fields.push({ name: "tags", value: tags });
  }
  if (canonicalUrl !== undefined) {
    effectiveOptions["canonical_url"] = canonicalUrl;
    fields.push({ name: "canonical_url", value: canonicalUrl });
  }
  if (description !== undefined) {
    effectiveOptions["description"] = description;
    fields.push({ name: "description", value: description });
  }

  return deepFreezeJson({
    payloadVersion: 1 as const,
    payload,
    effectiveContent,
    effectiveOptions,
    preview: { content: { ...effectiveContent }, fields },
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

/** Public article URL from a create response, or `undefined` when unrecognised. */
function articleUrl(parsed: JsonObject | undefined): string | undefined {
  const url = readString(parsed, "url");
  if (url !== undefined && url.startsWith("https://")) {
    return url;
  }
  const path = readString(parsed, "path");
  if (path !== undefined && path.startsWith("/") && !path.startsWith("//")) {
    return `${DEVTO_ORIGIN}${path}`;
  }
  return undefined;
}

/**
 * Classify one returned transport result.
 *
 * - 2xx is a definite acceptance, so the outcome is `succeeded` and carries the
 *   article id and, when present, its public URL;
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
    const remoteId = readString(parsed, "id") ?? readIdNumber(parsed);
    const url = articleUrl(parsed);
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
 * Publish the compiled article with the API key in the `api-key` header.
 *
 * A missing key is a stable `auth` failure and sends nothing. This provider
 * never retries: exactly one request leaves the process per publish call.
 */
async function publishDevto(input: ProviderPublishInput): Promise<ProviderWriteOutcome> {
  const apiKey = readString(input.credentials, "apiKey");
  if (apiKey === undefined) {
    return { status: "failed", disposition: "not_applied", retryable: false, reason: "auth" };
  }

  let result: ProviderHttpResult;
  try {
    const request: ProviderHttpRequest = {
      url: CREATE_ARTICLE_URL,
      method: "POST",
      headers: { "content-type": "application/json", [API_KEY_HEADER]: apiKey },
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
 * `publishOptions` is exactly the create-article body fields this first version
 * supports, using the verified API field names. `series`, `main_image` and
 * `organization_id` are deliberately absent (no HTML, no media, no org), and no
 * title-length or tag-count limit is claimed because the evidence has none.
 */
const manifest: ProviderManifest = {
  id: DEVTO_PROVIDER_ID,
  name: "DEV.to",
  version: DEVTO_PROVIDER_VERSION,
  apiVersion: 1,
  declaredCapabilities: ["article"],
  // The only host this provider calls: the public DEV.to API origin.
  egress: { fixedOrigins: ["https://dev.to"] },
  schemas: {
    connectOptions: { type: "object", additionalProperties: false },
    credentialInput: {
      type: "object",
      additionalProperties: false,
      required: ["apiKey"],
      properties: { apiKey: { type: "string", minLength: 1 } },
    },
    content: {
      type: "object",
      additionalProperties: false,
      properties: { text: { type: "string" } },
    },
    publishOptions: {
      type: "object",
      additionalProperties: false,
      required: ["title", "body_markdown"],
      properties: {
        title: { type: "string", minLength: 1 },
        body_markdown: { type: "string", minLength: 1 },
        published: { type: "boolean" },
        tags: { type: "array", items: { type: "string", minLength: 1 } },
        canonical_url: { type: "string", minLength: 1 },
        description: { type: "string", minLength: 1 },
      },
    },
  },
};

/** The provider plugin, validated structurally by `defineProvider`. */
const plugin: ProviderPlugin = defineProvider({
  manifest,
  connect: { run: runConnect, verify: verifyConnect },
  freeze: freezeDevto,
  publish: publishDevto,
});

export default plugin;
