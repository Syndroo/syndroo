# Releasing Syndroo

One release is three public packages published as one train, in this order:

| Order | Package | Manifest |
| --- | --- | --- |
| 1 | `@syndroo/sdk` | `packages/sdk/package.json` |
| 2 | `@syndroo/cli` | `packages/cli/package.json` |
| 3 | `@syndroo/cloudflare-worker` | `packages/cloudflare-worker/package.json` |

The CLI cannot install without the SDK it ships with, so the SDK is published
first and the CLI depends on the *exact* SDK version rather than a range. The
Worker is the deployable artifact and ships last. Core and the platform adapter
workspaces remain private implementation details bundled into the Worker.

All three manifests declare the same version. `scripts/release-train.ts` reads
all three and refuses to describe the checkout as a releasable train when they
disagree:

| Train version | npm dist-tag | Git tag | GitHub Release |
| --- | --- | --- | --- |
| `<major>.<minor>.<patch>` | `latest` | `v<version>` | non-prerelease |
| `<major>.<minor>.<patch>-rc.<n>` | `next` | `v<version>` | prerelease |

Two hard rules, both enforced by the checker rather than by memory:

1. **A release candidate cannot be retagged as a stable release.** The dist-tag
   is derived from the version and nothing else, and a publish step that asks
   for any other tag is refused. Moving the `latest` tag does not change the
   version inside a published tarball, and npm refuses to publish a prerelease
   without an explicit tag even if that guard were removed.
2. **A published version is never republished and never overwritten.** The
   checker reports an existing version as already published and plans no action
   for it. Fixes ship as a new `-rc.<n>` or a new patch version.

## Current blocker

The version mismatch is resolved: all three manifests and the CLI's exact
`@syndroo/sdk` dependency now declare the same `0.5.0-rc.1` candidate, and the
offline `npm run release:train` check passes against the actual manifests,
alongside the 92 release-check fixtures. That alignment is metadata only: this
work has not created a tag or a GitHub Release, and it has not published any npm
version. The checkout is not releasable yet.

The train stays blocked by product readiness rather than version drift:

- the Worker aggregate test run hangs after an `EnvironmentTeardownError` and is
  terminated at its 60-second deadline with exit code 124, so no complete main
  test count is recorded;
- a direct `tsc` over the Worker test tree still reports four known type errors;
  `npm run check` was not run in this pass because it invokes Wrangler type
  generation;
- the tarball consumer gate, the Worker bundle, and the full gate have not run on
  this commit;
- the final HTTP/Queue/Cron runtime cutover, the D1 fences and public read
  projection, the fresh/legacy migration rehearsal, crypto/R2 interop, and the
  CLI boundary evidence remain unaccepted;
- the corrections those scopes need are not yet authorized.

Do not publish, tag, or deploy from this checkout, and do not treat the existing
`scripts/deploy.ts` as a ready 0.5 deployment path: it still applies remote
migrations and deploys without an upgrade/cutover preflight. See
[v0.5.0/deployment-release-handoff.md](v0.5.0/deployment-release-handoff.md) for
the blocked gates, the checks that are runnable now, and the future deployment
and publication order.

Two things below are historical context rather than current instructions:

- the version-specific sequences further down this file (the `0.4.0-rc.1` and
  `0.4.0` steps, and the `0.2.0` migration notes) describe earlier trains. They
  are examples, not the execution path for the current 0.5 work;
- the "each publication is a separate maintainer approval" wording predates the
  current authorization. Deployment and publication for 0.5.0 are already
  conditionally authorized by the user, so the open item is readiness, not a
  fresh approval for every step.

The current route for 0.5.0 is
[v0.5.0/deployment-release-handoff.md](v0.5.0/deployment-release-handoff.md).

## Release checks

Before creating a release:

1. Set the same version in `packages/sdk/package.json`,
   `packages/cli/package.json`, `packages/cloudflare-worker/package.json`, and
   the CLI's exact `@syndroo/sdk` dependency, then synchronize the lockfile.
