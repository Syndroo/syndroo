# Syndroo Connect

Connect social platforms to a running Syndroo instance and publish content through the agent.

## When to use this skill

Load this skill whenever the user wants to:
- Connect (authorize) a social platform like X, Bluesky, Threads, LinkedIn, or Tumblr
- Publish or schedule content to one or more platforms
- Check which platforms are currently connected
- Disconnect a platform

---

## Step 1 — Locate the Syndroo endpoint

Ask the user for the Syndroo base URL if you do not already know it.

| Scenario | Typical base URL |
|----------|-----------------|
| Local development | `http://localhost:8787` |
| Cloudflare deployment | `https://<worker-subdomain>.workers.dev` |
| Custom domain | `https://api.yourdomain.com` |

You also need the `SYNDROO_API_KEY`. Store it for this session; never print it in responses.

---

## Step 2 — Check connected platforms

```
GET {base_url}/v1/auth
Authorization: Bearer {api_key}
```

Response shape:
```json
{
  "platforms": {
    "bluesky":  { "configured": true,  "source": "credential", "oauthSupported": false },
    "threads":  { "configured": false, "source": null,         "oauthSupported": false },
    "x":        { "configured": false, "source": null,         "oauthSupported": true  },
    "tumblr":   { "configured": true,  "source": "env",        "oauthSupported": true  },
    "linkedin": { "configured": false, "source": null,         "oauthSupported": true  }
  }
}
```

- `source: "credential"` → token stored in D1 (via this flow)
- `source: "env"` → configured via environment variable at deployment time
- `source: null` → not connected

---

## Step 3 — Connect a platform

Choose the right method based on the platform:

### Method A – Direct token submission (Bluesky, Threads)

Use when the user can obtain a token directly from the platform's developer settings without an OAuth redirect.

**Bluesky** — uses an app password (not the account password):
1. Tell the user: "Go to <https://bsky.app/settings/app-passwords> and create a new app password."
2. Ask for their handle (e.g. `alice.bsky.social`) and the app password.
3. Submit:
   ```
   POST {base_url}/v1/auth/bluesky
   Authorization: Bearer {api_key}
   Content-Type: application/json
   { "identifier": "{handle}", "password": "{app_password}" }
   ```

**Threads** — uses a long-lived user token:
1. Tell the user: "Go to the Meta for Developers portal → your Threads app → Roles → Generate a long-lived user access token."
2. Ask for the token.
3. Submit:
   ```
   POST {base_url}/v1/auth/threads
   Authorization: Bearer {api_key}
   Content-Type: application/json
   { "access_token": "{token}" }
   ```

---

### Method B – OAuth browser flow (X, LinkedIn, Tumblr)

Use when the platform requires the user to click "Authorize" in their browser.

**Prerequisites (developer must configure once):**
- **X / Tumblr**: `X_API_KEY` + `X_API_SECRET` (or `TUMBLR_CONSUMER_KEY` + `TUMBLR_CONSUMER_SECRET`) must be set as environment variables / Cloudflare secrets. These are the OAuth *app* credentials, not the user's tokens.
- **LinkedIn**: `LINKEDIN_CLIENT_ID` + `LINKEDIN_CLIENT_SECRET` must be set, and `{base_url}/v1/auth/linkedin/callback` must be added as an authorized redirect URL in the LinkedIn app settings.

**Steps:**

1. Call the connect endpoint to get the authorization URL:
   ```
   GET {base_url}/v1/auth/{platform}/connect
   Authorization: Bearer {api_key}
   ```
   Response:
   ```json
   { "platform": "x", "url": "https://api.twitter.com/oauth/authorize?oauth_token=…", "message": "…" }
   ```

2. Tell the user: "Open this URL in your browser: `{url}`"
   - **If your agent has a built-in browser** (e.g. Claude's browser tool, Codex browser), navigate to the URL automatically.
   - **Otherwise**, ask the user to open it manually.

3. The user logs in and clicks "Authorize" on the platform's page.
   The platform redirects to `{base_url}/v1/auth/{platform}/callback`, which completes the token exchange and stores the credentials automatically. The browser shows a success page.

4. Ask the user: "Did the browser show a success page?" or confirm by calling:
   ```
   GET {base_url}/v1/auth/{platform}
   Authorization: Bearer {api_key}
   ```
   A `"configured": true` response confirms the token was stored.

---

### Method C – Direct access token (X, Tumblr, LinkedIn) — advanced

If the user already has their own access tokens (e.g. from the developer portal), submit them directly without going through the OAuth flow:

**X:**
```
POST {base_url}/v1/auth/x
Authorization: Bearer {api_key}
Content-Type: application/json
{ "access_token": "{token}", "access_token_secret": "{secret}" }
```

**Tumblr:**
```
POST {base_url}/v1/auth/tumblr
Authorization: Bearer {api_key}
Content-Type: application/json
{ "token": "{token}", "token_secret": "{secret}", "blog": "{blog-name}" }
```

**LinkedIn:**
```
POST {base_url}/v1/auth/linkedin
Authorization: Bearer {api_key}
Content-Type: application/json
{ "access_token": "{token}", "author": "urn:li:person:{member-id}" }
```

---

## Step 4 — Publish content

Once at least one platform is connected, post content with:

```
POST {base_url}/v1/posts
Authorization: Bearer {api_key}
Idempotency-Key: {unique-key}
Content-Type: application/json
{
  "content": "Hello from Syndroo!",
  "platforms": ["bluesky", "x"]
}
```

- `platforms` is a non-empty array of connected platform names.
- `Idempotency-Key` prevents duplicate posts; use a UUID or a deterministic key per piece of content.
- Response `202 Accepted` means the post is queued; check status with `GET {base_url}/v1/posts/{id}`.

Optional override per platform (e.g. different wording on X):
```json
{
  "content": "Default text for all platforms",
  "platforms": ["bluesky", "x"],
  "overrides": {
    "x": { "content": "Shorter text for X (max ~280 chars)" }
  }
}
```

---

## Step 5 — Disconnect a platform

```
DELETE {base_url}/v1/auth/{platform}
Authorization: Bearer {api_key}
```

This removes the D1-stored credential. If the platform was configured via an environment variable, the env-var credential remains active until the environment is updated.

---

## Error handling

| HTTP status | `code` | Action |
|-------------|--------|--------|
| 401 | `UNAUTHORIZED` | Check the API key |
| 422 | `PLATFORM_NOT_CONFIGURED` | App credentials for OAuth not set; use Method A or C instead |
| 502 | `PROVIDER_ERROR` | Platform's OAuth endpoint failed; retry or check app credentials |
| 409 | `IDEMPOTENCY_CONFLICT` | Same `Idempotency-Key` used with different content; use a new key |

---

## Quick reference — which method to suggest

| Platform | Recommended method | Notes |
|----------|--------------------|-------|
| Bluesky | **A** (app password) | Fast, no OAuth setup needed |
| Threads | **A** (long-lived token) | Get from Meta for Developers portal |
| X | **B** (OAuth browser) if app keys set, else **C** | Requires X developer app |
| Tumblr | **B** (OAuth browser) if app keys set, else **C** | Requires Tumblr app |
| LinkedIn | **B** (OAuth browser) if client credentials set, else **C** | Requires LinkedIn app |

When the user says they have no developer account and no existing tokens, guide them to **create a developer app** on the platform first (X: <https://developer.x.com>, LinkedIn: <https://developer.linkedin.com>, Tumblr: <https://www.tumblr.com/oauth/apps>).
