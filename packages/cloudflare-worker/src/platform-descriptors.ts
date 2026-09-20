/**
 * Worker-level platform registry.
 *
 * Each entry wraps the platform package's PlatformAdapter with the
 * Cloudflare-Worker-specific concerns: Env var names, credential resolution,
 * HTTP body validation, and OAuth app-key env mappings.
 *
 * Platform packages own: provider name, publisher construction, OAuth URLs.
 * This file owns: env var names, credential merging, ApiError handling.
 */

import { blueskyAdapter } from "@syndroo/bluesky";
import { threadsAdapter } from "@syndroo/threads";
import { xAdapter } from "@syndroo/x";
import { tumblrAdapter, normalizeTumblrBlog } from "@syndroo/tumblr";
import { linkedinAdapter, isLinkedInConfigurationValid } from "@syndroo/linkedin";
import {
  PublishError,
  type Platform,
  type PlatformAdapter,
  type Publisher,
  type OAuth1Endpoints,
  type OAuth2Endpoints,
  type OAuthEndpoints,
} from "@syndroo/core";

import { ApiError } from "./http.js";

export type { OAuthEndpoints, OAuth1Endpoints, OAuth2Endpoints };

// ---------------------------------------------------------------------------
// Worker-level OAuth config (extends platform's endpoint URLs with env keys)
// ---------------------------------------------------------------------------

export interface WorkerOAuth1Config extends OAuth1Endpoints {
  readonly consumerKeyEnv: keyof Env;
  readonly consumerSecretEnv: keyof Env;
}

export interface WorkerOAuth2Config extends OAuth2Endpoints {
  readonly clientIdEnv: keyof Env;
  readonly clientSecretEnv: keyof Env;
}

export type WorkerOAuthConfig = WorkerOAuth1Config | WorkerOAuth2Config;

// ---------------------------------------------------------------------------
// Worker platform descriptor
// ---------------------------------------------------------------------------

export interface WorkerPlatformDescriptor {
  readonly id: Platform;
  readonly label: string;
  readonly installed: boolean;
  readonly adapter: PlatformAdapter;

  /** True when all required env vars are present without D1 credentials. */
  isConfiguredFromEnv(env: Env): boolean;

  /** True when a D1 credential combined with env app keys is sufficient. */
  isConfiguredWithCredential(cred: Record<string, string>, env: Env): boolean;

  /**
   * Merge the stored D1 credential with env var fallbacks into the unified
   * record that `adapter.buildPublisher()` expects.
   * Returns null when the combination is insufficient to publish.
   */
  resolveCredential(
    cred: Record<string, string> | null,
    env: Env,
  ): Record<string, string> | null;

  /**
   * Validate and normalise the JSON body from `POST /v1/auth/:platform`.
   * Throws `ApiError(400)` on malformed input.
   */
  parseDirectCredential(body: Record<string, unknown>): Record<string, string>;

