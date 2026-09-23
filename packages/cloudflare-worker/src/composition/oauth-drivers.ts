/**
 * Concrete OAuth drivers for the installed platforms.
 *
 * This is Worker composition: it copies plain configuration strings once at
 * construction, reuses the installed adapters' endpoint metadata and the shared
 * bounded transport, and never touches storage, the network or an Env binding
 * object while being built. Protocol state transitions, encryption contexts and
 * revision guards stay in the portable application use cases; this module only
 * speaks the provider protocols.
 *
 * Every request uses the existing 15-second/64 KiB boundary with manual
 * redirects and exactly one underlying fetch per operation. Failures become
 * fixed `OAuthDriverError` reasons; provider text, bodies, codes, state,
 * verifiers and native payloads never leave through an error.
 */

import {
  computeCredentialBinding,
  encodeBindingMaterial,
  OAuthDriverError,
  type BindingMaterial,
  type BindingSigner,
  type OAuthBeginInput,
  type OAuthBeginResult,
  type OAuthConfirmInput,
  type OAuthConfirmResult,
  type OAuthDriver,
  type OAuthDriverResolver,
  type OAuthExchangeInput,
  type OAuthExchangeResult,
  type OAuthRefreshDriver,
  type OAuthRefreshDriverResolver,
  type OAuthRefreshInput,
  type OAuthRefreshResult,
  type OAuthTargetOverrides,
  type IsoInstant,
} from "@syndroo/application";
import type { Platform } from "@syndroo/core";
import { isLinkedInConfigurationValid, linkedinAdapter } from "@syndroo/linkedin";
import { TransportError, boundedRequest, oauth1AuthorizationHeader } from "@syndroo/transport";
import { decodeTumblrUserCredential, normalizeTumblrBlog, tumblrAdapter } from "@syndroo/tumblr";
import { decodeXUserCredential, xAdapter } from "@syndroo/x";

import {
  canonicalCallbackUrl,
  encodeNativePayload,
  expiresAtFromSeconds,
  isOpaqueCredentialValue,
  parseFormResponse,
  parseJsonObjectResponse,
  parseNativePayload,
  parsePublicOrigin,
  requireFixedHttpsEndpoint,
} from "./oauth-protocol-support.js";
import { parseCredentialFields, type InstalledPlatform } from "./platform-credential-decoders.js";

/** Transport policy shared by every concrete request. */
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Fixed, safe configuration failure.
 *
 * Thrown at resolver invocation for a platform this build *can* drive, so the
 * portable use case maps it to "instance configuration unavailable" instead of
 * "unsupported platform". No key name, value or platform text travels with it.
 */
const CONFIGURATION_UNAVAILABLE = "OAuth configuration is unavailable";

/** Platforms this build can drive; everything else is genuinely unsupported. */
const OAUTH_PLATFORMS: readonly Platform[] = Object.freeze(["x", "tumblr", "linkedin"]);

/** Plain-configuration keys of each runtime app group. */
export const X_APP_FIELDS: readonly string[] = Object.freeze(["X_API_KEY", "X_API_SECRET"]);
export const TUMBLR_APP_FIELDS: readonly string[] = Object.freeze([
  "TUMBLR_CONSUMER_KEY",
  "TUMBLR_CONSUMER_SECRET",
]);
export const LINKEDIN_APP_FIELDS: readonly string[] = Object.freeze([
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
]);

export interface OAuthDriverConfigInput {
  /** Plain string configuration; never an Env binding object. */
  readonly values: Readonly<Record<string, string | undefined>>;
  /** Canonical public origin; connect/complete require it, refresh does not. */
  readonly publicUrl: string | null | undefined;
  readonly signer: BindingSigner;
}

export interface LinkedInRefreshConfigInput {
  readonly values: Readonly<Record<string, string | undefined>>;
}

/**
 * Build the connect/callback/complete resolver for x, tumblr and linkedin.
 *
 * Returning null means "this build has no OAuth flow for the platform". For a
 * platform this build can drive, a missing or invalid public origin or an
 * incomplete app group throws a fixed configuration error instead: a
 * misconfiguration is an instance-readiness problem, never a silent
 * unsupported platform.
 */
