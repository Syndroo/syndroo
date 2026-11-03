# Releasing Syndroo

Architecture v1 is one coherent tree of eleven packages, all at `0.7.0`. The
ten public packages are prepared for npm under the `latest` tag and
`@syndroo/core` remains private. The `0.7.0` train has not been published, no
Worker or server has been deployed, and the remaining registry and authentication
prerequisites are listed below.

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

## Public installation target

Once all ten package versions are present on npm, the complete default local CLI
installation is:

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
availability. Verify the public install from a clean prefix before publishing
installation claims or changing the website's product pin.

## Initial publication for absent package names

npm Trusted Publishing cannot create a package name's first version. For a new
`0.7.0` train, an authenticated maintainer must perform an explicitly authorized
initial publish for each absent package before configuring that package's Trusted
Publisher for later OIDC releases. This is a manual bootstrap, not a new workflow
or token path.

Use only tarballs that already passed the release gates above. The artifacts in
`artifacts/` are exact publish candidates; do not rebuild them during this step.
For every package in dependency order, run its `npm view` preflight immediately
before deciding whether to publish. A returned `0.7.0` means the version already
exists and **must not** be republished. An `E404` means the version is absent and
the corresponding publish command may run.

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

The publish line is conditional on the matching preflight being absent. Stop on
any unexpected result, version conflict, or authentication error. After a new
package exists, configure npm Trusted Publisher for that package with GitHub
repository `Syndroo/syndroo` and workflow `release.yml`; repeat the setting for
each newly created package. Local `npm login` or `npm whoami` authenticates the
maintainer CLI only. It does not configure GitHub OIDC, create packages, or set
package-level trusted publishers.

## Publication prerequisites

A real release or deployment is a separate, explicitly authorized step:

1. Confirm the local maintainer authentication separately by running
   `npm whoami`; the preparation session got HTTP 401 and did not retry or
   perform login. Local credentials do not authorize the GitHub OIDC workflow.
2. Bootstrap each absent package name with the authorized, preflighted
   maintainer path in [Initial publication for absent package
   names](#initial-publication-for-absent-package-names). Never republish a
   version that already exists.
3. Configure a per-package npm Trusted Publisher for the `Syndroo/syndroo`
   `release.yml` workflow after each package exists. Do not infer OIDC or
   package-level trust from a local login.
4. Merge a reviewed commit and create the matching `v0.7.0` release. Then set
   the repository variable `SYNDROO_PUBLISH_ON_RELEASE=true`, or dispatch the
   existing release workflow with `mode: publish`. The workflow uses OIDC; no
   long-lived npm token belongs in repository secrets for this path.
5. Verify every public package and the seven-package installation from the
   public registry. Do not report a partial or prepared train as released.
6. A user-owned deployment project from `syndroo server init`. The Worker reads its
   bindings (`DB`, `WORK_QUEUE`, `QUEUE_NAME`, `DLQ_NAME`, `API_BEARER`,
   `SECRET_KEY`, `RUNTIME_KEY`, `SCOPE`, `PUBLIC_FETCH_STRICT`) at request time;
   the deployment must also set Wrangler's `global_fetch_strictly_public` flag.
   The generated `wrangler.jsonc` points at the installed Worker artifact. The
   CLI validates these values, derives an ignored effective config, creates
   missing D1/queues, and deploys with project-local Wrangler. No generated or
   root deployment has been made, and no real secret has been uploaded.
7. For the self-hosted server, the runtime options in
   [remote-compatibility.md](remote-compatibility.md): a Bearer secret, a state
   path, a secrets path, a secret-store key, and a provider composition.

## Release automation

`.github/workflows/ci.yml` runs the v1 gates in the order that makes them mean
something, and the build comes first: `npm run build` produces the declarations
every workspace checks against, then `npm run check` type-checks the packages and
asserts the bundle rows against real artifacts instead of reporting `PENDING`.
`npm test`, `npm run test:scripts`, the e2e type check, `npm run e2e:local-only`,
`npm pack --dry-run` for five public packages and `git diff --exit-code` for
generated drift follow. The matrix is Node 24 only, because every v1 package
requires `>=24.19.0`.

`.github/workflows/release.yml` validates the ten-package train and publishes
nothing by default. Publishing requires an explicit opt-in — the repository
variable `SYNDROO_PUBLISH_ON_RELEASE` set to the exact string `true` on a release
event, or a manual dispatch with `mode: publish` — and the publish step walks the
train in dependency order, skipping any package the registry already satisfies.
The OIDC workflow cannot perform a package name's first publish; absent names
must use the preflighted maintainer bootstrap above and receive package-level
Trusted Publisher settings before automation is used.

The product commit before these release-preparation changes has successful
GitHub Actions evidence. The dirty release preparation still requires its own CI
run; local command results do not stand in for that run.

## What is not verified

- **Live-account acceptance**: no provider has been exercised against a real
  account. The five providers are fixture-tested against recorded API evidence.
- **Deployment**: no Worker or server has been deployed from this tree, and no
  real GitHub environment, Meta callback, or Threads account has been configured.
- **Public-registry installation**: the `0.7.0` train is not published. Read-only
  checks at preparation time found the public CLI only at `0.4.0-rc.1` and no
  `@syndroo/cloudflare` package. Local packed artifact proofs do not establish
  public availability.
- **Platform matrix**: this checkout has run on Node.js 24.19.0 only.
- **LinkedIn version**: `LINKEDIN_VERSION` (`202601`) is a pinned package
  constant awaiting re-verification against LinkedIn's supported versions.
- **Threads**: publishing uses a single `auto_publish_text=true` call; the
  two-step container flow is deliberately not implemented.

## Contribution gate

Every commit needs a Developer Certificate of Origin sign-off
(`git commit --signoff`); `npm run dco:check` enforces it. See
[CONTRIBUTING.md](../CONTRIBUTING.md).
