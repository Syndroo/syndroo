# @syndroo/cli

The `syndroo` command publishes plain text to Bluesky and Threads from the
machine it runs on. This is the CLI-first `0.6.0-rc.1` candidate: a local path
with no server, no queue, and no database, plus the retained remote path for a
deployed Syndroo instance.

Local publishing is two commands over one frozen plan:

```text
document.json --dry-run--> signed local plan --plan <id>--> provider calls + receipts
```

Nothing reaches a platform during the preview. The execution runs that same
frozen plan, never re-reads your input file, and reports one result per target.

## Status

- Target version: `0.6.0-rc.1`. It is not published to npm yet.
- Local providers: Bluesky and Threads, plain text, foreground execution.
- Provider maturity is `fixture-tested`: the protocol paths are covered by
  tests against controlled endpoints, and no live-account acceptance has been
  run for this candidate.
- The remote surface (`doctor`, `posts ...`) is unchanged and still speaks to a
  deployed instance.

## Install

The candidate is not on npm yet, so it is installed from the tarball this
repository builds. To build it yourself, run this from the repository root:

```bash
npm run pack:cli
npm install --global ./artifacts/syndroo-cli-0.6.0-rc.1.tgz
syndroo version
```

If someone hands you the tarball, skip the build and install that path
directly:

```bash
npm install --global /path/to/syndroo-cli-0.6.0-rc.1.tgz
```

`npm pack` inside `packages/cli` is not the release path: it packs a workspace
whose internal dependencies are not published, which is what `pack:cli` exists
to avoid.

Requires Node.js 22 or newer.

## Local quickstart

```bash
syndroo init --namespace default
syndroo providers list
syndroo auth set bluesky --local --from-env
syndroo auth set threads --local --from-env
syndroo auth status --local
```

`auth set` reads one whole credential group: `BLUESKY_IDENTIFIER`,
`BLUESKY_PASSWORD`, and optional `BLUESKY_HOST` (`bsky.social`), or
`THREADS_ACCESS_TOKEN`. It never reads `.env`, never mixes sources, and stores
a reference plus a stable account id, never the secret.

Bind only the providers you will actually publish to: every platform named in
`platforms` needs an active binding, or the preview is refused before it writes
anything. The document below selects `bluesky` alone, so one binding is enough;
add `"threads"` to `platforms` only when a Threads binding exists.

A credential file must be a plain file the current user owns, readable only by
that user. Create it yourself and tighten it before use:

```bash
chmod 600 ./threads-credentials.json
syndroo auth set threads --local --credential-file ./threads-credentials.json
```

The CLI refuses a file that is group- or world-readable, a symbolic link, or a
directory, and it reads the whole group once to take a snapshot. Fix the
permissions yourself; the CLI does not relax them for you.

Write a strict JSON document, then preview it:

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

The preview prints the frozen text, the target accounts, the binding
revisions, and the frozen business timestamp. The execution needs both `--yes`
and `--no-input` when no human can answer a prompt. Exit code `0` on a preview
means the plan was written; only a full success means everything published.

## What the local path does not do

No scheduling, no media, no threads or replies, no batch or watch mode, no RSS,
no experimental platforms, no local OAuth or token refresh, and no automatic
switch to the remote path. `scheduledAt` is a remote document field only.

## State and credentials

| What | Where |
| --- | --- |
| Config | `${XDG_CONFIG_HOME:-$HOME/.config}/syndroo/config.json` |
| State | `${XDG_STATE_HOME:-$HOME/.local/state}/syndroo` |

Both are created by `syndroo init`. Directories are `0700` and files are
`0600`; `--state-home <path>` overrides the location for one run. Permissions
limit access, they are not encryption: plans and receipts hold the post text
and the account identity.

One logical delivery is identified by `(namespace, key, provider, targetId)`.
Keep the key, the namespace, and the state directory when something goes wrong;
changing any of them to "start clean" publishes the same text under a new
identity. A preview whose target already succeeded reports `skip` and sends
nothing, and a same-key same-target change of content is marked `blocked`
rather than silently republished.

## Retry and recovery

```bash
syndroo retry <operation-id> --to threads --dry-run --json
syndroo retry --plan <plan-id> --yes --no-input --json
syndroo state inspect
syndroo state recover --confirm-no-writers --yes
```

Only targets whose failure is provably `not_applied` are retryable, within
three content attempts per logical delivery. An `unknown` outcome is never
retried blindly. `state recover` is maintenance for a machine whose writers
have stopped: it quarantines a stale lock, keeps evidence, and turns orphaned
in-flight intent into `unknown`.

## Remote surface (retained)

The pre-0.6 HTTP path is unchanged. It is selected explicitly and never as a
fallback from a local failure.

```bash
export SYNDROO_BASE_URL=https://syndroo.example.com
export SYNDROO_API_KEY=...
syndroo doctor
syndroo posts validate --file post.json
syndroo posts create --file post.json --idempotency-key release-001 --yes
syndroo posts get <post-id>
```

## The bundled skill

`syndroo skill path` prints the directory of the bundled Agent Skill. The skill
is guidance for a local, confirmed, two-phase publish; it grants no permission
and proves nothing about any particular agent client.

## More

- CLI manual: https://github.com/Syndroo/syndroo/blob/main/docs/cli-manual.md
- Agent quickstart: https://github.com/Syndroo/syndroo/blob/main/docs/agent-quickstart.md
