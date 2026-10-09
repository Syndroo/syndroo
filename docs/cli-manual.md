# Syndroo CLI manual

This manual covers the architecture-v1 `syndroo` command: `connect`, `publish`
and `status`. The CLI is the local runtime of protocol v1 and shares its contract
with the self-hosted server ([remote-compatibility.md](remote-compatibility.md)).

Status: the CLI is **unreleased** (`0.7.0-rc.1`) and has **no live-account
acceptance**. Provider paths are covered by tests against recorded API evidence
and controlled fixtures. Every command and flag on this page was checked against
the built `dist/bin.js`: each per-command `--help` and each documented invocation
was run and its exit code recorded.

## Install and run

`@syndroo/cli` is not published. Build the workspace and run the bundle:

```bash
npm ci
npm run build
node packages/cli/dist/bin.js --help
```

`@syndroo/cli` requires Node.js `>=24.19.0`. The bundle inlines private
`@syndroo/core` and `@syndroo/provider-sdk`, so it needs no unpublished package
at runtime.

## Command surface

Three business commands, plus help and version:

```text
connect [options] [provider]  Connect, update or disconnect a provider account.
publish [options]             Prepare, execute or retry a publication.
status [options]              Query providers, connections and operations.
```

A bare `syndroo`, `syndroo --help`, `syndroo -h`, `syndroo --version` and
`syndroo <command> --help` need no configuration, credentials, state writes or
network calls.

### Global flags

Extracted before the command, so they work anywhere on the line:

| Flag | Effect |
| --- | --- |
| `--config <absolute path>` | Select the configuration file. A relative path is refused. |
| `--json` | Write exactly one JSON envelope to stdout; diagnostics and any human preview go to stderr. |
| `--verbose` | Add diagnostics on stderr. `--json` output is unchanged. |
| `--no-color` | Disable ANSI styling. `NO_COLOR` and a non-TTY stdout do the same. |
| `--help`, `-h` | Print help and exit `0`. |
| `--version` | Print `<version> (node <version>)` and exit `0`. |

A repeated global flag is a usage error, not last-one-wins.

### `connect`

| Flag | Effect |
| --- | --- |
| `[provider]` | Provider id to connect, for example `bluesky`. |
| `--label <label>` | Set the connection label. |
| `--connection <connectionId>` | Reconnect or refresh an existing connection. |
| `--from-env` | Import credentials from `SYNDROO_CREDENTIALS`. |
| `--credential-file <path>` | Import credentials from a JSON file. |
| `--update <connectionId>` | Change a connection's label or default flag. |
| `--disconnect <connectionId>` | Disconnect a stored connection. |
| `--input <file>` | Read a whole machine `ConnectRequest`; `-` reads stdin. Cannot be combined with a provider positional. |
| `--redirect-uri <uri>` | OAuth redirect URI to register; defaults to a loopback URI. |
| `--callback-url <url>` | Redirected URL to verify; `-` reads it from standard input. |
| `--default` | Mark the connection as default. Only valid with `--update`. |
| `--no-default` | Clear the default flag. Only valid with `--update`. |

```bash
node packages/cli/dist/bin.js connect bluesky
node packages/cli/dist/bin.js connect bluesky --from-env
node packages/cli/dist/bin.js connect bluesky --credential-file ./bluesky.json
node packages/cli/dist/bin.js connect bluesky --label work
node packages/cli/dist/bin.js connect bluesky --connection conn_example
node packages/cli/dist/bin.js connect --input ./connect.json
node packages/cli/dist/bin.js connect --update conn_example --label personal
node packages/cli/dist/bin.js connect --update conn_example --default
node packages/cli/dist/bin.js connect --update conn_example --no-default
node packages/cli/dist/bin.js connect --disconnect conn_example
```

A provider positional starts a connection. On a terminal, a `credential_input`
step is prompted field by field and secret fields are read with echo disabled.
Without a terminal, or with `--json`, the CLI reports `action_required` and exits
`0`; it never blocks waiting for input. `--from-env` and `--credential-file` are
mutually exclusive, and neither is guessed when the provider needs credentials.

