# Syndroo CLI reference (protocol v1)

Three commands: `connect`, `publish`, `status`. This file is the exact surface;
the audit for each command and flag is the built `--help`.

## Global flags

| Flag | Effect |
| --- | --- |
| `--config <absolute path>` | Select the configuration file. A relative path is refused. |
| `--json` | Exactly one JSON envelope on stdout; diagnostics on stderr. |
| `--verbose` | Extra diagnostics on stderr; `--json` output is unchanged. |
| `--no-color` | Disable ANSI styling (`NO_COLOR` and non-TTY do the same). |
| `--help`, `-h` | Print help and exit `0`. |
| `--version` | Print `<version> (node <version>)` and exit `0`. |

A repeated global flag is a usage error. Bare `syndroo`, `--help` and `--version`
read no config, credentials, state or network.

## Paths

| What | Where |
| --- | --- |
| Config | `${XDG_CONFIG_HOME:-$HOME/.config}/syndroo/config.json`, or an absolute `--config` path |
| State | `${XDG_STATE_HOME:-$HOME/.local/state}/syndroo/runtime-v1`, or the config's `stateRoot` |

State directories are `0700`, files `0600`; that is access control, not
encryption, and the state holds post text and account identity.

## `connect`

```text
syndroo connect [options] [provider]
```

| Option | Effect |
| --- | --- |
| `--label <label>` | Set the connection label. |
| `--connection <connectionId>` | Reconnect or refresh an existing connection. |
| `--from-env` | Import credentials from `SYNDROO_CREDENTIALS`. |
| `--credential-file <path>` | Import credentials from a JSON file. |
| `--update <connectionId>` | Change label or default flag. |
| `--disconnect <connectionId>` | Disconnect a stored connection. |
| `--input <file>` | Whole machine `ConnectRequest`; `-` reads stdin. Not with a provider positional. |
| `--default` / `--no-default` | Set or clear the default flag. Only with `--update`. |

```bash
syndroo connect bluesky
syndroo connect bluesky --from-env
syndroo connect bluesky --credential-file ./bluesky.json
syndroo connect bluesky --label work
syndroo connect bluesky --connection conn_example
syndroo connect --input ./connect.json
syndroo connect --update conn_example --label personal
syndroo connect --update conn_example --default
syndroo connect --disconnect conn_example
```

The four entry points — a provider positional, `--input`, `--update`,
`--disconnect` — are mutually exclusive. `--default` without `--update` is a
usage error: the default flag is set with
`syndroo connect --update <connectionId> --default`.

`--from-env` and `--credential-file` are mutually exclusive. A `resume` request
is only accepted from stdin. On a terminal a credential step is prompted field by
field; secret fields are read with echo disabled. Without a terminal, or with
`--json`, the command returns `action_required` and exits `0`.

### Connect requests

```json
{ "type": "start", "provider": "bluesky", "label": "work" }
```
```json
{
  "type": "resume",
  "connectSessionId": "cs_example",
  "stepRevision": 1,
  "input": { "type": "credentials", "credentials": { "identifier": "you.bsky.social", "password": "APP_PASSWORD" } }
}
```
```json
{ "type": "update", "connectionId": "conn_example", "changes": { "label": "personal", "isDefault": true } }
```
```json
{ "type": "disconnect", "connectionId": "conn_example" }
```

`resume` `input` is either `{ "type": "credentials", "credentials": <object> }`
or `{ "type": "callback_complete" }`.

## `publish`

```text
syndroo publish [options]
```

| Option | Effect |
| --- | --- |
| `--input <file>` | Read a request document; `-` reads stdin. |
| `--data <json>` | Inline request document. |
| `--retry <operationId>` | Retry an operation's eligible targets. |
| `--to <connectionId>` | Retry target; repeatable and required with `--retry`. |
| `--request-id <id>` | Stable request identity for this logical call. |
| `--dry-run` | Offline preview; no state, credential or network access. |

Exactly one of `--input`, `--data`, or `--retry`. A document without a `type` is a
`content` + `targets` document and becomes a `prepare`: the wire `PublishRequest`
always requires a `type`, and the CLI adds `"type": "prepare"` before the
document reaches Core. An `execute` request is read only from stdin.

```bash
syndroo publish --input post.json
syndroo publish --input post.json --dry-run
syndroo publish --data '{"type":"prepare","content":{"text":"Hello"},"targets":[{"provider":"bluesky"}]}'
syndroo publish --input - --json < execute.json
syndroo publish --retry op_example --to conn_example
```

### Publish requests

```json
{ "type": "prepare", "content": { "text": "…" }, "targets": [{ "provider": "bluesky" }] }
```
```json
{
  "type": "prepare",
  "content": { "text": "Hello" },
  "targets": [
    { "provider": "bluesky", "connection": "conn_example" },
    { "provider": "mastodon", "options": { "visibility": "public" } }
  ]
}
```
```json
{ "type": "execute", "approvalToken": "at_example" }
```
```json
{ "type": "retry", "retryOf": "op_example", "targets": [{ "provider": "bluesky", "connection": "conn_example" }] }
```

A target is `{ provider, connection?, content?, options? }`. `options` is
validated against the provider's `publishOptions` schema; a provider that
declares no options rejects any.

## `status`

```text
syndroo status [options]
```

| Option | Effect |
| --- | --- |
| `--provider <providerId>` | Ask about one provider. |
| `--connections` | List stored connections (combines with `--provider`). |
| `--operation <operationId>` | Read one operation. |
| `--operations` | Page through operation summaries. |
| `--limit <count>` | Page size, 1 to 100. |
| `--cursor <cursor>` | Opaque cursor. |

```json
{ "type": "overview" }
{ "type": "provider", "provider": "bluesky" }
{ "type": "connections", "provider": "bluesky" }
{ "type": "operation", "operationId": "op_example" }
{ "type": "operations", "limit": 20, "cursor": "…" }
```

At most one of `--connections`, `--operation`, `--operations`. `--limit` and
`--cursor` belong only to `--operations`. Read-only: no provider call, no secret
read, no state write.

## Credential fields

| Provider | Fields |
| --- | --- |
| `bluesky` | `identifier`, `password` (app password) |
| `devto` | `apiKey` |
| `linkedin` | `client_id`, `client_secret` |
| `threads` | `client_id`, `client_secret` |
| `mastodon` | `{}` (empty) |

`--from-env` reads one variable, `SYNDROO_CREDENTIALS`, holding a strict-JSON
object of those fields. `--credential-file` reads the same object from a file.
Sources are never mixed or guessed.

## JSON output

```json
{
  "protocolVersion": 1,
  "operation": "status",
  "ok": true,
  "result": { "type": "connections", "connections": [] },
  "error": null
}
```

On failure `ok` is `false`, `result` is `null`, and `error` is
`{ "code", "message", "details"? }` with a static safe message.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Handled: a query read, a prepare or execute returned, or a run fully succeeded. A prepare returning `confirmation_required` is `0`. |
| `1` | Local failure or a durability failure. |
| `2` | Usage, configuration, input, authentication or preflight rejection. Nothing sent. |
| `4` | An execution round returned `unknown`. |
| `5` | A human explicitly declined. Nothing sent. |
| `6` | Execution finished and is known not to be fully successful (`failed`/`partial`). |
| `130` | The process stopped on a signal. |

Read `result.status` as well as the code: `0` never means a platform published.

## Retired syntax

There is no `doctor`, `posts`, `skill`, `auth`, `init`, `receipts`, `retry`,
`state` or `local *` command, and no `--yes`/`--no-input`. Historical note only.
