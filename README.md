# Syndroo

Open-source publishing infrastructure for the social web.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/daiyanze/syndroo)

Syndroo v0.1 is a small npm-workspaces monorepo. It accepts immediate or scheduled posts, stores one publication per selected platform in Cloudflare D1, dispatches publication jobs through Cloudflare Queues, and scans scheduled work with Cron Triggers.

Only the native Bluesky adapter is installed in v0.1. The public platform and publishing contracts already live in `@syndroo/core`; adding another platform means adding an adapter package and wiring one explicit switch in the Worker. Requests for known but uninstalled platforms return `PLATFORM_NOT_CONFIGURED` instead of silently doing nothing.

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
    packages/bluesky ─────► Bluesky AT Protocol
              │
              ▼
    packages/core

Repository layout:

    .
    ├── packages/
    │   ├── core/                     # domain types, Publisher, normalized errors
    │   └── bluesky/                  # native text-only Bluesky adapter
    ├── apps/
    │   └── cloudflare-worker/        # HTTP, auth, D1 repository, Queue, Cron
    ├── experiments/
    │   └── crosspost-cloudflare/     # isolated workerd failure reproduction
    ├── docs/
    └── wrangler.jsonc                # one production deployment manifest

Dependency direction is `core ← bluesky ← cloudflare-worker`. Core imports neither platform code nor Cloudflare APIs.

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

Put a Bluesky app password, not the account password, in `.dev.vars`. Do not commit this file.

The local Worker defaults to `http://localhost:8787`.

## API

`GET /health` is public. Every `/v1/*` endpoint requires:

```text
Authorization: Bearer <SYNDROO_API_KEY>
```

Create an immediate post:

```bash
curl -X POST http://localhost:8787/v1/posts \
  -H "Authorization: Bearer $SYNDROO_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "content": "Hello from Syndroo",
    "platforms": ["bluesky"]
  }'
```

Create a scheduled post with platform-specific content:

```bash
curl -X POST http://localhost:8787/v1/posts \
  -H "Authorization: Bearer $SYNDROO_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "content": "Shared fallback",
    "platforms": ["bluesky"],
    "overrides": {
      "bluesky": { "content": "Bluesky-specific text" }
    },
    "scheduledAt": "2030-01-02T03:04:05.000Z"
  }'
```

Read data:

```bash
curl -H "Authorization: Bearer $SYNDROO_API_KEY" \
  "http://localhost:8787/v1/posts?limit=50"

curl -H "Authorization: Bearer $SYNDROO_API_KEY" \
  "http://localhost:8787/v1/posts/<post-id>"
```

The detail response includes each platform publication, attempt count, normalized error, ambiguity flag, remote ID, and remote URL.

## Cloudflare deployment

For the fastest setup, click the **Deploy to Cloudflare** button at the top of this README. Cloudflare will fork the repository into your GitHub account, prompt for the four required values, provision D1 and Queue resources, apply the D1 migration, configure the Cron Trigger, and deploy the Worker. Future pushes to the generated repository are deployed by Workers Builds.

The required values are:

- `SYNDROO_API_KEY`: a long random secret used by clients as the Bearer token;
- `BLUESKY_IDENTIFIER`: your Bluesky handle;
- `BLUESKY_PASSWORD`: a Bluesky app password, not your account password;
- `BLUESKY_HOST`: normally `bsky.social`.

The deploy button requires a public GitHub or GitLab source repository. It deploys only the production Worker described by the root `wrangler.jsonc`; the Crosspost experiment is not deployed.

For manual CLI deployment, set secrets interactively:

```bash
npx wrangler secret put SYNDROO_API_KEY
npx wrangler secret put BLUESKY_IDENTIFIER
npx wrangler secret put BLUESKY_PASSWORD
npx wrangler secret put BLUESKY_HOST
```

For a new account, provision once, then apply the schema:

```bash
npm run build
npx wrangler deploy
npm run db:migrate:remote
```

After initial provisioning, `npm run deploy` applies pending migrations and deploys the Worker. Wrangler provisions the declared `syndroo` D1 database and `syndroo-publications` Queue when they do not exist. Review generated resource identifiers before committing configuration changes.

## Implementation notes

- Queue delivery is at least once. A publication is claimed atomically before outbound work, so duplicate messages do not normally duplicate posts.
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