2. Update `CHANGELOG.md` and release notes, including new D1 migrations, secrets,
   bindings, compatibility changes, and breaking changes.
3. Run:

   ```bash
   npm run release:train
   npm test
   npm run check
   npm run bundle
   npm run startup
   npm run build:package
   npm run e2e:local
   npm run e2e:consumer -- --source tarball
   npm run verify:package
   npm pack --workspace @syndroo/sdk --dry-run
   npm pack --workspace @syndroo/cli --dry-run
   npm pack --workspace @syndroo/cloudflare-worker --dry-run
   git diff --check
   ```

   `npm test` already runs `npm run test:scripts`, which compiles the repository
   scripts and executes the release-checker suites, including the release-train
   fixtures.

   `npm run e2e:local` is the local Mock SNS gate. It drives the bundled Worker,
   D1, Queue, the scheduled handler, the real adapters, and the built SDK and
   CLI against loopback Mock SNS servers with fake credentials, and it proves
   internal integration only. Live platform acceptance stays a separate gate.

   `npm run e2e:consumer -- --source tarball` installs the packed artifacts in a
   directory outside this repository and runs the installed SDK and CLI there.
   `--source registry --version <v>` only reports whether the exact version is
   published; installing from a real registry needs
   `SYNDROO_CONSUMER_ALLOW_REGISTRY_INSTALL=true` on an approved host.

   `npm run verify:package` checks the packed artifact, including the bundled
   third-party license text.

4. Merge through `main`.
5. Create tag `v<version>` from the reviewed commit.
6. Publish a GitHub Release from that tag: prerelease for `-rc.<n>` versions,
   non-prerelease for stable versions.

## Release workflow

`.github/workflows/release.yml` runs on `release: published` and on
`workflow_dispatch`.

- `workflow_dispatch` validates the repository and never publishes. The publish
  step requires a release event.
- `npm run release:train` (`scripts/release-train.ts`) is the train gate. It
  validates all three manifests together, refuses any version disagreement, and
  reports which packages the train still needs. On a release event it also
  requires the tag to be exactly `v<train version>`, and the GitHub prerelease
  boolean to agree with the version shape.

  With `SYNDROO_CHECK_REGISTRY=true` it reads one packument per package and
  decides each package as `publish`, `already-published`, or `blocked`. Only
  HTTP `404` counts as "not published"; a `401`, `403`, `429`, `5xx`, an
  unreadable packument, or a transport failure fails the run and blocks the rest
  of the train instead of being read as a missing package.
- `npm run release:check` (`scripts/check-release.ts`) still validates the
  Worker package on its own, and emits the `version`, `published`, and
  `dist_tag` outputs the Worker publish step uses.
- `npm run e2e:consumer -- --source tarball` runs in the same job, so a release
  cannot be published from a checkout whose packed artifacts do not install and
  run outside the repository.
- The workflow asserts that the dist-tag it is about to use matches the version
  shape: `-rc.<n>` must use `next`, a stable version must use `latest`, and any
  other value aborts the run. `next` publishes with `--tag next`, because npm
  requires an explicit tag for a prerelease; `latest` publishes without
  `--tag`, so npm's own guard still refuses to move `latest` backwards.
- A release event without complete release metadata, a registry HTTP error, or a
  registry network failure fails the run. Only HTTP `404` counts as an
  unpublished version.
- When an exact version already exists on npm, the workflow reports that and
  skips that package.

### Outstanding workflow work

The publish step still publishes only `@syndroo/cloudflare-worker`. Extending it
to the three-step train changes what the workflow does in production, so it
needs an explicit maintainer decision and is not made here. The change is
mechanical once the train versions are unified:

1. Publish `@syndroo/sdk` when `steps.train.outputs.publish_sdk == 'true'`.
2. Publish `@syndroo/cli` when `steps.train.outputs.publish_cli == 'true'`.
3. Publish `@syndroo/cloudflare-worker` when
   `steps.train.outputs.publish_worker == 'true'`.

