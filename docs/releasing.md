# Releasing Syndroo

`packages/cloudflare-worker/package.json` is the only version source for public
releases. The release checker reads that manifest and nothing else declares a
release version.

| Package version | npm dist-tag | Git tag | GitHub Release |
| --- | --- | --- | --- |
| `<major>.<minor>.<patch>` | `latest` | `v<version>` | non-prerelease |
| `<major>.<minor>.<patch>-rc.<n>` | `next` | `v<version>` | prerelease |

Only `@syndroo/cloudflare-worker` is public. Core and platform adapter
workspaces remain private implementation details and are bundled into the
Worker artifact.

## Release checks

Before creating a release:

1. Update `packages/cloudflare-worker/package.json` and synchronize the
   lockfile.
2. Update `CHANGELOG.md` and release notes, including new D1 migrations, secrets,
   bindings, compatibility changes, and breaking changes.
3. Run:

   ```bash
   npm test
   npm run check
   npm run check:e2e
   npm run bundle
   npm run startup
   npm run build:package
   npm run test:e2e
   npm run verify:package
   npm pack --workspace @syndroo/cloudflare-worker --dry-run
   git diff --check
   ```

   `npm test` already runs `npm run test:scripts`, which compiles the repository
   scripts and executes the release-checker suite.

   `npm run test:e2e` is the local Mock SNS gate. It drives the bundled Worker,
   D1, Queue, the scheduled handler, and the real adapters against loopback Mock
   SNS servers with fake credentials, and it proves internal integration only.
   Live platform acceptance stays a separate gate.

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
- `npm run release:check` (`scripts/check-release.ts`) validates the package
  name, version form, license, and repository URL. On a release event it also
  requires the tag to be exactly `v<package version>` and the GitHub prerelease
  boolean to agree with the version: `-rc.<n>` must be a prerelease, stable
  versions must not be.
- The checker emits `version`, `published`, and `dist_tag`, where `dist_tag` is
  `latest` for stable versions and `next` for release candidates. The publish
  step branches on that value: `next` publishes with `--tag next`, because npm
  requires an explicit tag when publishing a prerelease version; `latest`
  publishes without `--tag`, so npm's own guard still refuses to move `latest`
  backwards to an older version; any other value aborts the run.
- A release event without complete release metadata, a registry HTTP error, or a
  registry network failure fails the run. Only HTTP `404` counts as an
  unpublished version.
- When the exact version already exists on npm, the workflow reports that and
  skips the publish step.

## Release sequence

The candidate ships first under `next`; the stable version ships under `latest`
only after candidate acceptance. Each publication is a separate maintainer
approval, and the release checklist in
[v0.2.0-todo.md](v0.2.0-todo.md) tracks the surrounding release gates.

### 1. Release candidate (`next`)

1. Set `packages/cloudflare-worker/package.json` to `0.2.0-rc.1` and synchronize
   the lockfile.
2. Run every release check above from the reviewed commit.
3. Publish under `next`:
   - If `@syndroo/cloudflare-worker` has no published version yet, npm cannot
     hold a trusted publisher for it. Bootstrap the candidate manually with
     two-factor authentication:

     ```bash
     npm publish --workspace @syndroo/cloudflare-worker --tag next
     ```

   - If the trusted publisher is already configured, create the
     `v0.2.0-rc.1` tag and the prerelease GitHub Release, and let the workflow
     publish with `--tag next`.
4. Validate the candidate before promoting anything: install the exact
   `@syndroo/cloudflare-worker@0.2.0-rc.1` in a throwaway project and in
   `Syndroo/syndroo-deploy-template`, apply migrations, and exercise the Worker.
   The template pins the exact candidate version and never a range or the moving
   `next` tag, so a later candidate cannot silently change what a template
   install resolves. Record the verified version in the template's lockfile
   after the registry install succeeds.
5. Publish a new candidate number for any fix. Never publish over an existing
   version.

### 2. Stable release (`latest`)

1. Set `packages/cloudflare-worker/package.json` to `0.2.0` and synchronize the
   lockfile.
2. Run every release check again from the final release commit.
3. Create tag `v0.2.0` and a non-prerelease GitHub Release, and let the workflow
   publish under `latest`. If trusted publishing is unavailable, publish
   manually with two-factor authentication:

   ```bash
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
Configure `@syndroo/cloudflare-worker` on npm with:

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

Never store an npm publish token in repository secrets after trusted publishing
is configured.

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
- Registry state beyond a single exact-version existence probe.

## Release compatibility policy

- Patch and minor releases must not add a required secret or binding.
- Required secret or binding changes are breaking changes.
- Published D1 migrations are immutable and remain in every later package.
- Migrations must preserve compatibility with the previous deployed Worker so
  a failed code deployment does not leave the database unusable.
- Releases are never published from a fork.
