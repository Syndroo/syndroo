# Automated releases

Syndroo uses a single synchronized version for its eleven packages.

## Flow

1. Merge a Conventional Commit to `main`: `fix:` bumps the patch version; `feat:` bumps minor; `BREAKING CHANGE` or `!:` bumps minor while the major version is 0. Documentation and chore-only changes do not normally produce a release.
2. `.github/workflows/auto-release.yml` runs [Release Please](https://github.com/googleapis/release-please) on every `main` push and opens or refreshes a release PR with changelog, package versions, lockfile changes, and a DCO-signed release commit. When that run reports a release PR, the same job also checks the PR branch out, builds the provider contracts, regenerates the CLI catalog, runs a full build (whose Cloudflare stage writes the second catalog) and pushes a signed `chore(release): refresh provider catalogs` commit when the catalogs changed. The human reviews the PR, waits for the CI run triggered by that refresh commit (the final head), and lets it pass.
3. The human merges the release PR. The next `main` push makes Release Please create the Git tag and publish the GitHub Release.
4. The `release: published` event triggers the existing `.github/workflows/release.yml` workflow, which re-runs every gate and publishes the npm train with `npm publish` over npm Trusted Publishing (OIDC). No npm token is involved.
5. After a successful **stable** publish train, `release.yml` can dispatch the `syndroo-release` event to `Syndroo/syndroo-web`. That event is the website's release signal; the website repository owns its downstream checks and any push it makes to its own `main` branch. The dispatch happens only after the gates described under [Website release notification](#website-release-notification) pass.

A notification failure does not undo npm publication. The packages are already on the registry when the notification step runs, so the publish remains successful even if the workflow run turns red on the dispatch. A publish rerun is safe: the train skips packages already present and dispatches the same `tag`/`sha` payload again.

The chain has no shortcuts:

- `auto-release.yml` is triggered only by `push` to `main`; there is no other trigger.
- It never merges the release PR and never dispatches another workflow. The `publish` path is reached through the `release: published` event, not through an explicit dispatch from the automation.
- `release.yml` keeps its own `workflow_dispatch` entry point for a human (`mode: validate`, the default, or `mode: publish`). Nothing calls it automatically.

## First release and bootstrap

`git ls-remote origin v0.7.2` returns no tag, so the first run has no earlier
release to anchor on. With `release-please` 17.3.0 and no tag, a manifest run
falls back to the `.release-please-manifest.json` version but still scans the
whole commit history, which would fold older commits into the first release PR.
The top-level `bootstrap-sha` in `release-please-config.json`
(`4bb57531fea9089c8bb31e5456992e1b53924aed`, the current `release/v0.7.2`
HEAD) caps that scan: only commits after the baseline are considered for the
first release.
Once a tag such as `v0.8.0` exists, the normal latest-release path takes over
and `bootstrap-sha` no longer applies.

## Workflow permissions

`auto-release.yml` declares `permissions: contents: read` only. Every write it produces — branches, the release PR, the tag, the GitHub Release — is made with the `SYNDROO_RELEASE_TOKEN` secret, so the default `GITHUB_TOKEN` is reduced to a read scope rather than being granted `contents: write` and `pull-requests: write` it does not use.

`release.yml` keeps `contents: read` plus `id-token: write`. The OIDC token is what npm Trusted Publishing exchanges for a short-lived publish credential. The optional website dispatch uses a separate fine-grained token that is scoped to `Syndroo/syndroo-web` and added only to the notification step's environment, not to the job or any earlier step.

## Concurrency

Both workflows serialise with a constant group and `cancel-in-progress: false`, using separate groups so a release-please run and a publish train never block each other:

| Workflow | Group | Cancellation |
| --- | --- | --- |
| `auto-release.yml` | `auto-release` | a **running** job is never cancelled |
| `release.yml` | `release-train` | a **running** job is never cancelled |

Because the groups are fixed strings rather than ref-derived, concurrent `main` pushes and a manual `mode: publish` dispatch share one queue with a `release: published` run, so two publishes never interleave.

`cancel-in-progress: false` is narrower than "nothing is ever cancelled". GitHub only guarantees that the **running** job of a group is not cancelled. A run that is still **pending** (queued, not yet started) can be replaced or dropped when a newer run enters the same group: at most the most recent pending run is retained, and older pending runs are cancelled even with `cancel-in-progress: false`. A release-please run interrupted that way is harmless (the next `main` push or a re-run refreshes the same PR, and `always-update: true` keeps it idempotent).

A **dropped pending publication is not harmless**, because nothing retries it: the `release: published` event has already been consumed. Recovery is explicit — re-run the `Release` workflow after the drop, either with **Re-run jobs / Re-run all jobs** on the original run or with `workflow_dispatch` and `mode: publish`. Both are safe: the train reports what is already on the registry and publishes only the packages still missing, so a partially completed train resumes instead of conflicting on duplicates. Check the `release-train` group's run list and the npm registry after any burst of releases or manual dispatches before assuming a release published.

## Provider version constants and generated catalogs

The five official providers export their version from a literal in source:

```text
packages/provider-bluesky/src/index.ts   BLUESKY_PROVIDER_VERSION
packages/provider-devto/src/index.ts     DEVTO_PROVIDER_VERSION
packages/provider-linkedin/src/index.ts  LINKEDIN_PROVIDER_VERSION
packages/provider-mastodon/src/index.ts  MASTODON_PROVIDER_VERSION
packages/provider-threads/src/index.ts   THREADS_PROVIDER_VERSION
```

Each constant line carries Release Please's generic updater marker, so the version bump reaches the literals, not just `package.json`:

```ts
export const BLUESKY_PROVIDER_VERSION = "0.7.2"; // x-release-please-version
```

`release-please-config.json` lists all five files as `{"type": "generic", "path": ...}` extra-files. Without the marker on the line, the generic updater matches nothing and the constant silently falls behind the package version.

The catalogs in `packages/cli/src/runtime/providers/generated/catalog.ts` and `packages/cloudflare/src/providers/catalog.ts` embed those manifest versions, so a version bump that does not carry regenerated catalogs fails the gate. The catalog is checked twice, from two directions:

- `packages/cloudflare`'s own `build` script starts with `node scripts/generate-provider-catalog.ts --check` (run from the repository root), then `node src/build/generate.ts` writes `packages/cloudflare/src/providers/catalog.ts`.
- CI's final step, `git diff --exit-code` (`.github/workflows/ci.yml`), fails when any generated file in the tree is uncommitted — this is what actually catches a stale CLI catalog, because the Cloudflare build stage has already regenerated the Cloudflare catalog by then and the CLI catalog is regenerated by the same generator source.

**The root `npm run check` does not invoke `check:provider-catalog`.** That script is `npm run check:v1-tools && node scripts/check-v1.ts`; `check:provider-catalog` exists as a separate script for local use only. Do not describe `npm run check` as the catalog gate.

Because the Cloudflare check runs **inside** `npm run build`, a full build on a release branch with a stale CLI catalog fails before anything is written. `npm run build` alone therefore cannot repair the drift; the generator has to run first.

### Catalog refresh on the release PR

After Release Please runs, the same `auto-release` job:

1. resolves the release PR head branch from the action's `pr` output and refuses to continue unless it is exactly `release-please--branches--main--components--syndroo` (release-please's `BranchName.ofComponentTargetBranch("syndroo", "main")`);
2. checks that branch out in the same repository with the default read token and `persist-credentials: false`;
3. runs `npm ci` with no token in the environment;
4. builds only what the generator reads, in dependency order, before anything fails on drift:

   ```bash
   npm run build --workspace @syndroo/provider-sdk
   npm run build --workspace @syndroo/core
   npm run build --workspace @syndroo/provider-bluesky
   npm run build --workspace @syndroo/provider-threads
   npm run build --workspace @syndroo/provider-linkedin
   npm run build --workspace @syndroo/provider-mastodon
   npm run build --workspace @syndroo/provider-devto
   ```

