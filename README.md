# Syndroo

Open-source publishing infrastructure for the social web.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Syndroo/syndroo)

Syndroo v0.1 is a small npm-workspaces monorepo. It accepts immediate or scheduled posts, stores one publication per selected platform in Cloudflare D1, dispatches publication jobs through Cloudflare Queues, and scans scheduled work with Cron Triggers.

Threads, Bluesky, X, Tumblr, and LinkedIn adapters are installed in v0.1. The public platform and publishing contracts live in `@syndroo/core`; adding another platform means adding one adapter package and wiring one explicit switch in the Worker. Requests for uninstalled or unconfigured platforms return `PLATFORM_NOT_CONFIGURED` instead of silently doing nothing. See the [SDK development roadmap](docs/platform-roadmap.md) for upcoming adapters.

## Using v0.1

Syndroo v0.1 is an HTTP API service. It does not include a web dashboard. Deploy it, then call the Worker URL from `curl`, an automation tool, or your own application.

### 1. Deploy

Click **Deploy to Cloudflare** at the top of this README. During setup, enter
`SYNDROO_API_KEY`, a long random secret chosen by you. After deployment, add
the credentials for the platforms you want to use in the Worker's **Settings →
Variables and Secrets** as secrets:

- `BLUESKY_IDENTIFIER`: your Bluesky handle, such as `alice.bsky.social`;
- `BLUESKY_PASSWORD`: a Bluesky app password, not your account password;
- `BLUESKY_HOST`: optional; defaults to `bsky.social`;
- `THREADS_ACCESS_TOKEN`: a long-lived Threads user access token with `threads_basic` and `threads_content_publish`.

Wait for the Cloudflare build to succeed. Open the deployed Worker in Cloudflare and copy its `https://...workers.dev` URL.