The four entry points are mutually exclusive: a provider positional,
`--input`, `--update` and `--disconnect`. `--label` and `--connection` belong to
the provider positional; `--label`, `--default` and `--no-default` belong to
`--update`. `--default` without `--update` is a usage error, so the default flag
is set with `connect --update <connectionId> --default`, not on the initial
connect.

A `resume` request carries credentials or a callback exchange and is therefore
only accepted from stdin (`--input -`), never from a named file.

### `publish`

| Flag | Effect |
| --- | --- |
| `--input <file>` | Read a request document; `-` reads stdin. |
| `--data <json>` | Inline request document. |
| `--retry <operationId>` | Retry an operation's eligible targets. |
| `--to <connectionId>` | Retry target connection; repeatable. Required with `--retry`. |
| `--request-id <id>` | Stable request identity for this logical call. |
| `--dry-run` | Offline preview; no state, credential or network access. |

Exactly one source: `--input <file>`, `--data <json>`, or `--retry <operationId>`
with one or more `--to <connectionId>`. A conflict, a missing source, `--to`
without `--retry`, or `--dry-run` with `--retry` is a usage error.

```bash
node packages/cli/dist/bin.js publish --input post.json
node packages/cli/dist/bin.js publish --input post.json --dry-run
node packages/cli/dist/bin.js publish --data '{"type":"prepare","content":{"text":"Hello"},"targets":[{"provider":"bluesky"}]}'
node packages/cli/dist/bin.js publish --input - --json < execute.json
node packages/cli/dist/bin.js publish --retry op_example --to conn_example
```

In human mode a `prepare` result prints the full preview and then asks the
controlling terminal for an explicit `y`/`yes`. A confirmed run executes the same
in-process token and prints the execution; a declined answer prints the exact
later command and exits `5`; a run with no terminal prints the preview and the
later command and exits `0` without sending. `--json` never prompts.

An execute request carries a live approval token, so it is only ever read from
stdin. A `retry` request built from `--retry`/`--to` resolves each connection id
through `status --connections`; an unknown id is `NOT_FOUND` and a repeated id is
`DUPLICATE_TARGET`.

### `status`

| Flag | Effect |
| --- | --- |
| `--provider <providerId>` | Ask about one provider. |
| `--connections` | List stored connections. May be combined with `--provider`. |
| `--operation <operationId>` | Read one operation. |
| `--operations` | Page through operation summaries. |
| `--limit <count>` | Page size for `--operations`, 1 to 100. |
| `--cursor <cursor>` | Opaque cursor for `--operations`. |

```bash
node packages/cli/dist/bin.js status
node packages/cli/dist/bin.js status --provider bluesky
node packages/cli/dist/bin.js status --connections
node packages/cli/dist/bin.js status --provider bluesky --connections
node packages/cli/dist/bin.js status --operation op_example
node packages/cli/dist/bin.js status --operations --limit 20
node packages/cli/dist/bin.js status --operations --limit 20 --cursor <cursor>
```

At most one of `--connections`, `--operation` and `--operations` may be used.
`--provider` cannot be combined with `--operation` or `--operations`. `--limit`
and `--cursor` belong only to `--operations`. With no selector, the overview is
returned. Nothing here creates the state root, takes a write lock, reads a secret
or calls a provider: reads never mutate and never repair.

## Configuration

```json
{
  "version": 1,
  "stateRoot": "/absolute/path/to/state",
  "providers": { "bluesky": { "path": "./plugins/bluesky" } }
}
```

| Key | Meaning |
| --- | --- |
| `version` | Must be `1`. Any other value is refused and never migrated. |
| `stateRoot` | Optional. An absolute path, or a path resolved against the config file's directory. Defaults to `$XDG_STATE_HOME/syndroo/runtime-v1`. |
| `providers` | Optional. Provider id to `{ "path": "<local package root>" }`, at most 100 entries. An override replaces the built-in catalog entry and its provenance. |

