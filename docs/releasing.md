# Releasing Syndroo

## Current release: v0.7.2

The current release train has eleven source workspaces at `0.7.2` (ten public
npm packages and private `@syndroo/core`). Publishing a non-draft GitHub Release
from the exact `v0.7.2` tag **automatically** triggers the `release.yml`
workflow, validates the release train, then publishes each missing package in
its dependency order under the matching npm `latest` dist-tag. Any failed gate
stops publishing. The workflow requires npm Trusted Publisher configured for
`Syndroo/syndroo` and `.github/workflows/release.yml` on each public package.

The manual `workflow_dispatch` route remains available with `mode=validate`
(default; no npm publication) and `mode=publish` (publish after validation).
GitHub tag creation alone does not publish packages; the Release must be
**published**. A stable version must not be marked as a prerelease. npm
publication is distinct from deploying a Cloudflare Worker or a Node server.

To validate an intended publication before publishing the GitHub Release:

```bash
npm ci && npm run build && npm run check && npm test
npm run test:scripts && npm run check:pack
SYNDROO_CHECK_REGISTRY=true SYNDROO_RELEASE_TAG=v0.7.2 SYNDROO_RELEASE_PRERELEASE=false npm run release:train
```

### Historical publication: v0.7.0

Architecture v1 is one coherent tree of eleven packages, all at `0.7.0`. The
ten public packages are published to npm under the `latest` tag and
`@syndroo/core` remains private. No Worker or server has been deployed. All ten public versions and their artifact integrity values were verified.
A clean seven-package public installation passed.

## Versions

| Package | Version | Role |
| --- | --- | --- |
| `@syndroo/provider-sdk` | `0.7.0` | public: plugin contract and `defineProvider` |
| `@syndroo/core` | `0.7.0` | **private**: inlined into the public bundles |
| `@syndroo/provider-{bluesky,threads,linkedin,mastodon,devto}` | `0.7.0` | public: official providers |
| `@syndroo/sdk` | `0.7.0` | public: HTTP client |
| `@syndroo/server` | `0.7.0` | public: self-hosted Node server |
| `@syndroo/cli` | `0.7.0` | public: `syndroo` command |
| `@syndroo/cloudflare` | `0.7.0` | public artifact: Worker bundle |

The protocol generation is `protocolVersion: 1`. That is a protocol revision, not
an npm version. The release train is exactly ten public packages; there is no
umbrella package and no runtime provider download.

`@syndroo/core` stays private. Three artifacts inline it and must keep it out of
their runtime `dependencies`:

| Artifact | Entry |
| --- | --- |
| `@syndroo/cli` | `dist/bin.js` |
| `@syndroo/server` | `dist/index.js` |
| `@syndroo/cloudflare` | `dist/worker.js` |

## Checks before publication

```bash
npm ci
npm run build                     # build all eleven packages in dependency order
npm run check                     # type-check plus bundle assertions
npm test                          # per-package test suites
npm run test:scripts              # bundler, license and release-tool tests
npm run check:provider-catalog    # catalog matches the built providers
npm run check:pack                # npm pack --dry-run for every stage
npm run pack:local                # ten public tarballs; never Core
npm run install:global -- --dry-run
node scripts/server-cli-artifact-smoke.ts
git diff --check
```

The Developer Certificate of Origin check is a CI step over a commit range:
`SYNDROO_BASE_SHA=<sha> SYNDROO_HEAD_SHA=<sha> npm run dco:check`. Run it that
way for a pull request; there is no bare local form.

`npm run check` reports any bundle that has not been built as `PENDING`, never
`ok`. Build before you rely on the bundle rows.

Each bundled artifact ships `dist/THIRD_PARTY_LICENSES.txt`. The inventory is
generated from esbuild's actual input graph during the build, fails closed when a
bundled package has no usable license text or reviewed exact-version supplement,
and is included in the CLI, Server and Worker pack manifests.

## Packaging and installing locally

`npm run pack:local` writes one `0.7.0` tarball per public package into
`artifacts/` (the private `@syndroo/core` is never packed), and
`npm run install:global` installs the CLI, its provider contract and the five
official providers from those tarballs in one `npm install --global`.

The one rule not to forget: after any change to a provider's built output,
regenerate the provider catalog (`npm run generate:provider-catalog`) and
reinstall the CLI too, or the CLI sees a fingerprint that no longer matches the
installed provider and reports it as `stale` / `PROVIDER_TRUST_REQUIRED`.

The server artifact proof is separate from the ten-package local release. It
packs the existing `@syndroo/cli` and `@syndroo/cloudflare` builds with lifecycle
scripts disabled, serves those two exact versions from a bounded loopback npm
registry, and initializes a generated project outside the checkout. Public
dependencies still use npm's normal resolution. The script verifies tarball
contents, exact generated pins, help, read-only doctor, module imports, source
path independence, and `wrangler deploy --dry-run`.

Use `--keep` only when the disposable fixture needs review. The default run
removes its temporary registry files and project. This proves artifact shape and
local installation, not public-registry availability.

## Public installation

The complete default local CLI installation is:

```bash
npm install --global \
  @syndroo/cli@0.7.0 \
  @syndroo/provider-sdk@0.7.0 \
  @syndroo/provider-bluesky@0.7.0 \
  @syndroo/provider-threads@0.7.0 \
  @syndroo/provider-linkedin@0.7.0 \
  @syndroo/provider-mastodon@0.7.0 \
  @syndroo/provider-devto@0.7.0
syndroo --version
```

A prepared tarball or successful dry run does not establish registry
availability. Verify this public install from a clean prefix before rollout.

## Initial publication for absent package names

