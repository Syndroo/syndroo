# Syndroo CLI reference

One command talks to exactly one deployed Syndroo instance. Read this when you need an exact flag, exit code, or JSON field.

## Configuration

| Variable | Meaning |
| --- | --- |
| `SYNDROO_BASE_URL` | Origin of a deployed instance, for example `https://syndroo.example.com` |
| `SYNDROO_API_KEY` | Instance API key. Sent only as a `Bearer` header, never printed |

The CLI reads those two variables and its own flags. It has no API-key flag and no configuration file, so a key stays in the environment or a CI credential store. `--base-url` overrides the URL for one run.

Global options accepted by every command:

| Flag | Meaning |
| --- | --- |
| `--json` | Write exactly one JSON object to stdout; every diagnostic, including the preview, goes to stderr |
| `--help` | Print help for the command and exit |

## Commands

| Command | What it does |
| --- | --- |
| `syndroo doctor` | Check configuration, reachability, and credentials. Read-only, sends no writes. |
| `syndroo posts validate` | Validate a document and print the preview. Sends nothing and needs no reachable instance. |
| `syndroo posts create` | Submit one document. Returns an acceptance receipt, not a delivery. |
| `syndroo posts list` | List recent posts, newest first. |
| `syndroo posts get <post-id>` | Read one post with its publications. |
| `syndroo posts wait <post-id>` | Read one post until it reaches a terminal status or the budget runs out. |
| `syndroo auth status [platform]` | Read one platform, or every platform plus instance readiness. Read-only. |
| `syndroo auth set <platform>` | Store one platform's direct credential from bounded secret JSON. |
| `syndroo auth connect <platform>` | Start one guarded OAuth operation and print its authorization URL. |
| `syndroo auth operation <platform> <operation-id>` | Read one authorization operation. Read-only. |
| `syndroo auth complete <platform> <operation-id>` | Confirm one authorization operation with public target fields. |
| `syndroo auth refresh <platform>` | Refresh one platform's stored token under its observed revision. |
| `syndroo auth remove <platform>` | Remove one platform's stored credential. |
| `syndroo diagnostics` | Read outbox and storage counters. Read-only. |
| `syndroo skill path` | Print the absolute path of this bundled skill directory. |
| `syndroo help`, `syndroo version` | Print usage and the CLI version. Neither touches the network. |

### Flags per command

| Command | Extra flags |
| --- | --- |
| `syndroo doctor` | `--base-url <url>` |
| `syndroo posts validate` | `--file <path>` |
| `syndroo posts create` | `--file <path>`, `--idempotency-key <key>`, `--yes`, `--dry-run` |
| `syndroo posts list` | `--limit <n>` |
| `syndroo posts get` | none |
| `syndroo posts wait` | `--timeout <duration>` |
| `syndroo auth status [platform]` | `--base-url <url>` |
| `syndroo auth set <platform>` | `--file <path>`, `--yes`, `--base-url <url>` |
| `syndroo auth connect <platform>` | `--base-url <url>` |
| `syndroo auth operation <platform> <operation-id>` | `--base-url <url>` |
| `syndroo auth complete <platform> <operation-id>` | `--author <urn>`, `--api-version <YYYYMM>`, `--blog <blog>`, `--yes`, `--base-url <url>` |
| `syndroo auth refresh <platform>` | `--base-url <url>` |
| `syndroo auth remove <platform>` | `--yes`, `--base-url <url>` |
| `syndroo diagnostics` | `--base-url <url>` |
| `syndroo skill path` | none |

- `--file <path>` takes a document path, or `-` for stdin. With no `--file`, the document is read from stdin when stdin is not a terminal.
- `--idempotency-key <key>` is required together with `--yes`, and must be 1-128 characters from `A-Z a-z 0-9 . _ : -`. Reuse the same key to replay a result; choose a new key only for a genuinely different post.
- `--limit <n>` is an integer from 1 to 100.
- `--timeout <duration>` accepts `500ms`, `60s`, `5m`, or `2h` and defaults to 60s. A bare number counts as seconds.
- `--dry-run` validates and previews without sending anything, and needs no reachable instance.

## Credentials and authorization

`syndroo auth set` reads one platform's direct credential fields as JSON. Send
them on stdin (`--file -` or no `--file` with piped input) or name a file with
`--file`. There is no credential flag: a token or password never belongs in
argv, in chat, in a commit, or in a log, and the CLI registers submitted values
for redaction before it validates them. Input is bounded to 64 KiB; a terminal
stdin without `--file` fails instead of prompting for a password.

| Platform | Accepted credential fields |
| --- | --- |
| `bluesky` | `identifier`, `password`, optional `host` |
| `threads` | `access_token` |
| `x` | `access_token`, `access_token_secret` |
| `tumblr` | `token`, `token_secret`, optional `blog` |
| `linkedin` | `access_token`, optional `author`, `api_version`, `refresh_token` |

