# Agent quickstart

The short path for an agent or automation that drives the `syndroo` CLI. The
packaged Skill (`packages/cli/skills/syndroo/SKILL.md`) carries the same workflow
with more detail; this page is the repo-side summary.

The default CLI path is protocol v1 with three commands: `connect`, `publish`,
and `status`. Publishing is two explicit phases. `publish` with a `prepare`
request returns a `confirmation_required` result and an approval token; a second
`publish` with an `execute` request carries that token. Nothing is sent until the
execute call. The optional `server` path is separate and documented below.

The install target is the CLI, provider contract, and all five official
providers pinned to `0.7.0` in one npm command. Check that the version is
available before advertising it; a prepared tarball is not registry evidence.

## Establish the runtime before installing

Onboarding fails when the install lands in one Node installation and later
commands resolve another, or when a chat or home directory is used instead of the
project. Fix the context first, then install.

1. `cd` to the project that will run Syndroo, and note the runtime manager it
declares (mise, asdf, Volta, nvm, Homebrew, system Node). The examples use mise;
use the equivalent for the manager you actually have. Do not assume Homebrew.
2. Record the runtime that is actually in effect and the global prefix it
installs into:

```bash
command -v node npm
node --version                 # must be >=24.19.0
npm --version
npm root --global
npm prefix --global
```

3. Use that same runtime for the install, the version check, the Skill lookup,
and every later command. With mise:

```bash
# Run the complete npm install command below prefixed with mise exec --.
mise exec -- syndroo --version
mise exec -- npm root --global
mise which node
mise which npm            # real paths behind the shims
```

4. Verify the shell resolves an executable for the install you just made. A
manager shim is expected, so check the resolved target instead of comparing
pathnames:

```bash
command -v syndroo
syndroo --version
mise which syndroo             # when the manager reports command paths
```

