# Syndroo CLI manual

This manual covers the `syndroo` command in the CLI-first `0.7.0-rc.1`
candidate: local publishing to Bluesky, Threads, LinkedIn, Mastodon, and DEV.to, plus the retained remote
path for a deployed Syndroo instance.

The candidate is not published to npm and has no live-account acceptance. The
local providers are `fixture-tested`: their protocol paths are exercised
against controlled endpoints, not against real accounts.

## Install

The candidate is not on npm yet, so it is installed from the tarball this
repository builds. From the repository root:

```bash
npm run pack:cli
npm install --global ./artifacts/syndroo-cli-0.7.0-rc.1.tgz
syndroo version
```

Install a tarball someone handed you directly:

```bash
npm install --global /path/to/syndroo-cli-0.7.0-rc.1.tgz
```

`npm pack` inside `packages/cli` is not the release path; `pack:cli` produces
the self-contained artifact that references no unpublished workspace package.

Node.js 22 or newer is required. The packaged CLI is self-contained; you do not
need to publish or install the internal workspace packages first.

## What the local path does

Publish plain text to Bluesky, Threads, LinkedIn, and Mastodon, and articles to
DEV.to, in the foreground from this machine.
`publish` sends directly after confirmation; `--dry-run` is an optional preview.
Bare `syndroo`, `syndroo -h`, and `syndroo --help` show help without config,
state writes, credential access, or network calls.

Out of scope for this version: scheduling, media, replies or threads, batch and
watch modes, RSS, local OAuth on instances that do not advertise S256, or
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

The state holds `installation.json`, `integrity.key`, `connections/`, `intents/`,
`operations/`, `deliveries/`, a write lock, a recovery guard, and quarantine
evidence. Directories are `0700` and files are `0600`. Those permissions limit
access; they are not encryption, and intents and receipts contain the post text
and the account identity. Older `plans/` records remain readable for existing
operations; new publishing never writes that directory.

## Register an account

The `connect` entrypoint defaults to local mode and reuses the existing auth
binding. `--local` remains accepted, but is not required for `connect`:

```bash
syndroo connect bluesky
syndroo connect bluesky --from-env --expect-account <verified-id> --yes --no-input
```

On an interactive terminal, the first command offers a credential-source
choice; without a TTY or with `--no-input`, it refuses with source-selection
guidance. It never guesses a source. The second command verifies and binds the
explicitly selected account. Binding requires prior `syndroo init`. Remote
instance environment variables cannot switch this command to a server. `--managed` is rejected
before side effects; it does not enable a hosted service. The older `auth`
commands below still require `--local`.

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
  "key": "release-announcement-001",
  "content": "Syndroo now publishes from the command line.",
  "platforms": ["bluesky", "threads", "linkedin", "mastodon"],
  "overrides": { "bluesky": { "content": "Shorter version for Bluesky." } }
}
```

`key` is the stable logical identity (1-128 characters from `A-Z a-z 0-9 . _ :
-`). `content` is non-blank and at most 10000 Unicode code points. `platforms`
must be non-empty, must not repeat, and may name `bluesky`, `threads`,
`linkedin`, or `mastodon` for text, plus `devto` only for an explicit
`schemaVersion: 2` article with `overrides.devto.content` and
`overrides.devto.article.title` (see the article example below). `overrides`
may only name a selected platform. `schemaVersion` is optional and defaults to
`1`; explicit `2` also accepts text-only documents. Explicit null or unsupported
versions are refused.

Every input is strict JSON: comments, trailing commas, repeated keys, invalid
UTF-8, and unpaired surrogates are refused, and one leading byte-order mark is
tolerated. The source limit is 64 KiB before decoding. `--input -` reads stdin.
`--data <json>` accepts the same document inline. Choose exactly one source:
inline JSON, file, or stdin. Conflicts fail before reading input or changing
state. There is no text shortcut. Provider limits still apply.

## Publish directly

```bash
syndroo publish --input post.json --yes --no-input --json
syndroo publish --data '{"key":"agent-post-001","content":"Hello from Syndroo","platforms":["bluesky"]}' --yes --no-input --json
```

Use reusable files for maintained content, or inline JSON for generated content
without a temporary file. Inline content may appear in shell history and
process arguments. Use `--input -` with stdin for sensitive text. Keep
credentials out of post JSON, and pass generated JSON as one argument rather
than interpolating post text into a shell command.

To validate and inspect before publishing, add an optional dry-run:

```bash
syndroo publish --input post.json --dry-run --json
```

The preview requires existing local config and target bindings, but writes no
state, takes no lock, resolves no credentials, and makes no network request.
It shows text, accounts, binding revisions, and a business timestamp. A later
publish reads the current input again; changing the file between commands
changes that publish. Within one invocation, confirmation and sending use the
same parsed snapshot, even if the source changes while the prompt is open.

The execution holds the local write lock, re-checks that the account binding is
still current, and sends at most one content request per target. Publishing a
delivery that already succeeded reports the original result and sends
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
syndroo retry <operation-id> --to threads --yes --no-input --json
```

