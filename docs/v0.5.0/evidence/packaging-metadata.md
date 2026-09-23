# Packaging metadata, build order and lockfile consistency

Task T9b. Aligns the release metadata for the v0.5.0 candidate: the root build
and test order now includes the new application and transport packages, the three public packages
declare one train version, both private workspace packages are declared where
they are consumed, and `package-lock.json` was refreshed so it agrees with those
manifests without moving a single third-party version.

Four package manifests, the lockfile and this evidence file changed. No source, test, workflow,
script or documentation file outside that list was edited.

## What changed

`package.json` (root)

- `build` (line 76) and `test` (line 83) now run `@syndroo/transport` and
  `@syndroo/application` immediately after `@syndroo/core`, and before the
  platform adapters. Before this change neither package appeared in either
  order even though both are real workspace packages with their own build and
  test scripts.
- The resulting order is a valid topological order of the workspace dependency
  graph, and no package appears twice:
  `core -> transport -> application -> bluesky -> threads -> linkedin -> tumblr
  -> x -> sdk -> cli`, with `cloudflare-worker` tested between `x` and `sdk`,
  exactly as before.
- Dependency facts the order was derived from: `@syndroo/application` depends on
  `@syndroo/core` (`packages/application/package.json:17`); `@syndroo/transport`
  declares no workspace dependency; the five platform adapters depend on
  `@syndroo/core` and `@syndroo/transport`; `@syndroo/cli` depends on
  `@syndroo/sdk` (`packages/cli/package.json:42`); the Worker consumes
  `@syndroo/application` and `@syndroo/transport` as development dependencies
  only.

`packages/sdk/package.json`, `packages/cli/package.json`,
`packages/cloudflare-worker/package.json`

- Version moved from `0.4.0-rc.1`/`0.4.0-rc.1`/`0.2.0-rc.1` to a single train
  version `0.5.0-rc.1` (line 3 in each file).
- `packages/cli/package.json:42` declares `"@syndroo/sdk": "0.5.0-rc.1"`, an
  exact version rather than a range, so a published CLI cannot install a
  different SDK than the one in this train.
- `packages/cloudflare-worker/package.json` declares
  `"@syndroo/application": "0.1.0"` (line 64) and
  `"@syndroo/transport": "0.1.0"` (line 71) in `devDependencies`.
  `@syndroo/application` is imported by Worker source and tests but was missing
  from the Worker manifest entirely; `@syndroo/transport` is imported by
  `src/composition/oauth-drivers.ts` and by the OAuth driver tests. Both stay
  development dependencies because the release train refuses a public package
  that depends on a private workspace package at runtime.
- The Worker `test`, `test:worker:main`, `test:worker:canary` and
  `test:worker:watchdog` scripts (lines 51-54) are unchanged from the accepted
  T9a work; the only edits in that file are the version line and the two
  `devDependencies` entries.

Private versions deliberately stay at `0.1.0`: the root manifest, plus
`packages/application/package.json:3` and `packages/transport/package.json:3`.

## Lockfile refresh

```
npm install --package-lock-only --ignore-scripts --no-audit --no-fund --offline
```

- `package-lock.json` sha256 before: `bd1af79b471e79b35d6c1a1c84ec8cb9fec62f0336218ad9ed9ccb4f6ebeb3bf`
  (identical to the root snapshot `/tmp/root-v050-pre-metadata-lock.json`).
- sha256 after: `5d44d79075cd4db43cbb927a30b6360b7e063feb89f3a34649533ed76b42c1d5`.
- The command was run twice with the default npm configuration, then twice more
  with a cleaned configuration (`NPM_CONFIG_USERCONFIG=/dev/null` alone, and
  the user and global variables pointed at two distinct empty files). Every
  completed run reported `up to date` with exit `0`, and the file hash did not
  move after the first refresh. The lock is converged with the manifests.