For X, see [X credentials](#x-credentials-and-publishing). For Tumblr, see
[Tumblr credentials](#tumblr-credentials-and-publishing). For LinkedIn, see
[LinkedIn credentials](#linkedin-credentials-and-publishing).

Platforms are enabled independently: Bluesky needs both identifier and app
password; Threads needs its access token; X needs all four OAuth credentials;
Tumblr needs four OAuth credentials and a valid target blog name; LinkedIn needs
a token, author URN, and API version. Missing credentials return HTTP `422`
with `PLATFORM_NOT_CONFIGURED` before persistence or Queue delivery. A deployment
without platform credentials can serve health checks but cannot accept posts.

Bluesky uses the official `@atproto/api` SDK. Syndroo controls timeouts and
retries and preserves the existing `bluesky-native` provider identifier for
compatibility. Threads retains its existing HTTP adapter; SDK migration is
outside the current roadmap.

Set two variables in the terminal that will call Syndroo:

```bash
export SYNDROO_URL="https://your-worker.your-subdomain.workers.dev"
export SYNDROO_API_KEY="the-same-secret-entered-during-deployment"
```

Do not commit either value. Treat `SYNDROO_API_KEY` like a password: anyone who has it can publish through this Worker.

### 2. Check the service

The health endpoint does not require authentication:

```bash
curl "$SYNDROO_URL/health"
```

Expected response:

```json
{"status":"ok"}
```

### 3. Publish to Threads and Bluesky

```bash
curl -X POST "$SYNDROO_URL/v1/posts" \
  -H "Authorization: Bearer $SYNDROO_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: example-post-001" \
  --data '{
    "content": "Hello from Syndroo on Threads",
    "platforms": ["threads", "bluesky"],
    "overrides": {
      "bluesky": { "content": "Hello from Syndroo on Bluesky" }
    }
  }'
```

Syndroo accepts the request before the Queue finishes publishing, so the response uses HTTP `202`:

```json
{
  "id": "post_...",
  "status": "queued"
}
```

Copy the returned `id`. `queued` means accepted for processing, not yet confirmed by either platform.

All v0.1 adapters publish text only. Threads content is limited to 500 Unicode characters. Bluesky content is limited to 300 Unicode characters and 3,000 UTF-8 bytes; HTTP(S) URLs receive link facets. X supports standard posts of up to 280 weighted characters, validated with `twitter-text` before network access. Longer content can be accepted by the API but its platform publication later finishes as `failed` with `INVALID_CONTENT`.

`Idempotency-Key` is optional but recommended for deployment automation. Use a stable key for one logical post. Repeating the same request with the same key returns the original post with `replayed: true`; reusing it with different content returns HTTP `409`.

### Threads access token

Create a Meta app with the **Threads use case**, authorize your Threads account, and request at least `threads_basic` plus `threads_content_publish`. Exchange the short-lived user token for a long-lived token, then store that value as `THREADS_ACCESS_TOKEN`. Meta's official [Threads API Postman workspace](https://www.postman.com/meta/threads/collection/dht3nzz/threads-api) contains the current authorization, token exchange, refresh, and token-debugger requests.

Do not use an app access token here. Syndroo needs a **Threads user access token** authorized to publish for the account. Long-lived tokens expire; refresh the token before expiry and replace the Worker secret.

### X credentials and publishing

X uses the official `@xdevplatform/xdk` SDK with OAuth 1.0a user authentication.
Create an X developer app with **Read and Write** permissions, then generate
the account's access token and secret. If permissions change, regenerate the
user credentials. Configure all four Worker secrets to enable X:

- `X_API_KEY`: consumer API key;
- `X_API_SECRET`: consumer API secret;
- `X_ACCESS_TOKEN`: user access token;
- `X_ACCESS_TOKEN_SECRET`: paired user access token secret.

These are optional for deployments that do not publish to X. An app-only bearer
token is not sufficient. API access and available credits are managed in the X
Developer Console; using the SDK does not grant posting access.

Use `"platforms": ["x"]` in the existing post API, optionally alongside
`"threads"` and `"bluesky"`. Platform-specific text uses
`"overrides": { "x": { "content": "Text for X" } }`. The provider identifier is
`x-sdk`; a successful publication returns the post ID and an `x.com` URL.

The adapter normalizes text to NFC and uses X's weighted length rules, including
CJK and emoji weights and shortened URL lengths. Premium long posts, media,
replies, and OAuth login/token issuance flows are outside this version. SDK
retries are disabled. Timeouts, interrupted responses, and post-stage 5xx remain
ambiguous and are not automatically resent.

References: [official SDK](https://docs.x.com/tools/typescript-xdk),
[character counting](https://docs.x.com/fundamentals/counting-characters),
[creating posts](https://docs.x.com/x-api/posts/create-post).

### Tumblr credentials and publishing

Tumblr uses native HTTP with OAuth 1.0a and Web Crypto signing. Register an
application at [Tumblr OAuth apps](https://www.tumblr.com/oauth/apps), authorize
the publishing account, and obtain its consumer and user credentials. Configure:

- `TUMBLR_CONSUMER_KEY`: application's OAuth consumer key;
- `TUMBLR_CONSUMER_SECRET`: application's OAuth consumer secret;
- `TUMBLR_TOKEN`: authorized user's OAuth token;
- `TUMBLR_TOKEN_SECRET`: paired user token secret;
- `TUMBLR_BLOG`: target blog name, such as `alice` or `alice.tumblr.com`.

The authorized account must have posting permission for the target blog.
URLs, custom domains, and blog UUIDs are not accepted in this version.
All five values are optional unless publishing to Tumblr; store them as Worker
secrets. Add their names to a deployment template's local secret list, not
production `secrets.required`. No new D1 migration is required.

Use `"platforms": ["tumblr"]`, optionally with other installed platforms.
An override is `"overrides": { "tumblr": { "content": "Text for Tumblr" } }`.
Syndroo sends one NPF text block, limited to 4,096 Unicode code points.
HTML and Markdown are plain text; no media, tags, drafts, or reblogs are supported.
Scheduling stays in Syndroo, not Tumblr's queue. The provider is `tumblr-native`;
success returns a string post ID and a Tumblr post URL.

Requests have a 15-second deadline through response reading, a 64 KiB response
limit, and no adapter retries. Unknown outcomes are ambiguous and not resent.
OAuth login and token issuance are outside this release.

References: [NPF publishing API](https://github.com/tumblr/docs/blob/master/api.md#posts---createreblog-a-post-neue-post-format),
[NPF text limits](https://github.com/tumblr/docs/blob/master/npf-spec.md#text-block-length).

### LinkedIn credentials and publishing

LinkedIn uses an independently written native HTTP adapter for `POST /rest/posts`.
Configure these optional Worker secrets to enable it:

- `LINKEDIN_ACCESS_TOKEN`: a user OAuth access token authorized for publishing;
- `LINKEDIN_AUTHOR`: one `urn:li:person:<member-id>` or
  `urn:li:organization:<numeric-id>`, not a profile/Page URL;
- `LINKEDIN_API_VERSION`: an explicitly selected supported `YYYYMM` version.
  `202604` is the documentation baseline used here, not an automatically updated default.

Create a LinkedIn developer application and obtain the appropriate API product
access. Personal publishing needs `w_member_social` (Share on LinkedIn).
Organization publishing needs `w_organization_social`, the relevant product
access, and an eligible Page role for the authenticated member. A token and a
syntactically valid URN do not prove these permissions; LinkedIn checks them.
Use the author identifier supplied by LinkedIn's authorized APIs or developer
tools. Never substitute a profile vanity name. Renew expired tokens outside
Syndroo and replace the secret.

Use `"platforms": ["linkedin"]` and, optionally,
`"overrides": { "linkedin": { "content": "LinkedIn text" } }`.
v0.1 publishes public, text-only posts to the main feed under the configured
author. There is no per-request author, OAuth login UI, token refresh, media,
reshare, or audience targeting. Scheduling stays in Syndroo.

Text is escaped for LinkedIn's little-text grammar so punctuation and apparent
mentions remain literal. Markdown and mention markup are not interpreted.
Syndroo conservatively allows at most **3,000 UTF-16 units after escaping**:
emoji may consume two units, and reserved characters add an escape unit.
This can reject some text that the LinkedIn website accepts; nothing is truncated.
Over-limit publications fail with `INVALID_CONTENT` before network access.

The provider is `linkedin-native`. Success requires HTTP `201` and a valid
`x-restli-id` post URN. Response bodies are canceled without buffering; the
adapter does not depend on success JSON. Requests have a 15-second deadline,
redirects are disabled, and unknown results are not automatically resent.

Add the three names to a thin template's local secret list, not production
`secrets.required`. No D1 migration is needed. Track LinkedIn version retirements:
update `LINKEDIN_API_VERSION` after reviewing the target API version. Format
validation cannot determine whether LinkedIn still supports a version.

References: [Posts API and permissions](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-04),
[little-text grammar](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format?view=li-lms-2026-03),
[API versioning](https://learn.microsoft.com/en-us/linkedin/marketing/versioning?view=li-lms-2026-04).
Native HTTP avoids distributing the restricted SDK, but LinkedIn API terms and
application approval still apply.

### 4. Check the result

```bash
curl \
  -H "Authorization: Bearer $SYNDROO_API_KEY" \
  "$SYNDROO_URL/v1/posts/post_..."
```

A successful publication eventually looks like:

```json
{
  "id": "post_...",
  "content": "Hello from Syndroo",
  "platforms": ["bluesky"],
  "status": "published",
  "createdAt": "2030-01-02T03:04:05.000Z",
  "publications": [
    {
      "id": "pub_...",
      "postId": "post_...",
      "platform": "bluesky",
      "provider": "bluesky-native",
      "content": "Hello from Syndroo",
      "status": "published",
      "attempts": 1,
      "externalId": "bafyre...",
      "externalUrl": "https://bsky.app/profile/.../post/...",
      "errorAmbiguous": false,
      "createdAt": "2030-01-02T03:04:05.000Z",
      "publishedAt": "2030-01-02T03:04:06.000Z"
    }
  ]
}
```

If it is still `queued` or `publishing`, wait briefly and request the same URL again. If it is `failed`, inspect `errorCode`, `errorMessage`, and `errorAmbiguous` in the publication entry.

### 5. Schedule a post

`scheduledAt` must be an ISO date-time. Use an explicit timezone, preferably UTC with `Z`:

```bash
curl -X POST "$SYNDROO_URL/v1/posts" \
  -H "Authorization: Bearer $SYNDROO_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "content": "Shared fallback",
    "platforms": ["bluesky"],
    "overrides": {
      "bluesky": { "content": "Scheduled Bluesky post" }
    },
    "scheduledAt": "2030-01-02T03:04:05.000Z"
  }'
```

Expected response:

```json
{
  "id": "post_...",
  "status": "scheduled",
  "scheduledAt": "2030-01-02T03:04:05.000Z"
}
```

Cron scans every 15 minutes. Scheduled publication can therefore occur up to roughly 15 minutes after the requested time. A `scheduledAt` value in the past is handled as an immediate post.

### 6. List recent posts

```bash
curl \
  -H "Authorization: Bearer $SYNDROO_API_KEY" \
  "$SYNDROO_URL/v1/posts?limit=50"
```

`limit` is optional, defaults to `50`, and must be an integer from `1` to `100`. The response shape is:

```json
{
  "items": [
    {
      "id": "post_...",
      "content": "Hello from Syndroo",
      "platforms": ["bluesky"],
      "status": "published",
      "createdAt": "2030-01-02T03:04:05.000Z"
    }
  ]
}
```

### Statuses

Post statuses:

- `scheduled`: waiting for `scheduledAt`;
- `queued`: accepted and waiting for a publication job;
- `publishing`: at least one platform request is running;
- `published`: every selected platform succeeded;
- `partial`: some platforms succeeded and some failed;
- `failed`: every selected platform failed.

Publication statuses:

- `scheduled`: waiting for its scheduled time;
- `pending`: ready for Queue delivery;
- `publishing`: claimed by a Queue consumer;
- `published`: platform confirmed success;
- `failed`: stopped after a terminal or exhausted failure.

`threads`, `bluesky`, `x`, `tumblr`, and `linkedin` can be selected in v0.1 when their credentials are configured. Other recognized platform names return HTTP `422` with `PLATFORM_NOT_CONFIGURED`.

### Error responses

Errors use one JSON shape:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "platforms must be a non-empty array"
  }
}
```

Common responses:

- `400`: invalid JSON, content, platforms, overrides, date, or list limit;
- `401`: missing or incorrect Bearer token;
- `409`: an idempotency key was reused with a different request;
- `404`: route or post not found;
- `413`: request body exceeds 64 KiB;
- `415`: request body is not `application/json`;
- `422`: requested platform adapter is not installed or its credentials are missing.

## Architecture

    client
      │ Bearer-authenticated HTTP
      ▼
    packages/cloudflare-worker
      ├── D1: posts + per-platform publications
      ├── Queue producer/consumer
      ├── Cron: due-post scan + stale-job recovery
      └── explicit publisher selection
              │
              ▼
    packages/threads ─────► Meta Threads API
    packages/bluesky ─────► Bluesky AT Protocol
    packages/x ───────────► X API v2
    packages/tumblr ──────► Tumblr NPF API
    packages/linkedin ────► LinkedIn Posts API
              │
              └──────────► packages/core

Repository layout:

    .
    ├── packages/
    │   ├── core/                     # domain types, Publisher, normalized errors
    │   ├── bluesky/                  # native text-only Bluesky adapter
    │   ├── threads/                  # native text-only Threads adapter
    │   ├── x/                        # official X SDK text adapter
    │   ├── tumblr/                   # native HTTP NPF text adapter
    │   ├── linkedin/                 # native HTTP Posts text adapter
    │   └── cloudflare-worker/        # public bundled Worker package
    ├── experiments/
    │   └── crosspost-cloudflare/     # isolated workerd failure reproduction
    ├── docs/
    └── wrangler.jsonc                # one production deployment manifest

Dependency direction is `core ← {bluesky, threads, x, tumblr, linkedin} ← cloudflare-worker`. Core imports neither platform code nor Cloudflare APIs.

The abstraction is deliberately narrow:

- one `Publisher.publish()` contract;
- one concrete `D1Repository`, without an ORM or generic repository layer;
- one explicit platform switch, without a registry or dependency-injection container;
- Cloudflare bindings and lifecycle handlers stay inside the Worker app.

## Distribution and upgrades

`@syndroo/cloudflare-worker` is the only public npm package. It contains the
Worker plus the core, Bluesky, Threads, X, Tumblr, and LinkedIn implementation; those internal
workspace packages are not separate public APIs.

The long-term deployment entry point is the separate
`Syndroo/syndroo-deploy-template` repository. That repository stays small: it
pins one Worker package version and owns only the Cloudflare configuration and
user customizations. Dependabot proposes package upgrades as pull requests.
Users review Worker changes, D1 migrations, and any new secrets before merging.
Nothing automatically merges or writes to production `main`.

Until the first npm package and deployment template are published, the deploy
button above continues to use this source repository. See
[Releasing Syndroo](docs/releasing.md) for the bootstrap and release process.

## Local use

Requirements: Node.js 22 or newer and npm.

All repository-owned executable code and tests are TypeScript. JSONC, JSON, SQL, and Markdown remain in their native configuration or data formats. Internal `.js` import suffixes are intentional NodeNext ESM paths that resolve from TypeScript source to compiled JavaScript.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm test
npm run check
npm run dev
```

Put only the platform credentials you use in `.dev.vars`. Do not commit this
file. `npm run dev` selects the `local` Wrangler environment so optional platform
secrets are loaded. Warnings for unused platform secrets are expected. Production
requires only `SYNDROO_API_KEY`; never deploy using `--env local`.

The local Worker defaults to `http://localhost:8787`.

## Cloudflare deployment

For the fastest setup, click the **Deploy to Cloudflare** button at the top of this README. Cloudflare creates an independent repository in your GitHub account; it is not a GitHub fork and does not retain an upstream relationship. Cloudflare prompts for the required API key, provisions D1 and Queue resources, applies D1 migrations, configures the Cron Trigger, and deploys the Worker. Add optional platform secrets after deployment. Future pushes to the generated repository are deployed by Workers Builds.

The API key is required. Configure the remaining secrets only for platforms you use:

- `SYNDROO_API_KEY`: a long random secret used by clients as the Bearer token;
- `BLUESKY_IDENTIFIER`: your Bluesky handle;
- `BLUESKY_PASSWORD`: a Bluesky app password, not your account password;
- `BLUESKY_HOST`: optional; defaults to `bsky.social`;
- `THREADS_ACCESS_TOKEN`: a long-lived Threads user access token with publishing permission.

For X, also configure `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, and
`X_ACCESS_TOKEN_SECRET`; see [X setup](#x-credentials-and-publishing).

The deploy button requires a public GitHub or GitLab source repository. It deploys only the production Worker described by the root `wrangler.jsonc`; the Crosspost experiment is not deployed.

For manual CLI deployment, set secrets interactively:

```bash
npx wrangler secret put SYNDROO_API_KEY
npx wrangler secret put BLUESKY_IDENTIFIER
npx wrangler secret put BLUESKY_PASSWORD
npx wrangler secret put BLUESKY_HOST
npx wrangler secret put THREADS_ACCESS_TOKEN
```

Deploy after setting the secrets:

```bash
npm run deploy
```

The deployment script checks the declared `syndroo` D1 database, repairs a missing or stale generated database ID, applies pending migrations, and deploys the Worker. Wrangler provisions the `syndroo-publications` Queue when it does not exist. The account-specific D1 ID is written only to a temporary ignored configuration file.

## Implementation notes

- Queue delivery is at least once. A publication is claimed atomically before outbound work, so duplicate messages do not normally duplicate posts.
- Client retries should provide `Idempotency-Key`; D1 stores a unique key so deployment retries cannot create another logical post.
- A timeout or 5xx after the remote publish request can be ambiguous: the platform may have accepted the post. Ambiguous failures are stored and are not retried automatically.
- Only rate-limit, provider-unavailable, and unambiguous network failures are retried, with a maximum of three application attempts.
- If enqueue fails, or an acknowledged Queue lease becomes stale, the post stays pending. Cron acts as a small outbox recovery loop and enqueues it later.
- A publication stuck in `publishing` for 15 minutes becomes an ambiguous failure instead of being blindly replayed.
- The request body is capped at 64 KiB. Bluesky text is validated before network access.
- Run `npm run check` after changing bindings; Wrangler regenerates `Env` types from `wrangler.jsonc`.
- Keep Cloudflare-specific routing, bindings, and Worker code inside `packages/cloudflare-worker`.
- Keep experiments out of production imports and dependencies.

Crosspost 1.0.4 remains an isolated compatibility experiment because it bundles but cannot boot in workerd. See [Crosspost Cloudflare spike](docs/crosspost-cloudflare-spike.md).

Tumblr uses native HTTP after its SDK spike identified missing cancellation and
response-size controls. The SDK remains isolated in experiments. See the
[Tumblr spike report](docs/tumblr-cloudflare-spike.md).

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Grant Dai.

Contributions require a Developer Certificate of Origin sign-off. See
[CONTRIBUTING.md](CONTRIBUTING.md).