Retry executes directly; its optional dry-run is read-only. Only targets whose
failure is provably `not_applied` are eligible, and only within three content
attempts per logical delivery. A selection that includes an `unknown` target
blocks the whole retry; narrow it to other safe targets instead. A succeeded
target is never republished.

If credentials were rotated, the retry preview shows the old and the new
binding, and the same stable account must be re-verified before retrying.

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
| `0` | The command finished: a preview validated, a query read successfully, or a run fully succeeded |
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

The directory holds `SKILL.md` and its references. The skill describes direct
publishing for an agent: prepare JSON, check authorization, optionally preview,
publish, report every target. It is guidance, not an installer and not proof that
any particular agent client will discover or run it.

## Evidence and limits

The local publish, plan, store, provider, and command paths have focused tests,
including real file-state tests, real subprocess tests for locking and signals,
and provider tests against controlled endpoints.

The packaged CLI has been verified as an isolated install: the self-contained
tarball installs outside the repository and runs the documented local workflow
against fake providers, without reaching a real platform. That is packaging and
plumbing evidence, not platform acceptance.

Limited Linux verification passed on Node.js 22.23.3 as uid 1000 with networking
disabled: offline old and new CLI installs, explicit schema-1-to-2 state
upgrade, actual old 0.6 CLI refusal without changing schema-2 state, 0700/0600
permissions, and unsafe-state-file refusal. Evidence is recorded in
`root-linux-state-verification.log` for prior candidate SHA-256
`86c7bdf538db4c63bb67252b70b88086fae67b8b46f9f874e1a82af9b102ac12`.
This proves state compatibility and permissions for that candidate, not the
full Linux publishing flow. Root will verify the final repacked candidate
separately.

Still unverified: the full packaged-platform locality gate (its fixture errors
remain unresolved), full Linux publishing, the complete macOS/Linux Node.js
matrix, and live-account acceptance on any of the five providers. No npm
publication has occurred.

## R3 local release: commands, limits, and evidence

### Commands

```bash
syndroo connect <provider> [--local] [--from-env | --credential-file <path> | --oauth --instance <url>]
syndroo connect <provider> --from-env --save-credential-file <new-path> --yes --no-input --expect-account <id>
syndroo state upgrade --to 2 --confirm-no-writers --yes --no-input
syndroo state inspect
```

- `connect` is local-only. `--managed` and remote endpoint flags are refused before
  any credential read, network call, or state write. `auth set/status/remove`
  keep their explicit `--local` requirement.
- `--credential-file` imports an existing file read-only. `--save-credential-file`
  creates a **new** file: exclusive create, mode 0600, parent directory must
  already be 0700 (never chmodded), no overwrite, symlinks refused. If the file
  is written but the binding revision changed, the result reports
  `credentialFileSaved:true, bindingChanged:false`; the file stays, nothing is
  deleted, and no path or secret is printed.
- `--oauth` is Mastodon-only and needs `--instance` plus
  `--save-credential-file`. It registers one local app on that instance after
  explicit approval, uses a one-shot loopback callback with PKCE S256, verifies
  the real account, and then binds. An instance without S256 is refused with a
  static message; importing a BYO user token is a separate, explicitly chosen
  `--credential-file` command, never an automatic downgrade. No app secret is
  cached or reused.
