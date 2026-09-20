/**
 * Agent-guided authentication endpoints.
 *
 * GET  /v1/auth                          List per-platform credential status.
 * POST /v1/auth/:platform                Store credentials directly (all platforms).
 * DELETE /v1/auth/:platform              Remove stored credentials.
 * GET  /v1/auth/:platform/connect        Start an OAuth flow; returns the URL to open.
 * GET  /v1/auth/:platform/callback       OAuth redirect target (no Bearer required).
 *
 * Connect + callback supports OAuth 1.0a (X, Tumblr) and OAuth 2.0 (LinkedIn).
 * Bluesky and Threads use direct credential submission only.
 */

import { isPlatform, type Platform, PLATFORMS } from "@syndroo/core";
import { isPlatformConfigured } from "./publishers.js";
import { ApiError, json, readJsonBody } from "./http.js";
import type { D1Repository } from "./repository.js";

// ---------------------------------------------------------------------------
// Route dispatcher – called from api.ts after auth check (except /callback).
// ---------------------------------------------------------------------------

export async function routeAuth(
  request: Request,
  env: Env,
  repository: D1Repository,
): Promise<Response> {
  const url = new URL(request.url);
  // /v1/auth/{platform}/callback  – matched before Bearer check in api.ts
  // /v1/auth/{platform}/connect
  // /v1/auth/{platform}
  // /v1/auth

  const parts = url.pathname.split("/").filter(Boolean);
  // parts: ["v1","auth"] | ["v1","auth",platform] | ["v1","auth",platform,"connect"|"callback"]

  if (parts.length === 2) {
    // GET /v1/auth
    if (request.method === "GET") return listCredentialStatus(env, repository);
    throw new ApiError("Method not allowed", 405, "INVALID_REQUEST");
  }

  const rawPlatform = parts[2];
  if (!rawPlatform || !isPlatform(rawPlatform)) {
    throw new ApiError(`Unknown platform: ${rawPlatform}`, 404, "NOT_FOUND");
  }
  const platform = rawPlatform as Platform;

  const action = parts[3]; // "connect" | "callback" | undefined

  if (!action) {
    if (request.method === "GET") return getCredentialStatus(platform, env, repository);
    if (request.method === "POST") {
      const body = await readJsonBody(request);
      return storeCredential(platform, body, repository);
    }
    if (request.method === "DELETE") return removeCredential(platform, repository);
    throw new ApiError("Method not allowed", 405, "INVALID_REQUEST");
  }

  if (action === "connect") {
    if (request.method !== "GET") throw new ApiError("Method not allowed", 405, "INVALID_REQUEST");
    return connectOAuth(platform, request, env, repository);
  }

  if (action === "callback") {
    if (request.method !== "GET") throw new ApiError("Method not allowed", 405, "INVALID_REQUEST");
    return handleOAuthCallback(platform, request, env, repository);
  }

  throw new ApiError("Not found", 404, "NOT_FOUND");
}

// ---------------------------------------------------------------------------
// Status listing
// ---------------------------------------------------------------------------

async function listCredentialStatus(env: Env, repository: D1Repository): Promise<Response> {
  const installedPlatforms = PLATFORMS.filter(
    (p) => p !== "mastodon" && p !== "nostr",
  ) as Platform[];

  const items = await Promise.all(
    installedPlatforms.map(async (platform) => {
      const credential = await repository.getCredential(platform);
      return {
        platform,
        configured: Boolean(credential) || isPlatformConfigured(platform, env),
        source: credential ? "credential" : isPlatformConfigured(platform, env) ? "env" : null,
        oauthSupported: isOAuthPlatform(platform),
      };
    }),
  );

  return json({ platforms: Object.fromEntries(items.map((i) => [i.platform, i])) });
}

async function getCredentialStatus(
  platform: Platform,
  env: Env,
  repository: D1Repository,
): Promise<Response> {
  const credential = await repository.getCredential(platform);
  return json({
    platform,
    configured: Boolean(credential) || isPlatformConfigured(platform, env),
    source: credential ? "credential" : isPlatformConfigured(platform, env) ? "env" : null,
    oauthSupported: isOAuthPlatform(platform),
  });
}

// ---------------------------------------------------------------------------
// Direct credential submission
// ---------------------------------------------------------------------------