export function createOAuthDriverResolver(input: OAuthDriverConfigInput): OAuthDriverResolver {
  const values = copyConfigValues(input.values, [
    ...X_APP_FIELDS,
    ...TUMBLR_APP_FIELDS,
    ...LINKEDIN_APP_FIELDS,
  ]);
  const origin = parsePublicOrigin(input.publicUrl ?? null);
  // Capture the signer once: a later mutation of the caller's object must not
  // change how this resolver computes configuration fingerprints.
  const signer = captureSigner(input.signer);
  const fingerprints = new Map<string, Promise<string>>();

  const fingerprint = (key: string, build: () => Promise<string>): Promise<string> => {
    const existing = fingerprints.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const computed = build();
    fingerprints.set(key, computed);
    return computed;
  };

  return async (platform: Platform): Promise<OAuthDriver | null> => {
    if (!OAUTH_PLATFORMS.includes(platform)) {
      return null;
    }
    if (origin === null) {
      throw new Error(CONFIGURATION_UNAVAILABLE);
    }
    const callbackUrl = canonicalCallbackUrl(origin, platform);
    switch (platform) {
      case "x": {
        const app = requireAppGroup(values, X_APP_FIELDS);
        const endpoints = requireOAuth1Endpoints(xAdapter.oauth, callbackUrl);
        const startConfigBinding = await fingerprint("x", () =>
          oauth1ConfigurationBinding({
            platform: "x",
            callbackUrl,
            endpoints,
            appFields: X_APP_FIELDS,
            values,
            signer,
          }),
        );
        return createXOAuth1Driver({ app, endpoints, callbackUrl, startConfigBinding, platform: "x" });
      }
      case "tumblr": {
        const app = requireAppGroup(values, TUMBLR_APP_FIELDS);
        const endpoints = requireOAuth1Endpoints(tumblrAdapter.oauth, callbackUrl);
        const startConfigBinding = await fingerprint("tumblr", () =>
          oauth1ConfigurationBinding({
            platform: "tumblr",
            callbackUrl,
            endpoints,
            appFields: TUMBLR_APP_FIELDS,
            values,
            signer,
          }),
        );
        return createTumblrOAuth1Driver({
          app,
          endpoints,
          callbackUrl,
          startConfigBinding,
          platform: "tumblr",
        });
      }
      case "linkedin": {
        const app = requireAppGroup(values, LINKEDIN_APP_FIELDS);
        const endpoints = requireOAuth2Endpoints(linkedinAdapter.oauth, callbackUrl);
        const startConfigBinding = await fingerprint("linkedin", () =>
          oauth2ConfigurationBinding({
            platform: "linkedin",
            callbackUrl,
            endpoints,
            appFields: LINKEDIN_APP_FIELDS,
            values,
            signer,
          }),
        );
        return createLinkedInDriver({
          app,
          endpoints,
          callbackUrl,
          startConfigBinding,
          platform: "linkedin",
        });
      }
      default:
        // Unreachable: the platform guard above accepts exactly these three.
        return null;
    }
  };
}

/**
 * Build the LinkedIn-only refresh resolver.

 * Refresh needs neither the public origin nor the configuration fingerprint, so
 * it works on an instance whose `SYNDROO_PUBLIC_URL` is absent. Null means
 * "not LinkedIn"; a missing app group is an instance-readiness failure.
 */
export function createLinkedInRefreshResolver(
  input: LinkedInRefreshConfigInput,
): OAuthRefreshDriverResolver {
  const values = copyConfigValues(input.values, LINKEDIN_APP_FIELDS);
  return (platform: Platform): OAuthRefreshDriver | null => {
    if (platform !== "linkedin") {
      return null;
    }
    const app = requireAppGroup(values, LINKEDIN_APP_FIELDS);
    const endpoints = requireOAuth2Endpoints(linkedinAdapter.oauth, "https://invalid.example/callback");
    return createLinkedInRefreshDriver({ app, endpoints, platform: "linkedin" });
  };
}