Each step passes `--tag next` for the `next` dist-tag and no `--tag` for
`latest`, exactly as the Worker step does today. Until that lands, a release can
publish only the Worker, and the SDK and CLI have to be published by hand in the
order above.

### Partial publication recovery

The three publications are not atomic. When a publish fails partway through,
for example with the SDK published and the CLI step failing:

1. `npm run release:train` reports the SDK as `already-published`, the failed
   package as `blocked`, and the package that was never attempted as `blocked`
   with `not attempted`. It exits non-zero and announces no success.
2. Do not republish, delete, or retag the published version. npm cannot
   overwrite it, and the tarball that is already published is the reviewed
   artifact.
3. Fix the cause and re-run the same check. It plans work only for the packages
   that are still missing, and the publish steps skip the rest.

`scripts/release-train.spec.ts` exercises that exact sequence against a fake
registry: SDK published with the CLI returning `500`, then a resumed run where
the SDK is skipped and only the CLI and Worker remain publishable. No failure
injection touches a real registry.

## Release sequence

The candidate ships first under `next`; the stable version ships under `latest`
only after candidate acceptance. Each publication is a separate maintainer
approval, and the release checklist in
[v0.4.0/syndroo-v0.4.0-local-e2e-checklist.md](v0.4.0/syndroo-v0.4.0-local-e2e-checklist.md)
tracks the surrounding release gates.

### 1. Release candidate (`next`)

1. Set the same `0.4.0-rc.1` version in `packages/sdk/package.json`,
   `packages/cli/package.json`, `packages/cloudflare-worker/package.json`, and
   the CLI's exact `@syndroo/sdk` dependency, then synchronize the lockfile. Run
   `npm run release:train` and require it to pass before anything else.
