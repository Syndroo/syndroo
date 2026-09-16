# Changelog

All notable Syndroo changes are recorded here. Releases use Semantic
Versioning and matching `v<version>` Git tags.

## 0.2.0-rc.1 (release candidate, not published)

Prepared candidate. The version lives in
`packages/cloudflare-worker/package.json`. Nothing in this section has been
published to npm, tagged, deployed, or accepted; publication is a separate
maintainer approval under [docs/releasing.md](docs/releasing.md).

### Changed

- Use the official `@atproto/api` SDK for Bluesky, retaining link facets,
  publication identifiers, bounded responses, and application-owned retries.
- Send Bluesky requests with `redirect: "manual"`. `workerd` rejects
  `redirect: "error"` before dispatching the request; `"manual"` keeps the same
  guarantee, because the response is inspected and a 3xx is a failure rather
  than a followed hop.
- Enable platforms independently from their credentials. Reject unconfigured
  platforms before persistence or enqueueing; default the Bluesky host to
  `bsky.social`.
- Require only `SYNDROO_API_KEY` during production setup. Configure platform
  secrets after deployment. Local development uses the `local` Wrangler
  environment to load optional platform credentials.
- Commit publication state transitions together with their Post aggregate
  update in one D1 transaction, including the claim read. A statement failure
  rolls the claim back; an unknown commit outcome stays on the conservative
  path instead of resetting a publication to `pending`.
- Rebuild the Worker bundle from source into a clean output directory before
  packaging, instead of reusing an existing `dist/`. The build removes the
  output directory first, strips the absolute build path from the source map,
  drops Wrangler's generated `README.md`, and `npm run verify:package` checks
  the packed artifact against the built bundle.
- Raise the toolchain floor to `wrangler@^4.132.0`, `@cloudflare/workers-types`
  `^5.20260915.1`, and `@cloudflare/vitest-plugin` `^1.1.10`, and refresh the
  lockfile after the audited dependency findings.

### Added

- Optional maintenance admission control: the non-secret variable
  `SYNDROO_MAINTENANCE` with the exact value `true` rejects authenticated
  `POST /v1/posts` with HTTP `503` before the request body, the
  `Idempotency-Key`, or D1 is read. `GET /health` and authenticated post queries
  keep working, and the switch does not pause Queue consumers or the Cron
  Trigger.

- Strict retry deadlines through migration
  `packages/cloudflare-worker/migrations/0003_retry_timing.sql`, which adds the
  nullable `publications.retry_at` column. Claim and Cron selection both require
  the deadline, so a duplicate Queue message cannot start the next attempt
  early. Minimum waits are 60 seconds after the first failure and 120 seconds
  after the second, the application attempt limit stays at three, and ambiguous
  outcomes are never retried automatically.

- A local Mock SNS end-to-end gate (`npm run test:e2e`, `npm run check:e2e`)
  that drives the bundled Worker, D1, Queue, Cron handler, and real adapters
  against loopback Mock SNS servers with fake credentials. See
  [docs/testing.md](docs/testing.md).

- Package verification (`npm run verify:package`) covering the packed artifact,
  and generated third-party license text for the bundled Worker.

- Native LinkedIn public text publishing with explicit author/API version,
  little-text escaping, header-based confirmation, and ambiguous-write protection.

- Native Tumblr NPF text publishing with OAuth 1.0a, optional blog credentials,
  preflight text validation, bounded responses, and ambiguous-write protection.

- X text publishing through the official `@xdevplatform/xdk` SDK, optional
  OAuth 1.0a credentials, official weighted text validation, and bounded
  application-controlled requests without SDK retries.

- Thin deployment architecture with the public
  `@syndroo/cloudflare-worker` package.
- Apache License 2.0, NOTICE, DCO contribution policy, CI, and npm release
  workflow.

### Migration and rollback

- Apply migration `0003_retry_timing.sql` before deploying this Worker version;
  `npm run deploy` applies pending migrations before the code deploy. The
  migration is compatible with the previously deployed Worker: rows written by
  older code keep `retry_at` as `NULL` and stay immediately eligible.
- Rolling back to older Worker code keeps publishing against the migrated
  database but cannot enforce the stored retry deadline, so a duplicate Queue
  message or a Cron scan can start the next attempt before the earliest stored
  retry time. Roll back code only if that trade-off is acceptable. Do not
  reverse the migration, and do not reset publication statuses by hand; a
  retryable failure returning a publication to `pending` with a `retry_at`
  deadline is the retry policy, not a rollback.

### Licensing

- `@xdevplatform/xdk@0.6.6` declares `"license": "MIT"` and an author in its
  `package.json`, but the published tarball for that exact version contains only
  `dist/`, `package.json`, and `README.md`, and the upstream repository has no
  `LICENSE` or `COPYING` file. The package attributes no license or copyright
  text. The distribution therefore adds the canonical SPDX MIT text, leaving the
  `<year> <copyright holders>` placeholder unmodified, and records the source
  URL and SHA-256 next to it as a supplement. This is not the upstream project's
  license file, it asserts no copyright holder, and it is not a statement that
  every legal obligation in this distribution has been reviewed or certified.

### Verification status

- Local unit and script suites pass. Gate totals are recorded by the release
  maintainer after the final run rather than carried in this changelog.
- Bluesky and Threads are exercised locally through the Mock SNS gate only.
  Live-account acceptance has not been performed. X, Tumblr, and LinkedIn are
  experimental and have not been validated live.
