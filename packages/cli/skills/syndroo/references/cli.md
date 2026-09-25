# Syndroo CLI reference

The CLI has two surfaces. The local surface publishes from this machine and needs no server; the legacy remote surface talks to a deployed Syndroo instance. They never mix: a local command reads no remote variable, and a remote command reads no local state.

## Local surface

### Paths

| What | Where |
| --- | --- |
| Config | `${XDG_CONFIG_HOME:-$HOME/.config}/syndroo/config.json`, holding `schemaVersion` and `namespace` only |
| State | `${XDG_STATE_HOME:-$HOME/.local/state}/syndroo`, overridden for one run by `--state-home <path>` |
| Bundled skill | The directory printed by `syndroo skill path` |

`syndroo init` creates both. With no `--namespace <name>` the namespace is `default`; a later `init` that would change an existing namespace is refused rather than overwritten. There is no default platform anywhere: every post names its own targets.

State directories are `0700` and state files are `0600`. Those permissions limit access; they are not encryption, and plans and receipts hold the post text and the account identity in plain files.

### Commands

| Command | What it does |
| --- | --- |
| `syndroo init [--namespace <name>]` | Create the local config and state. Repeats safely with the same namespace |
| `syndroo doctor --local` | Check config, state, permissions, and bindings. Read-only, no network |
| `syndroo providers list` | List the local providers with maturity, `localPublish`, and `unavailableReason` |
| `syndroo auth set <provider> --local (--from-env \| --credential-file <path>)` | Verify one account and register a credential reference |
| `syndroo auth status [<provider>] --local` | Show the local bindings. Offline unless `--verify` is added |
| `syndroo auth remove <provider> --local` | Remove one binding and keep a tombstone |
| `syndroo publish --input <path\|-> --dry-run` | Freeze a plan and print it. The only way to start a local publish |
| `syndroo publish --plan <plan-id>` | Execute one frozen plan |
| `syndroo receipts list` | List recent local operations, newest first, default 20 |
| `syndroo receipts show <operation-id>` | Show one operation with its authoritative per-target records |
| `syndroo retry <operation-id> --to <csv> --dry-run` | Freeze a retry plan for explicitly selected safe targets |
| `syndroo retry --plan <plan-id>` | Execute one frozen retry plan |
| `syndroo state inspect` | Show lock, versions, and defects. Never repairs |
| `syndroo state recover --confirm-no-writers --yes` | Recover after every other writer has stopped |
| `syndroo skill path` | Print the absolute path of the bundled skill directory |
| `syndroo help`, `syndroo version` | Print usage, or the CLI version. Neither touches the network |

### Flags

Global: `--json` writes exactly one JSON object to stdout and sends every diagnostic, including the preview, to stderr. `--help` prints help for the command and exits.

Local: `--local` selects the local path for `doctor` and the auth commands; `--state-home <path>` and `--namespace <name>` override the configured location and deduplication domain for one run; `--no-input` never prompts; `--yes` confirms without a prompt; `--from-env` and `--credential-file <path>` choose the credential source; `--expect-account <id>` pins the stable account id a non-interactive run already verified; `--verify` re-checks an identity over the network without changing the binding; `--input <path|->` names the publish document; `--plan <plan-id>` names a frozen plan; `--to <csv>` names the retry targets; `--confirm-no-writers` is the recovery confirmation; `--timeout <duration>` bounds execution and explicit verification; `--limit <n>` bounds a listing.

Remote: `--base-url <url>`, `--file <path>`, `--idempotency-key <key>`, `--limit <n>`, `--timeout <duration>`, `--yes`, `--dry-run`.

A local command refuses a repeated flag. `--timeout` is accepted only for execution or for `auth status --verify`, and accepts a positive whole number of seconds or milliseconds up to 600s. A local run needs both `--yes` and `--no-input` when no human can answer a prompt.

### Publish document

```json
{
  "schemaVersion": 1,
  "key": "release-announcement-001",
  "content": "Syndroo now publishes from the command line.",
  "platforms": ["bluesky", "threads"],
  "overrides": { "bluesky": { "content": "Shorter version for Bluesky." } }
}
```

| Field | Rule |
| --- | --- |
| `schemaVersion` | Exactly `1` |
| `key` | Stable logical identity, 1-128 characters from `A-Z a-z 0-9 . _ : -`, starting with a letter or digit |
| `content` | Non-blank text of at most 10000 Unicode code points |
| `platforms` | Non-empty array with no repeats; each entry one of `bluesky`, `threads` |
| `overrides` | Optional object naming only selected platforms; each entry allows `content` only |

The file is strict JSON: comments, trailing commas, repeated keys (including escaped equivalents), invalid UTF-8, and unpaired surrogates are refused. One leading byte-order mark is tolerated. The source is limited to 64 KiB before decoding, and `--input -` reads stdin. There is no text shortcut: a post always starts from this document. `scheduledAt` belongs to the remote surface only and is refused locally.

### Credential sources

`--from-env` reads one whole group from the environment: `BLUESKY_IDENTIFIER`, `BLUESKY_PASSWORD`, and optional `BLUESKY_HOST` (which must be `bsky.social`), or `THREADS_ACCESS_TOKEN`.

`--credential-file <path>` reads one strict JSON file:

```json
{
  "schemaVersion": 1,
  "provider": "bluesky",
  "credentials": {
    "identifier": "your-handle.bsky.social",
    "password": "APP_PASSWORD_PLACEHOLDER",
    "host": "bsky.social"
  }
}
```

Threads uses `accessToken` instead. Exactly one source is used per command; the CLI never mixes sources, never falls back to another source, and never reads `.env` or a shell profile. The state keeps a credential reference, a stable account id, a revision, and a local group fingerprint; it keeps no platform secret. Source paths and fingerprints never appear in output.

