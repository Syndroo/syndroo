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
packages/x                 Official X SDK text-only publisher
packages/tumblr            Native HTTP NPF text publisher
packages/linkedin          Native HTTP LinkedIn Posts publisher
packages/sdk               Public HTTP client for one deployed instance
packages/cli               Public `syndroo` command: local publish/retry/receipts
                           plus the retained remote commands and the bundled Skill
packages/cloudflare-worker Public bundled Worker, D1, Queue, Cron, orchestration
scripts/deploy.ts          Cloudflare deployment and D1 recovery
wrangler.jsonc             Sole production Worker manifest
```

CLI internals: `packages/cli/src/local/` holds the local use cases (`plan`,
`execute`, `retry`, `auth`, `config`, `credentials`, `state/`) behind the narrow
ports in `packages/cli/src/local/ports/`; `packages/cli/skills/syndroo/` is the
single shipped Skill source; `packages/cli/test/local/` covers the local
surface.

Dependency direction:

```text
@syndroo/core <- {@syndroo/bluesky, @syndroo/threads, @syndroo/x, @syndroo/tumblr, @syndroo/linkedin} <- @syndroo/cloudflare-worker
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

Installed adapters: `threads`, `bluesky`, `x`, `tumblr`, and `linkedin` (private
packages). Threads, Tumblr, and LinkedIn use native HTTP; Bluesky and X use
official SDKs. X requires all four OAuth 1.0a credentials.

Known but uninstalled platforms must return `PLATFORM_NOT_CONFIGURED` at request validation. Never accept work that cannot be dispatched.

Local scope is fixed for `0.6`: Bluesky and Threads, plain text, local
publishing, plus the retained remote commands. The other adapters are preserved
for the remote path and are not local targets; do not add a platform, a local
OAuth flow, or a local scheduling path without an explicit requirement. Keep
every existing adapter's behavior and tests intact when working on the local
surface.

## Local invariants

- A local preview writes a signed frozen plan; only executing that same plan
  sends content. The execution never re-reads the input document.
- One logical delivery is `(namespace, key, provider, targetId)`. A succeeded
  delivery replays its original result instead of sending again, and the same
  key and target with different content conflicts rather than overwriting.
- An `unknown` target outcome stops blind retries; a retry must select targets
  whose failure is provably `not_applied`.
- Every local write happens under the global write lock, and recovery is
  explicit. A lock whose owner record is missing is fail-closed: never delete or
  reclaim a lock automatically.
- State permissions (`0700` directories, `0600` files) limit access; they are
  not encryption. Local plans and receipts contain post text and account data.

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
npm run pack:cli
npm run e2e:cli-local
npm run db:migrate:local
npm test
npm run check
npm run bundle
npm run startup
npm run build:package
npm run dev
```

The candidate versions are split, so the release-set scripts need
`SYNDROO_RELEASE_SET=cli`; the default `all` set stays strict and reports that
mismatch on purpose.

Use focused package tests while iterating. Before handing off code changes:

1. Run relevant tests.
2. Run `npm test` and `npm run check` (`SYNDROO_RELEASE_SET=cli`) for shared contracts, local use cases, adapters, API, database, or deployment changes.
3. Run `npm run e2e:cli-local` for CLI packaging or local workflow changes.
4. Run `npm run bundle` for Worker or Wrangler changes, and `npm run startup` when Worker imports or startup work changes.
5. Run `git diff --check` and inspect final `git diff`.

After binding changes, run `npm run check`; the Worker workspace regenerates `worker-configuration.d.ts` from `wrangler.jsonc`.

## Documentation

- The root `README.md` is the local CLI operating guide. Keep its examples executable and keep the retained remote path to a short section that links the package documentation: `docs/remote-compatibility.md`, `packages/cloudflare-worker/README.md`, `packages/sdk/README.md`, and `skills/syndroo-connect.md`.
- Keep `docs/cli-manual.md` and `docs/agent-quickstart.md` aligned with the local CLI, and `docs/testing.md` and `docs/releasing.md` aligned with the real gates, release sets, and unverified areas.
- Keep the bundled Skill (`packages/cli/skills/syndroo/`) as the single shipped Skill source; the commands, flags, and exit codes it documents must match the built `--help`.
- State the current candidate versions and what is unverified. Local providers are `fixture-tested`; never describe local publishing as live-validated, and never describe a package as published before it is.
- Keep supported platforms, required secrets, content limits, Cron cadence, and deployment steps synchronized with code; the remote path is documented in the Worker and SDK package READMEs.
- Do not claim a platform feature before its adapter, tests, configuration, and documentation all exist.
- The repository and public Worker package use Apache-2.0. Preserve `LICENSE`,
  `NOTICE`, and required notices in distributions.
- Public packages are `@syndroo/cli`, `@syndroo/sdk`, and
  `@syndroo/cloudflare-worker`. `@syndroo/core` and the platform adapters stay
  private: they are bundled into the CLI and Worker artifacts, so a published
  package must not reference them at runtime. Do not change this policy without
  user direction.
- Require DCO sign-off for contributions. Do not add a CLA without user
  direction.
