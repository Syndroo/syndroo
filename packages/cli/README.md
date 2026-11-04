# @syndroo/cli

The `syndroo` command: a local-first client for protocol **v1**. It publishes
plain text to Bluesky, Threads, LinkedIn and Mastodon, and articles to DEV.to,
from the machine it runs on. That local path has no server, queue or database.
The same package also ships an optional `server` workflow for a user-owned
Cloudflare deployment with its own state and credentials.

The repository prepares a `0.7.0` release; registry availability must be checked
before installation is announced. The CLI has **no live-account acceptance**.
Provider paths are covered by tests against recorded API evidence and controlled
fixtures.

## Install and run

Resolve the project directory and runtime first, then install with that runtime.
An install into one Node installation while the project shell resolves another
is the usual cause of a missing `syndroo`:

```bash
cd /path/to/project
command -v node npm
node --version                         # requires >=24.19.0
npm root --global
npm prefix --global
```

Any of mise, asdf, Volta, nvm, Homebrew, or a system Node can provide the
runtime; none is assumed. Use the same one for the install, the version check,
the Skill lookup, and later commands. With mise, for example:

```bash
# Run the complete npm install command below prefixed with mise exec --.
mise exec -- syndroo --version
mise which node
mise which npm                    # real paths behind the shims
```

Manager shims are expected, so confirm the shell resolves an executable for the
install you just made instead of comparing pathnames:

```bash
command -v syndroo
syndroo --version
```

If it does not resolve, activate the project runtime or run the install once with
the manager you intend to keep using. Do not add a second global install under a
different Node, and do not prepend a package-manager bin directory to `PATH` to
work around a shim.

Once published, install the CLI with its provider contract and all five official
providers so explicit provider discovery is complete:

```bash
node --version                         # requires >=24.19.0
npm install --global \
  @syndroo/cli@0.7.0 \
  @syndroo/provider-sdk@0.7.0 \
  @syndroo/provider-bluesky@0.7.0 \
  @syndroo/provider-threads@0.7.0 \
  @syndroo/provider-linkedin@0.7.0 \
  @syndroo/provider-mastodon@0.7.0 \
  @syndroo/provider-devto@0.7.0
syndroo --help
syndroo --version
```

Requires Node.js `>=24.19.0`. The bundle inlines private `@syndroo/core` and
`@syndroo/provider-sdk`, so it needs no unpublished package at runtime. The
package ships `dist/`, `skills/`, `LICENSE`, `NOTICE`, the generated bundled-code
license inventory, and this README.

## Commands

Three local business commands plus the optional `server` command family, help
and version. `syndroo` alone, `syndroo --help` and `syndroo --version` need no
configuration, credentials, state or network.

```bash
syndroo connect bluesky
syndroo publish --input post.json
syndroo status
```

Global flags: `--config <absolute path>`, `--json`, `--verbose`, `--no-color`,
`--help`/`-h`, `--version`.

### connect

```bash
syndroo connect bluesky
syndroo connect bluesky --from-env
syndroo connect bluesky --credential-file ./bluesky.json
syndroo connect bluesky --label work
syndroo connect --update conn_example --default
syndroo connect --update conn_example --label personal
syndroo connect --disconnect conn_example
syndroo connect --input -     # machine ConnectRequest on stdin
```

On a terminal, a credential step is prompted field by field; secret fields are
read with echo disabled. Without a terminal, or with `--json`, the command
reports `action_required` and exits `0` instead of blocking. `--from-env` reads
`SYNDROO_CREDENTIALS`; `--credential-file` reads one JSON file. Both carry the
provider's own credential field names and are imported once.

The entry points are mutually exclusive: a provider positional, `--input`,
`--update` and `--disconnect`. `--default`/`--no-default` are only accepted with
`--update`, and `--input` cannot be combined with a provider positional.

### publish

```bash
syndroo publish --input post.json
syndroo publish --input post.json --dry-run
syndroo publish --data '{"type":"prepare","content":{"text":"Hello"},"targets":[{"provider":"bluesky"}]}'
syndroo publish --retry op_example --to conn_example
syndroo publish --input - --json < execute.json
```

Exactly one source: `--input <file|->`, `--data <json>`, or `--retry
<operationId>` with one or more `--to <connectionId>`. A document without a
`type` is an ordinary `content` + `targets` document and becomes a `prepare`.
An `execute` request carries a live approval token and is only read from stdin.

In human mode a prepare prints the full preview and asks the controlling terminal
for an explicit `y`/`yes`; only a confirmed run executes. `--json` never prompts.
A run with no terminal prints the preview and the exact later command and exits
`0` without sending. `--dry-run` is an offline preview: no state write, no
credential resolution, no network call.

### status

```bash
syndroo status
syndroo status --provider bluesky
syndroo status --connections
syndroo status --operation op_example
syndroo status --operations --limit 20
```

Read-only. It never calls a provider, reads a secret, or writes state.

### server