The default config file is `$XDG_CONFIG_HOME/syndroo/config.json`, falling back
to `$HOME/.config/syndroo/config.json`. `--config` is the only way to select
another one, and it must be an absolute path that exists. The file is at most
64 KiB, must be strict JSON, rejects unknown top-level keys, and rejects any key
that looks like a token, secret, password, API key or credential rather than
ignoring it. State root and provider paths resolve against the config file's
directory, so changing the working directory cannot change which plugin or which
state a run uses.

## State

State lives under the resolved state root. Directories are created `0700` and
files `0600`. Those permissions limit access; they are not encryption. The state
holds connection records, operation intent, deliveries and a request journal, and
it contains post text and account identity in plain files.

`status` never repairs state. A lock whose owner record is missing is fail-closed:
the CLI will not delete or reclaim it on its own. Diagnose that condition by hand
with every Syndroo process stopped, and keep the files as evidence.

## Credentials

Credentials are imported once and then managed by Core. Later calls read the
Core credential store, never the original environment variable or file.

`--from-env` reads exactly one variable, `SYNDROO_CREDENTIALS`, whose value is a
strict-JSON object of the provider's credential fields. `--credential-file <path>`
reads the same object from a plain JSON file.

| Provider | Credential fields | Notes |
| --- | --- | --- |
| `bluesky` | `identifier`, `password` | `password` is an app password, not the account password. The positional `connect bluesky` form works. |
| `devto` | `apiKey` | Sent as the `api-key` header; identity is `GET /api/users/me`. The positional `connect devto` form works. |
| `linkedin` | `client_id`, `client_secret` | Authorization-code flow; needs a `start` request with `redirectUri`. PKCE is deliberately absent. |
| `threads` | `client_id`, `client_secret` | Authorization-code flow; needs a `start` request with `redirectUri`. `threads_basic` and `threads_content_publish` are requested. |
| `mastodon` | `{}` (empty object) | Authorization-code flow with PKCE (S256); needs a `start` request with `instance`, `redirectUri` and `scopes`. |

These five credential shapes are the ones the official provider manifests
declare, and each was checked against the built provider's `credentialInput`
schema. Only `bluesky` and `devto` can be started from the positional
`connect <provider>` form; `linkedin`, `threads` and `mastodon` require connect
options, so they are started with a whole `ConnectRequest` through
`connect --input -`.

```json
{ "identifier": "you.bsky.social", "password": "APP_PASSWORD" }
```

Never paste a secret into a shell argument, a document, a chat or a screenshot.
`--credential-file` reads a file you manage; `--from-env` reads one environment
variable. The CLI never reads `.env`, never mixes sources and never falls back to
another source.

## Getting credentials per platform

Each official platform is prepared differently. These steps come from the
recorded API evidence this tree was written against
(`outputs/provider-api-evidence.md`, kept outside this repository); where that
evidence recorded an unresolved point, this guide repeats the gap instead of
inventing a path.

### Bluesky (`bluesky`)

Registering nothing is needed: Bluesky posting uses an **app password**.

1. Open your Bluesky account settings and find the app-password screen. The two
   official pages the evidence checked give different navigation paths, so this
   guide does not assert one — look for "App Passwords".
2. Create a new app password and copy the value it shows once.
3. Connect with `identifier` (your handle or email) and `password` (that app
   password, not your account password):

   ```bash
   SYNDROO_CREDENTIALS='{"identifier":"you.bsky.social","password":"APP_PASSWORD"}' \
     node packages/cli/dist/bin.js connect bluesky --from-env
   ```

The CLI exchanges those two fields for a session at
`https://bsky.social/xrpc/com.atproto.server.createSession` by JSON body, not
HTTP basic auth, and stores the session token. To revoke, delete the app password
in the same settings area.

### DEV.to (`devto`)

1. Sign in and open your DEV.to account settings; the settings page issues a
   personal **API key**.
