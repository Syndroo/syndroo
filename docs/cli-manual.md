# Syndroo CLI manual

This manual covers the `syndroo` command in the CLI-first `0.6.0-rc.1`
candidate: local publishing to Bluesky and Threads, plus the retained remote
path for a deployed Syndroo instance.

The candidate is not published to npm and has no live-account acceptance. The
local providers are `fixture-tested`: their protocol paths are exercised
against controlled endpoints, not against real accounts.

## Install

The candidate is not on npm yet, so it is installed from the tarball this
repository builds. From the repository root:

```bash
npm run pack:cli
npm install --global ./artifacts/syndroo-cli-0.6.0-rc.1.tgz
syndroo version
```

Install a tarball someone handed you directly:

```bash
npm install --global /path/to/syndroo-cli-0.6.0-rc.1.tgz
```

`npm pack` inside `packages/cli` is not the release path; `pack:cli` produces
the self-contained artifact that references no unpublished workspace package.

Node.js 22 or newer is required. The packaged CLI is self-contained; you do not
need to publish or install the internal workspace packages first.

## What the local path does

Plain text to Bluesky and Threads, in the foreground, from this machine. One
logical post becomes one frozen plan, and that plan is executed explicitly.

Out of scope for this version: scheduling, media, replies or threads, batch and
watch modes, RSS, platforms other than Bluesky and Threads, local OAuth or
token refresh, and any automatic fallback to the remote path.

## Set up local state

```bash
syndroo init --namespace default
syndroo doctor --local
syndroo providers list
```

| What | Where |
| --- | --- |
| Config | `${XDG_CONFIG_HOME:-$HOME/.config}/syndroo/config.json` (`schemaVersion`, `namespace`) |
| State | `${XDG_STATE_HOME:-$HOME/.local/state}/syndroo` |

`--state-home <path>` overrides the state location for one run, and
`--namespace <name>` overrides the namespace. The namespace is a
deduplication domain, not a permission boundary: changing it creates an
independent identity for the same text, which is why it is not a repair.

The state holds `installation.json`, `integrity.key`, `connections/`, `plans/`,
`operations/`, `deliveries/`, a write lock, a recovery guard, and quarantine
evidence. Directories are `0700` and files are `0600`. Those permissions limit
access; they are not encryption, and plans and receipts contain the post text
and the account identity.

## Register an account

```bash
syndroo auth set bluesky --local --from-env
syndroo auth set threads --local --credential-file ./threads-credentials.json
syndroo auth status --local
syndroo auth status bluesky --local --verify
syndroo auth remove bluesky --local
```

`--from-env` reads one whole group: `BLUESKY_IDENTIFIER`, `BLUESKY_PASSWORD`,
and optional `BLUESKY_HOST` (which must be `bsky.social`), or
`THREADS_ACCESS_TOKEN`. A credential file is strict JSON:

```json
{
  "schemaVersion": 1,
  "provider": "threads",
  "credentials": { "accessToken": "USER_SUPPLIED_TOKEN_PLACEHOLDER" }
}
```

Exactly one source is used, the whole group is read once to take a snapshot,
and the CLI never reads `.env`, never mixes sources, and never falls back to
another source. The state stores a reference, a stable account id, a revision,
and an installation-keyed group fingerprint; it stores no platform secret.
Output never contains a value, a source path, or a fingerprint.

A credential file must be a plain file the current user owns that nobody else
can read. Create it yourself and tighten it before the first use:

```bash
chmod 600 ./threads-credentials.json
syndroo auth set threads --local --credential-file ./threads-credentials.json
```

The CLI refuses a group- or world-readable file, a symbolic link, and a
directory, and it never changes permissions for you. The same check applies
every time the source is re-read for an execution.

`auth set` verifies the account with the provider before registering it. A
non-interactive run needs the stable account id the operator already checked:

```bash
syndroo auth set bluesky --local --from-env --expect-account <stable-id> --yes --no-input
```

`auth remove` writes a tombstone. It does not delete your credential file and
does not revoke anything at the platform.

## Write the document

```json
{
  "schemaVersion": 1,
  "key": "release-announcement-001",
  "content": "Syndroo now publishes from the command line.",
  "platforms": ["bluesky", "threads"],
  "overrides": { "bluesky": { "content": "Shorter version for Bluesky." } }
}
```

`key` is the stable logical identity (1-128 characters from `A-Z a-z 0-9 . _ :
-`). `content` is non-blank and at most 10000 Unicode code points. `platforms`
must be non-empty, must not repeat, and may only name `bluesky` or `threads`.
`overrides` may only name a selected platform.

The file is strict JSON: comments, trailing commas, repeated keys, invalid
UTF-8, and unpaired surrogates are refused, and one leading byte-order mark is
tolerated. The source limit is 64 KiB before decoding. `--input -` reads stdin.
There is no text shortcut; a post always starts from this document. The
provider's own limit still applies after this validation.

## Preview, then execute

```bash
syndroo publish --input post.json --dry-run --json
syndroo publish --plan <plan-id> --yes --no-input --json
```

