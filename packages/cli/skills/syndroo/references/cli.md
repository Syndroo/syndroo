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
| `syndroo skill path` | none |

- `--file <path>` takes a document path, or `-` for stdin. With no `--file`, the document is read from stdin when stdin is not a terminal.
- `--idempotency-key <key>` is required together with `--yes`, and must be 1-128 characters from `A-Z a-z 0-9 . _ : -`. Reuse the same key to replay a result; choose a new key only for a genuinely different post.
- `--limit <n>` is an integer from 1 to 100.
- `--timeout <duration>` accepts `500ms`, `60s`, `5m`, or `2h` and defaults to 60s. A bare number counts as seconds.
- `--dry-run` validates and previews without sending anything, and needs no reachable instance.

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
| `2` | Usage, configuration, or document problem; nothing was sent |
| `3` | `posts wait` reached its deadline; the post still exists |
| `4` | A write may have reached the instance and no result is known |
| `5` | The preview was declined; nothing was sent |
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