2. Store it as `apiKey`. The provider sends it in the `api-key` header and checks
   identity with `GET https://dev.to/api/users/me`.

```bash
SYNDROO_CREDENTIALS='{"apiKey":"DEVTO_API_KEY"}' \
  node packages/cli/dist/bin.js connect devto --from-env
```

The evidence did not confirm a primary key-regeneration or revoke procedure.
Rotate the key from the same settings page as a platform operation; the CLI
itself has no revoke command (unverified).

### LinkedIn (`linkedin`)

LinkedIn is a three-legged authorization-code flow that needs an app you
register yourself, and it needs a redirect URI before it can start.

1. Create a LinkedIn developer app and note its **client id** and **client
   secret**.
2. Request the scopes the flow asks for by default: `w_member_social` (post as
   the member) plus the OIDC scopes `openid` and `profile`.
3. Start the connect with a `start` request that carries `redirectUri`. The
   positional form `connect linkedin` fails, because `redirectUri` is required
   and only a whole `ConnectRequest` can set it:

   ```bash
   echo '{"type":"start","provider":"linkedin","options":{"redirectUri":"https://127.0.0.1:8080/callback"}}' \
     | node packages/cli/dist/bin.js connect --input - --json
   ```

   The result is `action_required` with a `credential_input` action asking for
   `client_id` and `client_secret`.
4. Resume that session with the pair; the result is `action_required` with an
   `open_url` action holding the authorization URL:

   ```bash
   echo '{"type":"resume","connectSessionId":"cs_example","stepRevision":1,
          "input":{"type":"credentials","credentials":{"client_id":"CLIENT_ID","client_secret":"CLIENT_SECRET"}}}' \
     | node packages/cli/dist/bin.js connect --input - --json
   ```

   The URL is built on `https://www.linkedin.com/oauth/v2/authorization` with
   `scope="w_member_social openid profile"`; the code is exchanged at
   `https://www.linkedin.com/oauth/v2/accessToken`. No PKCE parameter is sent:
   the evidence found none documented on LinkedIn's token endpoint.

Connect options: `redirectUri` (required), `scopes`, `clientId`, `clientSecret`.

The evidence retrieved no primary permission-removal or token-revoke procedure;
this guide does not assert a revoke URL.

### Threads (`threads`)

Threads is a Meta authorization-code flow and also needs an app you register.

1. Create a Meta app with the Threads use case and note its **client id** and
   **client secret**.
2. The flow requests `threads_basic` (required for token exchange and refresh)
   and `threads_content_publish`.
3. Start the connect with a `start` request carrying `redirectUri` (again the
   positional form fails without it):

   ```bash
   echo '{"type":"start","provider":"threads","options":{"redirectUri":"https://127.0.0.1:8080/callback"}}' \
     | node packages/cli/dist/bin.js connect --input - --json
   ```

   The result is `action_required` with a `credential_input` action for
   `client_id` and `client_secret`; resuming with the pair returns an `open_url`
   action built on `https://www.threads.net/oauth/authorize`. The provider then
   exchanges the code at `https://graph.threads.net/oauth/access_token` and
   trades the short-lived token for a long-lived one. The short-lived token
   lifetime is unresolved in the evidence, so no expiry is documented here.

Connect options: `redirectUri` (required), `scopes`, `apiHost`,
`authorizationHost`, `clientId`, `clientSecret`.

The evidence retrieved no revoke procedure for Threads.

### Mastodon (`mastodon`)

Mastodon is per-instance. The instance host is a connect option, not a plugin
constant, and it must be an `https://` URL.

