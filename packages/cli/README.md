# @syndroo/cli

The `syndroo` command: a local-first client for protocol **v1**. It publishes
plain text to Bluesky, Threads, LinkedIn and Mastodon, and articles to DEV.to,
from the machine it runs on. There is no server, queue or database in this path.

`0.7.0-rc.1` is **unreleased** and has **no live-account acceptance**. Provider
paths are covered by tests against recorded API evidence and controlled
fixtures.

## Install and run

The package is not published, so build the workspace and run the bundle:

```bash
npm ci
npm run build
node packages/cli/dist/bin.js --help
```

Requires Node.js `>=24.19.0`. The bundle inlines private `@syndroo/core` and
`@syndroo/provider-sdk`, so it needs no unpublished package at runtime. The
package ships `dist/`, `skills/`, `LICENSE`, `NOTICE` and this README.

## Commands

Three business commands plus help and version. `syndroo` alone, `syndroo --help`
and `syndroo --version` need no configuration, credentials, state or network.

```bash
node packages/cli/dist/bin.js connect bluesky
node packages/cli/dist/bin.js publish --input post.json
node packages/cli/dist/bin.js status
```

Global flags: `--config <absolute path>`, `--json`, `--verbose`, `--no-color`,
`--help`/`-h`, `--version`.

### connect

```bash
node packages/cli/dist/bin.js connect bluesky
node packages/cli/dist/bin.js connect bluesky --from-env
node packages/cli/dist/bin.js connect bluesky --credential-file ./bluesky.json
node packages/cli/dist/bin.js connect bluesky --label work
node packages/cli/dist/bin.js connect --update conn_example --default
node packages/cli/dist/bin.js connect --update conn_example --label personal
node packages/cli/dist/bin.js connect --disconnect conn_example
node packages/cli/dist/bin.js connect --input -     # machine ConnectRequest on stdin
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
node packages/cli/dist/bin.js publish --input post.json
node packages/cli/dist/bin.js publish --input post.json --dry-run
node packages/cli/dist/bin.js publish --data '{"type":"prepare","content":{"text":"Hello"},"targets":[{"provider":"bluesky"}]}'
node packages/cli/dist/bin.js publish --retry op_example --to conn_example
node packages/cli/dist/bin.js publish --input - --json < execute.json
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
node packages/cli/dist/bin.js status
node packages/cli/dist/bin.js status --provider bluesky
node packages/cli/dist/bin.js status --connections
node packages/cli/dist/bin.js status --operation op_example
node packages/cli/dist/bin.js status --operations --limit 20
```

Read-only. It never calls a provider, reads a secret, or writes state.

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
the v1 flow: status discovery, an explicit connection, prepare, show the preview,
obtain confirmation, execute, then status. It grants no permission and proves
nothing about any particular agent client.

## Honest limits

- No live end-to-end call to any platform has been made from this repository.
- Providers are `fixture-tested` against recorded API evidence and fixtures.
- LinkedIn pins `LINKEDIN_VERSION` and awaits re-verification; Threads uses a
  single `auto_publish_text=true` call.
- No scheduling, media, threads/replies, batch or watch mode, and no automatic
  token refresh.

Full reference: [docs/cli-manual.md](../../docs/cli-manual.md). Agent quickstart:
[docs/agent-quickstart.md](../../docs/agent-quickstart.md).