All third-party records were compared field by field against
`/tmp/root-v050-pre-metadata-lock.json`. The comparison walks every
`packages["..."]` entry, excluding the root `""` record, the 13 workspace
records (`packages/*`, `experiments/*`) and the 13 `node_modules/@syndroo/*`
link entries:

| measure | before | after |
| --- | --- | --- |
| third-party records | 319 | 319 |
| added records | — | none |
| removed records | — | none |
| records with a changed value | — | none |

With the root `""` record included the count is 320 on both sides. The
independent root comparison reported 319, which is this same set counted
without that one record; both numbers describe the same unchanged file.

The entire lockfile diff is workspace metadata: two new links and workspace
records for `packages/application` and `packages/transport`, the three moved
public versions, the CLI's SDK dependency
edge, and the `@syndroo/transport` edges already declared by the adapter
manifests but not yet reflected in the lock. `git diff --numstat` reports 34
insertions and 8 deletions for the file. No third-party version, integrity
hash, resolution, license or engine field changed, and the refresh was executed in offline, lockfile-only mode.

## Verification

All runs used Node `v24.19.0` and npm `11.19.0`
(`/Users/daiyanze/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`
first on `PATH`), from the worktree root
`/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050`.

1. Manifest and order invariants (scripted assertions over the five manifests):
   15/15 checks pass. Versions, `private` flags, the CLI's exact SDK dependency,
   the Worker's runtime and development dependency sets, and the absence of
   ordering violations and duplicates in both root aggregations were all
   asserted, not eyeballed.

2. `npm ls --workspaces --depth=0` — exit `0`. Every workspace resolves,
   including `@syndroo/sdk@0.5.0-rc.1 -> ./packages/sdk`, and every adapter
   dedupes to the single `./packages/transport`.

3. `npm run build` — exit `0`. All ten workspaces built in the new order, and
   the SDK and CLI report `0.5.0-rc.1`.

4. `npm run check:scripts` — exit `0`. `npm run build:scripts` — exit `0`.

5. `node --test --test-concurrency=1 .build/scripts/check-release.spec.js
   .build/scripts/release-train.spec.js` — exit `0`, 10 suites, 92 tests
   passed, 0 failed, 2538 ms. Both suites replace global fetch with a
   fixture registry, so no registry request left the machine.

6. `node .build/scripts/release-train.js` with the registry check disabled —
   exit `0`, `ok: true`, `stage: "rc"`, `version: "0.5.0-rc.1"`,
   `distTag: "next"`, all three packages `publish`, `failures: []`. This runs
   against the real manifests on disk, so the train's own rules (one shared
   version, no `workspace:` protocol, no private runtime dependency, required
   `files`, `bin`, `engines`, `publishConfig` and repository fields, exact CLI
   SDK pin) were all enforced against the edited files.

7. Same script with `SYNDROO_CHECK_REGISTRY=true` and an offline stand-in for
   `registry.npmjs.org` that answers every lookup with HTTP 404 — exit `0`,
   `registryChecked: true`, exactly 3 lookups (sdk, cli, cloudflare-worker),
   all three reported `publish`, `failures: []`.

8. `node .build/scripts/check-release.js` with the registry check disabled —
   exit `0`, `{"package":"@syndroo/cloudflare-worker","version":"0.5.0-rc.1",
   "distTag":"next","releaseTag":null,"published":false}`. With the same
   404 stand-in and the registry check enabled — exit `0`, one lookup,
   `published: false`.

9. Guards that must fail still fail, and the correct request still passes:

| run | exit |
| --- | --- |
| release-train, `SYNDROO_RELEASE_TAG=v0.5.0-rc.1`, prerelease `true` | 0 |
| release-train, same tag, prerelease `false` | 1 |
| release-train, `--dist-tag latest` | 1 |
| release-train, `--dist-tag next` | 0 |
| check-release, `SYNDROO_RELEASE_TAG=v0.5.0-rc.1`, prerelease `true` | 0 |
| check-release, `SYNDROO_RELEASE_TAG=v0.4.0-rc.1` | 1 |