5. runs `npm run generate:provider-catalog`, which writes `packages/cli/src/runtime/providers/generated/catalog.ts`;
6. runs the full `npm run build`, whose Cloudflare stage now passes its `--check` and writes `packages/cloudflare/src/providers/catalog.ts` through `packages/cloudflare/src/build/generate.ts`. No generator runs after the full build;
7. commits **only** the two catalog files, with `--signoff` and the `github-actions[bot]` identity;
8. pushes non-force to that same branch, authenticating through `gh auth setup-git` with `SYNDROO_RELEASE_TOKEN` in the push step alone.

The refresh commit is a normal commit on the PR branch, so it starts a fresh pull-request CI run. **The human must wait for that run (the PR's final head) before merging**; a green run from before the refresh does not cover the refreshed catalogs.

### Reruns are safe

`release-please-config.json` sets the top-level `"always-update": true`. Without it, release-please's `maybeUpdateExistingPullRequest` returns early when the release PR body is unchanged, the action reports no PR, and a rerun of this job would skip the catalog refresh entirely.

With it, any rerun of the `auto-release` job (a new `main` push, or Re-run jobs in the Actions UI) updates the existing release PR and then re-runs the refresh. The refresh itself is idempotent: it stages only the two catalog paths and exits without committing when `git diff --cached` is empty, so re-running on an already-refreshed PR pushes nothing and creates no empty commit.

### Known limits

- The refresh runs only when the release-please step reports a PR (`pr` output). A run that produced no release PR at all — for example one that only published a Release — does not refresh anything.
- The publish train reads the `release: published` event, so a catalog problem is caught on the release PR's CI, not by the publish workflow.
- The expected branch name is a hard-coded mirror of release-please's `BranchName` utility for this single-component repository. If the component name, target branch, or release-please's branch naming ever changes, the refresh fails closed with a branch-mismatch error instead of pushing somewhere wrong.

## One-time setup

Create a GitHub **fine-grained personal access token** (or equivalent dedicated bot token) scoped to `Syndroo/syndroo` with these repository permissions:

- **Contents: read and write** — create branches and tags, publish the GitHub Release.
- **Pull requests: read and write** — open and update the release PR.
- **Metadata: read** — implicit and always granted on fine-grained tokens; it needs no explicit selection.

Store it as the GitHub Actions repository secret `SYNDROO_RELEASE_TOKEN`. Ensure the repository's Actions settings allow workflows to create pull requests.

The token's owning account must be able to create PRs and releases on the repository, and its branch-protection bypass must match the repository policy — do not grant bypass just for the bot.

Set a short expiration (for example 90 days) and rotate on a calendar you actually keep. Rotation is: create the replacement token, update the `SYNDROO_RELEASE_TOKEN` secret, then delete the old token. A release window that fails with `Validate publishing token` or an authentication error in the release-please step is the usual symptom of an expired or revoked token.

### Personal access token vs GitHub App

A dedicated bot account holding a fine-grained PAT is the simplest option: one secret, no registration, no key handling. Its cost is a human-owned credential with a hard expiration that must be rotated, and it is tied to that account's repository access.

A GitHub App is the long-term option: it authenticates with a private key and mints short-lived installation tokens (about an hour), so a leaked token expires by itself and no personal account owns the automation. It costs an app registration, key storage, and a token-minting step in `auto-release.yml`.

The current automation deliberately keeps the PAT: the extra moving parts of an App are not justified yet. If the token rotation becomes the recurring failure, switch to an App rather than extending the PAT lifetime.

### npm Trusted Publisher

No npm access token exists in this repository. Each of the ten public packages — `@syndroo/provider-sdk`, `@syndroo/provider-bluesky`, `@syndroo/provider-threads`, `@syndroo/provider-linkedin`, `@syndroo/provider-mastodon`, `@syndroo/provider-devto`, `@syndroo/sdk`, `@syndroo/cli`, `@syndroo/server`, `@syndroo/cloudflare` — must have a Trusted Publisher configured on npmjs.com that matches exactly:

- Owner: `Syndroo`
- Repository: `syndroo`
- Workflow filename: `release.yml`

A mismatch (case, repository name, or a workflow path like `.github/workflows/release.yml`) makes `npm publish` fail with a provenance/authentication error even though the OIDC token is valid. `@syndroo/core` stays private and is bundled, so it has no Trusted Publisher.

### Automatic publication

Publishing is automatic on a non-draft GitHub Release. The `release: published` event triggers `release.yml`, which validates the ten-package train and publishes every package the registry still lacks. This branch has no publish opt-in variable: creating and publishing the GitHub Release **is** the publish action.

A manual `workflow_dispatch` with `mode: publish` publishes for that run after the same gates, and `mode: validate` (the default) publishes nothing. A fork or deployment copy that must not publish should not publish a Release through this workflow.

## Website release notification

After the npm train succeeds, `release.yml` can tell the website repository that a stable release exists. The notification is a GitHub `repository_dispatch` to the fixed endpoint `https://api.github.com/repos/Syndroo/syndroo-web/dispatches` with:

```json
{
  "event_type": "syndroo-release",
  "client_payload": { "tag": "v0.8.0", "sha": "<checked-out 40-character HEAD>" }
}
```

The `tag` is the train version prefixed with `v`; the `sha` is read from the commit actually checked out by the workflow, not from an interpolated shell value. `scripts/notify-website-release.ts` performs the request without a shell, validates the stable `major.minor.patch` version and the full lowercase 40-character SHA, accepts only HTTP `204`, and never retries the POST. It does not log the response body. The request carries a 20-second abort signal and uses `redirect: "error"`, so a hanging request is bounded and a redirect cannot turn the POST into a second, unintended destination.

The step is **off by default** and requires all of these gates:

- the repository variable `SYNDROO_SYNC_WEBSITE` holds the exact string `true`;
- the `Publish the train` step (now `id: publish`) finished with `outcome == 'success'`;
- the train's `dist_tag` is `latest`, which excludes prereleases.

So a validate-only run, a failed publish, or a prerelease dispatches no notification. An idempotent publish rerun does dispatch: the publish step still succeeds when every package is already present, and the event repeats the same `tag` and `sha`, which downstream consumers can treat as one release signal.

This repository's dispatch only starts the website-side workflow. Any automatic push to the website repository's `main` branch happens there, after the website's own checks pass; it is not performed by `release.yml`.

### One-time setup for the website dispatch

Create a GitHub **fine-grained personal access token** whose owner is `Syndroo` and whose only repository permission is **Contents: write** on `Syndroo/syndroo-web`. Store it as the `Syndroo/syndroo` repository secret `SYNDROO_WEB_DISPATCH_TOKEN`. Do not grant it access to `Syndroo/syndroo` or any other repository, and do not add it to the job-level environment.

Set the repository variable `SYNDROO_SYNC_WEBSITE` to the exact string `true` only when the website side is ready. Leaving it unset or any other value keeps the step skipped, so existing releases behave as before. When the variable is `true` and the secret is missing, the notification step fails with a clear `SYNDROO_WEB_DISPATCH_TOKEN is required` error after the publish has finished; when the variable is not exactly `true`, the token is never required.

## DCO

The DCO checker is unchanged: `.github/workflows/ci.yml` runs `npm run dco:check` on every pull request with `SYNDROO_BASE_SHA` and `SYNDROO_HEAD_SHA`, and **every commit in the PR must carry a `Signed-off-by` trailer**. The release PR is a pull request like any other; it has no exemption.

The release PR is normally merged with a squash. A squash produces a single new commit, so the retention rules matter:

- Keep the sign-off trailer in the squashed commit message (GitHub's squash message editor preserves it; do not strip it).
- Keep the release PR's conventional title and body — the title Release Please generates is `chore(main): release <version>`, and that title plus body become the squashed commit subject and the changelog source for the next release.

Editing the squashed message to remove either the `Signed-off-by` trailer or that `chore(main): release <version>` title breaks the gate for the following PR or the next version bump. The catalog refresh commit is signed off for the same reason: it lives on the release PR branch and is reviewed and squashed with the rest of the PR.

## Troubleshooting

- **No release PR:** check Conventional Commit messages, workflow permissions, `SYNDROO_RELEASE_TOKEN` expiration, and the release-please step log. The `Validate publishing token` step fails loudly when the secret is missing.
- **Release PR check did not run:** see the event-chaining note below.
- **Release PR fails `npm ci` or the catalog drift check:** inspect all workspace versions, `package-lock.json` and the two generated catalogs. The version train must remain synchronized, and the release PR must carry a refreshed catalog. Re-run the `auto-release` job first: with `always-update: true` it re-runs the refresh, and pushes nothing when the catalogs already match. Never hand-edit a catalog; CI compares it byte for byte against the generator output.
- **Release PR CI ran before the refresh commit:** expected. The refresh commit starts another run; merge only on the final head.
- **GitHub Release appears but npm is not published:** check the `release: published` run of `release.yml` and the Trusted Publisher owner/repository/workflow triplet. A manual dispatch with `mode: validate` is the diagnostic path; `mode: publish` performs the publish.
- **Two publishes queued:** expected. The `release-train` concurrency group serialises them and the second run resumes only the packages the train still reports as missing. The second dispatch can, however, cause GitHub to drop an older *pending* run in the same group; if no publish run exists for a release that should have published, re-run the `Release` workflow (`mode: publish`) as described under Concurrency.
- **Manually created GitHub Release:** the existing `release.yml` workflow still runs. Do not create a tag/release for a version that has already been published.

## Event chaining

The external token is required because work performed with the default `GITHUB_TOKEN` does not start further workflow runs. The current GitHub behaviour is more nuanced than "nothing triggers":

- A pull request **opened, synchronised, or reopened** by `GITHUB_TOKEN` starts a run that sits in **approval-required** state, so release PR CI is neither silently skipped nor run unattended.
- A **GitHub Release published** with `GITHUB_TOKEN` still does not chain: no `release: published` run of `release.yml` is started.

Using the PAT (or an App installation token) avoids both problems: PR CI starts without manual approval and the published release triggers the npm workflow automatically.

Reference: [Trigger a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

## Integration status

This automation was first written in a separate worktree based on commit `37005fec1f5584469072d7ceab1e739dd19fb854` (`37005fe`, the `v0.7.2` prepare commit). That source snapshot is preserved untouched in its original worktree outside this checkout; it is no longer the integration target.

The automation configs, scripts and docs were transplanted onto the current `release/v0.7.2` branch at commit `4bb57531fea9089c8bb31e5456992e1b53924aed`. `bootstrap-sha` anchors the first release at that commit, and the destination's existing product and Server sources were not modified: only the automation files, the provider version-marker comments and the regenerated catalogs changed. `npm run check:scripts` and `npm run test:scripts` run on this integrated checkout. Nothing here has been committed, tagged, pushed or published.

Before enabling `SYNDROO_SYNC_WEBSITE` or relying on this automation, re-run `npm run check:scripts` and `npm run test:scripts` on the final branch head.

## Verification status

Everything above is **design-level and live-unverified**. No release has been run through this automation: the workflows, token scopes, the automatic `release: published` → publish path, the Trusted Publisher entries, event propagation and OIDC publishing are documented intent, not observed behaviour. Event propagation (`release: published` → `release.yml`, refresh commit → PR CI) and the npm OIDC exchange behind Trusted Publishing have **not** been confirmed live; do not describe either as working.

The website dispatch is also **design-level and live-unverified**: no `repository_dispatch` has been sent to `Syndroo/syndroo-web`, and the website-side workflow, its checks and any push to its `main` branch are outside this repository. The local suite only proves the request shape, the version/SHA validation, the HTTP failure handling, the missing-token failure, and the workflow gate strings.

### Local validation (verified locally, not a live release)

`npm run test:scripts` runs `scripts/release-automation.spec.ts`, which exercises the real Release Please machinery from the installed dependency — `release-please` **17.3.0** — against `release-please-config.json`, `.release-please-manifest.json`, the node strategy and the real updaters, with an in-memory GitHub/SCM stub. It asserts that a `fix:` yields 0.7.3 and a `feat:`, `feat!:`, or `BREAKING CHANGE` footer yields 0.8.0 across all eleven workspaces, all 67 configured extra-files, the lockfile mirrors and the five `x-release-please-version` provider constants, that docs/chore/test/refactor releases nothing, that the release tag is `v0.8.0`, and that the release-please sign-off passes `dco:check`. It also proves the fixture does not mutate the checked-out versions, and covers
the no-tag first release: with `bootstrap-sha` in place a newer `fix:` releases
0.7.3 while an older `feat:` before the baseline is excluded, and a no-tag
docs-only change after the baseline releases nothing. A separate test counts
`updatePullRequest` calls to prove `always-update` refreshes an unchanged
release PR (and that disabling it skips the update).

The generated 0.8.0 release can be materialised into a **disposable copy** of the repository outside the worktree:

```bash
SYNDROO_RELEASE_FIXTURE_DIR=/tmp/syndroo-release-fixture npm run test:scripts
```

`scripts/notify-website-release.spec.ts` covers the website dispatch without network access: malformed versions and SHAs, the exact destination/body/headers, the request's abort signal and `redirect: "error"`, non-`204` responses with no retry and no response-body logging, a timed-out POST with a generic non-secret error, the missing-token failure, HEAD resolution without exposing the token to the `git` child process, and the `release.yml` gate strings. It runs from source through Node's type stripping and is also wired into `npm run test:scripts` as `.build/scripts/notify-website-release.spec.js`.

```bash
node --test scripts/notify-website-release.spec.ts
# or as part of the compiled script suite:
npm run test:scripts
```

The target directory must already exist and, after symlinks are resolved, must
not be the checkout or inside it; the test writes the release-please change set there and re-asserts the full bump on the written files. That is the closest local substitute for a release PR; it validates configuration and updaters, not GitHub event propagation, token scopes or npm publishing.

Remaining unverified:

- that Release Please accepts the pinned action, the config/manifest pair and the five `x-release-please-version` markers in a real GitHub run (locally it does, per `npm run test:scripts`);
- that the catalog refresh resolves the branch, regenerates, signs off, and pushes to the release PR branch without force;
- that the refresh commit triggers the expected pull-request CI run;
- that the PAT scopes listed above are sufficient for branch, PR, tag, and Release creation;
- that PR CI starts unattended (rather than in approval-required state) with the PAT;
- that `release: published` chains into `release.yml` (**event propagation unverified**);
- that all ten Trusted Publisher entries match and `npm publish` succeeds over OIDC (**OIDC exchange unverified**);
- that the `SYNDROO_WEB_DISPATCH_TOKEN` fine-grained scope is accepted by `Syndroo/syndroo-web` and that its workflow treats the repeated `tag`/`sha` dispatch safely (**website dispatch unverified**);
- that the integrated automation behaves in a real GitHub run as the local fixture suite does (**live automation unverified**).

Validate each one on the first real release before describing any of them as working. The local fixture suite above does not reduce this list.