  /** OAuth worker config: endpoint URLs + env var key names. */
  readonly oauth?: WorkerOAuthConfig;
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

// ---------------------------------------------------------------------------
// Bluesky
// ---------------------------------------------------------------------------

const bluesky: WorkerPlatformDescriptor = {
  id: "bluesky",
  label: "Bluesky",
  installed: true,
  adapter: blueskyAdapter,

  isConfiguredFromEnv: (env) =>
    Boolean(env.BLUESKY_IDENTIFIER?.trim() && env.BLUESKY_PASSWORD?.trim()),

  isConfiguredWithCredential: (cred) =>
    Boolean(cred.identifier?.trim() && cred.password?.trim()),

  resolveCredential: (cred, env) => {
    const identifier = cred?.identifier?.trim() ?? env.BLUESKY_IDENTIFIER?.trim();
    const password = cred?.password?.trim() ?? env.BLUESKY_PASSWORD?.trim();
    if (!identifier || !password) return null;
    return {
      identifier,
      password,
      host: cred?.host?.trim() ?? env.BLUESKY_HOST?.trim() ?? "bsky.social",
    };
  },

  parseDirectCredential: (body) => {
    const data: Record<string, string> = {
      identifier: requireStr(body, "identifier"),
      password: requireStr(body, "password"),
    };
    const host = optStr(body, "host");
    if (host) data.host = host;
    return data;
  },
};

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

const threads: WorkerPlatformDescriptor = {
  id: "threads",
  label: "Threads",
  installed: true,
  adapter: threadsAdapter,

  isConfiguredFromEnv: (env) => Boolean(env.THREADS_ACCESS_TOKEN?.trim()),

  isConfiguredWithCredential: (cred) => Boolean(cred.access_token?.trim()),

  resolveCredential: (cred, env) => {
    const token = cred?.access_token?.trim() ?? env.THREADS_ACCESS_TOKEN?.trim();
    return token ? { access_token: token } : null;
  },

  parseDirectCredential: (body) => ({
    access_token: requireStr(body, "access_token"),
  }),
};

// ---------------------------------------------------------------------------
// X (OAuth 1.0a) — app key/secret from env, user token from cred or env
// ---------------------------------------------------------------------------

const x: WorkerPlatformDescriptor = {
  id: "x",
  label: "X",
  installed: true,
  adapter: xAdapter,

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

  resolveCredential: (cred, env) => {
    const apiKey = env.X_API_KEY?.trim();
    const apiSecret = env.X_API_SECRET?.trim();
    if (!apiKey || !apiSecret) return null;
    const accessToken = cred?.access_token?.trim() ?? env.X_ACCESS_TOKEN?.trim();
    const accessTokenSecret = cred?.access_token_secret?.trim() ?? env.X_ACCESS_TOKEN_SECRET?.trim();
    if (!accessToken || !accessTokenSecret) return null;
    return { api_key: apiKey, api_secret: apiSecret, access_token: accessToken, access_token_secret: accessTokenSecret };
  },

  parseDirectCredential: (body) => ({
    access_token: requireStr(body, "access_token"),
    access_token_secret: requireStr(body, "access_token_secret"),
  }),

  oauth: {
    ...xAdapter.oauth as OAuth1Endpoints,
    consumerKeyEnv: "X_API_KEY",
    consumerSecretEnv: "X_API_SECRET",
  },
};

// ---------------------------------------------------------------------------
// Tumblr (OAuth 1.0a) — consumer key/secret from env, token from cred or env
// ---------------------------------------------------------------------------

const tumblr: WorkerPlatformDescriptor = {
  id: "tumblr",
  label: "Tumblr",
  installed: true,
  adapter: tumblrAdapter,

  isConfiguredFromEnv: (env) => {
    if (
      ![
        env.TUMBLR_CONSUMER_KEY,
        env.TUMBLR_CONSUMER_SECRET,
        env.TUMBLR_TOKEN,
        env.TUMBLR_TOKEN_SECRET,
        env.TUMBLR_BLOG,
      ].every((v) => Boolean(v?.trim()))
    )
      return false;
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

  resolveCredential: (cred, env) => {
    const consumerKey = env.TUMBLR_CONSUMER_KEY?.trim();
    const consumerSecret = env.TUMBLR_CONSUMER_SECRET?.trim();
    if (!consumerKey || !consumerSecret) return null;
    const token = cred?.token?.trim() ?? env.TUMBLR_TOKEN?.trim();
    const tokenSecret = cred?.token_secret?.trim() ?? env.TUMBLR_TOKEN_SECRET?.trim();
    const blog = cred?.blog?.trim() ?? env.TUMBLR_BLOG?.trim();
    if (!token || !tokenSecret || !blog) return null;
    return { consumer_key: consumerKey, consumer_secret: consumerSecret, token, token_secret: tokenSecret, blog };
  },

  parseDirectCredential: (body) => {
    const data: Record<string, string> = {
      token: requireStr(body, "token"),
      token_secret: requireStr(body, "token_secret"),
    };
    const blog = optStr(body, "blog");
    if (blog) data.blog = blog;
    return data;
  },

  oauth: {
    ...tumblrAdapter.oauth as OAuth1Endpoints,
    consumerKeyEnv: "TUMBLR_CONSUMER_KEY",
    consumerSecretEnv: "TUMBLR_CONSUMER_SECRET",
  },
};

// ---------------------------------------------------------------------------
// LinkedIn (OAuth 2.0)
// ---------------------------------------------------------------------------

const linkedin: WorkerPlatformDescriptor = {
  id: "linkedin",
  label: "LinkedIn",
  installed: true,
  adapter: linkedinAdapter,

  isConfiguredFromEnv: (env) =>
    isLinkedInConfigurationValid(env.LINKEDIN_ACCESS_TOKEN, env.LINKEDIN_AUTHOR, env.LINKEDIN_API_VERSION),

  isConfiguredWithCredential: (cred, env) =>
    Boolean(cred.access_token?.trim() && (cred.author?.trim() || env.LINKEDIN_AUTHOR?.trim())),

  resolveCredential: (cred, env) => {
    const accessToken = cred?.access_token?.trim() ?? env.LINKEDIN_ACCESS_TOKEN?.trim();
    const author = cred?.author?.trim() ?? env.LINKEDIN_AUTHOR?.trim();
    const apiVersion = cred?.api_version?.trim() ?? env.LINKEDIN_API_VERSION?.trim() ?? "202604";
    if (!isLinkedInConfigurationValid(accessToken, author, apiVersion)) return null;
    return { access_token: accessToken!, author: author!, api_version: apiVersion! };
  },

  parseDirectCredential: (body) => {
    const data: Record<string, string> = { access_token: requireStr(body, "access_token") };
    const author = optStr(body, "author");
    const apiVersion = optStr(body, "api_version");
    if (author) data.author = author;
    if (apiVersion) data.api_version = apiVersion;
    return data;
  },

  oauth: {
    ...linkedinAdapter.oauth as OAuth2Endpoints,
    clientIdEnv: "LINKEDIN_CLIENT_ID",
    clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
  },
};

// ---------------------------------------------------------------------------
// Not-installed stubs (mastodon, nostr)
// ---------------------------------------------------------------------------

function notInstalled(id: Platform): WorkerPlatformDescriptor {
  const fail = () => { throw new PublishError("No publisher configured for platform: " + id, "PROVIDER_UNAVAILABLE"); };
  return {
    id,
    label: id,
    installed: false,
    adapter: { providerName: id, buildPublisher: fail },
    isConfiguredFromEnv: () => false,
    isConfiguredWithCredential: () => false,
    resolveCredential: () => null,
    parseDirectCredential: () => { throw new ApiError("Platform is not installed: " + id, 422, "PLATFORM_NOT_CONFIGURED"); },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const DESCRIPTORS: Readonly<Record<Platform, WorkerPlatformDescriptor>> = {
  bluesky,
  threads,
  x,
  tumblr,
  linkedin,
  mastodon: notInstalled("mastodon"),
  nostr: notInstalled("nostr"),
};

/** Build a Publisher from a stored credential + env vars.  Throws `PublishError("AUTH")` when insufficient. */
export function buildPublisher(platform: Platform, cred: Record<string, string> | null, env: Env): Publisher {
  const desc = DESCRIPTORS[platform];
  const resolved = desc.resolveCredential(cred, env);
  if (!resolved) throw new PublishError("Platform credentials are not configured: " + platform, "AUTH");
  return desc.adapter.buildPublisher(resolved);
}
