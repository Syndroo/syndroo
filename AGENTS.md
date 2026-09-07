# Syndroo Agent Guide

## Scope and source of truth

- Work from the repository root.
- Read `README.md`, relevant package manifests, and nearby tests before changing behavior.
- Inspect `git status` first. Preserve user changes and unrelated work.
- Treat this repository as the development source. Repositories created by the Deploy to Cloudflare button are deployment copies and do not automatically receive later source changes.
- Keep changes within the requested scope. Do not commit, push, deploy, or mutate remote resources unless the user requests it.

## Repository structure

Syndroo is an npm-workspaces TypeScript monorepo:

```text
packages/core              Platform-neutral domain contracts and errors
packages/bluesky           Native text-only Bluesky publisher
packages/threads           Native text-only Threads publisher
packages/cloudflare-worker Public bundled Worker, D1, Queue, Cron, orchestration
experiments/               Isolated compatibility experiments
scripts/deploy.ts          Cloudflare deployment and D1 recovery
wrangler.jsonc             Sole production Worker manifest
```

Dependency direction:

```text
@syndroo/core <- {@syndroo/bluesky, @syndroo/threads} <- @syndroo/cloudflare-worker
```

`@syndroo/core` must not import platform adapters, Cloudflare APIs, or runtime-specific types.

## Design rules

- Use TypeScript for all repository-owned executable code and tests.
- Keep NodeNext ESM `.js` import suffixes in TypeScript source.
- Keep JSON, JSONC, SQL, and Markdown in their native formats.
- Prefer the smallest concrete design that satisfies current requirements.
- Keep one `Publisher.publish()` contract in `@syndroo/core`.
- Keep one concrete `D1Repository`; do not add a generic repository layer or ORM without a demonstrated need.
- Select publishers through the explicit switch in `packages/cloudflare-worker/src/publishers.ts`.
- Do not add a dependency-injection container, plugin registry, adapter factory hierarchy, or speculative runtime abstraction.
- Keep Cloudflare bindings, handlers, routing, persistence, Queue, Cron, and Worker code inside `packages/cloudflare-worker`; keep deployment orchestration in `scripts/deploy.ts`.
- Keep experiments out of production imports and dependencies.

## Platform adapters

Installed adapters: `threads` and `bluesky`.

Known but uninstalled platforms must return `PLATFORM_NOT_CONFIGURED` at request validation. Never accept work that cannot be dispatched.

To add a platform:

1. Add `packages/<platform>`.
2. Implement the core `Publisher` contract.
3. Normalize provider failures to `PublishError`.
4. Add adapter unit tests.
5. Mark the platform available in request validation.
6. Wire one explicit case in `publisherFor()`.
7. Add required bindings and regenerate Worker types.
8. Update README setup, limits, examples, and status behavior.

## Reliability invariants

- Queue delivery is at least once.
- Claim each publication atomically before any provider request.
- Preserve `Idempotency-Key` behavior: same key and same request replays the original result; same key with different input returns HTTP `409`.
- Never blindly retry an ambiguous provider result. A timeout, connection loss, or provider 5xx after submission may mean the remote platform accepted the post.
- Retry only rate limits, provider unavailability, and unambiguous network failures.
- Keep the application attempt limit at three unless requirements explicitly change.
- If enqueue fails, leave the publication recoverable as pending. Cron provides the outbox recovery path.
- Mark a publication stuck in `publishing` for 15 minutes as an ambiguous failure.
- Current Cron cadence is every 15 minutes. Documentation and scheduling expectations must match `wrangler.jsonc`.

## API invariants

- `GET /health` is public.
- Every `/v1/*` route requires the Bearer token in `SYNDROO_API_KEY`.
- Keep error responses shaped as `{ "error": { "code": string, "message": string } }`.
- Preserve the 64 KiB request-body limit and JSON content-type validation.
- Validate request structure before database or provider side effects.
- `POST /v1/posts` returns HTTP `202`; queued does not mean published.
- Treat API response shape or status-code changes as public contract changes. Update tests and README together.

## Data and migrations

- D1 stores posts, per-platform publications, and idempotency records.
- Add a new numbered migration for schema changes. Do not rewrite an applied migration.
- Keep migrations under `packages/cloudflare-worker/migrations`.
- Update repository mappings, fixtures, and tests with every schema change.
- Run local migrations before Worker tests when adding a migration.
- Do not commit account-specific D1 IDs.
- `scripts/deploy.ts` must continue to recover missing or stale generated D1 IDs, apply migrations, deploy through a temporary ignored config, and clean that config afterward.

## Secrets and external credentials

- Never commit `.dev.vars`, `.env`, tokens, app passwords, or generated account resource IDs.
- Never print secret values in logs, command output, test snapshots, or error messages.
- Bluesky uses an app password, not the account password.
- Threads uses a user access token authorized for publishing, not an app access token.
- Treat `SYNDROO_API_KEY` as a publishing credential.
- Add new secrets to `.dev.vars.example`, root `package.json` binding descriptions, `wrangler.jsonc`, generated Worker types, and README setup instructions.

## Commands

```bash
npm install
npm run db:migrate:local
npm test
npm run check
npm run bundle
npm run startup
npm run build:package
npm run dev
```

Use focused package tests while iterating. Before handing off code changes:

1. Run relevant tests.
2. Run `npm test` and `npm run check` for shared contracts, adapters, API, database, or deployment changes.
3. Run `npm run bundle` for Worker or Wrangler changes.
4. Run `npm run startup` when Worker imports or startup work changes.
5. Run `git diff --check` and inspect final `git diff`.

After binding changes, run `npm run check`; the Worker workspace regenerates `worker-configuration.d.ts` from `wrangler.jsonc`.

## Documentation

- Keep README examples executable with the current API.
- State clearly that v0.1 is an HTTP API service without a web dashboard.
- Keep supported platforms, required secrets, content limits, Cron cadence, and deployment steps synchronized with code.
- Do not claim a platform feature before its adapter, tests, configuration, and documentation all exist.
- The repository and public Worker package use Apache-2.0. Preserve `LICENSE`,
  `NOTICE`, and required notices in distributions.
- Only `@syndroo/cloudflare-worker` is a public package. Core and platform
  adapters remain bundled implementation details unless the user changes this
  policy.
- Require DCO sign-off for contributions. Do not add a CLA without user
  direction.
