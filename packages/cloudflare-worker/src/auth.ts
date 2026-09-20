/**
 * Agent-guided authentication endpoints.
 *
 * GET    /v1/auth                         List per-platform credential status.
 * GET    /v1/auth/:platform               Single platform status.
 * POST   /v1/auth/:platform               Store credentials directly.
 * DELETE /v1/auth/:platform               Remove stored credentials.
 * GET    /v1/auth/:platform/connect       Start OAuth flow; returns the URL to open.
 * GET    /v1/auth/:platform/callback      OAuth redirect (no Bearer required).
 * POST   /v1/auth/:platform/refresh       Refresh an expired OAuth 2.0 token.
 *
 * All platform-specific behaviour comes from the platform descriptor's
 * OAuthConfig.  No platform names appear in the OAuth logic below.
 */

import { isPlatform, PLATFORMS, type Platform } from "@syndroo/core";
import {
  DESCRIPTORS,
  type WorkerOAuth1Config,
  type WorkerOAuth2Config,
} from "./platform-descriptors.js";
import { isPlatformConfigured } from "./publishers.js";
import { ApiError, json, readJsonBody } from "./http.js";
import type { D1Repository } from "./repository.js";

// ---------------------------------------------------------------------------
// Route dispatcher
// ---------------------------------------------------------------------------

