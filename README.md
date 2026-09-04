# Syndroo

Open-source publishing infrastructure for the social web.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/daiyanze/syndroo)

Syndroo v0.1 is a small npm-workspaces monorepo. It accepts immediate or scheduled posts, stores one publication per selected platform in Cloudflare D1, dispatches publication jobs through Cloudflare Queues, and scans scheduled work with Cron Triggers.

Native Threads and Bluesky adapters are installed in v0.1. The public platform and publishing contracts live in `@syndroo/core`; adding another platform means adding one adapter package and wiring one explicit switch in the Worker. Requests for known but uninstalled platforms return `PLATFORM_NOT_CONFIGURED` instead of silently doing nothing.

## Using v0.1

Syndroo v0.1 is an HTTP API service. It does not include a web dashboard. Deploy it, then call the Worker URL from `curl`, an automation tool, or your own application.

### 1. Deploy

Click **Deploy to Cloudflare** at the top of this README. During setup, enter:

- `SYNDROO_API_KEY`: a long random secret chosen by you;
- `BLUESKY_IDENTIFIER`: your Bluesky handle, such as `alice.bsky.social`;
- `BLUESKY_PASSWORD`: a Bluesky app password, not your account password;
- `BLUESKY_HOST`: normally `bsky.social`;
- `THREADS_ACCESS_TOKEN`: a long-lived Threads user access token with `threads_basic` and `threads_content_publish`.

Wait for the Cloudflare build to succeed. Open the deployed Worker in Cloudflare and copy its `https://...workers.dev` URL.

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

Both v0.1 adapters publish text only. Threads content is limited to 500 Unicode characters. Bluesky content is limited to 300 Unicode characters and 3,000 UTF-8 bytes; HTTP(S) URLs receive link facets. Longer content can be accepted by the API but its platform publication later finishes as `failed` with `INVALID_CONTENT`.

`Idempotency-Key` is optional but recommended for deployment automation. Use a stable key for one logical post. Repeating the same request with the same key returns the original post with `replayed: true`; reusing it with different content returns HTTP `409`.

### Threads access token

Create a Meta app with the **Threads use case**, authorize your Threads account, and request at least `threads_basic` plus `threads_content_publish`. Exchange the short-lived user token for a long-lived token, then store that value as `THREADS_ACCESS_TOKEN`. Meta's official [Threads API Postman workspace](https://www.postman.com/meta/threads/collection/dht3nzz/threads-api) contains the current authorization, token exchange, refresh, and token-debugger requests.

Do not use an app access token here. Syndroo needs a **Threads user access token** authorized to publish for the account. Long-lived tokens expire; refresh the token before expiry and replace the Worker secret.

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

Cron scans once per minute. Publication can therefore occur shortly after the requested time rather than at the exact millisecond. A `scheduledAt` value in the past is handled as an immediate post.

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

`threads` and `bluesky` can be selected in v0.1. Other recognized platform names return HTTP `422` with `PLATFORM_NOT_CONFIGURED`.

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
- `422`: requested platform adapter is not installed.

## Architecture

    client
      │ Bearer-authenticated HTTP
      ▼
    apps/cloudflare-worker
      ├── D1: posts + per-platform publications
      ├── Queue producer/consumer
      ├── Cron: due-post scan + stale-job recovery
      └── explicit publisher selection
              │
              ▼
    packages/threads ─────► Meta Threads API
    packages/bluesky ─────► Bluesky AT Protocol
              │
              └──────────► packages/core

Repository layout:

    .
    ├── packages/
    │   ├── core/                     # domain types, Publisher, normalized errors
    │   ├── bluesky/                  # native text-only Bluesky adapter
    │   └── threads/                  # native text-only Threads adapter
    ├── apps/
    │   └── cloudflare-worker/        # HTTP, auth, D1 repository, Queue, Cron
    ├── experiments/
    │   └── crosspost-cloudflare/     # isolated workerd failure reproduction
    ├── docs/
    └── wrangler.jsonc                # one production deployment manifest

Dependency direction is `core ← {bluesky, threads} ← cloudflare-worker`. Core imports neither platform code nor Cloudflare APIs.

The abstraction is deliberately narrow:

- one `Publisher.publish()` contract;
- one concrete `D1Repository`, without an ORM or generic repository layer;
- one explicit platform switch, without a registry or dependency-injection container;
- Cloudflare bindings and lifecycle handlers stay inside the Worker app.

## Local use

Requirements: Node.js 20 or newer and npm.

All repository-owned executable code and tests are TypeScript. JSONC, JSON, SQL, and Markdown remain in their native configuration or data formats. Internal `.js` import suffixes are intentional NodeNext ESM paths that resolve from TypeScript source to compiled JavaScript.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm test
npm run check
npm run dev
```

Put a Bluesky app password and Threads user access token in `.dev.vars`. Do not commit this file.

The local Worker defaults to `http://localhost:8787`.

## Cloudflare deployment

For the fastest setup, click the **Deploy to Cloudflare** button at the top of this README. Cloudflare will fork the repository into your GitHub account, prompt for the five required values, provision D1 and Queue resources, apply D1 migrations, configure the Cron Trigger, and deploy the Worker. Future pushes to the generated repository are deployed by Workers Builds.

The required values are:

- `SYNDROO_API_KEY`: a long random secret used by clients as the Bearer token;
- `BLUESKY_IDENTIFIER`: your Bluesky handle;
- `BLUESKY_PASSWORD`: a Bluesky app password, not your account password;
- `BLUESKY_HOST`: normally `bsky.social`;
- `THREADS_ACCESS_TOKEN`: a long-lived Threads user access token with publishing permission.

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
- Keep Cloudflare-specific routing, bindings, and deployment code inside `apps/cloudflare-worker`.
- Keep experiments out of production imports and dependencies.

Crosspost 1.0.4 remains an isolated compatibility experiment because it bundles but cannot boot in workerd. See [Crosspost Cloudflare spike](docs/crosspost-cloudflare-spike.md).

## License

License not selected yet.