### Plans, receipts, and recovery

A preview freezes the text, the target binding, the payload version, and a content hash, signs the plan under the local installation key, and stores it. Plans live 24 hours from creation. An execution re-checks the active binding under the write lock and sends no more than one content request per target; it never re-reads your input file, so editing the file afterwards cannot change a frozen plan.

A logical delivery is identified by `(namespace, key, provider, targetId)`. Replaying a delivery that already succeeded reports the original result and sends nothing. The same key and target with different content is a conflict, and the preview marks that item `blocked`. A blocked item makes the plan unexecutable; read the receipt and use an explicit retry instead.

Each logical delivery allows at most three content attempts, counted across every plan and operation. Only a failure the provider proves was never applied can be retried safely. A timeout, a dropped connection, or a success response without a usable id is `unknown`, and an unknown result stops blind retries.

`state recover --confirm-no-writers --yes` is local maintenance for a stopped machine: it quarantines the stale lock, keeps evidence, and turns orphaned in-flight intent into `unknown`. It never sends content and never forces a lock that a live process may hold.

## Remote surface (retained)

This is the pre-0.6 HTTP path. It stays available and unchanged, and it is never selected automatically: a local failure does not fall back to it, and it does not fall back to local.

| Variable | Meaning |
| --- | --- |
| `SYNDROO_BASE_URL` | Origin of a deployed instance, for example `https://syndroo.example.com` |
| `SYNDROO_API_KEY` | Instance API key, sent only as a `Bearer` header and never printed |

| Command | What it does |
| --- | --- |
| `syndroo doctor` | Check configuration, reachability, and credentials for the instance |
| `syndroo posts validate` | Validate a remote post document and print the preview. Sends nothing |
| `syndroo posts create` | Submit one document. Returns an acceptance receipt, not a delivery |
| `syndroo posts list` | List recent remote posts, newest first |
| `syndroo posts get <post-id>` | Read one remote post with its publications |
| `syndroo posts wait <post-id>` | Read one remote post until it is terminal or the budget runs out |

```json
{
  "content": "We just shipped a new release.",
  "platforms": ["bluesky", "threads"],
  "overrides": { "bluesky": { "content": "Shorter version." } },
  "scheduledAt": "2026-10-01T09:00:00Z"
}
```

| Field | Rule |
| --- | --- |
| `content` | Non-empty string of at most 10000 characters |
| `platforms` | Non-empty array with no repeats; each entry one of `x`, `threads`, `bluesky`, `tumblr`, `mastodon`, `linkedin`, `nostr` |
| `overrides` | Optional; keys must already be selected, and each entry allows `content` only |
| `scheduledAt` | Optional ISO 8601 instant; a past instant warns and publishes as soon as the instance can |

Unknown top-level fields are warnings here, not errors. `--idempotency-key <key>` is required together with `--yes` for a non-interactive create, and reusing the same key with the same body replays the original result.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command finished. For a preview this means the plan was written; for a remote create it means accepted, not delivered |
| `1` | Local I/O or runtime failure, or a trusted success that could not be persisted |
| `2` | Admission failure: usage, configuration, document, confirmation, or binding. No content request was made |
| `3` | A remote `posts wait` reached its deadline; the post still exists |
| `4` | An unknown write result. Stop and read the receipt or the post before retrying |
| `5` | The operator declined before any content request |
| `6` | The run ended without full delivery, including a deadline that passed before a target started |
| `130` | The local process stopped on a signal. An in-flight write is not cancelled |

## JSON output

Local commands print one envelope on stdout:

```json
{
  "schemaVersion": 1,
  "command": "publish",
  "mode": "local",
  "ok": true,
  "result": { "planId": "plan_...", "expiresAt": "...", "digest": "...", "items": [] },
  "error": null
}
```

`ok` says whether the command completed its own task: for a preview that means the plan was written, for a query that the read succeeded, and only for an execution that every target succeeded and the result was persisted. Scripts must read `result.status` as well as the exit code.

Execution results carry `operationId`, `planId`, `status`, `durability`, and one entry per target with `provider`, `targetId`, `status`, `reused`, `attempts`, `remoteId`, `url`, `writeDisposition`, and `retry`. `status` is `succeeded`, `partial`, `failed`, `unknown`, or `blocked`; `durability` is `committed` or `failed`. A `null` url means no verified link is known, never a guess.

Failures carry `error.code` and a safe message, for example `INVALID_DOCUMENT`, `INVALID_JSON`, `INPUT_TOO_LARGE`, `CONFIRMATION_REQUIRED`, `PROVIDER_LOCAL_UNAVAILABLE`, `LOCAL_RUNTIME_UNSUPPORTED`, `LOCAL_SCHEDULING_UNSUPPORTED`, `LOCAL_OAUTH_UNAVAILABLE`, `AUTH_SOURCE_UNAVAILABLE`, `AUTH_SOURCE_CHANGED`, `ACCOUNT_MISMATCH`, `BINDING_CHANGED`, `PLAN_EXPIRED`, `PLAN_TAMPERED`, `PLAN_KIND_MISMATCH`, `IDEMPOTENCY_CONFLICT`, `STATE_BUSY`, `STATE_CORRUPT`, `STATE_VERSION_UNSUPPORTED`, `STATE_COMMIT_FAILED`, `OUTCOME_UNKNOWN`, `RETRY_NOT_READY`, `ATTEMPTS_EXHAUSTED`, `NOT_DELIVERED`, `CONFIG`, `USAGE`, `CANCELLED`, and `INTERRUPTED`.

Remote commands keep their own older shape, which includes `exitCode` and `createRequests`. Do not parse a local envelope and a remote envelope with one reader.
