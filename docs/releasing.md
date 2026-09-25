# Releasing Syndroo

The `0.6.0-rc.1` candidate ships the **CLI alone**. The SDK and the Worker keep
their existing versions and behavior; they are validated by the same run but
are not published by it.

Current versions and release roles, as declared in this checkout:

| Package | Version | Release role |
| --- | --- | --- |
| `@syndroo/cli` | `0.6.0-rc.1` | the candidate this release set publishes |
| `@syndroo/sdk` | `0.4.0-rc.1` | retained; validated, not part of the CLI set |
| `@syndroo/cloudflare-worker` | `0.2.0-rc.1` | retained; validated, not part of the CLI set |
| `@syndroo/core` and the platform adapters | private, bundled | not separate packages |

This task builds and installs the local tarball only; it performs no npm
publish, and it did not verify the registry's current state. Treat every install
instruction as "build the tarball first" until a release actually exists.

## Release sets

The release train validates one set at a time, chosen by `SYNDROO_RELEASE_SET`:

- `cli` — the `0.6` candidate. The CLI must be self-contained: no runtime
  dependency on any workspace package, one uniform version, and a bundled
  Skill whose documented surface matches the built `--help`.
- `all` (default) — the historical three-package train (SDK, CLI, Worker) that
  requires one shared version and a CLI pinned to the exact SDK it was built
  against. It stays meaningful and stays the default; right now it reports a
  real mismatch, because the three packages are at different candidate
  versions.

Selecting `cli` narrows the package set. It does not relax a rule.

```bash
SYNDROO_RELEASE_SET=cli npm run release:train   # the CLI candidate alone
npm run release:train                           # the legacy three-package train
```

## Checks before a candidate

```bash
npm ci
# The candidate versions are split, so the release-set scripts need the CLI set.
export SYNDROO_RELEASE_SET=cli
npm test
npm run check
npm run build:scripts
npm run bundle                 # Worker bundle
npm run bundle:cli             # self-contained CLI bundle
npm run pack:cli               # artifacts/syndroo-cli-<version>.tgz
npm run e2e:cli-local          # packed CLI, isolated install, fake providers
npm run e2e:local              # retained remote path, Mock SNS
npm run verify:package         # Worker artifact, licences, isolated install
SYNDROO_RELEASE_SET=cli npm run release:train
npm run dco:check
git diff --check
```

`npm run check` regenerates `packages/cloudflare-worker/worker-configuration.d.ts`
from `wrangler.jsonc`. Review that diff; a binding change that does not appear
there is a bug, and an unrelated regeneration should be reverted rather than
smuggled into a feature change.

## Publishing the CLI candidate

1. Confirm the version in `packages/cli/package.json`, and that the release tag
   is `v<that version>`.
2. `npm run pack:cli` and inspect `artifacts/syndroo-cli-<version>.tgz`: it must
   contain no `workspace:*` reference and no unpublished runtime dependency.
3. Install that tarball outside the repository and run
   `syndroo version`, `syndroo skill path`, and `syndroo doctor --local`.
4. Run `SYNDROO_RELEASE_SET=cli npm run release:train` and keep its output.
5. Publish through the release workflow, never by hand from a dirty checkout.

The release workflow runs with `SYNDROO_RELEASE_SET=cli`, so it publishes
`@syndroo/cli` only. The SDK and Worker are validated, not published.

## Release tag, dist-tag, and what actually publishes

- The release tag is exactly `v<version>`, for example `v0.6.0-rc.1` for the
  version in `packages/cli/package.json`. The workflow reads the tag from the
  release event and refuses when the metadata version, the train version, and
  the tag do not agree.
- A CLI release candidate publishes under the `next` dist-tag. The workflow
  **refuses `latest`** for this candidate, so a stable `latest` publish is not
  available through it yet.
- `workflow_dispatch` runs the same gates but **validates only**: the publish
  step requires the `release: published` event, so a manual dispatch never
  publishes.
- The publish step runs only when the train reports the CLI release set, the
  metadata names `@syndroo/cli`, and the version is not already published.

The train step runs with registry checks enabled: it reports which packages are
missing and never publishes anything itself.

## What is not verified

- **Live-account acceptance**: no local publish has been run against real
  Bluesky or Threads accounts. The local providers are `fixture-tested`.
- **Linux execution**: local evidence so far is macOS arm64. CI covers Linux
  and the Node.js 22/24 matrix; this checkout does not.
- **Registry installation**: not verified; this task built and installed the
  local tarball only and performed no npm publish.
- **Worker deployment**: the deployment template is prepared but has not been
  rehearsed end to end against a real Cloudflare account.

`npm run e2e:live` is the **legacy remote** check only: it exercises `doctor`
and `posts ...` against a deployed instance from an approved plan file. It does
not validate local publishing.

## Migrations and compatibility

- Worker schema changes ship as new numbered migrations under
  `packages/cloudflare-worker/migrations`. Never rewrite an applied migration.
- Run local migrations before Worker tests when adding one, and apply pending
  migrations before deploying a Worker version that expects them.
- The local state format is versioned and refuses unknown newer versions. It is
  not migrated from the remote database, and remote data is not migrated into
  local state.
- The retained remote path keeps its HTTP contract: status codes, error shapes,
  `Idempotency-Key` behavior, and the Bearer-token rule.

## Third-party licences

The repository and the published Worker package use Apache-2.0. Preserve
`LICENSE`, `NOTICE`, and the bundled third-party notices in distributions;
`npm run verify:package` checks the packed artifact for them.

## Recovery from a partial publication

- Never overwrite a version that already reached the registry, and never publish
  different contents under a version number that was used before. The workflow
  refuses to publish a version it reports as already published.
- If that version is wrong, fix the problem and publish a new version (a `-rc.2`
  candidate, for example) and, where the registry allows it, deprecate the old
  one so operators stop installing it.
- If nothing was published yet, correct the checkout and rerun the workflow; the
  gates are safe to repeat.
- This candidate is not published by this task, and the registry's current state
  was not verified here.

## Contribution gate

Every commit needs a Developer Certificate of Origin sign-off
(`git commit --signoff`); `npm run dco:check` enforces it. See
[CONTRIBUTING.md](../CONTRIBUTING.md).