npm Trusted Publishing cannot create a package name's first version. For a new
`0.7.0` train, an authenticated maintainer bootstrapped each absent package
before configuring that package's Trusted Publisher for later OIDC releases.
All ten public publish commands were accepted under `latest`.

Use only tarballs that already passed the release gates above. The artifacts in
`artifacts/` are the immutable `0.7.0` publish candidates; do not rebuild or
republish them. The audit sequence below is retained for the release record.

```bash
# Run one preflight at a time; run its publish line only after confirming E404.
# Do not paste this entire block into a shell.
npm whoami

npm view @syndroo/provider-sdk@0.7.0 version
npm publish ./artifacts/syndroo-provider-sdk-0.7.0.tgz --tag latest

npm view @syndroo/provider-bluesky@0.7.0 version
npm publish ./artifacts/syndroo-provider-bluesky-0.7.0.tgz --tag latest

npm view @syndroo/provider-threads@0.7.0 version
npm publish ./artifacts/syndroo-provider-threads-0.7.0.tgz --tag latest

npm view @syndroo/provider-linkedin@0.7.0 version
npm publish ./artifacts/syndroo-provider-linkedin-0.7.0.tgz --tag latest

npm view @syndroo/provider-mastodon@0.7.0 version
npm publish ./artifacts/syndroo-provider-mastodon-0.7.0.tgz --tag latest

npm view @syndroo/provider-devto@0.7.0 version
npm publish ./artifacts/syndroo-provider-devto-0.7.0.tgz --tag latest

npm view @syndroo/sdk@0.7.0 version
npm publish ./artifacts/syndroo-sdk-0.7.0.tgz --tag latest

npm view @syndroo/cli@0.7.0 version
npm publish ./artifacts/syndroo-cli-0.7.0.tgz --tag latest

npm view @syndroo/server@0.7.0 version
npm publish ./artifacts/syndroo-server-0.7.0.tgz --tag latest

npm view @syndroo/cloudflare@0.7.0 version
npm publish ./artifacts/syndroo-cloudflare-0.7.0.tgz --tag latest
```

Each publish was conditional on its matching preflight. Do not republish an
existing `0.7.0` version. Trusted Publisher configuration remains a separate
setting for future OIDC releases and cannot be inferred from the bootstrap.

## Publication record

All ten public `0.7.0` package publish commands were accepted by npm under
`latest`.

- All ten public versions, `latest` tags, and artifact integrity values were verified.
- A clean seven-package public installation passed; public Server init and doctor also passed.
- Trusted Publisher settings and OIDC automation are separate from the accepted
  initial publication and must be checked before a future release.
- A user-owned deployment project comes from `syndroo server init`. The Worker reads its
   bindings (`DB`, `WORK_QUEUE`, `QUEUE_NAME`, `DLQ_NAME`, `API_BEARER`,
   `SECRET_KEY`, `RUNTIME_KEY`, `SCOPE`, `PUBLIC_FETCH_STRICT`) at request time;
   the deployment must also set Wrangler's `global_fetch_strictly_public` flag.
   The generated `wrangler.jsonc` points at the installed Worker artifact. The
   CLI validates these values, derives an ignored effective config, creates
   missing D1/queues, and deploys with project-local Wrangler. No generated or
   root deployment has been made, and no real secret has been uploaded.
- For the self-hosted server, the runtime options in
   [remote-compatibility.md](remote-compatibility.md): a Bearer secret, a state
   path, a secrets path, a secret-store key, and a provider composition.

## Release automation

`.github/workflows/ci.yml` runs the v1 gates in the order that makes them mean
something, and the build comes first: `npm run build` produces the declarations
every workspace checks against, then `npm run check` type-checks the packages and
asserts the bundle rows against real artifacts instead of reporting `PENDING`.
`npm test`, `npm run test:scripts`, the e2e type check, `npm run e2e:local-only`,
`npm pack --dry-run` for five public packages and `git diff --exit-code` for
generated drift follow. The Release Please design, the first-release
`bootstrap-sha`, token setup and verification status are in
[release-automation.md](release-automation.md). The matrix is Node 24 only,
because every v1 package requires `>=24.19.0`.

`.github/workflows/release.yml` validates the ten-package train and publishes
it when a GitHub Release is published from the release tag; a manual dispatch
with `mode: publish` does the same after the gates, and `mode: validate` (the
default) publishes nothing. The publish step walks the train in dependency
order, skipping any package the registry already satisfies. The OIDC workflow
cannot perform a package name's first publish; absent names must use the
preflighted maintainer bootstrap above and receive package-level Trusted
Publisher settings before automation is used. Release Please opens and refreshes
the release PR from Conventional Commits on `main`; see
[release-automation.md](release-automation.md) for the automated flow, the
catalog refresh and the optional website notification.

Release-preparation commit
`c656b5ec999bb8363e0f63451df492b825d4ba2f` has successful Linux and macOS
GitHub Actions evidence. This documentation update requires its own checks.

## What is not verified

- **Live-account acceptance**: no provider has been exercised against a real
  account. The five providers are fixture-tested against recorded API evidence.
- **Deployment**: no Worker or server has been deployed from this tree, and no
  real GitHub environment, Meta callback, or Threads account has been configured.
- **Platform matrix**: Linux/macOS CI passed on Node.js 24; public installation also passed locally on Node.js 26.7.0. Other platforms remain unverified.
- **LinkedIn version**: `LINKEDIN_VERSION` (`202601`) is a pinned package
  constant awaiting re-verification against LinkedIn's supported versions.
- **Threads**: publishing uses a single `auto_publish_text=true` call; the
  two-step container flow is deliberately not implemented.

## Contribution gate

Every commit needs a Developer Certificate of Origin sign-off
(`git commit --signoff`); `npm run dco:check` enforces it. See
[CONTRIBUTING.md](../CONTRIBUTING.md).