type AppGroup = Readonly<Record<string, string>>;

function copyConfigValues(
  values: Readonly<Record<string, string | undefined>>,
  keys: readonly string[],
): AppGroup {
  const copied: Record<string, string> = {};
  for (const key of keys) {
    const value = values[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed !== "") {
      copied[key] = trimmed;
    }
  }
  return Object.freeze(copied);
}

/** The complete group, or a fixed configuration failure. */
function requireAppGroup(values: AppGroup, keys: readonly string[]): AppGroup {
  if (keys.some((key) => values[key] === undefined)) {
    throw new Error(CONFIGURATION_UNAVAILABLE);
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, values[key] as string])));
}

interface OAuth1Endpoints {
  readonly requestTokenUrl: string;
  readonly authorizeUrl: string;
  readonly accessTokenUrl: string;
}

interface OAuth2Endpoints {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: string;
}

function requireOAuth1Endpoints(oauth: unknown, callbackUrl: string): OAuth1Endpoints {
  void callbackUrl;
  const metadata = oauth as
    | { readonly type?: string; readonly requestTokenUrl?: unknown; readonly authorizeUrl?: unknown; readonly accessTokenUrl?: unknown }
    | undefined;
  const requestTokenUrl = requireFixedHttpsEndpoint(metadata?.requestTokenUrl);
  const authorizeUrl = requireFixedHttpsEndpoint(metadata?.authorizeUrl);
  const accessTokenUrl = requireFixedHttpsEndpoint(metadata?.accessTokenUrl);
  if (
    metadata?.type !== "oauth1" ||
    requestTokenUrl === null ||
    authorizeUrl === null ||
    accessTokenUrl === null
  ) {
    throw new Error("OAuth1 endpoint metadata is not usable");
  }
  return Object.freeze({ requestTokenUrl, authorizeUrl, accessTokenUrl });
}

function requireOAuth2Endpoints(oauth: unknown, callbackUrl: string): OAuth2Endpoints {
  void callbackUrl;
  const metadata = oauth as
    | { readonly type?: string; readonly authorizationUrl?: unknown; readonly tokenUrl?: unknown; readonly scopes?: unknown }
    | undefined;
  const authorizationUrl = requireFixedHttpsEndpoint(metadata?.authorizationUrl);
  const tokenUrl = requireFixedHttpsEndpoint(metadata?.tokenUrl);
  const scopes = metadata?.scopes;
  if (
    metadata?.type !== "oauth2" ||
    authorizationUrl === null ||
    tokenUrl === null ||
    typeof scopes !== "string" ||
    scopes.trim() === ""
  ) {
    throw new Error("OAuth2 endpoint metadata is not usable");
  }
  return Object.freeze({ authorizationUrl, tokenUrl, scopes: scopes.trim() });
}

/** Domain-separated, versioned tuple: protocol, callback, endpoints and app group. */
async function oauth1ConfigurationBinding(input: {
  readonly platform: Platform;
  readonly callbackUrl: string;
  readonly endpoints: OAuth1Endpoints;
  readonly appFields: readonly string[];
  readonly values: AppGroup;
  readonly signer: BindingSigner;
}): Promise<string> {
  return bindingDigest(input.platform, input.signer, [
    ["protocol", "oauth1"],
    ["callback", input.callbackUrl],
    ["endpoint.request_token", input.endpoints.requestTokenUrl],
    ["endpoint.authorize", input.endpoints.authorizeUrl],
    ["endpoint.access_token", input.endpoints.accessTokenUrl],
    ...input.appFields.map((key) => [key, input.values[key] ?? null] as const),
  ]);
}

async function oauth2ConfigurationBinding(input: {
  readonly platform: Platform;
  readonly callbackUrl: string;
  readonly endpoints: OAuth2Endpoints;
  readonly appFields: readonly string[];
  readonly values: AppGroup;
  readonly signer: BindingSigner;
}): Promise<string> {
  return bindingDigest(input.platform, input.signer, [
    ["protocol", "oauth2"],
    ["callback", input.callbackUrl],
    ["endpoint.authorization", input.endpoints.authorizationUrl],
    ["endpoint.token", input.endpoints.tokenUrl],
    ["scopes", input.endpoints.scopes],
    ...input.appFields.map((key) => [key, input.values[key] ?? null] as const),
  ]);
}