- `state upgrade` is the only migration. `publish`/`dry-run` never upgrade.
  Both confirmations are mandatory; an interrupted upgrade leaves a marker that
  old and new binaries refuse, and rerunning the command resumes it.

### DEV.to article document (v2)
```json
{
  "schemaVersion": 2,
  "key": "article-2026-10-04",
  "content": "Summary for the text providers.",
  "platforms": ["bluesky", "mastodon", "devto"],
  "overrides": {
    "devto": {
      "content": "# Heading\n\nFull Markdown body.",
      "article": {
        "title": "A verified publishing workflow",
        "tags": ["typescript", "opensource"],
        "canonicalUrl": "https://example.com/posts/safe-publishing"
      }
    }
  }
}
```
Four providers take plain text (`bluesky`, `threads`, `linkedin`, `mastodon`);
only `devto` takes the v2 article. A v2 document that does not select `devto`
is still a valid text document. Mastodon env: `MASTODON_INSTANCE`,
`MASTODON_ACCESS_TOKEN`. DEV.to env: `DEVTO_API_KEY`. Mastodon publishes public
statuses only; DEV.to publishes individual public articles only, with no media,
series, organization, or scheduling fields.

### Interactive connect
`connect` without a credential source on a real terminal prints the platform
guidance and offers env, an existing file, hidden local entry, or Mastodon
OAuth. Non-interactive or no-TTY runs refuse immediately with the actionable
usage error; a missing source is never guessed.

### Limits and guarantees

- Five local providers: Bluesky, Threads, LinkedIn, Mastodon (plain text),
  DEV.to (articles). Every provider publishes publicly in the foreground; there
  is no scheduler, daemon, media upload, series, or organization article.
- Article input is an explicit `schemaVersion: 2` document with
  `overrides.devto.content` and `article.title`. Product limits: title 1-128
  code points, at most 4 unique lowercase-alphanumeric tags of 1-30 characters,
  canonical URL an HTTPS URL of at most 2048 characters, body at most 10000
  code points, 64 KiB source, YAML front matter and Liquid directives refused.
  These are Syndroo product limits, not platform-official limits.
- A frozen plan is the approved bytes. The preview shows the account, title,
  full Markdown, ordered tags, canonical URL, and public visibility; the
  execution path re-checks the frozen payload and the current account, and a
  successful target replays from its receipt with zero credential or network
  work.
- Machine off means no publishing. There is no automatic token refresh or
  revocation; `auth remove` writes a local tombstone and the token must be
  revoked in the platform settings. State is one active ledger on one machine;
  backups and the integrity key are the operator's responsibility, and
  restoring an old ledger or copying state to a second machine is not a
  deduplication boundary. Switching to the remote API is a different
  deduplication authority, not a fallback.
- Never paste a token into a chat or a document. Agents need command execution
  on this device and explicit publish authorization; an unknown result is never
  retried automatically, never re-keyed, and never routed through another
  channel.
- Third-party services and platforms can change their APIs, limits, and prices;
  this release makes no availability, delivery, or cost promise.

### Fixture-tested release notes

`0.7.0-rc.1` is fixture-tested: five providers are wired with controlled
fixtures, the CLI bundles its internal adapters with no bare `@syndroo/*`
runtime dependency, and the local state upgrade has executed fault-injection
and real-old-binary evidence. No live account was connected and no real post
was published for this candidate; live validation stays a separate, authorized
gate.

### Voluntary U0 trial (proposed, not recruited)

Design values only: five technical users who publish repeatedly, each on their
own device, over two weeks. Each participant runs connect, a dry-run preview,
an authorized publish, and a receipt read-back on their own account; they
record what broke, how they recovered, and whether they used it again. Records
are supplied voluntarily and redacted by the participant. This release neither
recruits participants, automates the trial, nor collects telemetry.

### Voluntary U0 record template
Each participant supplies this voluntarily; never include tokens, secrets, real
account identifiers, or post contents.
```
record-version:
os-and-node:
task (connect | preview | publish | receipt | retry):
date-started: / date-finished:
time-to-connect-minutes:
errors (static code + what you saw):
recovery (what fixed it):
reused-within-two-weeks (yes/no + how often):
notes:
```