1. Note your instance host, for example `https://mastodon.social`.
2. Start the connect with `instance`, `scopes` and `redirectUri`:

   ```bash
   echo '{"type":"start","provider":"mastodon","options":{"instance":"https://mastodon.social","scopes":["read:accounts","write:statuses"],"redirectUri":"http://127.0.0.1:8080/callback"}}' \
     | node packages/cli/dist/bin.js connect --input - --json
   ```

   Without `clientId`/`clientSecret` in the options the provider first registers
   an app with the instance (`POST /api/v1/apps`), which is a network call;
   supplying a pre-registered pair skips it. With the pair supplied the result
   is `action_required` with an `open_url` action on
   `https://<instance>/oauth/authorize`; the pre-registered path is the one
   exercised here, while the auto-registration path needs network access and was
   not completed in this tree. The `credentialInput` for Mastodon is an empty
   object: `SYNDROO_CREDENTIALS='{}'` carries no fields.
3. PKCE with `S256` is used — Mastodon is the only provider here where PKCE
   support was verified. The token exchange is
   `POST https://<instance>/oauth/token`.

Connect options: `instance`, `redirectUri`, `scopes` (all required), and
optional `clientId`, `clientSecret`.

Mastodon's `POST /oauth/revoke` is documented by the platform, but the CLI ships
no revoke command; revoke from the instance or by the platform's own procedure.

### Completing an OAuth callback from the local CLI

LinkedIn, Threads and Mastodon reach an `open_url` / `wait_for_callback` step.
The local CLI completes that step itself, in one of two ways.

With a loopback redirect — the default, or the URI `--redirect-uri` names — the
CLI binds exactly that host, port and path for one delivery and consumes the
redirect in place. This needs a controlling terminal; without one the command
prints the authorize URL, reports `action_required` and exits `0` instead of
blocking.

With a redirect registered elsewhere, open the printed authorize URL and hand
back the URL the browser landed on: `connect <provider> --callback-url -` reads
one line from standard input, either piped or pasted at the terminal. A
delivered callback carries an authorization code, so the design forbids it on
the argument vector: an argv value that carries `code` or `state` is refused
with `CALLBACK_URL_INVALID` and exit `2` rather than used, and the session stays
open for the stdin form.

The redirected URL is never echoed, and neither the authorization code nor the
token reaches stdout, the envelope or a log. The self-hosted server keeps its own
`GET /oauth/callback/:provider` route
([remote-compatibility.md](remote-compatibility.md)) for a deployment that owns
the session. Bluesky and DEV.to do not need a callback.

## Request envelopes

Machine callers send strict JSON. The wire schema is
`packages/core/src/protocol/protocol.schema.json`; the three families are
`ConnectRequest`, `PublishRequest` and `StatusRequest`.

### Connect

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

`resume` `input` is either `{ "type": "credentials", "credentials": { ... } }`
or `{ "type": "callback_complete" }` for an OAuth callback step.

```json
{ "type": "update", "connectionId": "conn_example", "changes": { "label": "personal", "isDefault": true } }
```

```json
{ "type": "disconnect", "connectionId": "conn_example" }
```

### Publish

Prepare one frozen snapshot:

```json
{
  "type": "prepare",
  "content": { "text": "Syndroo now publishes from the command line." },
  "targets": [{ "provider": "bluesky" }]
}
```

A target may name a stored connection and carry its own content and options:

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

Execute the token a prepare returned:

```json
{ "type": "execute", "approvalToken": "at_example" }
```

Retry explicit targets of an existing operation:

```json
{ "type": "retry", "retryOf": "op_example", "targets": [{ "provider": "bluesky", "connection": "conn_example" }] }
```

A document with no `type` is an ordinary `content` + `targets` document; the CLI
adapts it by adding `"type": "prepare"` before the request reaches Core. The wire
`PublishRequest` itself always carries a `type`. Choose exactly one source
(`--input`, `--data`, or `--input -`); the request is at most 64 KiB and is
strict JSON: comments, trailing commas, repeated keys, invalid UTF-8 and unpaired
surrogates are refused.

### Status

```json
{ "type": "overview" }
{ "type": "provider", "provider": "bluesky" }
{ "type": "connections", "provider": "bluesky" }
{ "type": "operation", "operationId": "op_example" }
{ "type": "operations", "limit": 20, "cursor": "…" }
```

