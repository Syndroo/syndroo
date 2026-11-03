# User-owned server workflow

Read this when the user wants a Syndroo Cloudflare deployment, a Threads account
on that deployment, or manual GitHub CI. This path is optional. The local
`connect`, `publish`, and `status` workflow remains independent and keeps its own
state.

Status: server commands are fixture-tested in `0.7.0`. Registry availability is
not implied by the prepared release, no deployment has been made, and no Threads
publication has passed live-account acceptance.

## Ask before external work

Establish the project directory, Cloudflare account, and whether the user wants
a GitHub repository. If they do, collect `owner/repository` and visibility.
Private is the default; public requires the user to choose it explicitly.

`server init` is local unless `--github` is present. That flag authorizes creating
the named GitHub repository and pushing the generated initial commit; it does
not authorize deployment or publication. Browser login, Meta app setup, OAuth
authorization, Cloudflare deployment, and each real post remain separate actions.
Use authorization the user already gave for the exact action and scope. Ask only
when it is missing.

The initial `--github` push predates deployment and Threads connection. A
successful deploy updates `syndroo.config.jsonc` with the public origin, and a
successful connect updates it with the App ID and connection reference. Before
manual CI dispatch, review and explicitly commit/push those tracked config
changes, the generated workflow, and intended tracked posts. Never commit
`.syndroo/`, `node_modules/`, `wrangler.effective.jsonc`, environment files, or
private server state. `server ci setup github` never performs that Git push.

## Initialize and inspect

Use the installed CLI in the requested empty directory:

```bash
syndroo server init .
```

The server-only guide may install `@syndroo/cli@0.7.0` by itself. `server init`
generates a project whose exact `@syndroo/cloudflare@0.7.0` and Wrangler
dependencies are installed there. Verify registry availability before running
either installation.

For an explicit GitHub repository:

```bash
syndroo server init . --github OWNER/REPO --private
```

Use `--public` only after the user selects public visibility. The generated
repository has one tracked application config, `syndroo.config.jsonc`, and one
tracked platform config, `wrangler.jsonc`:

- `syndroo.config.jsonc` owns the project ID, scope, confirmed public origin, and
  verified Threads App ID and connection reference.
- `wrangler.jsonc` owns the Worker name, entry artifact, compatibility settings,
  bindings, D1 declaration, queues, cron, and public-egress policy.
- `wrangler.effective.jsonc` is generated deployment input and ignored.
- `.syndroo/` contains private initialization recovery metadata and is ignored.
- `package-lock.json`, exact package versions, and `posts/hello.json` are
  generated and tracked.

Do not ask the user to maintain a second application config or edit the
effective Wrangler file. Account IDs, D1/Queue IDs, deployment receipts, and
secret values stay out of tracked files.

Run the read-only check from the project:

```bash
syndroo server doctor --json
```

Read each check. `not_configured`, `missing`, `attention_required`, and
`unverified` are distinct. Authenticated resource checks run only when local
deployment identity and credentials exist. A successful `/health` check proves
liveness only. Doctor does not prove OAuth or publication readiness and never
repairs, installs, generates keys, or mutates a resource.

## Deploy

Explain the target Worker, account, intended D1 and queue changes, and the fact
that deployment is about to occur. Then invoke the command with explicit
authorization for that exact deployment:

```bash
syndroo server deploy --yes
```

Nonsecret recovery data goes to `--recover <path|->`. Missing deployment
credentials go through hidden TTY input or `--credentials-stdin`; never put a
bearer or key in argv. `--json` never prompts. Omit `--account` on repeat
deployments to use the verified stored account. If the user supplies `--account`,
set `CLOUDFLARE_ACCOUNT_ID`, or configure Wrangler `account_id`, it must resolve
to the same recorded account.

The first deployment uses Wrangler's existing login flow. Let the user complete
browser authentication; do not ask for a token in chat. Deployment preflights
the project and pinned package versions, verifies Cloudflare identity and remote
resource ownership, creates only missing resources, writes any generated
credentials to the private server state store before upload, and uses a fresh
receipt for each new attempt. A retry keeps the same pending operation identity.
Do not adopt a same-name foreign Worker, D1 database, or queue by name.

