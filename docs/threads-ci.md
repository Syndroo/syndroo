# Threads from a Cloudflare Worker and manual CI

The `server` commands connect one Threads account through a stable Worker
callback, then publish one plain-text post from manual CI or from the same
project locally. The flow uses the existing SDK and Core publication protocol.

Status: fixture-tested. This guide does not claim live Cloudflare, GitHub, Meta,
or Threads acceptance. Those steps need a user-owned deployment, a registered
Meta app, an authorized Threads account, and separate permission to publish.

## Order

1. Initialize and deploy the generated project.
2. Register the deployed callback in the Meta app.
3. Connect Threads and save the verified connection reference.
4. Configure manual GitHub CI if wanted.
5. Publish one post through an explicit, stable request ID.

The generated project uses the installed `@syndroo/cli` and
`@syndroo/cloudflare` artifacts plus project-local Wrangler. Do not copy product
source or repository helper scripts into the deployment project.

## Initialize and deploy

From the installed CLI:

```bash
syndroo server init ./syndroo-site
cd syndroo-site
syndroo server doctor --json
syndroo server deploy --yes
```

Omit `--github` for a local-only repository. If the user wants GitHub, use
`syndroo server init ./syndroo-site --github OWNER/REPO --private`; public
visibility requires an explicit `--public` choice. Wrangler browser login is a
human action. Deployment is also a separate authorized action.

The deploy command resolves and records one canonical HTTPS origin. It creates
only missing resources through verified APIs, never adopts same-name resources,
and preserves existing D1, queue, and Worker state. A repeat deployment uses the
verified stored account unless an explicit account setting is supplied and
conflicts with it.

`syndroo.config.jsonc` owns application settings, including the confirmed origin
and Threads connection reference. `wrangler.jsonc` owns Worker, D1, queue, cron,
and public-egress configuration. The CLI generates ignored effective deployment
configuration; do not maintain a duplicate application environment block or
commit account resource IDs.

An initial `--github` push happens before deployment and Threads connection, so
it does not contain the confirmed origin or connection. Deploy and connect then
update the tracked `syndroo.config.jsonc`. Those updates must reach the GitHub
repository before manual CI can use the same target. Review and explicitly
commit/push the config; setup never does that automatically.

## Register the callback

In the Meta app, register exactly:

```text
https://syndroo.example/oauth/callback/threads
```

Replace the example with the confirmed project origin. The origin must be a
canonical HTTPS origin with no credentials, path, query, fragment, or trailing
slash beyond the callback path. The Worker does not derive it from forwarding
headers.

## Connect Threads

Start with the Meta app ID:

```bash
syndroo server connect threads --app-id THREADS_APP_ID
```

The command prints the authorization URL and waits with a bounded poll. The user
must complete Meta's OAuth prompt in a browser. On success, the CLI verifies the
callback and automatically saves the connection reference to
`syndroo.config.jsonc`.

On a terminal, App Secret is read with echo disabled. A noninteractive caller can
use `THREADS_APP_SECRET` or `--app-secret-stdin`. Never put the App Secret in
argv, logs, JSON input, chat, or a screenshot. The CLI does not retain another
copy; the Worker stores provider credentials encrypted under `SECRET_KEY`.

For an uncertain connect result, reuse the same `--request-id`. A pending draft
resumes by default. Abandoning it requires both `--restart` and a different
explicit `--request-id`; `--restart` alone does not discard the saved identity.
Do not edit private state to force completion. This version has no automatic
Threads token refresh or key rotation. Reconnect explicitly when authorization
expires.

## Configure manual CI

After deployment and connection, ask for the target `owner/repository` and
authorization for the GitHub environment changes. Then run:

```bash
syndroo server ci setup github --repo OWNER/REPO --yes
```

The command installs this local file:

```text
.github/workflows/threads-publish.yml
```

The workflow is `workflow_dispatch` only, has `contents: read`, uses pinned
action commits, installs exact package versions with `npm ci`, and invokes:

```bash
npx --no-install syndroo server publish threads \
  --input "$INPUT_PATH" \
  --request-id "$REQUEST_ID" \
  --yes --json
```

CI setup creates or updates the `threads-ci` GitHub environment and configures:

| Kind | Name | Purpose |
| --- | --- | --- |
| Variable | `SYNDROO_URL` | Confirmed Worker origin |
| Secret | `SYNDROO_TOKEN` | Scoped `CI_BEARER`, distinct from `API_BEARER` |
| Secret | `SYNDROO_CONNECTION_ID` | One allowed Threads connection |

It preserves existing environment protections and unrelated workflows. It
uploads no Cloudflare admin bearer, `SECRET_KEY`, or `RUNTIME_KEY`. If an
existing scoped bearer cannot be recovered from private CLI state, supply it as
one bounded stdin value with `--ci-token-stdin`; never rotate an unknown bearer
silently.

Workflow installation is local. The command does not commit, push, dispatch, or
publish. Before dispatch, review the tracked diff and explicitly commit/push:

- `syndroo.config.jsonc`, including the confirmed origin and connection written
  by deploy/connect;
- `.github/workflows/threads-publish.yml`;
- intended tracked post documents under `posts/`.

Use existing authorization when it already covers this specific review and
push; otherwise ask for it. Stage those paths explicitly. Never commit
`.syndroo/`, `node_modules/`, `wrangler.effective.jsonc`, environment files, or
the private `serverctl-v1` state. The CLI does not push the merged changes.

## Publish

The post document is strict JSON with exactly one string property:

```json
{ "text": "Hello from Syndroo CI" }
```

Provide only the scoped token:

```bash
export SYNDROO_TOKEN
syndroo server publish threads \
  --input posts/hello.json \
  --request-id threads-ci:stable-content-revision \
  --yes --json
```

The request ID must match `[A-Za-z0-9._:-]{1,128}`. It identifies one logical
publication. Reuse it to recover a lost prepare or execute response for the same
content and connection; never reuse it for different content.

Optionally, CI can supply `SYNDROO_URL` and `SYNDROO_CONNECTION_ID`. When present,
they must match the project configuration. The workflow never receives an admin
token.

For CI, copy the generated workflow to the repository with the normal reviewed
change process and dispatch it manually with a checked-in post path and stable
request ID. The command prepares, explicitly executes, and waits for the
operation. It never creates a fresh publication identity after a timeout,
failed response, partial result, or unknown result.

Treat `unknown` as possibly published. Preserve its operation ID and report it as
unknown. Inspect the same operation or retry the same logical request ID; do not
send the same content under a new ID or assume a timeout means no post exists.
Exit `0` requires a settled `succeeded` result with at least one successful
delivery. `failed`, `partial`, `unknown`, timeout, and unavailable final status
stay distinct and fail clearly.

## Secret recovery and doctor

Server state and generated deployment values live under
`${XDG_STATE_HOME:-$HOME/.local/state}/syndroo/serverctl-v1`, protected by file
permissions and bound to project/account/Worker identity. This is not encryption
at rest. A clone cannot restore them. Back up the private directory securely, or
import all three deployment values together with
`server deploy --yes --credentials-stdin`. Missing values for an existing
deployment are never replaced by newly generated keys.

After an interrupted deploy, preserve the reported operation ID, confirmed
resources, and machine receipt and rerun the same project. Use `--recover` only
with user-verified nonsecret identifiers or Worker evidence. Doctor remains
read-only; `/health` proves reachability only, while OAuth and publication
readiness remain explicitly unverified until the corresponding human actions
and checks succeed.
