# Syndroo

Open-source publishing infrastructure for the social web.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Syndroo/syndroo)

Syndroo `0.2.0-rc.1` is a release candidate, not a published release. It is a small npm-workspaces monorepo that accepts immediate or scheduled posts, stores one publication per selected platform in Cloudflare D1, dispatches publication jobs through Cloudflare Queues, and scans scheduled work with Cron Triggers.

Threads, Bluesky, X, Tumblr, and LinkedIn adapters are installed in the v0.2 candidate. The public platform and publishing contracts live in `@syndroo/core`; adding another platform means adding one adapter package and wiring one explicit switch in the Worker. Requests for uninstalled or unconfigured platforms return `PLATFORM_NOT_CONFIGURED` instead of silently doing nothing. See the [SDK development roadmap](docs/platform-roadmap.md) for upcoming adapters.

## Release status

- Bluesky (official `@atproto/api` SDK) and Threads are exercised locally by the
  Mock SNS end-to-end gate. Live-account acceptance is still pending, so neither
  platform is claimed as validated.
- X, Tumblr, and LinkedIn are experimental. They are implemented and covered by
  unit tests, but they have not been validated against live accounts.
- The Deploy to Cloudflare button still deploys this source repository. The thin
  `syndroo-deploy-template` passed isolated local installation, migration,
  build, and startup checks. Registry installation and live deployment remain
  pending, and the button is not yet wired to it.

This `0.2.0-rc.1` candidate has not been published to npm or tagged, and it has
not been accepted as a release. See [docs/testing.md](docs/testing.md) for gate coverage and
[docs/v0.2.0-todo.md](docs/v0.2.0-todo.md) for the outstanding release gates.

## Using v0.2.0-rc.1 (candidate)

The v0.2 candidate is an HTTP API service. It does not include a web dashboard. Deploy it, then call the Worker URL from `curl`, an automation tool, or your own application.

### 1. Deploy

Click **Deploy to Cloudflare** at the top of this README. During setup, enter
`SYNDROO_API_KEY`, a long random secret chosen by you. After deployment, add
the credentials for the platforms you want to use in the Worker's **Settings →
Variables and Secrets** as secrets. Bluesky is the platform used by the
first-post walkthrough below:

- `BLUESKY_IDENTIFIER`: your Bluesky handle, such as `alice.bsky.social`;
- `BLUESKY_PASSWORD`: a Bluesky app password, not your account password;
- `BLUESKY_HOST`: optional; defaults to `bsky.social`.

Wait for the Cloudflare build to succeed. Open the deployed Worker in Cloudflare and copy its `https://...workers.dev` URL.