async function storeCredential(
  platform: Platform,
  body: unknown,
  repository: D1Repository,
): Promise<Response> {
  const data = parseCredentialBody(platform, body);
  await repository.setCredential(platform, data);
  return json({ platform, stored: true }, 200);
}

async function removeCredential(platform: Platform, repository: D1Repository): Promise<Response> {
  await repository.deleteCredential(platform);
  return json({ platform, removed: true }, 200);
}

function parseCredentialBody(platform: Platform, body: unknown): Record<string, string> {
  if (typeof body !== "object" || body === null) {
    throw new ApiError("Request body must be a JSON object", 400, "INVALID_REQUEST");
  }
  const b = body as Record<string, unknown>;

  switch (platform) {
    case "bluesky": {
      requireString(b, "identifier");
      requireString(b, "password");
      const data: Record<string, string> = { identifier: b.identifier as string, password: b.password as string };
      if (typeof b.host === "string" && b.host.trim()) data.host = b.host.trim();
      return data;
    }
    case "threads":
      requireString(b, "access_token");
      return { access_token: b.access_token as string };
    case "x": {
      // Direct: user supplies their own access token pair; app key/secret stay in env.
      requireString(b, "access_token");
      requireString(b, "access_token_secret");
      return { access_token: b.access_token as string, access_token_secret: b.access_token_secret as string };
    }
    case "tumblr": {
      requireString(b, "token");
      requireString(b, "token_secret");
      const data: Record<string, string> = { token: b.token as string, token_secret: b.token_secret as string };
      if (typeof b.blog === "string" && b.blog.trim()) data.blog = b.blog.trim();
      return data;
    }
    case "linkedin": {
      requireString(b, "access_token");
      const data: Record<string, string> = { access_token: b.access_token as string };
      if (typeof b.author === "string" && b.author.trim()) data.author = b.author.trim();
      if (typeof b.api_version === "string" && b.api_version.trim()) data.api_version = b.api_version.trim();
      return data;
    }
    default:
      throw new ApiError(`Platform ${platform} is not installed`, 422, "PLATFORM_NOT_CONFIGURED");
  }
}

function requireString(obj: Record<string, unknown>, key: string): void {
  if (typeof obj[key] !== "string" || !(obj[key] as string).trim()) {
    throw new ApiError(`${key} is required`, 400, "INVALID_REQUEST");
  }
}

// ---------------------------------------------------------------------------
// OAuth flow – connect
// ---------------------------------------------------------------------------

function isOAuthPlatform(platform: Platform): boolean {
  return platform === "x" || platform === "tumblr" || platform === "linkedin";
}

async function connectOAuth(
  platform: Platform,
  request: Request,
  env: Env,
  repository: D1Repository,
): Promise<Response> {
  const callbackUrl = oauthCallbackUrl(request, platform);

  switch (platform) {
    case "x":
      return connectOAuth1(platform, "https://api.twitter.com/oauth", env.X_API_KEY, env.X_API_SECRET, callbackUrl, env, repository);
    case "tumblr":
      return connectOAuth1(platform, "https://www.tumblr.com/oauth", env.TUMBLR_CONSUMER_KEY, env.TUMBLR_CONSUMER_SECRET, callbackUrl, env, repository);
    case "linkedin":
      return connectOAuth2(platform, callbackUrl, env, repository);
    default:
      throw new ApiError(
        `${platform} uses direct credential submission (POST /v1/auth/${platform}).`,
        422,
        "INVALID_REQUEST",
      );
  }
}