If `syndroo` is not found, activate the project runtime (`mise exec --`,
`mise activate`, or the manager's equivalent) or run the install once with the
manager you intend to keep using. Several Node installations may coexist, for
example Homebrew plus a project-local mise version; `command -v node` shows which
one wins, so invoke the manager explicitly when it is not the one the project
declares. Do not add a second global install under a different Node, and do not
prepend a package-manager bin directory to `PATH` to work around a shim. Report
the resolved `node`, `npm`, global root, and executable target when asking for
help; the paths are the evidence, not the version alone.

## Install after publication

Verify `node --version` reports `>=24.19.0` from the project directory, then
install the complete default CLI set:

```bash
npm install --global \
  @syndroo/cli@0.7.0 \
  @syndroo/provider-sdk@0.7.0 \
  @syndroo/provider-bluesky@0.7.0 \
  @syndroo/provider-threads@0.7.0 \
  @syndroo/provider-linkedin@0.7.0 \
  @syndroo/provider-mastodon@0.7.0 \
  @syndroo/provider-devto@0.7.0
syndroo --version
skill_root="$(npm root --global)/@syndroo/cli/skills/syndroo"
test -f "$skill_root/SKILL.md"
```

Read `$skill_root/SKILL.md` and its selected reference after installation, using
the same `npm` for the lookup. A Skill file proves that guidance shipped; it does
not prove that a particular Agent client automatically discovered or activated
it.

## The sequence

```bash
syndroo --version
syndroo status --json

# prepare, then show the preview to the user and get explicit approval
echo '{"type":"prepare","content":{"text":"Hello from Syndroo"},"targets":[{"provider":"bluesky"}]}' \
  | syndroo publish --input - --request-id req_agent_001 --json

# execute only after that approval, with the token the prepare returned
echo '{"type":"execute","approvalToken":"at_example"}' \
  | syndroo publish --input - --json

syndroo status --operation op_example --json
```

1. Confirm the CLI runs here and which providers have an active connection.
   `status` is read-only and never calls a provider or reads a secret.
2. Save a request identity. `--request-id <id>` is the stable key for one logical
   call; reuse it if you must retry a lost response, and never reuse it for
   different content.
3. Prepare. The result is `confirmation_required` with the `preview`,
   `operationId`, `approvalToken` and `expiresAt`. A `prepare` does not publish.
   Each preview target now carries the frozen provider `preview`
   (`content` + `fields`) and, when the provider supplied one, a `presentation`
   (`accountName`/`profileUrl`); that is the payload the execute call will send,
   not a re-derivation of it.
4. Show the preview to the user and get explicit approval. A zero exit from a
   prepare is not approval.
5. Execute with the token. In `--json` there is never an implicit prompt; an
   execute request is accepted only from stdin.
6. Report every target from the execution result, then read `status --operation`
   if you need the settled record. `status --operation` renders the same
   publication view as `publish`, is a single read that never polls or calls a
   provider, and prefixes a not-yet-settled stored record with
   `Last recorded status:` so a saved `in_flight` cannot look like a live
   confirmation.

When one specific publication already has the user's approval in this
conversation, `publish --input post.json --yes --json` prepares, auto-confirms and
executes in one call and prints exactly one final execution envelope — no second
prepared payload and no approval token on stdout. `--yes` is not a blanket
authorization: it re-mints no credential, bypasses no identity, expiry, provider
validation, frozen-payload or idempotency rule, and creates no second `prepare`.
With `--json` and no `--yes` the single envelope is the prepared result.

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

## Optional user-owned server

Use `server` only when the user wants a Syndroo Cloudflare deployment or a post
through that deployment. It shares protocol contracts with the local CLI but has
separate state and credentials.

1. Ask whether the user wants a GitHub repository. If yes, require
   `owner/repository` and visibility; private is default. Run
   `syndroo server init <directory>` for a local-only project or add explicit
   `--github OWNER/REPO --private|--public`. Only the explicit GitHub form
   creates and pushes a remote.
2. Run `syndroo server doctor --json`. Treat `missing`, `not_configured`,
   `attention_required`, and `unverified` as different states. `/health` proves
   liveness only; doctor never repairs or provisions.
3. Obtain authorization for this exact deployment, then run
   `syndroo server deploy --yes`. Let the user complete Wrangler's browser login.
   Omit `--account` on a rerun to use the verified stored account; explicit
   account settings must agree with it. If `SERVER_DEPLOY_ACCOUNT_SELECTION_REQUIRED`
   reports that the account cannot be used, run the project-local
   `./node_modules/.bin/wrangler whoami` and ask the user to choose an ACCOUNT ID;
   a member or user ID is not an account ID. Retry the login only if that check
   reports the session itself failed.
4. If the deploy is left pending, read `details.evidence` and follow
   `nextAction` rather than guessing: exit, timeout, output limit, and receipt
   state (missing, unreadable, invalid, incomplete, another Worker, another
   target) are reported separately. `RETRY_DEPLOY` means the subprocess never
   started; `RERUN_DEPLOY_TO_RECONCILE` means rerun the same project and let a
   complete receipt reconcile; only `PROVIDE_DEPLOY_RECOVERY` needs explicit
   evidence. A missing or invalid receipt can make that rerun ask for it.

   The canonical read-only procedure for the Worker tag and active version is in
   the packaged Skill reference `references/server.md`; it uses the project-local
   Wrangler pinned to the verified account, checks the public target through that
   Worker's Domains & Routes metadata, and never the Worker name or `/health` as
   proof. Then supply exactly the verified pair, and treat recovery as a baseline
   that still needs deployment authorization for the new version:

   ```bash
   printf '%s\n' '{"workerTag":"VERIFIED_WORKER_TAG","versionId":"VERIFIED_VERSION_ID"}' \
     | syndroo server deploy --yes --recover -
   ```

5. For Threads, register
   `https://<deployed-origin>/oauth/callback/threads`, then run
   `syndroo server connect threads --app-id <id>`. App Secret comes from hidden
   input, `THREADS_APP_SECRET`, or `--app-secret-stdin`; never argv or chat.
   Reuse the pending `--request-id` after uncertainty. Abandon it only with both
   `--restart` and a different explicit request ID.
6. Continue to manual CI only when the user asks:
   `syndroo server ci setup github --repo OWNER/REPO --yes`. The command creates
   a local manual workflow and scoped GitHub environment without uploading admin
   or encryption keys. It does not commit, push, dispatch, or publish. The
   initial `--github` push predates deploy/connect, so review and explicitly
   commit/push the updated `syndroo.config.jsonc`, generated workflow, and
   intended posts before dispatch. Use existing authorization when it already
   covers that exact push. Never add `.syndroo/`, `node_modules/`,
   `wrangler.effective.jsonc`, environment files, or private server state.
7. A real post is a separate authorized action:

```bash
syndroo server publish threads \
  --input posts/hello.json \
  --request-id REQUEST_ID \
  --yes --json
```

Provide only the scoped `SYNDROO_TOKEN` to that process. Reuse the same request
ID after a timeout or unknown result; never mint a replacement automatically.

Server state and generated deployment credentials live under
`${XDG_STATE_HOME:-$HOME/.local/state}/syndroo/serverctl-v1` with restrictive
permissions, but without encryption at rest. Preserve reported operation IDs,
resources, and receipts after interruption. Back up the private store securely;
a clone cannot restore secret values. Missing existing credentials require a
protected import via `server deploy --yes --credentials-stdin`, not key
regeneration. Do not edit private state by hand.

## Limits

`0.7.0` is release-prepared and fixture-tested: five providers are wired with
controlled fixtures; no live account has been connected and no real post has been
published. No package is claimed available until registry installation succeeds.
There is no scheduling, media, threads/replies, batch or watch mode, and no
automatic token refresh. LinkedIn, Threads and Mastodon connect through an
OAuth `open_url` step that needs connect options and a browser callback; the
local CLI completes that callback itself, either by binding the loopback
redirect `--redirect-uri` registers or by reading the redirected URL from
standard input with `--callback-url -`. No live account has been connected, so
the platform side of those three flows stays unverified. Bluesky and DEV.to
connect with credentials only.

See [cli-manual.md](cli-manual.md) for the full command and envelope reference,
and the packaged `references/cli.md` and `references/delivery-semantics.md` for
the agent-facing detail.