`syndroo auth set`, `syndroo auth complete`, and `syndroo auth remove` show a
preview, then need `--yes` or an interactive `y`. A non-interactive run without
`--yes` is refused before any read or write, and a declined preview performs zero
writes — the revision read that produced the preview has already happened, so
"nothing was sent" would be wrong for those commands. Every auth command reports
`authRequests {read, write}` on success and on failure. They are the command's
own attempt tally, not a server-side audit: a locally rejected run reports zero,
and a command that was interrupted before its read settled reports the attempt
it started. Treat them as guidance for recovery, never as proof of what the
instance committed.

Revisions are observed, never guessed:

* `syndroo auth set`, `syndroo auth connect`, `syndroo auth refresh`, and
  `syndroo auth remove` read the platform's current `revision` first and submit
  that observed active revision.
* `syndroo auth complete` reads the operation and the active status, then submits
  the operation's own `expectedRevision` — not the active one. A live operation
  whose revision no longer matches the active slot is refused locally.
* Completing an already completed operation replays its historical receipt,
  including its historical revision, even after the active slot moved.

A conflict is reported, never resolved by guessing a new revision, retrying
automatically, or rebasing onto a newer one.

OAuth follows four steps: `syndroo auth connect` starts an operation and prints
the provider URL once (open it yourself; never save or paste it anywhere),
the provider redirects to the instance callback, `syndroo auth operation` reads
the phase, and `syndroo auth complete` activates the operation with explicit
public target fields — `--author` and `--api-version` for `linkedin`, `--blog`
for `tumblr`, and no target fields for `x`. The candidate target is shown
separately from the currently active one. Completing an already completed
operation replays its historical receipt, including its own revision, even after
the active slot moved.

`syndroo auth refresh` refreshes the stored token under the observed revision.
An unknown or ambiguous result requires reconnect; never repeat a refresh
exchange automatically, and never retry an ambiguous mutation blindly. Inspect
`syndroo auth status` and `syndroo auth operation` instead. For posts, an
ambiguous create keeps the same idempotency key.

`syndroo doctor` reports three different things and keeps them apart, and its
result says which one failed:

* reachability — `GET /health`. An unreachable instance fails here and nothing
  else is claimed.
* key acceptance — an authenticated read. A rejected key fails as an
  authentication problem; a rejected key is not a readiness verdict, and a
  transport failure while checking it propagates instead of being reported as a
  credential verdict.
* local readiness — the `instance` object and per-platform `readiness` from
  `syndroo auth status`, which report what this instance's configuration is
  missing. A deployment that answers `404` or `405` there reports readiness as
  unknown; any other failure, including an abort, fails the command.

Exit code 0 means doctor ran and its reads succeeded. It does **not** mean the
instance is ready: `publishingReady: false` or a platform whose readiness is
`missing_credentials` still exits 0 and is reported as not ready. Local
readiness is configuration, never proof that a real account or an end-to-end
publish works.

## Document

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
| `overrides` | Optional object; keys must be platforms already in `platforms`, and each entry allows `content` only, with the same length rule |
| `scheduledAt` | Optional ISO 8601 date-time. An instant in the past becomes a warning and publishes as soon as the instance can |

Unknown top-level fields are reported as warnings and ignored. A source document larger than 1 MiB, a file that cannot be read, and empty stdin are all usage problems.

Whether a platform is actually configured is answered by the instance, not by local validation.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command finished. For `posts create` this means accepted, not delivered |
| `1` | The command failed |
| `2` | Usage, configuration, or document problem. No mutation is sent; an auth command rejected on usage may already have performed its revision read |
| `3` | `posts wait` reached its deadline; the post still exists |
| `4` | A write may have reached the instance and no result is known |
| `5` | The preview was declined. No writes happen; an auth preview may already have read the status it showed |
| `6` | The post ended without full delivery (`failed` or `partial`) |
| `130` | The local process stopped on a signal; server-side work was not cancelled |

## JSON output

With `--json`, stdout carries exactly one object and it always includes `exitCode`. Every result includes `createRequests`, the number of requests that could create a post.

On success the object carries `command`, `ok: true`, and the command's own fields, such as `id`, `status`, `platforms`, `scheduledAt`, `requestSha256`, and `idempotencyKey`.

On failure it is:

```json
{
  "ok": false,
  "command": "posts.create",
  "error": { "code": "AMBIGUOUS_DELIVERY", "message": "..." },
  "exitCode": 4
}
```

Error codes an agent branches on: `CONFIG` and `USAGE` for a bad invocation or missing configuration, `INVALID_DOCUMENT` for a bad document, `CONFIRMATION_REQUIRED` and `IDEMPOTENCY_KEY_REQUIRED` for a non-interactive run that was missing `--yes` or the key, `AUTH_REJECTED` and `CREDENTIAL_CHECK_FAILED` from `doctor`, `IDEMPOTENCY_CONFLICT` when a key was already used with a different request, `AMBIGUOUS_DELIVERY` for an unknown outcome, `CREATE_FAILED` for a rejected create, `WAIT_TIMEOUT` for a reached deadline, `ABORTED` for a local signal, and `UNEXPECTED` for anything else.

The preview, including the sha256 of the request, is a diagnostic on stderr. A `posts create` reads the document once, so the bytes previewed are the bytes submitted.