// OAuth 1.0a connect (X, Tumblr)
async function connectOAuth1(
  platform: Platform,
  oauthBase: string,
  consumerKey: string | undefined,
  consumerSecret: string | undefined,
  callbackUrl: string,
  env: Env,
  repository: D1Repository,
): Promise<Response> {
  if (!consumerKey?.trim() || !consumerSecret?.trim()) {
    throw new ApiError(
      `OAuth app credentials for ${platform} are not configured in environment variables`,
      422,
      "PLATFORM_NOT_CONFIGURED",
    );
  }

  const state = crypto.randomUUID();
  const requestTokenUrl = `${oauthBase}/request_token`;
  const oauthParams: Record<string, string> = {
    oauth_callback: `${callbackUrl}?state=${state}`,
    oauth_consumer_key: consumerKey,
    oauth_nonce: oauthNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: oauthTimestamp(),
    oauth_version: "1.0",
  };

  const signature = await oauthSign("POST", requestTokenUrl, oauthParams, {}, consumerSecret);
  const response = await fetch(requestTokenUrl, {
    method: "POST",
    headers: { Authorization: oauthAuthHeader({ ...oauthParams, oauth_signature: signature }) },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    console.error(JSON.stringify({ event: "oauth1_request_token_failed", platform, status: response.status, body: text }));
    throw new ApiError(`Failed to get request token from ${platform}`, 502, "PROVIDER_ERROR");
  }

  const body = await response.text();
  const params = new URLSearchParams(body);
  const requestToken = params.get("oauth_token");
  const confirmed = params.get("oauth_callback_confirmed");

  if (!requestToken || confirmed !== "true") {
    throw new ApiError(`${platform} returned an invalid request token response`, 502, "PROVIDER_ERROR");
  }

  await repository.setOAuthState(state, platform, requestToken);

  const authBase = platform === "x" ? "https://api.twitter.com/oauth/authorize" : `${oauthBase}/authorize`;

  return json({
    platform,
    url: `${authBase}?oauth_token=${encodeURIComponent(requestToken)}`,
    message: `Open the URL in your browser to authorize ${platform}. After authorizing, return here.`,
  });
}

// OAuth 2.0 connect (LinkedIn)
async function connectOAuth2(
  platform: Platform,
  callbackUrl: string,
  env: Env,
  repository: D1Repository,
): Promise<Response> {
  if (!env.LINKEDIN_CLIENT_ID?.trim()) {
    throw new ApiError(
      "LINKEDIN_CLIENT_ID is not configured in environment variables",
      422,
      "PLATFORM_NOT_CONFIGURED",
    );
  }

  const state = crypto.randomUUID();
  await repository.setOAuthState(state, platform);

  const authUrl = new URL("https://www.linkedin.com/oauth/v2/authorization");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", env.LINKEDIN_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", "w_member_social openid profile");

  return json({
    platform,
    url: authUrl.toString(),
    message: "Open the URL in your browser to authorize LinkedIn. After authorizing, return here.",
  });
}

// ---------------------------------------------------------------------------
// OAuth flow – callback
// ---------------------------------------------------------------------------

export async function handleOAuthCallback(
  platform: Platform,
  request: Request,
  env: Env,
  repository: D1Repository,
): Promise<Response> {
  switch (platform) {
    case "x":
      return callbackOAuth1(platform, "https://api.twitter.com/oauth/access_token", env.X_API_KEY, env.X_API_SECRET, request, repository);
    case "tumblr":
      return callbackOAuth1(platform, "https://www.tumblr.com/oauth/access_token", env.TUMBLR_CONSUMER_KEY, env.TUMBLR_CONSUMER_SECRET, request, repository);
    case "linkedin":
      return callbackOAuth2(request, env, repository);
    default:
      return htmlPage("Unsupported", `${platform} does not use OAuth callbacks.`);
  }
}

