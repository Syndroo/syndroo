/**
 * Per-platform descriptor objects — the single authoritative place for all
 * platform-specific behaviour.  Adding a new platform means adding one entry
 * here; no other file needs a new switch branch.
 *
 * Design notes:
 * - Each descriptor is a plain object (no class hierarchy).
 * - `buildPublisher(cred, env)` handles both the env-only path (cred = null)
 *   and the D1-credential path (cred = stored data), with env falling back to
 *   fill app-level keys where needed.
 * - `oauth` is present only for platforms that support the OAuth browser flow.
 *   OAuth 1.0a and OAuth 2.0 are represented as a discriminated union so the
 *   generic connect/callback helpers in auth.ts can pick the right path without
 *   another switch.
 */

import { BlueskyPublisher } from "@syndroo/bluesky";
import { ThreadsPublisher } from "@syndroo/threads";
import { XPublisher } from "@syndroo/x";
import { TumblrPublisher, normalizeTumblrBlog } from "@syndroo/tumblr";
import { LinkedInPublisher, isLinkedInConfigurationValid } from "@syndroo/linkedin";
import { PublishError, type Platform, type Publisher } from "@syndroo/core";

import { ApiError } from "./http.js";

export type CredentialData = Record<string, string>;

/** OAuth 1.0a connect configuration (X, Tumblr). */
export interface OAuth1Config {
  readonly type: "oauth1";
  /** Env-var name for the OAuth app consumer key. */
  readonly consumerKeyEnv: keyof Env;
  /** Env-var name for the OAuth app consumer secret. */
  readonly consumerSecretEnv: keyof Env;
  readonly requestTokenUrl: string;
  readonly authorizeUrl: string;
  readonly accessTokenUrl: string;
  /**
   * Optional: map additional fields from the access-token response body into
   * the stored credential (e.g. `blog_name` for Tumblr).
   */
  parseExtraCredentials?(params: URLSearchParams): CredentialData;
}

/** OAuth 2.0 authorization-code configuration (LinkedIn). */
export interface OAuth2Config {
  readonly type: "oauth2";
  /** Env-var name for the OAuth app client ID. */
  readonly clientIdEnv: keyof Env;
  /** Env-var name for the OAuth app client secret. */
  readonly clientSecretEnv: keyof Env;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: string;
}

export type OAuthConfig = OAuth1Config | OAuth2Config;

export interface PlatformDescriptor {
  readonly id: Platform;
  readonly label: string;
  readonly providerName: string;
  /**
   * False for platforms recognized by core but not yet installed in this
   * Worker (mastodon, nostr).  All methods on an uninstalled descriptor
   * throw immediately.
   */
  readonly installed: boolean;

  /** True when all required env vars alone are present and valid. */
  isConfiguredFromEnv(env: Env): boolean;

  /**
   * True when a stored credential, together with env vars for any app-level
   * keys, is sufficient to publish.  X and Tumblr need app keys from env
   * even when the user token comes from D1.
   */
  isConfiguredWithCredential(cred: CredentialData, env: Env): boolean;

  /**
   * Build a Publisher.
   * - `cred = null`: use env vars only.
   * - `cred` present: prefer credential fields, fall back to env for app keys.
   * Throws `PublishError("AUTH")` if the combination is insufficient.
   */
  buildPublisher(cred: CredentialData | null, env: Env): Publisher;

  /**
   * Validate and normalise the JSON body sent to `POST /v1/auth/:platform`.
   * Throws `ApiError(400)` on missing or malformed fields.
   */
  parseDirectCredential(body: Record<string, unknown>): CredentialData;

  /** Present only for platforms that support the OAuth browser-flow. */
  readonly oauth?: OAuthConfig;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function requireStr(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new ApiError(`${key} is required`, 400, "INVALID_REQUEST");
  }
  return v.trim();
}

