# Syndroo Agent Guide

## Scope and source of truth

- Work from the repository root.
- Read `README.md`, relevant package manifests, and nearby tests before changing behavior.
- Inspect `git status` first. Preserve user changes and unrelated work.
- Treat this repository as the development source. Repositories created by the Deploy to Cloudflare button are deployment copies and do not automatically receive later source changes.
- Keep changes within the requested scope. Do not commit, push, deploy, or mutate remote resources unless the user requests it.

## Repository structure

Syndroo is an npm-workspaces TypeScript monorepo. Architecture v1 is eleven
packages; the specs under
`docs/superpowers/specs/architecture-v1/` are authoritative when prose here is
older than the code.

```text
packages/core              Private: use cases, domain, protocol, ports
packages/provider-sdk      Public: Provider contract, defineProvider, test helpers
packages/provider-bluesky  Official Bluesky provider (text)
packages/provider-threads  Official Threads provider (text)
packages/provider-linkedin Official LinkedIn provider (text)
packages/provider-mastodon Official Mastodon provider (text, federated)
packages/provider-devto    Official DEV.to provider (article)
packages/sdk               Public HTTP client, protocol types and wait
packages/cli               Public `syndroo`: connect/publish/status, renderers,
                           local runtime and the bundled Skill
packages/server            Public self-hosted Node HTTP runtime, SQLite, secrets
packages/cloudflare        Public Worker artifact: D1, Queues, Cron
scripts/                   Build, protocol and provider-catalog export, checks
```

CLI internals: `packages/cli/src/commands/` holds the three commands,
`packages/cli/src/runtime/` holds the filesystem, provider and transport
adapters, `packages/cli/src/render/` holds the human and JSON renderers,
`packages/cli/src/request-journal/` holds request identity, and
`packages/cli/skills/syndroo/` is the single shipped Skill source.

Dependency direction:

```text
@syndroo/provider-sdk <- @syndroo/core <- @syndroo/provider-* <- {@syndroo/sdk, @syndroo/cli} <- @syndroo/server <- @syndroo/cloudflare
```

`@syndroo/core` must not import platform adapters, Cloudflare APIs, or runtime-specific types.

The `@syndroo/server -> @syndroo/cli` edge is deliberate and narrow: the Server's
Node provider composition reuses `@syndroo/cli/runtime`'s Node transport instead
of duplicating egress enforcement. `@syndroo/cloudflare` imports only
`@syndroo/server/http`, so the Worker never vendors the Node composition surface.

## Design rules

- Use TypeScript for all repository-owned executable code and tests.
- Keep NodeNext ESM `.js` import suffixes in TypeScript source.
- Keep JSON, JSONC, SQL, and Markdown in their native formats.
- Prefer the smallest concrete design that satisfies current requirements.
- Keep one Core entry point: `createCore()` in `@syndroo/core` owns connect, prepare, execute, retry and status. Adapters may not reimplement or relax a protocol rule.
- Providers implement the `@syndroo/provider-sdk` contract only; they must not reach for CLI, state, HTTP or filesystem APIs.
- Keep the runtime adapters concrete: filesystem and SQLite state in `packages/cli` and `packages/server`, D1 in `packages/cloudflare`. Do not add a generic repository layer, ORM, or adapter factory hierarchy.
- Do not add a dependency-injection container or speculative runtime abstraction.
- Keep Cloudflare bindings, routing, D1 state, queues and cron inside `packages/cloudflare`. Deployment configuration is `wrangler.jsonc` pointing at the built `packages/cloudflare/dist/worker.js`; there is no deploy script.
- Keep experiments out of production imports and dependencies.

## Platform adapters

The five official providers are
`@syndroo/provider-{bluesky,devto,linkedin,mastodon,threads}`. Every provider
declares its manifest, its connect/publish JSON Schemas and its `egress` policy:
`fixedOrigins` when the platform API lives on known origins, or
`federated: true` for Mastodon, whose instance the user chooses. The runtime
resolves a transport per provider from that declaration and fails closed for any
origin the plugin did not declare.