The server path initializes a thin repository whose Worker artifact comes from
the packed `@syndroo/cloudflare` package. The generated project has one tracked
application config (`syndroo.config.jsonc`) and one tracked platform config
(`wrangler.jsonc`). A private, ignored effective Wrangler file is generated for
deployment.

```bash
syndroo server init ./syndroo-site
syndroo server init ./syndroo-site --github OWNER/REPO --private
syndroo server --project ./syndroo-site doctor --json
syndroo server --project ./syndroo-site deploy --yes
syndroo server --project ./syndroo-site connect threads --app-id THREADS_APP_ID
syndroo server --project ./syndroo-site ci setup github --repo OWNER/REPO --yes
syndroo server --project ./syndroo-site publish threads \
  --input posts/hello.json --request-id RELEASE_001 --yes --json
```

`server init` is local by default. Only `--github` creates and pushes the named
GitHub repository; private is the default and public requires `--public`.
Deployment requires `--yes`. Browser login uses the installed Wrangler. Threads
App Secret arrives through hidden input, `THREADS_APP_SECRET`, or
`--app-secret-stdin`, never argv. CI setup creates a manual workflow locally and
configures a scoped GitHub environment; it does not commit, push, dispatch, or
publish. The initial `--github` push predates deploy/connect changes to
`syndroo.config.jsonc`; review and explicitly commit/push that config, the
workflow, and intended posts before manual dispatch. Keep `.syndroo/`,
`node_modules/`, `wrangler.effective.jsonc`, environment files, and private state
out of Git. A real Threads post needs a separate explicit
`publish threads --yes` invocation with a stable request ID.

Server state and generated deployment credentials live under
`${XDG_STATE_HOME:-$HOME/.local/state}/syndroo/serverctl-v1` with restrictive
permissions. They are bound to the project, Cloudflare account, and Worker and
are not tracked by Git. This is filesystem protection, not encryption at rest.
A clone cannot restore missing secret values. Back up the private store through
a protected channel, or import all three deployment credentials together on
stdin with `server deploy --yes --credentials-stdin`. Missing values are never
replaced by generating new keys for an existing deployment.

`server doctor` is read-only and distinguishes missing configuration,
unavailable checks, and `unverified` OAuth or publication readiness. A healthy
`/health` response proves liveness only.

The server path is fixture-tested and has not been deployed. No command in this
release-prepared tree claims live Cloudflare, GitHub, Meta, or Threads
acceptance.

## Configuration and state

| What | Where |
| --- | --- |
| Config | `${XDG_CONFIG_HOME:-$HOME/.config}/syndroo/config.json`, or an absolute `--config` path |
| State | `${XDG_STATE_HOME:-$HOME/.local/state}/syndroo/runtime-v1` |

```json
{
  "version": 1,
  "stateRoot": "/absolute/path/to/state",
  "providers": { "bluesky": { "path": "./plugins/bluesky" } }
}
```

`version` must be `1`. There is no `secretsRoot` key. The config file is strict
JSON, at most 64 KiB, rejects unknown top-level keys, and rejects any key that
looks like a token, secret, password, API key or credential. State directories
are `0700` and files `0600`; that limits access but is not encryption, and the
state holds post text and account identity in plain files.

## Credentials

| Provider | Fields | Notes |
| --- | --- | --- |
| `bluesky` | `identifier`, `password` | app password, not the account password |
| `devto` | `apiKey` | `api-key` header |
| `linkedin` | `client_id`, `client_secret` | authorization-code flow, no PKCE |
| `threads` | `client_id`, `client_secret` | authorization-code flow |
| `mastodon` | `{}` | OAuth with PKCE S256; instance is a connect option |

Credentials are imported once and then managed by Core. Never put a secret in a
shell argument, a document, a chat or a screenshot.

## JSON output

With `--json`, stdout carries exactly one envelope:

```json
{
  "protocolVersion": 1,
  "operation": "status",
  "ok": true,
  "result": { "type": "connections", "connections": [] },
  "error": null
}
```

`ok` means the call was handled, not that a platform published anything. Read
`result.status` as well as the exit code: `0` success, `1` local failure, `2`
usage/preflight rejection, `4` unknown write result, `5` declined, `6` not fully
delivered, `130` interrupted.

## The bundled Skill

The package ships `skills/syndroo/` (`SKILL.md` and its references). It teaches
the local v1 flow (status discovery, explicit connection, prepare, preview,
confirmation, execute, then status) and routes deployment work to its separate
server reference. It grants no permission and proves nothing about any agent
client.

## Honest limits

- No live end-to-end call to any platform has been made from this repository.
- Providers are `fixture-tested` against recorded API evidence and fixtures.
- LinkedIn pins `LINKEDIN_VERSION` and awaits re-verification; Threads uses a
  single `auto_publish_text=true` call.
- No scheduling, media, threads/replies, batch or watch mode, and no automatic
  token refresh.

Full reference: [docs/cli-manual.md](../../docs/cli-manual.md). Agent quickstart:
[docs/agent-quickstart.md](../../docs/agent-quickstart.md).
