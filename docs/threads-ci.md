# Threads from Cloudflare Worker and CI

This helper path connects one Threads account through a stable HTTPS Worker
callback, then prepares, explicitly executes, and waits for one plain-text
publication from CI. It uses the existing SDK and Core publication protocol.

The client behavior is fixture-tested against fake HTTP and SDK responses. This
guide does not claim live validation; a deployed Worker, registered Meta app,
authorized Threads account, and intentional post are required for that separate
acceptance.

## Setup order

1. Deploy the Worker with `PUBLIC_ORIGIN` set to its canonical HTTPS origin and
   the existing admin/internal secrets (`API_BEARER`, `SECRET_KEY`, and
   `RUNTIME_KEY`).
2. Register the exact callback below in the Meta app.
3. Bootstrap the Threads account and save the resulting `connectionId`.
4. Configure the Worker's optional `CI_BEARER` and `CI_CONNECTION_ID` pair.
5. Configure the manual workflow environment and secrets.

Use Node.js 24.19.0 or newer. The final callback URL is
`${SYNDROO_URL}/oauth/callback/threads`, with no path suffix or query.
`SYNDROO_URL` must be a canonical HTTPS origin.

## Deploy and register the callback

Deploy through the repository's normal Worker procedure. Set `PUBLIC_ORIGIN` to
the stable public HTTPS origin; do not infer it from request forwarding headers.
Keep `API_BEARER` and the internal secrets on the Worker.

Register this exact callback in the Meta app:

```text
https://syndroo.example/oauth/callback/threads
```

## Build

From the repository root:

```bash
npm ci
npm run build --workspace @syndroo/sdk
npm run build:scripts
```

The workflow template builds `@syndroo/sdk` from this repository. It does not
depend on an unpublished action or an imaginary SDK release.

## Bootstrap the account

Supply secrets through environment variables. Do not put them on the command
line.

```bash
export SYNDROO_URL='https://syndroo.example'
export SYNDROO_ADMIN_TOKEN
export THREADS_APP_ID
export THREADS_APP_SECRET
node .build/scripts/threads-connect.js
```

The helper:

1. Calls `connect start` for provider `threads` with the exact callback URI.
2. Resumes the `credential_input` step with the app id and secret from the
   environment.
3. Prints the Threads authorization URL and waits, with a bounded poll, for the
   Worker callback and `callback_complete` to produce a bound connection.
4. Prints only the connection id and safe account presentation, never app
   credentials.

If the authorization expires or polling times out, the command exits nonzero.
A repeated `action_required` response is not treated as success.

Save the printed `connectionId`. After bootstrap succeeds, configure the
optional Worker pair:

- `CI_CONNECTION_ID` must be that exact Threads connection id.
- `CI_BEARER` must be a distinct scoped bearer and must differ from
  `API_BEARER`.

Then open the GitHub environment named `threads-ci` and configure:

| Kind | Name | Purpose |
| --- | --- | --- |
| Variable | `SYNDROO_URL` | Canonical Worker origin |
| Secret | `SYNDROO_TOKEN` | Worker `CI_BEARER` value |
| Secret | `SYNDROO_CONNECTION_ID` | The one allowed Threads connection |

Do not add `SYNDROO_ADMIN_TOKEN` or the Worker admin bearer to the CI
environment.

## Publish

The post file is strict and contains exactly one string property:

```json
{ "text": "Hello from Syndroo CI" }
```

Run:

```bash
export SYNDROO_URL='https://syndroo.example'
export SYNDROO_TOKEN
export SYNDROO_CONNECTION_ID
node .build/scripts/threads-publish.js \
  --input examples/threads-ci/post.json \
  --request-id threads-ci:stable-content-revision \
  --yes
```

`--yes` is required before the helper makes a prepare call. The request id is a
non-secret stable identity for one logical publication and must match
`[A-Za-z0-9._:-]{1,128}`. Use the same id when recovering a lost response for
the same content and connection; never reuse it for different content.

The helper prepares once, executes the returned approval, and waits on the
operation status. A prepare replay is sent directly to status waiting. It never
creates a fresh publication identity after a timeout, failure, partial result,
or unknown result.

If the execute response is lost after a successful prepare, the command exits
nonzero but preserves the prepared operation id. Treat admission as unknown,
inspect that operation, and rerun with the same `--request-id` to recover the
durable result. Do not use a new publication identity.

Exit code `0` requires an aggregate `succeeded` result with at least one target
whose delivery also succeeded. `failed`, `partial`, `unknown`, timeout, and
unavailable final status all exit nonzero. The output preserves the operation
id and safe per-target status so an operator can inspect the operation without
republishing.

## Manual workflow

[`examples/threads-ci/workflow.yml`](../examples/threads-ci/workflow.yml) is a
manual `workflow_dispatch` template. Copy it to `.github/workflows/` after
reviewing the callback, environment, and content selection.

The template derives its request id from the repository, checked-out commit,
operator-supplied content revision, and connection id. It uses the repository's
existing pinned checkout and setup-node commits. It has only read permission
for repository contents and receives no admin credential. The publish input is
the literal checked-in path; no workflow input is interpolated into shell code.

The initial integration does not refresh expired Threads tokens automatically.
An auth or permission failure must be surfaced, and the operator must reconnect
the account. The live acceptance step remains separate: deploy the Worker,
register the callback, authorize the account, deliberately dispatch once, and
rerun the same logical publication to confirm no duplicate.