async function callbackOAuth1(
  platform: Platform,
  accessTokenUrl: string,
  consumerKey: string | undefined,
  consumerSecret: string | undefined,
  request: Request,
  repository: D1Repository,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const oauthToken = url.searchParams.get("oauth_token");
  const oauthVerifier = url.searchParams.get("oauth_verifier");

  if (!state || !oauthToken || !oauthVerifier) {
    return htmlPage("Authorization failed", "Missing OAuth parameters. The authorization may have been denied.");
  }

  const storedState = await repository.getOAuthState(state);
  if (!storedState || storedState.platform !== platform) {
    return htmlPage("Authorization failed", "Invalid or expired authorization session. Please start over.");
  }

  await repository.deleteOAuthState(state);

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey!,
    oauth_nonce: oauthNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: oauthTimestamp(),
    oauth_token: oauthToken,
    oauth_verifier: oauthVerifier,
    oauth_version: "1.0",
  };

  const signature = await oauthSign(
    "POST",
    accessTokenUrl,
    oauthParams,
    {},
    consumerSecret!,
    storedState.requestToken ?? "",
  );

  const response = await fetch(accessTokenUrl, {
    method: "POST",
    headers: { Authorization: oauthAuthHeader({ ...oauthParams, oauth_signature: signature }) },
  });

  if (!response.ok) {
    return htmlPage("Authorization failed", `Could not exchange OAuth verifier with ${platform}. Please try again.`);
  }

  const params = new URLSearchParams(await response.text());
  const accessToken = params.get("oauth_token");
  const accessTokenSecret = params.get("oauth_token_secret");

  if (!accessToken || !accessTokenSecret) {
    return htmlPage("Authorization failed", `${platform} returned an invalid access token response.`);
  }

  const credentialData: Record<string, string> = {
    access_token: accessToken,
    access_token_secret: accessTokenSecret,
  };

  // Tumblr also needs a blog identifier; keep it from the original env if not in the token response.
  if (platform === "tumblr") {
    const blog = params.get("blog_name");
    if (blog) credentialData.blog = blog;
  }

  await repository.setCredential(platform, credentialData);

  return htmlPage(
    `${platformLabel(platform)} connected`,
    `${platformLabel(platform)} was authorized successfully. You can close this tab and return to the agent.`,
  );
}

async function callbackOAuth2(
  request: Request,
  env: Env,
  repository: D1Repository,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    return htmlPage("Authorization failed", `LinkedIn denied the authorization: ${errorDescription ?? error}`);
  }

  if (!state || !code) {
    return htmlPage("Authorization failed", "Missing OAuth parameters.");
  }

  const storedState = await repository.getOAuthState(state);
  if (!storedState || storedState.platform !== "linkedin") {
    return htmlPage("Authorization failed", "Invalid or expired authorization session. Please start over.");
  }

  await repository.deleteOAuthState(state);

  // Derive the callback URL from the incoming request (no query string).
  const callbackUrl = `${url.protocol}//${url.host}${url.pathname}`;

  const tokenResponse = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl,
      client_id: env.LINKEDIN_CLIENT_ID!,
      client_secret: env.LINKEDIN_CLIENT_SECRET!,
    }),
  });

  if (!tokenResponse.ok) {
    return htmlPage("Authorization failed", "Failed to exchange authorization code with LinkedIn. Please try again.");
  }

  const tokenData = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenData.access_token) {
    return htmlPage("Authorization failed", "LinkedIn returned an invalid access token response.");
  }

  await repository.setCredential("linkedin", { access_token: tokenData.access_token });

  return htmlPage("LinkedIn connected", "LinkedIn was authorized successfully. You can close this tab and return to the agent.");
}

// ---------------------------------------------------------------------------
// OAuth 1.0a helpers
// ---------------------------------------------------------------------------

async function oauthSign(
  method: string,
  url: string,
  oauthParams: Record<string, string>,
  bodyParams: Record<string, string>,
  consumerSecret: string,
  tokenSecret = "",
): Promise<string> {
  const allParams = { ...oauthParams, ...bodyParams };
  const sortedParams = Object.entries(allParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join("&");

  const baseString = `${method}&${enc(url)}&${enc(sortedParams)}`;
  const signingKey = `${enc(consumerSecret)}&${enc(tokenSecret)}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(baseString));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function oauthAuthHeader(params: Record<string, string>): string {
  const parts = Object.entries(params)
    .filter(([k]) => k.startsWith("oauth_"))
    .map(([k, v]) => `${enc(k)}="${enc(v)}"`)
    .join(", ");
  return `OAuth ${parts}`;
}

function oauthNonce(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function oauthTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function oauthCallbackUrl(request: Request, platform: Platform): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}/v1/auth/${platform}/callback`;
}

function platformLabel(platform: Platform): string {
  const labels: Record<string, string> = {
    x: "X",
    bluesky: "Bluesky",
    threads: "Threads",
    tumblr: "Tumblr",
    linkedin: "LinkedIn",
  };
  return labels[platform] ?? platform;
}

function htmlPage(title: string, message: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)} – Syndroo</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#1a1a1a}h1{font-size:1.4rem;margin-bottom:.5rem}p{color:#555;line-height:1.6}</style>
</head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
    status: title.toLowerCase().includes("fail") || title.toLowerCase().includes("error") ? 400 : 200,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