Platform differences belong in capability and option declarations, never in
Core. There is no runtime npm install and no dynamic package loading beyond the
explicit registry and the user override described in
`docs/superpowers/specs/architecture-v1/01-architecture-design.md`.

Do not claim platform support before the provider, its contract tests, its
registry entry and its documentation all exist. X and Tumblr are not part of
architecture v1.

## Local invariants

- The CLI keeps one state root (`$XDG_STATE_HOME/syndroo/runtime-v1` by default,
  or `stateRoot` from the config file) and one write lock. Every local write
  happens under that lock, and recovery is explicit. A lock whose owner record is
  missing is fail-closed: never delete or reclaim it automatically.
- `publish` parses its input once, freezes the intent, and never re-reads the
  input after confirmation. `execute` sends only against an approval token that
  still matches the frozen binding.
- Dry-run is read-only: no lock, no credential resolution, no network calls, no
  state writes.
- An `unknown` target outcome stops blind retries; a retry may select only
  targets whose failure is provably `not_applied`.
- State permissions (`0700` directories, `0600` files) limit access; they are not
  encryption. Local intents and receipts contain account data.
- Configuration is never inferred from the working directory: the documented
  default or an explicit `--config` is the only source, and a missing explicit
  config file is an error rather than a silent fallback.

## Reliability invariants

- Queue delivery is at least once.
- Claim each execution atomically before any provider request; the D1 write path
  is a compare-and-swap over an atomic batch.
- Requests are keyed: the same key with the same content replays the stored
  result, and the same key with different content conflicts rather than
  overwriting it.
- Never blindly retry an ambiguous provider result. A timeout, connection loss,
  or a provider failure after submission may mean the platform accepted the post.
- Retry only rate limits, provider unavailability, and unambiguous network
  failures. The attempt limit is three unless requirements explicitly change.
- If enqueue fails, leave the execution recoverable as pending; the scheduled
  scan is the outbox recovery path.
- Treat a claim that has not produced an outcome within its claim window as
  ambiguous rather than successful.
- The Worker's cron cadence is every 15 minutes. Documentation and scheduling
  expectations must match `wrangler.jsonc`.

## API invariants

- `GET /health` is public and returns only minimal liveness.
- `/v1/connect`, `/v1/publish` and `/v1/status` require the deployment Bearer
  token. An unauthorized request must not load a provider, read private state or
  produce any business side effect.
- The OAuth callback route is a transport exception: it proves ownership with a
  short-lived, verified session and never with the deployment Bearer token.
- Keep error responses shaped as
  `{ "error": { "code": string, "message": string } }`, with `413 BODY_TOO_LARGE`,
  `415 UNSUPPORTED_MEDIA_TYPE`, `401 UNAUTHORIZED`, `404 NOT_FOUND` and `409` for
  conflicts.
- Preserve the request-body limit and JSON content-type validation.
- Validate request structure before database or provider side effects.
- HTTP `202` marks a durably admitted execution that has not finished; it never
  means published.
- Treat response shape or status-code changes as public contract changes. Update
  tests, `docs/remote-compatibility.md` and `README.md` together.

## Data and migrations

- `@syndroo/core` owns domain records and ports; each runtime keeps its own
  physical schema. The filesystem and SQLite adapters in `packages/cli` and
  `packages/server`, and the D1 adapter in `packages/cloudflare`, must all satisfy
  the shared state-store contract tests.
- The Worker creates its D1 schema on demand, so there is no migrations directory
  and no applied migration to preserve. A fresh deployment answers `status` with
  a durability error until the first `connect` initializes storage; that is
  documented behaviour, not a defect.
- Update fixtures and contract tests with every schema change, and keep every
  runtime adapter passing the same contract.
- Do not commit account-specific D1 IDs; `wrangler.jsonc` carries only the binding
  and the database name.