2. Run every release check above from the reviewed commit.
3. Publish under `next`, in order, stopping at the first failure:
   - A package with no published version cannot hold a trusted publisher yet,
     so bootstrap it manually with two-factor authentication:

     ```bash
     npm publish --workspace @syndroo/sdk --tag next
     npm publish --workspace @syndroo/cli --tag next
     npm publish --workspace @syndroo/cloudflare-worker --tag next
     ```

   - Once the trusted publishers are configured, create the `v0.4.0-rc.1` tag
     and the prerelease GitHub Release. The workflow publishes what is still
     missing and skips any version that already exists.
   - If a step fails, follow [Partial publication
     recovery](#partial-publication-recovery) instead of republishing what
     succeeded.
4. Validate the candidate before promoting anything: install the exact
   `0.4.0-rc.1` versions in a throwaway project, including
   `@syndroo/cloudflare-worker@0.4.0-rc.1` in
   `Syndroo/syndroo-deploy-template`, apply migrations, and exercise the Worker
   and the CLI. `npm run e2e:consumer -- --source registry --version 0.4.0-rc.1`
   reports whether the versions are installable; the install itself is a
   maintainer action on an approved host. The template pins the exact candidate
   version and never a range or the moving `next` tag, so a later candidate
   cannot silently change what a template install resolves.
5. Publish a new candidate number for any fix. Never publish over an existing
   version.

### 2. Stable release (`latest`)

1. Set the same `0.4.0` version in all three manifests and the CLI's SDK
   dependency, synchronize the lockfile, and confirm `npm run release:train`
   passes. Bumping only the tag is not a release: the version inside the
   published tarball is what a consumer installs.
2. Run every release check again from the final release commit.
3. Create tag `v0.4.0` and a non-prerelease GitHub Release, and let the workflow
   publish under `latest`. If trusted publishing is unavailable, publish
   manually with two-factor authentication, in order:

   ```bash
   npm publish --workspace @syndroo/sdk
   npm publish --workspace @syndroo/cli
   npm publish --workspace @syndroo/cloudflare-worker
   ```

   Do not add `--tag latest` by hand. Publishing a stable version without an
   explicit tag already targets `latest`, and npm's own guard refuses to move
   `latest` backwards to an older version; forcing the tag gives up that
   protection.
4. Confirm the resulting dist-tags, then update the deployment template to the
   released version.

## Migrations

The v0.2.0 line adds
`packages/cloudflare-worker/migrations/0003_retry_timing.sql`, which carries the
strict retry deadline for publications.

- The migration is part of every `0.2.0*` release. Do not ship a `0.2.0*`
  package without it, and do not edit it after publication.
- Apply migrations before deploying the Worker version that needs them. The
  `deploy` script applies pending migrations during deployment.
- Published migrations are immutable and remain in every later package. Keep
  each new migration compatible with the previously deployed Worker so a failed
  code deployment does not leave the database unusable.
- Release notes must list new migrations and any required operator action.

## npm trusted publishing

The release workflow uses npm trusted publishing. It does not use an npm token.
Configure each of the three packages on npm with:

- package: `@syndroo/sdk`, `@syndroo/cli`, or `@syndroo/cloudflare-worker`;
- provider: GitHub Actions;
- organization: `Syndroo`;
- repository: `syndroo`;
- workflow filename: `release.yml`;
- direct `npm publish`: allowed, since the workflow publishes directly rather
  than through staged publishing.

Trusted publishing requires npm 11.5.1 or later, Node.js 22.14.0 or later, and a
GitHub-hosted runner. The workflow installs a pinned npm version and runs on
`ubuntu-latest`.

Trusted publishing requires an existing npm package. Bootstrap the first public
publication manually as described in the release candidate step, then configure
the trusted publisher before the next release. If a bootstrap version already
exists when its GitHub Release runs, the workflow detects it and exits without
publishing a duplicate.

Configure all three separately. A working publisher for one package proves
nothing about the others, and a local `npm whoami` does not prove that the CI
OIDC identity is authorized. Never store an npm publish token in repository
secrets after trusted publishing is configured.

## Bundled third-party licenses

The published Worker bundles third-party code. `npm run verify:package` and the
package build generate `dist/THIRD_PARTY_LICENSES.txt` from the built bundle,
and `packages/cloudflare-worker/licenses/third-party-license-supplements.json`
records supplemental texts alongside their source and SHA-256.

`@xdevplatform/xdk@0.6.6` declares `"license": "MIT"` and an author in its
`package.json`, but the published tarball for that exact version contains only
`dist/`, `package.json`, and `README.md`, and the upstream repository ships no
`LICENSE` or `COPYING` file. The package therefore carries no license or
copyright text to reproduce.

The supplement supplies the canonical SPDX MIT text with the
`<year> <copyright holders>` placeholder left exactly as published, plus the
recorded source URL and digest. It is not the upstream project's license file, it
asserts no copyright holder, and its presence is not a certification that every
legal obligation in this distribution has been reviewed.

## What this repository does not verify

- npm account permissions, two-factor authentication, and trusted publisher
  configuration are maintainer-side settings. The release checker only proves
  that the local package metadata and the GitHub release event agree; it does
  not prove that publication will be authorized.
- The Mock SNS gate proves internal wiring, persistence, idempotency, ambiguity
  handling, and scheduling. It does not prove provider permissions, API
  compatibility, or rate limits.
- Live platform credentials and API behavior; those remain separate release
  gates.
- Registry state beyond the packument reads described above. The train checker
  sees which versions exist and where the dist-tags point; it cannot verify an
  artifact's integrity, and it does not download a published tarball.
- Installing the published versions. `e2e:consumer --source tarball` proves the
  packed artifacts work, and `--source registry` only reports whether the
  versions exist. A real registry install runs on an approved host with
  `SYNDROO_CONSUMER_ALLOW_REGISTRY_INSTALL=true`.

## Release compatibility policy

- Patch and minor releases must not add a required secret or binding.
- Required secret or binding changes are breaking changes.
- Published D1 migrations are immutable and remain in every later package.
- Migrations must preserve compatibility with the previous deployed Worker so
  a failed code deployment does not leave the database unusable.
- Releases are never published from a fork.
