# Releasing Syndroo

Architecture v1 is one coherent tree of eleven packages, all at `0.7.0-rc.1`.
This page states what a release would need and what has **not** happened. No
package has been published to npm, no Worker or server has been deployed, and the
registry's current state has not been verified from this checkout.

## Versions

| Package | Version | Role |
| --- | --- | --- |
| `@syndroo/provider-sdk` | `0.7.0-rc.1` | public: plugin contract and `defineProvider` |
| `@syndroo/core` | `0.7.0-rc.1` | **private**: inlined into the public bundles |
| `@syndroo/provider-{bluesky,threads,linkedin,mastodon,devto}` | `0.7.0-rc.1` | public: official providers |
| `@syndroo/sdk` | `0.7.0-rc.1` | public: HTTP client |
| `@syndroo/server` | `0.7.0-rc.1` | public: self-hosted Node server |
| `@syndroo/cli` | `0.7.0-rc.1` | public: `syndroo` command |
| `@syndroo/cloudflare` | `0.7.0-rc.1` | public artifact: Worker bundle |

The protocol generation is `protocolVersion: 1`. That is a protocol revision, not
an npm version, and no release number beyond `0.7.0-rc.1` has been decided.

`@syndroo/core` stays private. Three artifacts inline it and must keep it out of
their runtime `dependencies`:

| Artifact | Entry |
| --- | --- |
| `@syndroo/cli` | `dist/bin.js` |
| `@syndroo/server` | `dist/index.js` |
| `@syndroo/cloudflare` | `dist/worker.js` |

## Checks before a candidate

```bash
npm ci
npm run build                     # build all eleven packages in dependency order
npm run check                     # type-check plus bundle assertions
npm test                          # per-package test suites
npm run check:provider-catalog    # catalog matches the built providers
npm run check:pack                # npm pack --dry-run for each stage (not verified here)
git diff --check
```

The Developer Certificate of Origin check is a CI step over a commit range:
`SYNDROO_BASE_SHA=<sha> SYNDROO_HEAD_SHA=<sha> npm run dco:check`. Run it that
way for a pull request; there is no bare local form.

`npm run check` reports any bundle that has not been built as `PENDING`, never
`ok`. Build before you rely on the bundle rows.

`npm run check:pack` was not verified in the documentation pass that wrote this
page: it failed with ten `pack FAIL` rows there, and each stage's `prepack`
script builds that package, which was out of scope for a docs-only change.

## What a publish or deploy would require

A real release or deployment is a separate, explicitly authorized step. It would
need, beyond the checks above:

1. A decision on the version and dist-tag, and a release tag matching the
   manifest version.
2. A generated third-party licence inventory. `packages/cli/NOTICE` states that
   this inventory is not part of the current pre-release wiring and must be added
   before any release.
3. A deployment configuration for `@syndroo/cloudflare`. The Worker reads its
   bindings (`DB`, `WORK_QUEUE`, `QUEUE_NAME`, `DLQ_NAME`, `API_BEARER`,
   `SECRET_KEY`, `RUNTIME_KEY`, `SCOPE`, `PUBLIC_FETCH_STRICT`) at request time;
   the deployment must also set Wrangler's `global_fetch_strictly_public` flag.
   The root `wrangler.jsonc` now describes a v1 Worker: it points at the built
   `packages/cloudflare/dist/worker.js`, carries exactly those bindings, drops
   `nodejs_compat` (the bundle gate refuses every `node:` import) and declares no
   migrations directory. `npx wrangler deploy --dry-run` succeeds against it.
   It has never been deployed: the D1 database, the two queues and the three
   secrets still have to exist in the target account.
4. For the self-hosted server, the runtime options in
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

Neither workflow has been executed: no GitHub Actions run has happened for this
tree, so their green status is a local reading of the commands, not a CI result.

## What is not verified

- **Live-account acceptance**: no provider has been exercised against a real
  account. The five providers are fixture-tested against recorded API evidence.
- **Deployment**: no Worker or server has been deployed from this tree, and the
  Worker's first-run behaviour (storage is created by the first `connect`, so
  `status` fails until then) has not been exercised against a real account.
- **Registry installation**: nothing has been published, so installing from a
  registry is untested.
- **Platform matrix**: this checkout has run on Node.js 24.19.0 only.
- **LinkedIn version**: `LINKEDIN_VERSION` (`202601`) is a pinned package
  constant awaiting re-verification against LinkedIn's supported versions.
- **Threads**: publishing uses a single `auto_publish_text=true` call; the
  two-step container flow is deliberately not implemented.

## Contribution gate

Every commit needs a Developer Certificate of Origin sign-off
(`git commit --signoff`); `npm run dco:check` enforces it. See
[CONTRIBUTING.md](../CONTRIBUTING.md).
