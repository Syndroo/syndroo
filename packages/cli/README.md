# @syndroo/cli

The `syndroo` command publishes plain text and DEV.to articles to Bluesky, Threads, LinkedIn, Mastodon, and DEV.to from the
machine it runs on. This is the CLI-first `0.7.0-rc.1` candidate: a local path
with no server, no queue, and no database, plus the retained remote path for a
deployed Syndroo instance.

Local publishing takes one command:

```text
syndroo publish --input post.json --yes --no-input --json
```

An optional `--dry-run` validates and previews without state writes, credential
resolution, or network calls. Actual publishing parses once, confirms that
snapshot, then sends it and reports one result per target.

## Status

- Target version: `0.7.0-rc.1`. It is not published to npm yet.
- Local providers: Bluesky, Threads, LinkedIn, Mastodon (plain text), and DEV.to (articles); foreground execution.
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
npm install --global ./artifacts/syndroo-cli-0.7.0-rc.1.tgz
syndroo version
```

If someone hands you the tarball, skip the build and install that path
directly:

```bash
npm install --global /path/to/syndroo-cli-0.7.0-rc.1.tgz
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
`platforms` needs an active binding, even for a read-only preview.
The document below selects `bluesky` alone, so one binding is enough;
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

Save a strict JSON document as `post.json`:

```json
{
  "key": "release-announcement-001",
  "content": "Syndroo now publishes from the command line.",
  "platforms": ["bluesky"]
}
```

```bash
syndroo publish --input post.json --dry-run --json
syndroo publish --input post.json --yes --no-input --json
syndroo receipts show <operation-id> --json
```

The first command is optional. It prints the text, target accounts, binding
revisions, and business timestamp, without changing state. Publish reads the
current file, so edits between these commands change the next publish. Within
one invocation, it never re-reads the input after confirmation. Non-interactive
publishing requires both `--yes` and `--no-input`. Preview exit `0` means
validation succeeded, not publication.

Agents can skip temporary files and supply serialized JSON as one argument:

```bash
syndroo publish --data '{"key":"agent-post-001","content":"Hello from Syndroo","platforms":["bluesky"]}' --yes --no-input --json
```

Use exactly one of `--data <json>`, `--input <file>`, or `--input -` (stdin).
Omitted `schemaVersion` defaults to `1`; explicit unsupported values fail.
Inline content may appear in shell history and process arguments; use stdin
for sensitive text. Never put credentials in post JSON or interpolate generated
content into a shell command. Bare `syndroo`, `syndroo -h`, and `syndroo --help`
show help without reading config or contacting a provider.

## What the local path does not do

No scheduling, no media, no threads or replies, no batch or watch mode, no RSS,
no experimental platforms, no automatic token refresh, and no automatic
switch to the remote path. `scheduledAt` is a remote document field only.

## State and credentials

| What | Where |
| --- | --- |
| Config | `${XDG_CONFIG_HOME:-$HOME/.config}/syndroo/config.json` |
| State | `${XDG_STATE_HOME:-$HOME/.local/state}/syndroo` |

Both are created by `syndroo init`. Directories are `0700` and files are
`0600`; `--state-home <path>` overrides the location for one run. Permissions
limit access, they are not encryption: execution intents and receipts hold the post text
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
syndroo retry <operation-id> --to threads --yes --no-input --json
syndroo state inspect
syndroo state recover --confirm-no-writers --yes
```

The preview is optional and read-only. Only targets whose failure is provably `not_applied` are retryable, within
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
is guidance for local, confirmed, direct publishing; it grants no permission
and proves nothing about any particular agent client.

## More

- CLI manual: https://github.com/Syndroo/syndroo/blob/main/docs/cli-manual.md
- Agent quickstart: https://github.com/Syndroo/syndroo/blob/main/docs/agent-quickstart.md