function optStr(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function notConfigured(platform: Platform): never {
  throw new PublishError("Platform credentials are not configured: " + platform, "AUTH");
}

// ---------------------------------------------------------------------------
// Bluesky
// ---------------------------------------------------------------------------

const bluesky: PlatformDescriptor = {
  id: "bluesky",
  label: "Bluesky",
  providerName: "bluesky-native",
  installed: true,

  isConfiguredFromEnv: (env) =>
    Boolean(env.BLUESKY_IDENTIFIER?.trim() && env.BLUESKY_PASSWORD?.trim()),

  isConfiguredWithCredential: (cred) =>
    Boolean(cred.identifier?.trim() && cred.password?.trim()),

  buildPublisher: (cred, env) => {
    const identifier = cred?.identifier?.trim() ?? env.BLUESKY_IDENTIFIER?.trim();
    const password = cred?.password?.trim() ?? env.BLUESKY_PASSWORD?.trim();
    if (!identifier || !password) notConfigured("bluesky");
    return new BlueskyPublisher({
      identifier,
      password,
      host: cred?.host?.trim() ?? env.BLUESKY_HOST?.trim() ?? "bsky.social",
    });
  },

  parseDirectCredential: (body) => {
    const b = body as Record<string, unknown>;
    const data: CredentialData = {
      identifier: requireStr(b, "identifier"),
      password: requireStr(b, "password"),
    };
    const host = optStr(b, "host");
    if (host) data.host = host;
    return data;
  },
};

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

const threads: PlatformDescriptor = {
  id: "threads",
  label: "Threads",
  providerName: "threads-native",
  installed: true,

  isConfiguredFromEnv: (env) => Boolean(env.THREADS_ACCESS_TOKEN?.trim()),

  isConfiguredWithCredential: (cred) => Boolean(cred.access_token?.trim()),

  buildPublisher: (cred, env) => {
    const token = cred?.access_token?.trim() ?? env.THREADS_ACCESS_TOKEN?.trim();
    if (!token) notConfigured("threads");
    return new ThreadsPublisher({ accessToken: token });
  },

  parseDirectCredential: (body) => {
    const b = body as Record<string, unknown>;
    return { access_token: requireStr(b, "access_token") };
  },
};

// ---------------------------------------------------------------------------
// X (formerly Twitter) – OAuth 1.0a
// ---------------------------------------------------------------------------

const x: PlatformDescriptor = {
  id: "x",
  label: "X",
  providerName: "x-sdk",
  installed: true,

  isConfiguredFromEnv: (env) =>
    [env.X_API_KEY, env.X_API_SECRET, env.X_ACCESS_TOKEN, env.X_ACCESS_TOKEN_SECRET].every(
      (v) => Boolean(v?.trim()),
    ),

  isConfiguredWithCredential: (cred, env) =>
    Boolean(
      cred.access_token?.trim() &&
        cred.access_token_secret?.trim() &&
        env.X_API_KEY?.trim() &&
        env.X_API_SECRET?.trim(),
    ),

  buildPublisher: (cred, env) => {
    const apiKey = env.X_API_KEY?.trim();
    const apiSecret = env.X_API_SECRET?.trim();
    if (!apiKey || !apiSecret) {
      throw new PublishError("X app credentials (X_API_KEY, X_API_SECRET) are not configured", "AUTH");
    }
    const accessToken = cred?.access_token?.trim() ?? env.X_ACCESS_TOKEN?.trim();
    const accessTokenSecret = cred?.access_token_secret?.trim() ?? env.X_ACCESS_TOKEN_SECRET?.trim();
    if (!accessToken || !accessTokenSecret) notConfigured("x");
    return new XPublisher({ apiKey, apiSecret, accessToken, accessTokenSecret });
  },

  parseDirectCredential: (body) => {
    const b = body as Record<string, unknown>;
    return {
      access_token: requireStr(b, "access_token"),
      access_token_secret: requireStr(b, "access_token_secret"),
    };
  },

  oauth: {
    type: "oauth1",
    consumerKeyEnv: "X_API_KEY",
    consumerSecretEnv: "X_API_SECRET",
    requestTokenUrl: "https://api.twitter.com/oauth/request_token",
    authorizeUrl: "https://api.twitter.com/oauth/authorize",
    accessTokenUrl: "https://api.twitter.com/oauth/access_token",
  },
};

// ---------------------------------------------------------------------------
// Tumblr – OAuth 1.0a
// ---------------------------------------------------------------------------

const tumblr: PlatformDescriptor = {
  id: "tumblr",
  label: "Tumblr",
  providerName: "tumblr-native",
  installed: true,

  isConfiguredFromEnv: (env) => {
    if (
      ![
        env.TUMBLR_CONSUMER_KEY,
        env.TUMBLR_CONSUMER_SECRET,
        env.TUMBLR_TOKEN,
        env.TUMBLR_TOKEN_SECRET,
        env.TUMBLR_BLOG,
      ].every((v) => Boolean(v?.trim()))
    ) {
      return false;
    }
    try {
      normalizeTumblrBlog(env.TUMBLR_BLOG!);
      return true;
    } catch {
      return false;
    }
  },

  isConfiguredWithCredential: (cred, env) =>
    Boolean(
      cred.token?.trim() &&
        cred.token_secret?.trim() &&
        env.TUMBLR_CONSUMER_KEY?.trim() &&
        env.TUMBLR_CONSUMER_SECRET?.trim() &&
        (cred.blog?.trim() || env.TUMBLR_BLOG?.trim()),
    ),

  buildPublisher: (cred, env) => {
    const consumerKey = env.TUMBLR_CONSUMER_KEY?.trim();
    const consumerSecret = env.TUMBLR_CONSUMER_SECRET?.trim();
    if (!consumerKey || !consumerSecret) {
      throw new PublishError("Tumblr app credentials are not configured", "AUTH");
    }
    const token = cred?.token?.trim() ?? env.TUMBLR_TOKEN?.trim();
    const tokenSecret = cred?.token_secret?.trim() ?? env.TUMBLR_TOKEN_SECRET?.trim();
    const blog = cred?.blog?.trim() ?? env.TUMBLR_BLOG?.trim();
    if (!token || !tokenSecret || !blog) notConfigured("tumblr");
    return new TumblrPublisher({ consumerKey, consumerSecret, token, tokenSecret, blog });
  },

  parseDirectCredential: (body) => {
    const b = body as Record<string, unknown>;
    const data: CredentialData = {
      token: requireStr(b, "token"),
      token_secret: requireStr(b, "token_secret"),
    };
    const blog = optStr(b, "blog");
    if (blog) data.blog = blog;
    return data;
  },

  oauth: {
    type: "oauth1",
    consumerKeyEnv: "TUMBLR_CONSUMER_KEY",
    consumerSecretEnv: "TUMBLR_CONSUMER_SECRET",
    requestTokenUrl: "https://www.tumblr.com/oauth/request_token",
    authorizeUrl: "https://www.tumblr.com/oauth/authorize",
    accessTokenUrl: "https://www.tumblr.com/oauth/access_token",
    parseExtraCredentials: (params) => {
      const blog = params.get("blog_name");
      return blog ? { blog } : {};
    },
  },
};

// ---------------------------------------------------------------------------
// LinkedIn – OAuth 2.0
// ---------------------------------------------------------------------------

const linkedin: PlatformDescriptor = {
  id: "linkedin",
  label: "LinkedIn",
  providerName: "linkedin-native",
  installed: true,

  isConfiguredFromEnv: (env) =>
    isLinkedInConfigurationValid(env.LINKEDIN_ACCESS_TOKEN, env.LINKEDIN_AUTHOR, env.LINKEDIN_API_VERSION),

  isConfiguredWithCredential: (cred, env) =>
    Boolean(
      cred.access_token?.trim() &&
        (cred.author?.trim() || env.LINKEDIN_AUTHOR?.trim()),
    ),

  buildPublisher: (cred, env) => {
    const accessToken = cred?.access_token?.trim() ?? env.LINKEDIN_ACCESS_TOKEN?.trim();
    const author = cred?.author?.trim() ?? env.LINKEDIN_AUTHOR?.trim();
    const apiVersion = cred?.api_version?.trim() ?? env.LINKEDIN_API_VERSION?.trim() ?? "202604";
    if (!isLinkedInConfigurationValid(accessToken, author, apiVersion)) notConfigured("linkedin");
    return new LinkedInPublisher({ accessToken: accessToken!, author: author!, apiVersion: apiVersion! });
  },

  parseDirectCredential: (body) => {
    const b = body as Record<string, unknown>;
    const data: CredentialData = { access_token: requireStr(b, "access_token") };
    const author = optStr(b, "author");
    const apiVersion = optStr(b, "api_version");
    if (author) data.author = author;
    if (apiVersion) data.api_version = apiVersion;
    return data;
  },

  oauth: {
    type: "oauth2",
    clientIdEnv: "LINKEDIN_CLIENT_ID",
    clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
    authorizationUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: "w_member_social openid profile",
  },
};

// ---------------------------------------------------------------------------
// Not-installed stubs (mastodon, nostr)
// ---------------------------------------------------------------------------

function notInstalledDescriptor(id: Platform): PlatformDescriptor {
  return {
    id,
    label: id,
    providerName: id,
    installed: false,
    isConfiguredFromEnv: () => false,
    isConfiguredWithCredential: () => false,
    buildPublisher: () => {
      throw new PublishError("No publisher configured for platform: " + id, "PROVIDER_UNAVAILABLE");
    },
    parseDirectCredential: () => {
      throw new ApiError("Platform is not installed: " + id, 422, "PLATFORM_NOT_CONFIGURED");
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const DESCRIPTORS: Readonly<Record<Platform, PlatformDescriptor>> = {
  bluesky,
  threads,
  x,
  tumblr,
  linkedin,
  mastodon: notInstalledDescriptor("mastodon"),
  nostr: notInstalledDescriptor("nostr"),
};