10. The two workspaces newly added to the root test order were executed on this
    tree: `npm run test --workspace @syndroo/transport` — exit `0`, 3 files,
    76 tests. `npm run test --workspace @syndroo/application` — exit `0`,
    23 files, 313 tests.

11. Clean npm configuration behaves as intended on this tree. Setting *both*
    `NPM_CONFIG_USERCONFIG=/dev/null` and `NPM_CONFIG_GLOBALCONFIG=/dev/null`
    fails on npm 11.19.0 with `Exit prior to config file resolving` /
    `double-loading config "/dev/null" as "global"`. Setting only the user
    variable, or pointing the two variables at two distinct empty files, exits
    `0` and leaves the lock at the hash recorded above.

## Out of scope, reported rather than fixed

- `README.md` still describes the `0.2.0-rc.1` candidate (lines 7, 23, 27)
  and the `0.4.0-rc.1` SDK/CLI pair (lines 612-613, 663).
- `docs/releasing.md:41` and `docs/releasing.md:44-45` still describe the Worker
  at `0.2.0-rc.1` against a `0.4.0-rc.1` train, and the checklist at
  `docs/releasing.md:180` still names the old version. `CHANGELOG.md:6` heads
  the changelog with `0.2.0-rc.1`.
- `scripts/release-train.ts:3` still describes itself as validating `v0.4.0`.
  This is a comment, and the behaviour it describes is version agnostic.
- `scripts/release-train.spec.ts:144` and `:322` use `0.4.0-rc.1` as fixture
  data for disposable manifests created under the system temporary directory.
  No assertion in that suite reads the repository's real versions, so the
  version move cannot make it pass or fail by accident.
- Documentation and release notes for the v0.5.0 candidate belong to the
  documentation slice, not to this metadata change.

## Limitations

- No live registry was contacted. Every registry-dependent path was exercised
  through the repository's own fixture suite or an offline 404 stand-in. This
  evidence says nothing about whether `0.5.0-rc.1` is publishable to the real
  registry, whether the package names are available, or how dist-tags there
  currently resolve.
- Nothing was published, tagged, deployed or migrated. No Wrangler operation,
  account operation or explicit credential inspection was performed. Initial
  npm refreshes used default npm configuration; later refreshes used explicit
  empty configuration files. This record does not independently establish
  whether npm implicitly read user configuration during the initial refreshes.
- The aggregate `npm test` and `npm run check` were not run: the root `check`
  invokes the Worker `types` script, which loads Wrangler credentials. The
  Worker suites themselves are the T9a owner's evidence, and the root agent
  runs the final aggregate.
- `npm run verify:package` and the `npm run build:package` integration case in
  `scripts/bundle-worker.spec.ts` were not run here; both bundle the Worker with
  Wrangler. The remaining four script spec files in the root `test:scripts`
  aggregation were likewise not re-run by this task.
- Node 22 is unverified; only Node 24.19.0 with npm 11.19.0 was exercised.
- This slice was executed by the delegated child task; the root agent selected
  and recorded the route. Model identity cannot be self-verified from inside
  the task, so the routing claim rests on the root's spawn record.

## Root acceptance

Root accepted this metadata/build-order scope after attempt1. Independent
Node24 checks: manifest/order assertions (`f3b728`), all319 external lock
records unchanged (`a47457`), offline workspace resolution (`64f996`), root
build of ten packages (`7e8ca0`, session35475), scripts build/typecheck
(`3b1bfe`), and92 release fixture tests (`efd40c`, session54019) all passed.
Current real manifests passed the release-train checker with registry access
disabled (`a28d4e`):0.5.0-rc.1/next. Root npm commands used two distinct empty
user/global configuration files.

This does not accept Worker bundling, installed artifacts, deployment or release.
The subsequent root Worker aggregate failed with exit124 because the main
project hung after a teardown exception; the other8 projects passed191 tests.
Worker-wide test typing still has4 known errors. See root-review.md for the
current integration result.