`limit` must be an integer from 1 to 100 inclusive. `cursor` is at most 1024
characters. `status` supports exactly these five queries and no query language.

## Target options per provider

`options` on a target is validated against the provider's `publishOptions`
schema. `options` is rejected if the provider declares no options.

| Provider | `publishOptions` |
| --- | --- |
| `bluesky` | none (text only) |
| `threads` | `{ "text": string }` |
| `linkedin` | `{ "commentary": string, "visibility": string, "author"?, "distribution"?, "linkedinVersion"? }` |
| `mastodon` | `{ "visibility": string }` |
| `devto` | `{ "title": string, "body_markdown": string, "published"?, "tags"?, "canonical_url"?, "description"? }` |

`threads`/`linkedin`/`mastodon`/`devto` also accept shared `content.text` where
their `content` schema declares it; `devto` declares `text` optional and its body
comes from `body_markdown`.

## JSON output

With `--json`, stdout carries exactly one envelope and nothing else:

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
`{ "code": string, "message": string, "details"?: { "field"?, "operationId"?, "retryAt"? } }`.
The message is a static, safe string; no raw error, stack, path or argv value is
ever placed in it.

Result shapes are declared by `StatusResult` and by the publish union:

- prepare → `{ "status": "confirmation_required", "operationId", "approvalToken", "expiresAt", "preview": [...] }`
- execute → `{ "phase": "execution", "operationId", "status", "deliveries": [...], "durabilityWarning"? }`
- `status` → one of `overview`, `provider`, `connections`, `operation`, `operations`.

`--dry-run` is a CLI-only preview and is **not** part of the wire schema. It
returns `{ "status": "preview", "preview": [...], "unverified": [...] }` inside
the publish envelope. `unverified` lists what the offline preview could not
confirm; treat it as unknown, not as success. The dry-run result requires an
existing connection for each target and fails with `NOT_FOUND` when a target has
none.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The call was handled: a query read, a prepare/execute returned, or a run fully succeeded. A prepare that returns `confirmation_required` is `0`; it did not publish anything. |
| `1` | Local failure: internal error, or a trusted result or state write that could not be persisted (`DURABILITY_ERROR`, `STATE_RECOVERY_REQUIRED`). |
| `2` | Usage, configuration, input, authentication or preflight rejection. Nothing was sent. |
| `4` | An execution round returned `unknown`: a write may have reached the provider. |
| `5` | A human explicitly declined at the confirmation step. Nothing was sent. |
| `6` | The execution finished and is known not to be fully successful (`failed` or `partial`). |
| `130` | The local process stopped on a signal. Server-side or provider work is not cancelled. |

Exit codes are part of the contract: an agent must read `result.status` as well
as the code, because `0` never means a platform published anything.

## Transport and egress

Every provider manifest declares its egress. The CLI resolves one transport per
provider and fails closed for an origin that was not declared. Mastodon is
`federated: true` with no fixed origins: its requests target the instance host
supplied at connect time. A cross-origin redirect is refused; only a same-origin
`https` redirect is followed.

## Retired syntax

The v1 CLI has no `doctor`, `posts`, `skill`, `auth`, `init`, `receipts`,
`retry`, `state` or `local *` commands, and no `--yes`/`--no-input` flags. This
paragraph is a historical note only; none of those are accepted by the current
build.

## Evidence and limits

- Commands and flags in this manual were verified against the built
  `node packages/cli/dist/bin.js`, including each per-command `--help`.
- JSON examples on this page were validated against the Core-generated
  validators for `ConnectRequest`, `PublishRequest` and `StatusRequest`.
- No live end-to-end call to any platform has been made. `dry-run` output,
  provider payloads and write outcomes are fixture-tested only.
- LinkedIn pins `LINKEDIN_VERSION` and is awaiting re-verification; Threads uses
  a single `auto_publish_text=true` call; see [releasing.md](releasing.md) and
  [testing.md](testing.md).
