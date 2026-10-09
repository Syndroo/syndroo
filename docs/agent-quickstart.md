# Agent quickstart

The short path for an agent or automation that drives the `syndroo` CLI. The
packaged Skill (`packages/cli/skills/syndroo/SKILL.md`) carries the same workflow
with more detail; this page is the repo-side summary.

The CLI is protocol v1: three commands, `connect`, `publish`, `status`. Publishing
is two explicit phases. `publish` with a `prepare` request returns a
`confirmation_required` result and an approval token; a second `publish` with an
`execute` request carries that token. Nothing is sent until the execute call.

## The sequence

```bash
node packages/cli/dist/bin.js --version
node packages/cli/dist/bin.js status --json

# prepare, then show the preview to the user and get explicit approval
echo '{"type":"prepare","content":{"text":"Hello from Syndroo"},"targets":[{"provider":"bluesky"}]}' \
  | node packages/cli/dist/bin.js publish --input - --request-id req_agent_001 --json

# execute only after that approval, with the token the prepare returned
echo '{"type":"execute","approvalToken":"at_example"}' \
  | node packages/cli/dist/bin.js publish --input - --json

node packages/cli/dist/bin.js status --operation op_example --json
```

1. Confirm the CLI runs here and which providers have an active connection.
   `status` is read-only and never calls a provider or reads a secret.
2. Save a request identity. `--request-id <id>` is the stable key for one logical
   call; reuse it if you must retry a lost response, and never reuse it for
   different content.
3. Prepare. The result is `confirmation_required` with the full `preview`,
   `operationId`, `approvalToken` and `expiresAt`. A `prepare` does not publish.
4. Show the preview to the user and get explicit approval. A zero exit from a
   prepare is not approval.
5. Execute with the token. In `--json` there is never an implicit prompt; an
   execute request is accepted only from stdin.
6. Report every target from the execution result, then read `status --operation`
   if you need the settled record.

## Request shapes

```json
{ "type": "prepare", "content": { "text": "…" }, "targets": [{ "provider": "bluesky" }] }
```
```json
{ "type": "execute", "approvalToken": "at_example" }
```
```json
{ "type": "retry", "retryOf": "op_example", "targets": [{ "provider": "bluesky", "connection": "conn_example" }] }
```

A `prepare` or `retry` uses `--request-id`; an `execute` does not need one.
`--dry-run` is an optional offline preview of a `prepare` document: it writes no
state, resolves no credentials and makes no network call. It requires an existing
connection for every target.

## Rules an agent must not break

- Never treat a zero exit as proof of publication. Read `result.status` and each
  delivery: `pending`, `running`, `succeeded`, `partial`, `failed`, `unknown`.
- Never retry an `unknown` outcome blindly. `unknown` means the write may have
  reached the platform. Read `status --operation <id>` and stop; a deliberate
  retry is a separate, user-authorized decision.
- Reuse the same `--request-id` to recover a lost response for the same call. A
  reused id with different content is `IDEMPOTENCY_CONFLICT`.
- Keep secrets out of the conversation, command arguments and screenshots.
  Credentials come from the user's own `SYNDROO_CREDENTIALS` environment variable
  or a credential file the user manages. Never put credentials in a post request.
- Pass serialized JSON as one argument or on stdin; never interpolate generated
  text into a shell command. Inline JSON may appear in shell history and process
  arguments, so prefer stdin for sensitive text.
- Do not switch to the HTTP server because the local path failed. They share
  contracts, not state.

## What to report back

The `operationId`, the aggregate status, and one line per target: provider,
connection, outcome status and attempt count. Keep three outcomes apart:
delivered (`succeeded`), not delivered (`failed`), and unknown (`unknown`). When
a `url` is absent, say that no verified link is known instead of constructing one.

## Limits

`0.7.0-rc.1` is unreleased and fixture-tested: five providers are wired with
controlled fixtures; no live account has been connected and no real post has been
published. There is no scheduling, media, threads/replies, batch or watch mode,
and no automatic token refresh. LinkedIn, Threads and Mastodon connect through
an OAuth `open_url` step that needs connect options and a browser callback; the
local CLI completes that callback itself, either by binding the loopback
redirect `--redirect-uri` registers or by reading the redirected URL from
standard input with `--callback-url -`. No live account has been connected, so
the platform side of those three flows stays unverified. Bluesky and DEV.to
connect with credentials only.

See [cli-manual.md](cli-manual.md) for the full command and envelope reference,
and the packaged `references/cli.md` and `references/delivery-semantics.md` for
the agent-facing detail.