export async function routeAuth(
  request: Request,
  env: Env,
  repository: D1Repository,
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length === 2) {
    if (request.method === "GET") return listCredentialStatus(env, repository);
    throw new ApiError("Method not allowed", 405, "INVALID_REQUEST");
  }

  const rawPlatform = parts[2];
  if (!rawPlatform || !isPlatform(rawPlatform)) {
    throw new ApiError(`Unknown platform: ${rawPlatform}`, 404, "NOT_FOUND");
  }
  const platform = rawPlatform;
  const action = parts[3];

  if (!action) {
    if (request.method === "GET") return getCredentialStatus(platform, env, repository);
    if (request.method === "POST") return storeCredential(platform, await readJsonBody(request), repository);
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

  if (action === "refresh") {
    if (request.method !== "POST") throw new ApiError("Method not allowed", 405, "INVALID_REQUEST");
    return refreshCredential(platform, env, repository);
  }

  throw new ApiError("Not found", 404, "NOT_FOUND");
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function listCredentialStatus(env: Env, repository: D1Repository): Promise<Response> {
  const installedPlatforms = PLATFORMS.filter((p) => DESCRIPTORS[p].installed) as Platform[];

  const items = await Promise.all(
    installedPlatforms.map(async (platform) => {
      const desc = DESCRIPTORS[platform];
      const cred = await repository.getCredential(platform);
      const fromEnv = isPlatformConfigured(platform, env);
      const fromCred = cred !== null && desc.isConfiguredWithCredential(cred, env);
      return {
        platform,
        configured: fromCred || fromEnv,
        source: fromCred ? (fromEnv ? "mixed" : "credential") : fromEnv ? "env" : null,
        oauthSupported: Boolean(desc.oauth),
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
  const desc = DESCRIPTORS[platform];
  const cred = await repository.getCredential(platform);
  const fromEnv = isPlatformConfigured(platform, env);
  const fromCred = cred !== null && desc.isConfiguredWithCredential(cred, env);
  return json({
    platform,
    configured: fromCred || fromEnv,
    source: fromCred ? (fromEnv ? "mixed" : "credential") : fromEnv ? "env" : null,
    oauthSupported: Boolean(desc.oauth),
  });
}

// ---------------------------------------------------------------------------
// Direct credential storage
// ---------------------------------------------------------------------------

async function storeCredential(
  platform: Platform,
  body: unknown,
  repository: D1Repository,
): Promise<Response> {
  const data = DESCRIPTORS[platform].parseDirectCredential(body as Record<string, unknown>);
  await repository.setCredential(platform, data);
  return json({ platform, stored: true });
}

async function removeCredential(platform: Platform, repository: D1Repository): Promise<Response> {
  await repository.deleteCredential(platform);
  return json({ platform, removed: true });
}

// ---------------------------------------------------------------------------
// OAuth connect – generic dispatchers
// ---------------------------------------------------------------------------

async function connectOAuth(
  platform: Platform,
  request: Request,
  env: Env,
  repository: D1Repository,
): Promise<Response> {
  const desc = DESCRIPTORS[platform];
  if (!desc.oauth) {
    throw new ApiError(
      `${desc.label} does not support OAuth. Use POST /v1/auth/${platform} to submit credentials directly.`,
      422,
      "INVALID_REQUEST",
    );
  }
  const callbackUrl = oauthCallbackUrl(request, platform);
  if (desc.oauth.type === "oauth1") {
    return connectOAuth1(desc.oauth, platform, callbackUrl, env, repository);
  }
  return connectOAuth2(desc.oauth, platform, callbackUrl, env, repository);
}

export async function handleOAuthCallback(
  platform: Platform,
  request: Request,
  env: Env,
  repository: D1Repository,
): Promise<Response> {
  const desc = DESCRIPTORS[platform];
  if (!desc.oauth) return htmlPage("Not supported", `${desc.label} does not use OAuth callbacks.`);
  if (desc.oauth.type === "oauth1") {
    return callbackOAuth1(desc.oauth, platform, request, env, repository);
  }
  return callbackOAuth2(desc.oauth, platform, request, env, repository);
}

// ---------------------------------------------------------------------------
// OAuth 1.0a
// ---------------------------------------------------------------------------

async function connectOAuth1(
  config: WorkerOAuth1Config,
  platform: Platform,
  callbackUrl: string,
  env: Env,
  repository: D1Repository,
): Promise<Response> {
  const consumerKey = (env[config.consumerKeyEnv] as string | undefined)?.trim();
  const consumerSecret = (env[config.consumerSecretEnv] as string | undefined)?.trim();

  if (!consumerKey || !consumerSecret) {
    throw new ApiError(
      `OAuth app credentials for ${platform} (${String(config.consumerKeyEnv)}, ${String(config.consumerSecretEnv)}) are not configured`,
      422,
      "PLATFORM_NOT_CONFIGURED",
    );
  }

  const state = crypto.randomUUID();
  const oauthParams: Record<string, string> = {
    oauth_callback: `${callbackUrl}?state=${state}`,
    oauth_consumer_key: consumerKey,
    oauth_nonce: oauthNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: oauthTimestamp(),
    oauth_version: "1.0",
  };

  const signature = await oauthSign("POST", config.requestTokenUrl, oauthParams, {}, consumerSecret);
  const response = await fetch(config.requestTokenUrl, {
    method: "POST",
    headers: { Authorization: oauthAuthHeader({ ...oauthParams, oauth_signature: signature }) },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    console.error(JSON.stringify({ event: "oauth1_request_token_failed", platform, status: response.status, body: text }));
    throw new ApiError(`Failed to get request token from ${platform}`, 502, "PROVIDER_ERROR");
  }

  const params = new URLSearchParams(await response.text());
  const requestToken = params.get("oauth_token");
  const requestTokenSecret = params.get("oauth_token_secret");
  const confirmed = params.get("oauth_callback_confirmed");

  if (!requestToken || !requestTokenSecret || confirmed !== "true") {
    throw new ApiError(`${platform} returned an invalid request token response`, 502, "PROVIDER_ERROR");
  }

  await repository.setOAuthState(
    state,
    platform,
    JSON.stringify({ request_token: requestToken, request_token_secret: requestTokenSecret }),
  );

  return json({
    platform,
    url: `${config.authorizeUrl}?oauth_token=${encodeURIComponent(requestToken)}`,
    message: `Open the URL in your browser to authorize ${DESCRIPTORS[platform].label}. After authorizing, return here.`,
  });
}

async function callbackOAuth1(
  config: WorkerOAuth1Config,
  platform: Platform,
  request: Request,
  env: Env,
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

  const stateData = JSON.parse(storedState.data) as { request_token_secret?: string };
  const requestTokenSecret = stateData.request_token_secret ?? "";

  const consumerKey = (env[config.consumerKeyEnv] as string | undefined)?.trim() ?? "";
  const consumerSecret = (env[config.consumerSecretEnv] as string | undefined)?.trim() ?? "";

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: oauthNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: oauthTimestamp(),
    oauth_token: oauthToken,
    oauth_verifier: oauthVerifier,
    oauth_version: "1.0",
  };

  const signature = await oauthSign(
    "POST",
    config.accessTokenUrl,
    oauthParams,
    {},
    consumerSecret,
    requestTokenSecret,
  );

  const response = await fetch(config.accessTokenUrl, {
    method: "POST",
    headers: { Authorization: oauthAuthHeader({ ...oauthParams, oauth_signature: signature }) },
  });

  if (!response.ok) {
    return htmlPage("Authorization failed", `Could not exchange the OAuth verifier with ${platform}. Please try again.`);
  }

  const resultParams = new URLSearchParams(await response.text());
  const accessToken = resultParams.get("oauth_token");
  const accessTokenSecret = resultParams.get("oauth_token_secret");

  if (!accessToken || !accessTokenSecret) {
    return htmlPage("Authorization failed", `${platform} returned an invalid access token response.`);
  }

  const credentialData: Record<string, string> = {
    access_token: accessToken,
    access_token_secret: accessTokenSecret,
  };

  // Let the platform adapter parse any extra fields from the response.
  const extra = config.parseExtraCredentials?.(resultParams) ?? {};
  Object.assign(credentialData, extra);

  // Normalize the keys to what this platform's descriptor and adapter expect.
  // (The descriptor's parseDirectCredential uses platform-native keys; we match those.)
  const storedData = DESCRIPTORS[platform].parseDirectCredential(
    normalizeOAuth1ResponseToDirectFormat(platform, credentialData),
  );
  await repository.setCredential(platform, storedData);

  return htmlPage(
    `${DESCRIPTORS[platform].label} connected`,
    `${DESCRIPTORS[platform].label} was authorized successfully. You can close this tab and return to the agent.`,
  );
}

/**
 * Map OAuth 1.0a access token response keys to the shape that each platform's
 * parseDirectCredential expects, so the stored credential is consistent whether
 * it came from OAuth or was submitted directly.
 */
function normalizeOAuth1ResponseToDirectFormat(
  platform: Platform,
  raw: Record<string, string>,
): Record<string, string> {
  // Tumblr stores token/token_secret (matching TumblrPublisher); other OAuth 1.0a platforms
  // use access_token/access_token_secret already.
  if (platform === "tumblr") {
    const { access_token, access_token_secret, ...rest } = raw;
    return { token: access_token ?? "", token_secret: access_token_secret ?? "", ...rest };
  }
  return raw;
}

// ---------------------------------------------------------------------------
// OAuth 2.0
// ---------------------------------------------------------------------------

async function connectOAuth2(
  config: WorkerOAuth2Config,
  platform: Platform,
  callbackUrl: string,
  env: Env,
  repository: D1Repository,
): Promise<Response> {
  const clientId = (env[config.clientIdEnv] as string | undefined)?.trim();
  if (!clientId) {
    throw new ApiError(`${String(config.clientIdEnv)} is not configured`, 422, "PLATFORM_NOT_CONFIGURED");
  }

  const state = crypto.randomUUID();
  await repository.setOAuthState(state, platform);

  const authUrl = new URL(config.authorizationUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", config.scopes);

  return json({
    platform,
    url: authUrl.toString(),
    message: `Open the URL in your browser to authorize ${DESCRIPTORS[platform].label}. After authorizing, return here.`,
  });
}

async function callbackOAuth2(
  config: WorkerOAuth2Config,
  platform: Platform,
  request: Request,
  env: Env,
  repository: D1Repository,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return htmlPage(
      "Authorization failed",
      `${DESCRIPTORS[platform].label} denied the authorization: ${url.searchParams.get("error_description") ?? error}`,
    );
  }
  if (!state || !code) return htmlPage("Authorization failed", "Missing OAuth parameters.");

  const storedState = await repository.getOAuthState(state);
  if (!storedState || storedState.platform !== platform) {
    return htmlPage("Authorization failed", "Invalid or expired authorization session. Please start over.");
  }
  await repository.deleteOAuthState(state);

  const callbackUrl = `${url.protocol}//${url.host}${url.pathname}`;
  const tokenData = await exchangeOAuth2Code(config, code, callbackUrl, env);
  if (!tokenData) {
    return htmlPage("Authorization failed", "Failed to exchange authorization code. Please try again.");
  }

  const credentialData: Record<string, string> = { access_token: tokenData.access_token };
  if (tokenData.refresh_token) credentialData.refresh_token = tokenData.refresh_token;

  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : undefined;

  await repository.setCredential(platform, credentialData, expiresAt);

  return htmlPage(
    `${DESCRIPTORS[platform].label} connected`,
    `${DESCRIPTORS[platform].label} was authorized successfully. You can close this tab and return to the agent.`,
  );
}

// ---------------------------------------------------------------------------
// Token refresh (OAuth 2.0 only)
// ---------------------------------------------------------------------------

async function refreshCredential(
  platform: Platform,
  env: Env,
  repository: D1Repository,
): Promise<Response> {
  const desc = DESCRIPTORS[platform];
  if (!desc.oauth || desc.oauth.type !== "oauth2") {
    throw new ApiError(
      `${desc.label} does not support token refresh (OAuth 2.0 only)`,
      422,
      "INVALID_REQUEST",
    );
  }

  const cred = await repository.getCredential(platform);
  if (!cred) throw new ApiError(`No stored credential for ${platform}`, 404, "NOT_FOUND");
  if (!cred.refresh_token) {
    throw new ApiError(
      `No refresh token for ${platform}. Re-authorize via GET /v1/auth/${platform}/connect`,
      422,
      "INVALID_REQUEST",
    );
  }

  const config = desc.oauth;
  const clientId = (env[config.clientIdEnv] as string | undefined)?.trim();
  const clientSecret = (env[config.clientSecretEnv] as string | undefined)?.trim();
  if (!clientId || !clientSecret) {
    throw new ApiError(`OAuth app credentials for ${platform} are not configured`, 422, "PLATFORM_NOT_CONFIGURED");
  }

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cred.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    throw new ApiError(`${desc.label} token refresh failed (HTTP ${response.status})`, 502, "PROVIDER_ERROR");
  }

  const tokenData = await response.json() as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!tokenData.access_token) {
    throw new ApiError(`${desc.label} returned an invalid token refresh response`, 502, "PROVIDER_ERROR");
  }

  const updated: Record<string, string> = { ...cred, access_token: tokenData.access_token };
  if (tokenData.refresh_token) updated.refresh_token = tokenData.refresh_token;

  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : undefined;

  await repository.setCredential(platform, updated, expiresAt);
  return json({ platform, refreshed: true, expiresAt: expiresAt ?? null });
}

// ---------------------------------------------------------------------------
// OAuth 2.0 code exchange
// ---------------------------------------------------------------------------

async function exchangeOAuth2Code(
  config: WorkerOAuth2Config,
  code: string,
  redirectUri: string,
  env: Env,
): Promise<{ access_token: string; expires_in?: number; refresh_token?: string } | null> {
  const clientId = (env[config.clientIdEnv] as string | undefined)?.trim() ?? "";
  const clientSecret = (env[config.clientSecretEnv] as string | undefined)?.trim() ?? "";

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) return null;
  const data = await response.json() as { access_token?: string; expires_in?: number; refresh_token?: string };
  return data.access_token
    ? (data as { access_token: string; expires_in?: number; refresh_token?: string })
    : null;
}

// ---------------------------------------------------------------------------
// OAuth 1.0a signing
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
  return `OAuth ${Object.entries(params)
    .filter(([k]) => k.startsWith("oauth_"))
    .map(([k, v]) => `${enc(k)}="${enc(v)}"`)
    .join(", ")}`;
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
// Shared helpers
// ---------------------------------------------------------------------------

function oauthCallbackUrl(request: Request, platform: Platform): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}/v1/auth/${platform}/callback`;
}

function htmlPage(title: string, message: string): Response {
  const isError = /fail|error|not supported/i.test(title);
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${escHtml(title)} – Syndroo</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#1a1a1a}h1{font-size:1.4rem;margin-bottom:.5rem}p{color:#555;line-height:1.6}</style>
</head>
<body><h1>${escHtml(title)}</h1><p>${escHtml(message)}</p></body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
    status: isError ? 400 : 200,
  });
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