async function bindingDigest(
  platform: Platform,
  signer: BindingSigner,
  fields: readonly (readonly [string, string | null])[],
): Promise<string> {
  // Explicit OAuth configuration domain and version precede the protocol,
  // endpoints, scopes and complete app group, so this digest can never be
  // confused with a publishing connection binding over the same platform.
  const material = encodeBindingMaterial({
    platform,
    source: "env",
    fields: [
      ["domain", "syndroo-oauth-config"],
      ["version", "1"],
      ...fields,
    ],
  });
  return computeCredentialBinding(material, signer);
}

/** Snapshot the injected signer once; a mutation afterwards changes nothing. */
function captureSigner(signer: BindingSigner): BindingSigner {
  if (signer === null || signer === undefined || typeof signer.sign !== "function") {
    throw new Error("OAuth configuration fingerprinting requires a binding signer");
  }
  const sign = signer.sign.bind(signer);
  return Object.freeze({
    sign: (material: BindingMaterial): Promise<string> => sign(material),
  });
}

interface OAuth1DriverInput {
  readonly platform: Platform;
  readonly app: AppGroup;
  readonly endpoints: OAuth1Endpoints;
  readonly callbackUrl: string;
  readonly startConfigBinding: string;
}

interface OAuth2DriverInput {
  readonly platform: Platform;
  readonly app: AppGroup;
  readonly endpoints: OAuth2Endpoints;
  readonly callbackUrl: string;
  readonly startConfigBinding: string;
}

/** One bounded provider request; a fixed reason leaves on every failure. */
async function providerPost(input: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: URLSearchParams;
}): Promise<string> {
  let response;
  try {
    response = await boundedRequest({
      url: input.url,
      method: "POST",
      headers: input.headers,
      ...(input.body === undefined ? {} : { body: input.body }),
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });
  } catch (error) {
    if (error instanceof TransportError) {
      throw new OAuthDriverError(
        error.code === "network" || error.code === "timeout" || error.code === "aborted"
          ? "unavailable"
          : "invalid_response",
      );
    }
    throw new OAuthDriverError("unavailable");
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new OAuthDriverError("denied");
  }
  if (!response.ok) {
    throw new OAuthDriverError(response.status === 429 || response.status >= 500 ? "unavailable" : "invalid_response");
  }
  return response.text();
}

