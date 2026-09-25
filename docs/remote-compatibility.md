# Retained remote path

The pre-0.6 remote surface stays available: the Cloudflare Worker serves an HTTP
API, and the `syndroo` CLI can still talk to a deployed instance with `doctor`
and `posts ...`. This page covers only what is unique to running that surface.
Package details live in
[`packages/cloudflare-worker/README.md`](../packages/cloudflare-worker/README.md)
and [`packages/sdk/README.md`](../packages/sdk/README.md).

The local CLI path never falls back to this surface, and the remote commands
never read local state. The two share contracts, not code paths.

## Status

| Piece | Version | Release role |
| --- | --- | --- |
| `@syndroo/cloudflare-worker` | `0.2.0-rc.1` | retained remote runtime |
| `@syndroo/sdk` | `0.4.0-rc.1` | retained HTTP client |

Bluesky and Threads are the Worker's release gates. X, Tumblr, and LinkedIn are
experimental: implemented and locally tested, not validated against live
accounts. This task performed no npm publish and did not verify the registry's
current state; build and install the local tarball instead.

## Run it

Two paths deploy the same Worker:

- **Deploy to Cloudflare button** — the button in the root README. Cloudflare
  creates an independent repository in your account (not a GitHub fork, with no
  upstream relationship), provisions D1 and Queue, applies D1 migrations,
  configures the Cron Trigger, and deploys the Worker. Cloudflare prompts for
  `SYNDROO_API_KEY`; add platform secrets afterwards.
- **Thin deployment template** — `Syndroo/syndroo-deploy-template` pins exact
  package versions with a lockfile. It is prepared but has not been rehearsed
  end to end, and it has no registry-backed lockfile until these versions are
  published.

### Local development

```bash
cp .dev.vars.example .dev.vars
# fill in only the platform secrets you need locally
npm ci
npm run build               # workspace packages must resolve to dist for wrangler
npm run db:migrate:local    # local D1 migrations
npm run dev                 # local Worker, reading .dev.vars
```

`npm run dev` uses the local `.dev.vars` file and the local D1 database. It
cannot reach production secrets, and `.dev.vars` must never be committed. The
Worker entry in `wrangler.jsonc` imports workspace packages whose exports
resolve to `dist`, so build the workspaces before the first local run.

### Production deploy from a checkout

```bash
npx wrangler secret put SYNDROO_API_KEY
# then the required secrets for each selected platform, for example:
npx wrangler secret put BLUESKY_IDENTIFIER
npx wrangler secret put BLUESKY_PASSWORD
npm run deploy              # production deploy through scripts/deploy.ts
```

Set the secrets before the deploy. Production uses the default environment;
do not pass `--env local` when deploying. The platform secret names and their
per-platform rules are listed in
[`packages/cloudflare-worker/README.md`](../packages/cloudflare-worker/README.md).

`scripts/deploy.ts` checks the declared D1 database, repairs a missing or stale
generated database ID, applies pending migrations, deploys through a temporary
ignored config, and removes that config afterwards. Apply migrations before
deploying a Worker version that expects them.

### Maintenance switch

`SYNDROO_MAINTENANCE` is an optional non-secret Worker variable. Only the exact
string `true` enables it; an unset variable or any other value keeps normal
operation.

- `true`: new `POST /v1/posts` requests are rejected with `503`
  `SERVICE_UNAVAILABLE`. Reads, Queue delivery, and Cron keep running, so
  already-accepted work is not lost.
- `false`, or removing the variable, resumes accepting new posts.

Retry after maintenance with the same `Idempotency-Key` and the same body.

### Scheduling and retries

The Cron Trigger runs every 15 minutes
(`wrangler.jsonc`, `"crons": ["*/15 * * * *"]`), which is the recovery cadence
for scheduled posts and stale enqueues. It is not a delivery-time guarantee.
Ambiguous provider outcomes — a timeout, a dropped connection, or a `5xx` after
submission — are never retried automatically: the publication is marked
ambiguous, and an operator verifies it on the platform instead of resending.

## API contract essentials

- Every `/v1/*` route requires `SYNDROO_API_KEY` as a Bearer token; `GET
  /health` is public.
- `POST /v1/posts` returns `202` when the request is accepted. Accepted is not
  delivered: a post is delivered only when every selected publication reached
  `published`.
- An `Idempotency-Key` replays the original result when the body is unchanged;
  the same key with a different body is a conflict.
- Post statuses are `scheduled`, `queued`, `publishing`, `published`,
  `partial`, and `failed`. An ambiguous publication outcome means the platform
  may have accepted the content, so verify on the platform instead of resending.
- The request body is capped at 64 KiB, and error bodies are shaped
  `{"error":{"code":...,"message":...}}`.

Platform credentials and per-platform publishing limits are documented in the
Worker package README linked above.

## Live checks

`npm run e2e:live -- --plan <file>` is the **legacy remote** live check: it runs
`doctor` and `posts ...` against a deployed instance from an approved plan file.
It does not exercise local publishing. Local live acceptance would publish real
text through the local CLI and has not been run for `0.6.0-rc.1`.

For the full gate matrix, see [testing.md](testing.md). For the release
process, see [releasing.md](releasing.md).
