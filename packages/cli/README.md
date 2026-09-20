# @syndroo/cli

The `syndroo` command talks to one deployed Syndroo instance. It is a thin
client over `@syndroo/sdk`: it owns argument parsing, the post document, the
preview, and the exit codes, and it defers authentication, retries, and polling
to the SDK.

```text
you / your shell / CI -> @syndroo/cli -> @syndroo/sdk -> Syndroo HTTP API
```

## Install

```bash
npm install --global @syndroo/cli
# or run one command without installing
npx @syndroo/cli doctor
```

Requires Node.js 22 or newer.

## Configure

| Variable | Meaning |
| --- | --- |
| `SYNDROO_BASE_URL` | Origin of a deployed instance, for example `https://syndroo.example.com` |
| `SYNDROO_API_KEY` | Instance API key. Sent only as a `Bearer` header, never printed |

The CLI reads those two variables and its own flags. It never reads `.env`,
`.dev.vars`, or a configuration file, and it never edits a shell profile. The
key stays in the environment or a CI credential store. `--base-url` can
override the URL for one run, but there is no `--api-key` flag, so a key cannot
leak into shell history or a process listing.

## Commands

```bash
syndroo doctor
syndroo posts validate --file post.json
syndroo posts create --file post.json
syndroo posts list
syndroo posts get <post-id>
syndroo posts wait <post-id> --timeout 60s
syndroo skill path
```

A post document is JSON:

```json
{
  "content": "We just shipped a new release.",
  "platforms": ["bluesky", "threads"],
  "overrides": { "bluesky": { "content": "Shorter version." } },
  "scheduledAt": "2026-10-01T09:00:00Z"
}
```

`content` and each override must be non-empty and at most 10000 characters.
Every platform must appear once in `platforms`, and `overrides` may only name a
selected platform. The document can come from `--file <path>` or from stdin
(`--file -`, or no `--file` when stdin is not a terminal). Content is read as
bytes and sent as JSON; it is never passed to a shell.

## Agent and CI mode

```bash
syndroo posts create \
  --file post.json \
  --idempotency-key release-announcement-001 \
  --json \
  --yes
```

With `--json`, stdout carries exactly one JSON object and every diagnostic,
including the preview, goes to stderr.

A create runs in one of two modes:

- Interactive: the CLI prints the preview and asks `Create this post? [y/N]`,
  reading the answer from the terminal. Anything that is not `y` or `yes`
  cancels and sends nothing.
- Non-interactive: `--yes` is required, and so is a stable
  `--idempotency-key`. The CLI never waits for input it cannot receive, and the
  key is required rather than generated so a retry cannot create a second post.

The preview is a promise about what will be sent: the document is read once,
and the exact bytes that were previewed are the bytes submitted. Editing the
file after the preview changes nothing. The preview prints the sha256 of the
request, so a receipt can be checked against it.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command finished. For `posts create`, Syndroo **accepted** the request |
| `1` | The command failed |
| `2` | Usage, configuration, or document problem; nothing was sent |
| `3` | `posts wait` reached its deadline; the post still exists |
| `4` | A write may have reached Syndroo and no receipt was read |
| `5` | The preview was declined; nothing was sent |
| `6` | The post ended as `failed` or `partial` |
| `130` | The local process stopped on a signal |

**`posts create` returning 0 does not mean anything was published.** HTTP 202 is
an acceptance receipt. Read the post, or run `posts wait`, before claiming a
delivery. `posts wait` exits 0 only when the status is `published`; an ambiguous
publication reports exit 4, and `failed` or `partial` reports exit 6.

## When a result is unknown

If a create fails after the request may have reached the instance, the CLI
reports exit 4, prints the idempotency key it used, and stops. It never retries
silently and never mints a new key to paper over the failure. Re-run the same
command with the same `--idempotency-key` to replay the original result, or read
the post once you have its id.

`posts wait` only reads. A timeout leaves the server-side post running, so
resume with `posts get` or a longer `posts wait` instead of resending.
