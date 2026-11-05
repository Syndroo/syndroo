# Changelog

All notable Syndroo changes are recorded here. Releases use Semantic
Versioning and matching `v<version>` Git tags.

## [0.8.0](https://github.com/Syndroo/syndroo/compare/v0.7.2...v0.8.0) (2026-11-05)


### ⚠ BREAKING CHANGES

* rebuild Syndroo on the architecture-v1 design
* **cli:** replace public --plan execution with direct publish and retry. Dry runs are read-only; inline JSON is accepted with --data.

### Features

* add one-click Cloudflare deployment ([f12e6bd](https://github.com/Syndroo/syndroo/commit/f12e6bd742d56f0a6a7caed634c1b0621a85eca1))
* add SDK-backed and native social publishers ([ec1e448](https://github.com/Syndroo/syndroo/commit/ec1e448d88f86ad698b4eb080b61519b96240c9e))
* add Threads cross-posting ([47e2a11](https://github.com/Syndroo/syndroo/commit/47e2a11cc079ef77fa27967189cbb26d8e82fbc4))
* agent-guided platform auth + descriptor refactor ([d8206f2](https://github.com/Syndroo/syndroo/commit/d8206f298333eeb83d45d319ea244bbda72c78f7))
* **cli:** add CLI-first local publishing ([786a76a](https://github.com/Syndroo/syndroo/commit/786a76a9ed2575e45f329c9d8c67361f94e40c13))
* **cli:** add local connections and five-provider publishing ([f961d8d](https://github.com/Syndroo/syndroo/commit/f961d8d14c088276c919a70f3dfb0031a0ac47f4))
* **cli:** add the syndroo command ([9c481e9](https://github.com/Syndroo/syndroo/commit/9c481e9921db3287c8424799c96c154bca5c3df1))
* **cli:** publish directly from document input ([292853b](https://github.com/Syndroo/syndroo/commit/292853b21a7535014642bd043610744ed74c3469))
* **cli:** ship the official Syndroo Skill with the CLI ([fdef5ec](https://github.com/Syndroo/syndroo/commit/fdef5ec9fd3f7924ee4fe1571d1e82fa2b3ed3c6))
* **cli:** unify publication output and frozen confirmation ([56d0e2f](https://github.com/Syndroo/syndroo/commit/56d0e2f28065c1def17481e2e1121f5a9811af77))
* initialize Syndroo publishing pipeline ([c52686d](https://github.com/Syndroo/syndroo/commit/c52686d16da5c8bd649e4aaa3c736f1edcbbadb7))
* prepare 0.7.0 npm release and server onboarding ([c656b5e](https://github.com/Syndroo/syndroo/commit/c656b5ec999bb8363e0f63451df492b825d4ba2f))
* prepare v0.2.0 release candidate ([87ba42b](https://github.com/Syndroo/syndroo/commit/87ba42b5e8bc4ad8b79b8e91e0b295c0238c8543))
* prepare versioned Worker package ([18aac24](https://github.com/Syndroo/syndroo/commit/18aac245d986f7ad5cacbf5e396343adac36392e))
* rebuild Syndroo on the architecture-v1 design ([780478b](https://github.com/Syndroo/syndroo/commit/780478b24659f6f371ba323a7c6eb2d9caaab481))
* **release:** add local pack and global install scripts ([edb1422](https://github.com/Syndroo/syndroo/commit/edb1422f98fb177d70dd0eba23310683bb4440ae))
* **release:** gate the release train and add the E2E entry points ([d03c1c5](https://github.com/Syndroo/syndroo/commit/d03c1c554717a58e491ad9bc0d30bf02bd1c0da2))
* **sdk:** add the public @syndroo/sdk HTTP client ([14f66be](https://github.com/Syndroo/syndroo/commit/14f66be764dd3eb5959b8919795f9628258d2b5a))
* **threads:** enable Worker OAuth and scoped CI publishing ([c606a64](https://github.com/Syndroo/syndroo/commit/c606a64f0b0113612be6f2dc3fac037a7394c74a))


### Bug Fixes

* **build:** put cli before server and build before check ([ff5a50b](https://github.com/Syndroo/syndroo/commit/ff5a50bcf623d913a80533b5ec40f44d2f27bf57))
* **cli:** clarify server onboarding and deployment recovery ([#5](https://github.com/Syndroo/syndroo/issues/5)) ([e33a2b6](https://github.com/Syndroo/syndroo/commit/e33a2b61d2ed32db06dd18b8a9ab7eb69b34eda1))
* **cli:** pass Threads publish text to provider options ([#4](https://github.com/Syndroo/syndroo/issues/4)) ([c78d933](https://github.com/Syndroo/syndroo/commit/c78d9334d850f193a1fd2784c4d2099e598e424d))
* **deps:** record the server's esbuild dev dependency in the lockfile ([c098be8](https://github.com/Syndroo/syndroo/commit/c098be86c10393e47f723eb6a5c6cc5d78119e31))
* **devto:** send a User-Agent so DEV.to stops answering 403 ([5016c1e](https://github.com/Syndroo/syndroo/commit/5016c1e6197e99c264c3ef456394971ce49b6ecb))
* recover missing D1 during deployment ([e6fe7df](https://github.com/Syndroo/syndroo/commit/e6fe7df698f728c17262b5a24dc0a7da81bc404e))
* **release:** keep inlined workspace packages out of runtime deps ([f48c8f6](https://github.com/Syndroo/syndroo/commit/f48c8f634aafa2c8e3ef2c394759bc697851387e))
* require Node.js 22 for Wrangler ([809d056](https://github.com/Syndroo/syndroo/commit/809d056628c896d0e4de03a4a6d00bd4ad390cde))

## 0.7.2 — 2026-11-05

Stable maintenance release based on the published 0.7.0 train.

- Retains the complete self-hosted Server CLI and all 0.7.0 providers.
- Includes the post-0.7.0 Threads publish text fix and server onboarding/recovery guidance corrections.
- Advances all eleven workspace versions and internal package pins consistently to 0.7.2, including generated provider catalogs.
- Publishes matching provider, CLI, SDK, Server and Cloudflare Worker artifacts. No deployment is implied by this source release.

For upgrade, install the matching 0.7.2 package train. See `docs/releasing.md` for release checks; the 0.7.0 historical record below remains unchanged.

## 0.7.0

The architecture-v1 release train is published at `0.7.0`. It contains ten
public npm packages under `latest`, plus the private, bundled
`@syndroo/core` package.

### Added

- A local-first CLI with `connect`, `publish`, and `status`, explicit provider
  discovery, frozen confirmation, JSON envelopes, and a bundled Agent Skill.
- An optional `server` workflow that generates a user-owned Cloudflare project,
  verifies local and remote state, deploys an exact Worker artifact, configures
  Threads OAuth, and prepares manual GitHub CI without publishing content.
- Five official providers: Bluesky, Threads, LinkedIn, Mastodon, and DEV.to.
- A standalone HTTP SDK and self-hosted Node server.
- A Cloudflare Worker artifact with D1 state, Queues, Cron recovery, encrypted
  secrets, and fail-closed egress handling.
- Generated `THIRD_PARTY_LICENSES.txt` inventories inside the CLI, Server, and
  Worker bundles, derived from the packages actually compiled into each bundle.
- Reproducible local pack and seven-package global installation tooling for the
  full local CLI plus official provider set.

### Release manifest

The ten public packages are:

```text
@syndroo/provider-sdk@0.7.0
@syndroo/provider-bluesky@0.7.0
@syndroo/provider-threads@0.7.0
@syndroo/provider-linkedin@0.7.0
@syndroo/provider-mastodon@0.7.0
@syndroo/provider-devto@0.7.0
@syndroo/sdk@0.7.0
@syndroo/cli@0.7.0
@syndroo/server@0.7.0
@syndroo/cloudflare@0.7.0
```

`@syndroo/core@0.7.0` remains private and is compiled into the CLI, Server, and
Worker artifacts; it is not a runtime dependency of any published package.

### Verification boundaries

- Provider and server paths are fixture-tested. No live social account has been
  connected and no real post has been made.
- No Worker, Node server, GitHub environment, or Meta callback has been deployed
  from this release-preparation checkout.
- Local packed installation is not public-registry validation. Only a successful
  registry install verifies npm availability.

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