The preview writes a signed plan and makes no platform request. Read it before
executing: it shows the frozen text, the target account, the binding revision,
and the frozen business timestamp. The plan lives 24 hours from creation, and
execution never re-reads the document, so editing the file afterwards cannot
change what was frozen.

The execution holds the local write lock, re-checks that the account binding is
still current, and sends at most one content request per target. Replaying an
operation that already succeeded reports the original result and sends
nothing.

When a human can answer a prompt, the CLI asks before sending. When none can,
the run needs both `--yes` and `--no-input`; a missing confirmation is exit `2`
with zero content requests, and a decline is exit `5`.

## Read the result

```bash
syndroo receipts list --limit 20
syndroo receipts show <operation-id> --json
```

Each target reports `status` (`succeeded`, `failed`, `unknown`, `in_flight`,
`not_started`), `reused`, `attempts`, `remoteId`, `url`,
`writeDisposition`, and a `retry` verdict. The aggregate `status` is
`succeeded`, `partial`, `failed`, `unknown`, or `blocked`, and `durability` is
`committed` or `failed`.

`unknown` means the write may have reached the platform. Report it as unknown
and stop. A `null` url means no verified link is known, so do not build one.

## Retry

```bash
syndroo retry <operation-id> --to threads --dry-run --json
syndroo retry --plan <plan-id> --yes --no-input --json
```

Retry is explicit and two-phase, exactly like publish. Only targets whose
failure is provably `not_applied` are eligible, and only within three content
attempts per logical delivery. A selection that includes an `unknown` target
blocks the whole retry; narrow it to other safe targets instead. A succeeded
target is never republished.

If credentials were rotated, the retry preview shows the old and the new
binding, and the same stable account must be re-verified before the plan is
accepted.

## State inspection and recovery

```bash
syndroo state inspect
syndroo state recover --confirm-no-writers --yes
```

`state inspect` is read-only: it reports the lock, schema versions, and any
defects it can see. `state recover` is maintenance for a machine where every
other writer has stopped. It takes an exclusive recovery guard, quarantines a
stale lock with its evidence, and turns orphaned in-flight intent into
`unknown`. It never sends content, never rewrites a committed outcome, and
never steals a lock that a live process may hold.

One failure mode deliberately stops and asks a human. If a process dies
immediately after creating the write lock but before its owner record is
durable, the state is left holding a lock with no readable owner. Every writer
and the recovery path refuse to proceed: the tool cannot tell a dead
half-acquisition from one that is still in progress, so it will not reclaim the
lock on its own. Diagnose that state by hand, with every Syndroo process
stopped, and keep the lock file as evidence. Nothing in this manual or the CLI
deletes, reclaims, or force-removes a lock automatically, and you should not
either without first proving that no writer is alive.

Deleting the state, changing the namespace, or restoring an old backup does not
prove that nothing was published. It removes the local record that prevents a
duplicate.

## Exit codes and JSON

| Code | Meaning |
| --- | --- |
| `0` | The command finished: a plan was written, a query read successfully, or a run fully succeeded |
| `1` | Local I/O or runtime failure, or a trusted success that could not be persisted |
| `2` | Admission failure: usage, config, document, confirmation, or binding. No content request |
| `3` | A remote `posts wait` reached its deadline |
| `4` | An unknown write result |
| `5` | The operator declined before any content request |
| `6` | The run ended without full delivery |
| `130` | The process stopped on a signal |

With `--json`, stdout carries exactly one envelope:
`{schemaVersion, command, mode, ok, result, error}`. Diagnostics, including the
preview, go to stderr. `ok` is the command's own success: a preview can be `ok`
while nothing was published. Read `result.status` as well as the exit code.

## Remote path (retained)

The pre-0.6 HTTP surface is unchanged and is selected explicitly:

```bash
export SYNDROO_BASE_URL=https://syndroo.example.com
export SYNDROO_API_KEY=...
syndroo doctor
syndroo posts validate --file post.json
syndroo posts create --file post.json --idempotency-key release-001 --yes
syndroo posts list --limit 20
syndroo posts get <post-id>
syndroo posts wait <post-id> --timeout 60s
```

Remote documents use `content`, `platforms`, `overrides`, and `scheduledAt`,
with the same platform set the Worker supports. A local failure never falls
back to this path, and this path never reads local state.

## The bundled skill

```bash
syndroo skill path
```

The directory holds `SKILL.md` and its references. The skill describes the same
two-phase workflow for an agent: preview, check authorization, execute the same
plan, report every target. It is guidance, not an installer and not proof that
any particular agent client will discover or run it.

## Evidence and limits

The local publish, plan, store, provider, and command paths have focused tests,
including real file-state tests, real subprocess tests for locking and signals,
and provider tests against controlled endpoints.

The packaged CLI has been verified as an isolated install: the self-contained
tarball installs outside the repository and runs the documented local workflow
against fake providers, without reaching a real platform. That is packaging and
plumbing evidence, not platform acceptance.

Still not performed for `0.6.0-rc.1`: live-account acceptance on Bluesky or
Threads, execution on Linux (the evidence above is macOS arm64), and release
publication to npm.