function oauth1Nonce(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function oauth1Timestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

/** Exact signed authorization header for one OAuth1 request. */
async function oauth1Header(input: {
  readonly url: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly token?: string;
  readonly tokenSecret?: string;
  readonly oauthParameters: readonly (readonly [string, string])[];
}): Promise<string> {
  return oauth1AuthorizationHeader({
    method: "POST",
    url: input.url,
    consumerKey: input.consumerKey,
    consumerSecret: input.consumerSecret,
    ...(input.token === undefined ? {} : { token: input.token }),
    ...(input.tokenSecret === undefined ? {} : { tokenSecret: input.tokenSecret }),
    oauthParameters: input.oauthParameters,
    timestamp: oauth1Timestamp(),
    nonce: oauth1Nonce(),
  });
}

function createXOAuth1Driver(input: OAuth1DriverInput): OAuthDriver {
  const consumerKey = input.app["X_API_KEY"] as string;
  const consumerSecret = input.app["X_API_SECRET"] as string;
  return Object.freeze({
    platform: input.platform,
    protocol: "oauth1" as const,
    canonicalCallbackUrl: input.callbackUrl,
    startConfigBinding: input.startConfigBinding,
    async begin({ state, now }: OAuthBeginInput): Promise<OAuthBeginResult> {
      void now;
      const callbackWithState = `${input.callbackUrl}?state=${encodeURIComponent(state)}`;
      const authorization = await oauth1Header({
        url: input.endpoints.requestTokenUrl,
        consumerKey,
        consumerSecret,
        oauthParameters: [["oauth_callback", callbackWithState]],
      });
      const text = await providerPost({
        url: input.endpoints.requestTokenUrl,
        headers: { authorization },
      });
      const granted = parseFormResponse(text, [
        "oauth_token",
        "oauth_token_secret",
        "oauth_callback_confirmed",
      ]);
      if (granted === null || granted["oauth_callback_confirmed"] !== "true") {
        throw new OAuthDriverError("invalid_response");
      }
      const requestToken = requireOpaqueValue(granted["oauth_token"]);
      const requestSecret = requireOpaqueValue(granted["oauth_token_secret"]);
      return {
        authorizationUrl: `${input.endpoints.authorizeUrl}?oauth_token=${encodeURIComponent(requestToken)}`,
        requestToken,
        requestSecret: new TextEncoder().encode(requestSecret),
      };
    },
    async exchange({ callback, requestSecret }: OAuthExchangeInput): Promise<OAuthExchangeResult> {
      const secret = decodeSecret(requestSecret);
      const verifier = requireCallbackValue(callback.verifier);
      const token = requireCallbackValue(callback.requestToken);
      const authorization = await oauth1Header({
        url: input.endpoints.accessTokenUrl,
        consumerKey,
        consumerSecret,
        token,
        tokenSecret: secret,
        oauthParameters: [["oauth_verifier", verifier]],
      });
      const text = await providerPost({
        url: input.endpoints.accessTokenUrl,
        headers: { authorization },
      });
      const granted = parseFormResponse(text, ["oauth_token", "oauth_token_secret"]);
      if (granted === null) {
        throw new OAuthDriverError("invalid_response");
      }
      return {
        plaintext: encodeNativePayload({
          access_token: requireOpaqueValue(granted["oauth_token"]),
          access_token_secret: requireOpaqueValue(granted["oauth_token_secret"]),
        }),
        expiresAt: null,
        target: null,
        missingFields: [],
      };
    },
    confirm({ candidate, target }: OAuthConfirmInput): OAuthConfirmResult {
      requireNoOverrides(target, input.platform);
      // The stored candidate is validated by the installed decoder, so
      // incomplete, malformed or unknown-key payloads never become a connection.
      const fields = requireNativeFields(candidate, "x");
      // Validate with the installed decoder, then keep the *original* opaque
      // values: the provider reader trims, so its return value is evidence of
      // validity, not the token to store.
      try {
        decodeXUserCredential({
          access_token: fields.get("access_token"),
          access_token_secret: fields.get("access_token_secret"),
        });
      } catch {
        throw new OAuthDriverError("invalid_response");
      }
      const accessToken = originalField(fields, "access_token");
      const accessTokenSecret = originalField(fields, "access_token_secret");
      return {
        plaintext: encodeNativePayload({
          access_token: accessToken,
          access_token_secret: accessTokenSecret,
        }),
        target: null,
        missingFields: [],
      };
    },
  });
}

function createTumblrOAuth1Driver(input: OAuth1DriverInput): OAuthDriver {
  const consumerKey = input.app["TUMBLR_CONSUMER_KEY"] as string;
  const consumerSecret = input.app["TUMBLR_CONSUMER_SECRET"] as string;
  return Object.freeze({
    platform: input.platform,
    protocol: "oauth1" as const,
    canonicalCallbackUrl: input.callbackUrl,
    startConfigBinding: input.startConfigBinding,
    async begin({ state, now }: OAuthBeginInput): Promise<OAuthBeginResult> {
      void now;
      const callbackWithState = `${input.callbackUrl}?state=${encodeURIComponent(state)}`;
      const authorization = await oauth1Header({
        url: input.endpoints.requestTokenUrl,
        consumerKey,
        consumerSecret,
        oauthParameters: [["oauth_callback", callbackWithState]],
      });
      const text = await providerPost({
        url: input.endpoints.requestTokenUrl,
        headers: { authorization },
      });
      const granted = parseFormResponse(text, [
        "oauth_token",
        "oauth_token_secret",
        "oauth_callback_confirmed",
      ]);
      if (granted === null || granted["oauth_callback_confirmed"] !== "true") {
        throw new OAuthDriverError("invalid_response");
      }
      const requestToken = requireOpaqueValue(granted["oauth_token"]);
      const requestSecret = requireOpaqueValue(granted["oauth_token_secret"]);
      return {
        authorizationUrl: `${input.endpoints.authorizeUrl}?oauth_token=${encodeURIComponent(requestToken)}`,
        requestToken,
        requestSecret: new TextEncoder().encode(requestSecret),
      };
    },
    async exchange({ callback, requestSecret }: OAuthExchangeInput): Promise<OAuthExchangeResult> {
      const secret = decodeSecret(requestSecret);
      const verifier = requireCallbackValue(callback.verifier);
      const token = requireCallbackValue(callback.requestToken);
      const authorization = await oauth1Header({
        url: input.endpoints.accessTokenUrl,
        consumerKey,
        consumerSecret,
        token,
        tokenSecret: secret,
        oauthParameters: [["oauth_verifier", verifier]],
      });
      const text = await providerPost({
        url: input.endpoints.accessTokenUrl,
        headers: { authorization },
      });
      const granted = parseFormResponse(text, ["oauth_token", "oauth_token_secret"]);
      if (granted === null) {
        throw new OAuthDriverError("invalid_response");
      }
      const issuedToken = requireOpaqueValue(granted["oauth_token"]);
      const issuedSecret = requireOpaqueValue(granted["oauth_token_secret"]);
      return {
        // The OAuth1 access-token response never names a blog, so the operator
        // must confirm the target explicitly.
        plaintext: encodeNativePayload({ token: issuedToken, token_secret: issuedSecret }),
        expiresAt: null,
        target: null,
        missingFields: ["blog"],
      };
    },
    confirm({ candidate, target }: OAuthConfirmInput): OAuthConfirmResult {
      if (target.author !== null || target.apiVersion !== null) {
        throw new OAuthDriverError("invalid_response");
      }
      const fields = requireNativeFields(candidate, "tumblr");
      const blogField = fields.get("blog");
      try {
        decodeTumblrUserCredential({
          token: fields.get("token"),
          token_secret: fields.get("token_secret"),
          ...(blogField === undefined ? {} : { blog: blogField }),
        });
      } catch {
        throw new OAuthDriverError("invalid_response");
      }
      const token = originalField(fields, "token");
      const tokenSecret = originalField(fields, "token_secret");
      const explicitBlog = target.blog === null ? null : validatedBlog(target.blog);
      if (explicitBlog === null) {
        // This exchange defines no provider-confirmed blog field: an arbitrary
        // `blog` inside the candidate is not evidence of provider confirmation,
        // and no discovery request is made to obtain one.
        return {
          plaintext: new Uint8Array(candidate),
          target: null,
          missingFields: ["blog"],
        };
      }
      const label = explicitBlog;
      return {
        plaintext: encodeNativePayload({
          token,
          token_secret: tokenSecret,
          blog: label,
        }),
        target: Object.freeze({ label, source: "user" }),
        missingFields: [],
      };
    },
  });
}

function createLinkedInDriver(input: OAuth2DriverInput): OAuthDriver {
  const clientId = input.app["LINKEDIN_CLIENT_ID"] as string;
  const clientSecret = input.app["LINKEDIN_CLIENT_SECRET"] as string;
  return Object.freeze({
    platform: input.platform,
    protocol: "oauth2" as const,
    canonicalCallbackUrl: input.callbackUrl,
    startConfigBinding: input.startConfigBinding,
    begin({ state }: OAuthBeginInput): Promise<OAuthBeginResult> {
      // No request: the authorization URL carries the confidential-client flow.
      const url = new URL(input.endpoints.authorizationUrl);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", input.callbackUrl);
      url.searchParams.set("state", state);
      url.searchParams.set("scope", input.endpoints.scopes);
      return Promise.resolve({
        authorizationUrl: url.toString(),
        requestToken: null,
        requestSecret: null,
      });
    },
    async exchange({ callback, now }: OAuthExchangeInput): Promise<OAuthExchangeResult> {
      const code = requireCallbackValue(callback.code);
      const text = await providerPost({
        url: input.endpoints.tokenUrl,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: input.callbackUrl,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      const token = requireTokenResponse(text, now);
      return {
        plaintext: encodeNativePayload({
          access_token: token.accessToken,
          ...(token.refreshToken === null ? {} : { refresh_token: token.refreshToken }),
        }),
        expiresAt: token.expiresAt,
        target: null,
        // Author and API version are explicit confirmations, never defaults.
        missingFields: ["author", "api_version"],
      };
    },
    confirm({ candidate, target }: OAuthConfirmInput): OAuthConfirmResult {
      if (target.blog !== null) {
        throw new OAuthDriverError("invalid_response");
      }
      const native = requireNativeFields(candidate, "linkedin");
      const accessToken = native.get("access_token");
      const offeredRefresh = native.get("refresh_token");
      if (
        accessToken === undefined ||
        accessToken === "" ||
        (offeredRefresh !== undefined && offeredRefresh === "")
      ) {
        throw new OAuthDriverError("invalid_response");
      }
      const missing: string[] = [];
      if (target.author === null) {
        missing.push("author");
      }
      if (target.apiVersion === null) {
        missing.push("api_version");
      }
      if (missing.length > 0) {
        return { plaintext: new Uint8Array(candidate), target: null, missingFields: missing };
      }
      const author = target.author as string;
      const apiVersion = target.apiVersion as string;
      if (!isLinkedInConfigurationValid(accessToken, author, apiVersion)) {
        throw new OAuthDriverError("invalid_response");
      }
      return {
        plaintext: encodeNativePayload({
          access_token: accessToken,
          ...(offeredRefresh === undefined ? {} : { refresh_token: offeredRefresh }),
          author,
          api_version: apiVersion,
        }),
        target: Object.freeze({ label: author, source: "user" }),
        missingFields: [],
      };
    },
  });
}

/** LinkedIn-only refresh capability, resolved without any public origin. */
function createLinkedInRefreshDriver(input: {
  readonly platform: Platform;
  readonly app: AppGroup;
  readonly endpoints: OAuth2Endpoints;
}): OAuthRefreshDriver {
  const clientId = input.app["LINKEDIN_CLIENT_ID"] as string;
  const clientSecret = input.app["LINKEDIN_CLIENT_SECRET"] as string;
  return Object.freeze({
    platform: input.platform,
    canRefresh(plaintext: Uint8Array): boolean {
      // Strict, network-free preflight over the complete stored native payload.
      return readLinkedInRefreshPayload(plaintext) !== null;
    },
    async refresh({ plaintext, now }: OAuthRefreshInput): Promise<OAuthRefreshResult> {
      const native = readLinkedInRefreshPayload(plaintext);
      if (native === null) {
        throw new OAuthDriverError("invalid_response");
      }
      const text = await providerPost({
        url: input.endpoints.tokenUrl,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: native.refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      const token = requireTokenResponse(text, now, native.refreshToken);
      return {
        plaintext: encodeNativePayload({
          access_token: token.accessToken,
          refresh_token: token.refreshToken as string,
          // Native author and API version are preserved exactly.
          author: native.author,
          api_version: native.apiVersion,
        }),
        expiresAt: token.expiresAt,
      };
    },
  });
}

interface LinkedInRefreshPayload {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly author: string;
  readonly apiVersion: string;
}

/**
 * Strict LinkedIn refresh preflight.

 * The complete native group must decode through the installed validator, only
 * the known field names may appear, and a usable refresh token must be present.
 * Everything here is local: no request is made.
 */
function readLinkedInRefreshPayload(plaintext: Uint8Array): LinkedInRefreshPayload | null {
  const fields = parseNativePayload(plaintext);
  if (fields === null || parseCredentialFields("linkedin", recordFrom(fields)) === null) {
    return null;
  }
  const accessToken = fields.get("access_token");
  const refreshToken = fields.get("refresh_token");
  const author = fields.get("author");
  const apiVersion = fields.get("api_version");
  if (!isLinkedInConfigurationValid(accessToken, author, apiVersion) || refreshToken === undefined || refreshToken === "") {
    return null;
  }
  return Object.freeze({
    accessToken: accessToken as string,
    refreshToken,
    author: author as string,
    apiVersion: apiVersion as string,
  });
}

/** Fixed field allowlist of one platform's stored native payload. */
function requireNativeFields(
  candidate: Uint8Array,
  platform: InstalledPlatform,
): ReadonlyMap<string, string> {
  const fields = parseNativePayload(candidate);
  if (fields === null || parseCredentialFields(platform, recordFrom(fields)) === null) {
    throw new OAuthDriverError("invalid_response");
  }
  return fields;
}

/** Plain record view of one parsed payload for the allowlist helper. */
function recordFrom(fields: ReadonlyMap<string, string>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [name, value] of fields.entries()) {
    // The names come from a parsed JSON object and the values are validated
    // strings; `Object.defineProperty` keeps a dangerous name as an own key.
    Object.defineProperty(record, name, {
      value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return record;
}

/** Required opaque field, exactly as stored. */
function originalField(fields: ReadonlyMap<string, string>, name: string): string {
  const value = fields.get(name);
  if (value === undefined || value === "") {
    throw new OAuthDriverError("invalid_response");
  }
  return value;
}

interface TokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: IsoInstant | null;
}

/**
 * Strict LinkedIn token response.

 * A nonempty string `access_token` is required. An absent `refresh_token`
 * preserves the previous one only when `preserveRefreshToken` is supplied;
 * an explicitly empty, null or non-string value always fails.
 */
function requireTokenResponse(
  text: string,
  baseline: IsoInstant,
  preserveRefreshToken?: string,
): TokenResponse {
  const body = parseJsonObjectResponse(text);
  if (body === null) {
    throw new OAuthDriverError("invalid_response");
  }
  // Provider-issued tokens obey the same rule as the stored native payload, so
  // a successful exchange or refresh can never commit a group that this
  // driver's own candidate/preflight parser would reject.
  const accessToken = requireOpaqueValue(body["access_token"]);
  let refreshToken: string | null = null;
  if (body["refresh_token"] === undefined) {
    refreshToken = preserveRefreshToken ?? null;
  } else {
    refreshToken = requireOpaqueValue(body["refresh_token"]);
  }
  const expiry = expiresAtFromSeconds(body["expires_in"], baseline);
  if (expiry.kind !== "ok") {
    throw new OAuthDriverError("invalid_response");
  }
  return Object.freeze({ accessToken, refreshToken, expiresAt: expiry.expiresAt });
}

/** Provider-issued opaque value; rejection is fixed and never echoes it. */
function requireOpaqueValue(value: unknown): string {
  if (!isOpaqueCredentialValue(value)) {
    throw new OAuthDriverError("invalid_response");
  }
  return value;
}

function decodeSecret(secret: Uint8Array | null): string {
  if (secret === null || secret.byteLength === 0) {
    throw new OAuthDriverError("invalid_response");
  }
  try {
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(secret);
    if (value === "") {
      throw new OAuthDriverError("invalid_response");
    }
    return value;
  } catch (error) {
    throw error instanceof OAuthDriverError ? error : new OAuthDriverError("invalid_response");
  }
}

function requireCallbackValue(value: string | null): string {
  if (value === null || value === "") {
    throw new OAuthDriverError("invalid_response");
  }
  return value;
}

function requireNoOverrides(target: OAuthTargetOverrides, platform: Platform): void {
  if (target.author !== null || target.apiVersion !== null || target.blog !== null) {
    throw new OAuthDriverError("invalid_response");
  }
  void platform;
}

function validatedBlog(value: string): string {
  try {
    return normalizeTumblrBlog(value);
  } catch {
    throw new OAuthDriverError("invalid_response");
  }
}