Threads, X, Tumblr, and LinkedIn stay optional. Add their secrets the same way
and follow [Additional platforms](#additional-platforms).

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

### 3. Publish your first post

```bash
curl -X POST "$SYNDROO_URL/v1/posts" \
  -H "Authorization: Bearer $SYNDROO_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: example-post-001" \
  --data '{
    "content": "Hello from Syndroo",
    "platforms": ["bluesky"]
  }'
```

Syndroo accepts the request before the Queue finishes publishing, so the response uses HTTP `202`:

```json
{
  "id": "post_...",
  "status": "queued"
}
```

Copy the returned `id`. `queued` means accepted for processing, not yet confirmed by the platform.

Query the stored status with that `id`:

```bash
curl \
  -H "Authorization: Bearer $SYNDROO_API_KEY" \
  "$SYNDROO_URL/v1/posts/post_..."
```

At first the response reports `"status": "queued"` or `"publishing"`, and the
Post becomes `"published"` after Bluesky confirms it; each publication reports
its own `status` as well. [Step 4](#4-check-the-result) shows the completed
response shape and how to read a `failed` result.

All adapters in this candidate publish text only. Bluesky content is limited to 300 Unicode characters and 3,000 UTF-8 bytes; HTTP(S) URLs receive link facets. Threads content is limited to 500 Unicode characters. X supports standard posts of up to 280 weighted characters, validated with `twitter-text` before network access. Longer content can be accepted by the API but its platform publication later finishes as `failed` with `INVALID_CONTENT`.

`Idempotency-Key` is optional but recommended for deployment automation. Use a stable key for one logical post. Repeating the same request with the same key returns the original post with `replayed: true`; reusing it with different content returns HTTP `409`.

### Additional platforms

Add a platform to `platforms` after configuring its secrets; the same request
can target several platforms at once.

```bash
curl -X POST "$SYNDROO_URL/v1/posts" \
  -H "Authorization: Bearer $SYNDROO_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "content": "Shared text",
    "platforms": ["bluesky", "threads"],
    "overrides": {
      "threads": { "content": "Threads-specific text" }
    }
  }'
```

- [Threads access token](#threads-access-token);
- [X credentials and publishing](#x-credentials-and-publishing);
- [Tumblr credentials and publishing](#tumblr-credentials-and-publishing);
- [LinkedIn credentials and publishing](#linkedin-credentials-and-publishing).

Selecting a platform without its required credential configuration returns HTTP
`422` with `PLATFORM_NOT_CONFIGURED`; the request is rejected before anything is
stored or queued, so a partially configured deployment never accepts work it
cannot dispatch. Configuration is checked for presence and shape only: an
expired, revoked, or insufficiently authorized credential passes that check and
surfaces later as a publication failure with `errorCode` `AUTH`. Live-account
validation of every platform is still pending, as described in
[Release status](#release-status).

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
The candidate publishes public, text-only posts to the main feed under the configured
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

Poll the same URL until the Post and every publication reach a terminal status.
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

`threads`, `bluesky`, `x`, `tumblr`, and `linkedin` can be selected in the v0.2 candidate when their credentials are configured. Other recognized platform names return HTTP `422` with `PLATFORM_NOT_CONFIGURED`.

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

### Maintenance mode

`SYNDROO_MAINTENANCE` is an optional, non-secret Worker variable that rejects
new posts during a migration cutover without taking the service offline. Only
the exact string `true` enables it; `false` or an unset variable keeps normal
operation. Change the value in the Worker's **Settings → Variables and Secrets**
or in `wrangler.jsonc` and save it as a new Worker version.

While maintenance is enabled, an authenticated `POST /v1/posts` returns HTTP `503`:

```json
{
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "Syndroo is in maintenance mode and is not accepting new posts; retry later with the same Idempotency-Key and request body"
  }
}
```

The rejection happens after Bearer authentication and before the request body,
the idempotency key, or the database is read, so maintenance never creates a
post and never records an `Idempotency-Key`. `GET /health` and the
authenticated `GET /v1/posts` and `GET /v1/posts/<id>` queries keep working, and
requests without a valid Bearer token still return `401`.

Maintenance is admission control only. It does not pause Queue consumers or the
Cron Trigger: publications accepted before the window, scheduled work, and
stale-job recovery continue to run. Set the variable back to `false` or remove
it to resume. Clients then retry with the original `Idempotency-Key` and body;
stored keys replay their saved result under the existing rules, and new keys
are accepted normally.

## Agent and API clients

Syndroo is an HTTP API. An agent skill, script, or CI job can call it, but every
step before the request belongs to that client: drafting the text, adapting it
per platform, showing a preview, and asking the person to confirm.
Confirmation is external to Syndroo. This candidate has no preview, approval,
retry, or cancel endpoint, and none is added by the v0.3.0 architecture work.

A workflow that stays safe:

1. Prepare and confirm the text in the client. Neither the planned content nor
   a confirmation state exists in Syndroo until a request is accepted.
2. `POST /v1/posts` with the content, the selected platforms, and a stable
   `Idempotency-Key`. HTTP `202` means the request was accepted for processing,
   not that the outcome is known: `queued` is not `published`, and Queue
   delivery can start the platform request immediately after acceptance.
3. Poll `GET /v1/posts/<id>` until each publication is `published` or `failed`.
   Status queries are read-only and safe to repeat.
4. Read each publication's `status`, `attempts`, `errorCode`, `errorMessage`,
   and `errorAmbiguous`. A `failed` publication with `errorAmbiguous: true` may
   still have been accepted by the platform: check the platform account
   manually. Do not resend that content automatically, and do not treat the
   latest error message as an audit trail.
5. Keep credentials in Worker secrets. Platform credentials belong to the
   deployment, never to the client, a demo input, a chat log, an issue, or a
   request body. The client holds only `SYNDROO_API_KEY`, which can publish and
   must itself be treated as a secret.

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
- one publishing executor (`src/publishing.ts`) that returns an ack/retry decision, with Queue acknowledgment and retry mechanics kept in `src/jobs.ts`;
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

The button deploys this source repository. The thin deployment template is
prepared but not validated, so the button is not pointed at it yet; it moves only
after the candidate is accepted.

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
- Publication state transitions and their Post aggregate updates commit together
  in D1 transactions. Claiming also reads the publication within that transaction;
  a database statement failure rolls back the claim and attempt increment.
  If the transaction response is lost, its commit outcome can still be unknown:
  Syndroo does not blindly reset a publication or resend it.
- Client retries should provide `Idempotency-Key`; D1 stores a unique key so deployment retries cannot create another logical post.
- A timeout or 5xx after the remote publish request can be ambiguous: the platform may have accepted the post. Ambiguous failures are stored and are not retried automatically.
- Only rate-limit, provider-unavailable, and unambiguous network failures are retried, with a maximum of three application attempts.
- Retryable failures persist the earliest retry time (`publications.retry_at`) in the same D1 transaction as the failure state. Claiming and Cron selection both require that deadline, so a duplicate Queue message cannot run the next attempt early. Minimum waits are 60 seconds after the first attempt and 120 seconds after the second; if a Queue retry is lost, recovery waits for the existing 15-minute enqueue lease to expire and a later Cron scan; Cron runs every 15 minutes, so the minimum retry wait is not a delivery-time guarantee.
- Migration `0003_retry_timing.sql` adds the nullable `publications.retry_at` column, so apply migrations before deploying this Worker version. Rows written by older code keep `retry_at` null and stay eligible. Running older Worker code against the migrated database still publishes, but it cannot enforce the stored deadline.
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