The private store is
`${XDG_STATE_HOME:-$HOME/.local/state}/syndroo/serverctl-v1` with restrictive
permissions. It binds entries to the project, account, and Worker. Permissions
protect files; this store is **not encrypted at rest**. Existing values are
`API_BEARER`, `SECRET_KEY`, and `RUNTIME_KEY`.

To back up, stop another deploy from running and copy that private directory to
protected storage. A clone of the Git repository cannot recover the values. To
restore on another machine, place the protected state under the same XDG state
root with ownership and permissions intact, then run `syndroo server doctor`.
For a supported import path, provide all three values as one strict JSON object
on stdin:

```bash
syndroo server deploy --yes --credentials-stdin
```

The caller must obtain that JSON through a secure channel and must not print it.
Missing credentials for an existing Worker require import or backup restoration;
never generate replacement keys. This version has no key rotation or automatic
token refresh.

If a deploy was interrupted, preserve the reported operation ID, resources, and
machine receipt. Rerun the same project. A retained receipt may complete only
the matching pending operation after its Worker tag, active version, and target
are verified. Supply `--recover` only with user-verified nonsecret identifiers to
reconcile ownership; explicit Worker evidence establishes a baseline for a new
deploy and does not fabricate completion. Report safe failure details unchanged
to the caller.

## Threads OAuth

Require a registered Meta app and the exact callback
`PUBLIC_ORIGIN/oauth/callback/threads`. The origin is the canonical HTTPS origin
written by a confirmed deployment; do not derive it from headers or the current
shell.

Start with the app ID. The CLI saves the verified connection reference after the
OAuth callback succeeds:

```bash
syndroo server connect threads --app-id THREADS_APP_ID
```

On a terminal, the App Secret is read with echo disabled. A noninteractive
caller may provide it through `THREADS_APP_SECRET` or bounded
`--app-secret-stdin`. Never pass it in argv, request JSON, logs, or chat. Show
the authorization URL to the user and wait for them to complete Meta's prompt.

Use the same `--request-id` when recovering an uncertain attempt. `--restart`
alone resumes the current draft; abandoning it requires both `--restart` and a
different explicit `--request-id`. Save no extra copy of the App Secret.

## Manual CI

CI setup requires a confirmed deployment, a connected Threads account, explicit
repository selection, and authorization:

```bash
syndroo server ci setup github --repo OWNER/REPO --yes
```

The command creates or updates the scoped `threads-ci` GitHub environment and
the manual `.github/workflows/threads-publish.yml` file locally, and it uploads
only the generated scoped Threads bearer and connection ID. It preserves
existing environment protections and unrelated workflows. It does not send the
Cloudflare admin bearer, `SECRET_KEY`, or `RUNTIME_KEY` to GitHub.

For an `action_required` result, reuse the stored scoped bearer with
`--ci-token-stdin`; do not rotate a credential whose existing value is unknown.
The workflow file is a local change. Setup does not commit, push, dispatch, or
publish. Tell the user which file changed and let a separate authorized Git
workflow publish it. First show the user the tracked changes to
`syndroo.config.jsonc`, `.github/workflows/threads-publish.yml`, and any intended
post file. After their authorization, stage those paths explicitly, review the
diff, commit, and push. Reuse existing authorization when it already covers this
specific review and push. Do not include ignored private/effective files.

## Publication

Deployment and CI setup never publish. A real Threads post is a separate action:

```bash
syndroo server publish threads \
  --input posts/hello.json \
  --request-id REQUEST_ID \
  --yes --json
```

The input is strict JSON with exactly one string property: `{ "text": "..." }`.
The caller supplies the scoped token through `SYNDROO_TOKEN`; optional
`SYNDROO_URL` and `SYNDROO_CONNECTION_ID` must agree with project config. Do not
use the admin token for publication.

Use a stable request ID for one logical post. On timeout, lost response, or
`unknown`, inspect the same operation and reuse the same request ID when
recovering. Never mint a fresh ID or await the post again under a new identity
after an uncertain result. Report `succeeded`, `failed`, and `unknown` separately.

## Integration checks

Server JSON is one `operation: "server"` envelope with a subcommand
discriminator. Preserve safe error `details`, especially `operationId`,
`failedStep`, `nextAction`, `confirmedResources`, `receiptRetained`, and
`machineRecord`. When a command returns `action_required`, perform the named
human action or safe import and retry; do not edit private state by hand.
