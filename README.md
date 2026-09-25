# Syndroo

Publish plain text to Bluesky and Threads from your own machine, with no
server, queue, or database in the path. Nothing is sent until you preview a
frozen plan and then execute that same plan.

This is the `0.6.0-rc.1` CLI-first candidate. Build and install its local
tarball for validation; live-account acceptance has not been run for it.

## Quickstart

Requirements: Node.js 22 or newer and npm. Local state writes support macOS and
Linux; Windows local writes are refused rather than approximated.

```bash
# build and install the candidate from this repository
npm ci
npm run build          # workspace types must exist in dist before bundling
npm run pack:cli
npm install --global ./artifacts/syndroo-cli-0.6.0-rc.1.tgz
syndroo version

# create local config and state
syndroo init --namespace default
syndroo providers list
syndroo auth set bluesky --local --from-env
syndroo auth status --local
```

`auth set` reads one whole credential group from the environment:
`BLUESKY_IDENTIFIER`, `BLUESKY_PASSWORD`, and optional `BLUESKY_HOST` (which
must be `bsky.social`), or `THREADS_ACCESS_TOKEN`. A credential file works too
and must be a plain file only you can read (`chmod 600`). The CLI never reads
`.env`, never mixes sources, and stores a reference plus a stable account id,
never the secret.

Write one strict JSON document, preview it, then execute that same plan:

```json
{
  "schemaVersion": 1,
  "key": "release-announcement-001",
  "content": "Syndroo now publishes from the command line.",
  "platforms": ["bluesky"]
}
```

```bash
syndroo publish --input post.json --dry-run --json
syndroo publish --plan <plan-id> --yes --no-input --json
syndroo receipts show <operation-id> --json
```

The preview writes a signed plan and makes no platform request; it prints the
frozen text, the target accounts, the binding revisions, and the frozen
business timestamp. The execution needs both `--yes` and `--no-input` when no
human can answer a prompt, holds the local write lock, and sends at most one
content request per target. Exit `0` on a preview means the plan was written;
only a full success means everything was published.

Full command reference: [docs/cli-manual.md](docs/cli-manual.md). Agent
quickstart: [docs/agent-quickstart.md](docs/agent-quickstart.md). The bundled
Skill lives at `syndroo skill path`.

## What this candidate includes

- **Local publishing**: Bluesky and Threads, plain text, foreground execution.
  The providers are `fixture-tested`: their protocol paths run against
  controlled endpoints, not live accounts.
- **Frozen plans**: one preview freezes the text, the target binding, and the
  payload; the execution runs that plan and never re-reads the input file. A
  logical delivery may be attempted at most three times, across every plan.
- **Explicit retry**: preview the targets whose failure is provably
  `not_applied`, then execute that retry plan. An `unknown` outcome stops blind
  retries.
- **Local receipts**: `receipts list` and `receipts show` report what each
  target did, including `unknown`.
- **Retained remote path**: the Worker and SDK keep their existing behavior; see
  [Retained remote path](#retained-remote-path).

Not in this **local** candidate: scheduling, media, replies or threads, batch
and watch modes, RSS, local OAuth or token refresh, and any automatic fallback
to the remote path. The retained remote path still supports scheduling, its
installed platform set, and its own operational rules.

## Safety model

- **A preview is not a publish.** `publish --input ... --dry-run` writes a local
  plan; only `publish --plan` can send content.
- **One logical post keeps one identity.** `(namespace, key, provider,
  targetId)` identifies a delivery. A replay of a succeeded delivery reports the
  original result and sends nothing; the same key and target with different
  content is a conflict, not a second post.
- **Unknown is reported as unknown.** A timeout, a dropped connection, or a
  success response without a usable id may mean the platform accepted the post.
  Read the receipt instead of re-sending.
- **State permissions are not encryption.** Directories are `0700` and files are
  `0600`; plans and receipts still hold the post text and account identity.
- **The plan MAC is integrity, not authorization.** It binds a plan to this
  installation; it does not prove the user approved anything.
- **A lock with no readable owner stops the tool.** If a process dies between
  creating the write lock and writing its owner record, every writer and the
  recovery path refuse to proceed, because a dead half-acquisition cannot be
  told apart from one still in progress. Diagnose that state by hand with all
  writers stopped; never delete or reclaim a lock automatically.
- **Copies do not extend the guarantee.** Restoring a whole state directory,
  changing the namespace, or changing the key removes the local record that
  prevents a duplicate.

## Retained remote path

The pre-0.6 remote surface is unchanged and explicitly chosen: the Cloudflare
Worker (`0.2.0-rc.1`) serves an HTTP API with D1, Queue, and Cron, the SDK
(`0.4.0-rc.1`) is its HTTP client, and the CLI keeps `doctor` and `posts ...`.

- [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Syndroo/syndroo)
- Worker package: [packages/cloudflare-worker/README.md](packages/cloudflare-worker/README.md)
- HTTP client: [packages/sdk/README.md](packages/sdk/README.md)
- Source deployment, API essentials, and the legacy live check: [docs/remote-compatibility.md](docs/remote-compatibility.md)
- Agent guidance for the remote connect flow: [skills/syndroo-connect.md](skills/syndroo-connect.md)

Bluesky and Threads are the Worker's release gates; X, Tumblr, and LinkedIn
remain experimental there. The local path never falls back to this surface, and
the remote commands never read local state.

## Repository layout

```text
packages/core              Platform-neutral domain contracts (private)
packages/bluesky           Native text-only Bluesky publisher (private)
packages/threads           Native text-only Threads publisher (private)
packages/x                 Official X SDK text-only publisher (private)
packages/tumblr            Native HTTP NPF text publisher (private)
packages/linkedin          Native HTTP LinkedIn Posts publisher (private)
packages/sdk               Public HTTP client for one deployed instance
packages/cli               Public `syndroo` command and bundled Skill
packages/cloudflare-worker Public bundled Worker, D1, Queue, Cron, orchestration
scripts/                   Build, verification, release, and deployment entry points
```

`@syndroo/core` and the platform adapters stay private: they are bundled into
the CLI and Worker artifacts, so a published package must not reference them at
runtime.

## Verification and release

```bash
npm ci
export SYNDROO_RELEASE_SET=cli
npm test
npm run check
npm run e2e:cli-local          # packed CLI, isolated install, fake providers
npm run e2e:local              # retained remote path through Mock SNS
npm run verify:package
npm run release:train
```

`npm run e2e:live -- --plan <file>` is the **legacy remote** live check: it
exercises `doctor` and `posts ...` against a deployed instance. It does not
exercise local publishing; local live acceptance has not been executed for this
candidate.

[docs/testing.md](docs/testing.md) describes what each layer proves;
[docs/releasing.md](docs/releasing.md) covers the release sets, packaging, and
what remains unverified.

## Contributing and licence

Contributions require a Developer Certificate of Origin sign-off; see
[CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Domain vocabulary
is in [CONTEXT.md](CONTEXT.md).

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Grant Dai.