## Secrets and external credentials

- Never commit `.dev.vars`, `.env`, tokens, app passwords, or generated account resource IDs.
- Never print secret values in logs, command output, test snapshots, error
  messages, URLs or CLI argv.
- The Worker's deploy-time secrets are `API_BEARER`, `SECRET_KEY` and
  `RUNTIME_KEY`. Provider credentials are not deployment configuration: they are
  created by `syndroo connect` and stored encrypted under `SECRET_KEY`.
- Bluesky uses an app password, not the account password. OAuth app secrets are
  deployment-level provider options and must be injected only for the provider
  that needs them.
- Add a new binding to `wrangler.jsonc`, the root `package.json` binding
  descriptions and the deployment documentation together.

## Commands

```bash
npm ci
npm run build                     # scripts/build-v1.ts: all eleven packages, in order
npm run check                     # check:v1-tools then scripts/check-v1.ts
npm test                          # scripts/check-v1.ts --tests
npm run test:v1                   # the same tests under one vitest run
npm run check:provider-catalog    # catalog matches the built official providers
git commit --signoff              # DCO: the CI check needs a SHA range, see below
```

All eleven v1 packages share version `0.7.0-rc.1` and Node engine
`>=24.19.0`. `@syndroo/core` is private and is inlined into the three built
artifacts (`@syndroo/cli`, `@syndroo/server`, `@syndroo/cloudflare`); those
artifacts must not list it in `dependencies`.

`npm run check` reports an unbuilt bundle as `PENDING` rather than `ok`. Run
`npm run build` first when a bundle assertion has to mean something.

Use focused package tests while iterating. Before handing off code changes:

1. Run relevant tests.
2. Run `npm test` and `npm run check` for shared contracts, the CLI, providers, the server, storage, or the Worker.
3. Run `npm run check:provider-catalog` after any provider manifest change.
4. Re-run the bundle check (`npm run check`) after touching a bundler or a package's `dependencies`.
5. Run `git diff --check` and inspect the final `git diff`.

## Documentation

- The root `README.md` is the local CLI operating guide. Keep its examples
  executable and keep the self-hosted and Worker surface in
  `docs/remote-compatibility.md`.
- Keep `docs/cli-manual.md` and `docs/agent-quickstart.md` aligned with the built
  CLI, and `docs/testing.md` and `docs/releasing.md` aligned with the real
  commands and unverified areas.
- Every command and flag a doc prints must be one the built CLI accepts. Retired
  syntax (`doctor`, `posts`, `skill`, `auth`, `init`, `receipts`, `retry`,
  `state`, `local *`, `--yes`, `--no-input`) may appear only in a clearly
  labelled historical note. Every JSON example must validate against the
  corresponding schema in `packages/core/src/protocol/`.
- Keep the bundled Skill (`packages/cli/skills/syndroo/`) as the single shipped
  Skill source; it must teach the v1 prepare → confirm → execute → status flow,
  and its commands, flags and exit codes must match the built `--help`.
- State what is verified and what is not. Providers are `fixture-tested`; no live
  account call has been made. Never describe publishing as live-validated, or a
  package as published, or a runtime as deployed, before it is.
- Verifiable claims must separate design, fixture-tested, live-validated, and
  published/deployed. An unverified area is marked in the doc itself rather than
  asserted.
- Do not claim a platform feature before its provider, tests, config and docs all
  exist.
- `@syndroo/core` and the pre-v1 adapters stay private. Core is bundled into the
  public artifacts, which must not reference it at runtime. Public v1 packages
  are `@syndroo/{provider-sdk,provider-*,sdk,server,cli,cloudflare}`.
- The repository and published packages use Apache-2.0. Preserve `LICENSE`,
  `NOTICE`, and required notices in distributions. `packages/cli/NOTICE` notes
  that a generated third-party licence inventory must be added before any
  release.
- Require DCO sign-off for contributions. Do not add a CLA without user
  direction.
