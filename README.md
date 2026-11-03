# Syndroo

Publish to Bluesky, Threads, LinkedIn, Mastodon and DEV.to from your own
machine, or run the same product as an authenticated HTTP service. Every
surface speaks one protocol generation, **v1**, with three operations:
`connect`, `publish` and `status`.

The `0.7.0` npm release train is available on npm under `latest`. No deployment
or live social-account acceptance has been performed. Provider behaviour is
covered by tests against recorded API evidence and controlled fixtures; see
[Honest boundaries](#honest-boundaries).

## Surfaces

| Surface | What runs | Entry point |
| --- | --- | --- |
| Local CLI | `syndroo` on your machine, private filesystem state | `@syndroo/cli` |
| Self-hosted server | Node HTTP service, SQLite state, encrypted secrets | `@syndroo/server` |
| Cloudflare Worker | D1 state, Queues, Cron recovery | `@syndroo/cloudflare` |
| User-owned deployment | Generated project with pinned CLI, Worker and Wrangler | `syndroo server` |
| HTTP client | Thin HTTP client plus status polling | `@syndroo/sdk` |
| Provider plugins | Platform authentication, payloads, write outcomes | `@syndroo/provider-*` |

The CLI and the server share contracts and semantics, not processes or state. A
failure on one surface is not a reason to switch to the other.

## Requirements

- Node.js `>=24.19.0` (the same floor every v1 package declares).
- npm.
- A POSIX host for local CLI state. Windows local writes are refused rather
  than approximated.

## Install

Install the CLI, its provider contract, and all five official providers together:

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
```

This seven-package command is the complete default local CLI installation.
`@syndroo/core` is private and is bundled into the CLI. The CLI discovers the
five installed official providers through its generated trust catalog and does
not download provider code at runtime.

The CLI package also contains the Syndroo Agent Skill. Its installed path is:

```bash
skill_root="$(npm root --global)/@syndroo/cli/skills/syndroo"
test -f "$skill_root/SKILL.md"
```

Agents can read that file after installation. Whether an Agent client discovers
or activates a Skill automatically remains client-specific; Syndroo does not
provide a universal installer.

## Build from source

Contributors can build the repository without installing from npm:

```bash
npm ci
npm run build                 # builds all eleven v1 packages in dependency order
node packages/cli/dist/bin.js --help
```

When using the installed package, the three local commands are:

```bash
syndroo connect bluesky
syndroo publish --input post.json
syndroo status
```

## Quickstart

### 1. Connect an account

```bash
syndroo connect bluesky
```

On a terminal the CLI prompts for the credential fields the provider declares
and reads secret fields with echo disabled. With no terminal, or with `--json`,
it prints the pending action and exits `0` instead of blocking.

To import credentials once, from a JSON file you own or from one environment
variable:

```bash
syndroo connect bluesky --credential-file ./bluesky.json
SYNDROO_CREDENTIALS='{"identifier":"you.bsky.social","password":"APP_PASSWORD"}' \
  syndroo connect bluesky --from-env
```

`--from-env` reads `SYNDROO_CREDENTIALS` and nothing else. The credential object
uses the provider's own field names: Bluesky `identifier` + `password`, DEV.to
`apiKey`, LinkedIn `client_id` + `client_secret`, Threads `client_id` +
`client_secret`, Mastodon an empty object. LinkedIn, Threads and Mastodon then
need OAuth connect options (`redirectUri`, and `instance`/`scopes` for Mastodon),
so they are started with a whole `ConnectRequest`; see
[docs/cli-manual.md](docs/cli-manual.md#getting-credentials-per-platform).
Credentials are imported once; later calls read the Core credential store, never
the original environment variable or file.

### 2. Publish

Save one strict JSON document as `post.json`. The shape is `content` + `targets`:

```json
{
  "content": { "text": "Syndroo now publishes from the command line." },
  "targets": [{ "provider": "bluesky" }]
}
```

```bash
syndroo publish --input post.json --dry-run
syndroo publish --input post.json
```

`publish` prepares one frozen snapshot, prints a short summary of it, asks for an
explicit yes on the terminal, and only then executes that same snapshot. The
summary is at most three lines per target; `v` expands the full frozen preview
before you answer, `y`/`yes` executes, and any other answer stops. The snapshot
is frozen before the prompt, so editing the input file, reconnecting an account
or a provider update while the prompt is open cannot change what an accepted `y`
sends.

```bash
syndroo publish --input post.json --yes
```

`--yes` auto-confirms the frozen intent this process just prepared, so a script
or an agent can prepare and execute in one call. It is an authorization shortcut,
not a shortcut around the safety checks: credentials, identity binding, expiry,
provider validation, the frozen payload and idempotency are still enforced.
`--dry-run --yes` is still a dry run that never sends, and `--yes` on an explicit
`execute` or `retry` request adds nothing.

An optional `--dry-run` previews without writing state, resolving credentials or
making a network call. A request without a `type` is an ordinary document and
becomes a `prepare` request; `{"type":"execute","approvalToken":"..."}` is only
read from standard input.

When no terminal can both show the preview and read the answer, the CLI prepares
and returns the awaiting-confirmation result instead of blocking or sending.

Agents should use `--json` and pass a machine request on stdin:

```bash
echo '{"type":"prepare","content":{"text":"Hello"},"targets":[{"provider":"bluesky"}]}' \
  | syndroo publish --input - --json
```

`--json` never prompts and prints exactly one envelope per run. Without `--yes`
that envelope is the `prepared` result; with `--yes --json` the process prepares,
auto-confirms and executes, and the single envelope is the final execution or
error result — there is no second prepared envelope and the approval token is not
echoed to stdout. `--verbose` adds full identifiers and any reviewed safe
diagnostics, and those diagnostics go to stderr, so the stdout envelope stays one
valid JSON document.

### 3. Inspect state

```bash
syndroo status                       # overview
syndroo status --connections         # stored connections
syndroo status --provider bluesky    # one provider's schema
syndroo status --operation <op_id>   # one operation
syndroo status --operations --limit 20
```

`status` is read-only: it never calls a provider, reads a secret, or writes
state. `status --operation <op_id>` reuses the same publication renderer as
`publish`; it is one read that never polls or waits, and an operation whose
stored state has not settled is labelled `Last recorded status:` so a saved
record cannot be mistaken for a live confirmation.

## User-owned Cloudflare deployment

The optional `server` command creates a thin repository that consumes packed
Syndroo artifacts; it does not copy this source tree:

```bash
syndroo server init ./syndroo-site
cd syndroo-site
syndroo server doctor --json
syndroo server deploy --yes
```

`server init` is local unless an explicit
`--github OWNER/REPO --private|--public` is supplied. The project has one
tracked `syndroo.config.jsonc` for application settings and one tracked
`wrangler.jsonc` for platform configuration. Generated effective config and
private recovery state are ignored; account and resource IDs are not committed.

`server doctor` is read-only and keeps OAuth and publication readiness
`unverified`. Its `/health` check proves liveness only. Deployment uses the
existing Wrangler browser login unless valid project-local Cloudflare credentials
are already available, preserves existing resources and keys, and refuses to
adopt same-name foreign resources.

Threads and CI are separate explicit steps:

```bash
syndroo server connect threads --app-id THREADS_APP_ID
syndroo server ci setup github --repo OWNER/REPO --yes
syndroo server publish threads \
  --input posts/hello.json --request-id RELEASE_001 --yes --json
```

App Secret and deployment credentials use hidden input, safe environment/stdin
paths, or private state, never argv. CI setup writes a manual workflow locally
and configures a scoped GitHub environment; it does not commit, push, dispatch,
or publish. An initial `--github` push predates deploy/connect, so review and
explicitly commit/push the updated `syndroo.config.jsonc`, generated workflow,
and intended posts before manual dispatch. Never commit `.syndroo/`,
`node_modules/`, `wrangler.effective.jsonc`, environment files, or private state.
A real publication needs its own authorization and stable request ID.

Deployment identity and generated credentials live under the private XDG
`syndroo/serverctl-v1` state root with restrictive permissions, not encryption.
A fresh clone cannot recover secret values. Back up the private store securely
or import all three deployment credentials together with
`server deploy --yes --credentials-stdin`. Missing values for an existing
deployment never cause silent key regeneration. This release has no automatic
token refresh or key rotation.

## Configuration

The CLI has one configuration source, and it is never inferred from the working
directory.

| What | Default | Selected by |
| --- | --- | --- |
| Config file | `${XDG_CONFIG_HOME:-$HOME/.config}/syndroo/config.json` | `--config <absolute path>` |
| State root | `${XDG_STATE_HOME:-$HOME/.local/state}/syndroo/runtime-v1` | `stateRoot` in the config file |

```json
{
  "version": 1,
  "stateRoot": "/absolute/path/to/state",
  "providers": { "bluesky": { "path": "./plugins/bluesky" } }
}
```

A missing default config file is not an error for commands that need no
provider resolution. An explicit `--config` path must be absolute, must exist,
and is validated strictly: unknown top-level keys are rejected, and any key that
looks like a token, secret, password, API key or credential is refused rather
than ignored. There is no `secretsRoot` key. See
[docs/cli-manual.md](docs/cli-manual.md) for the full contract.

## Repository layout

```text
packages/core                 private: use cases, domain, protocol, ports
packages/provider-sdk         public: Provider contract, defineProvider, test helpers
packages/provider-bluesky     official Bluesky provider
packages/provider-threads     official Threads provider
packages/provider-linkedin    official LinkedIn provider
packages/provider-mastodon    official Mastodon provider
packages/provider-devto       official DEV.to provider
packages/sdk                  public: HTTP client, protocol types, wait
packages/cli                  public: commander, renderers, local runtime, Skill
packages/server               public: Node HTTP runtime, SQLite, encrypted secrets
packages/cloudflare           public artifact: Worker, D1, Queues, Cron
scripts/                      build, protocol export, provider catalog, release checks
tests/                        cross-entry and packaged-consumer checks
docs/                         architecture specs and operator documentation
```

Dependency direction: `provider-sdk` then `core`, then the five official
providers, then `{sdk, server, cli}`, then `cloudflare`. `@syndroo/core` stays
platform-neutral. Three artifacts inline private Core: `@syndroo/cli`
(`dist/bin.js`), `@syndroo/server` (`dist/index.js`) and `@syndroo/cloudflare`
(`dist/worker.js`).

## Provider plugins

Every provider, official or third-party, implements the same
`@syndroo/provider-sdk` contract and is registered by an explicit registry, one
active implementation per provider id. Each manifest declares exactly which
origins it may call:

| Provider | Capability | Egress |
| --- | --- | --- |
| `bluesky` | text | `https://bsky.social` |
| `threads` | text | `https://www.threads.net`, `https://graph.threads.net` |
| `linkedin` | text | `https://www.linkedin.com`, `https://api.linkedin.com` |
| `mastodon` | text | federated: the instance host supplied at connect time |
| `devto` | article | `https://dev.to` |

The CLI resolves one transport per provider from that declaration and fails
closed for an undeclared origin. A third-party plugin runs as code you explicitly
trusted, in the same process, with your permissions: minimal arguments are not a
sandbox. The full trust and fingerprint policy is in
[packages/cli/src/runtime/providers/README.md](packages/cli/src/runtime/providers/README.md).

## Development

```bash
npm ci
npm run build        # build all eleven packages
npm run check        # type-check the v1 tools and inspect built artifacts
npm test             # per-package tests via scripts/check-v1.ts
npm run test:v1      # the same tests under one vitest run
git diff --check
```

`npm run check` reports `PENDING` for any bundle that has not been built; an
unbuilt artifact is an assertion that has not been verified, never a pass.
[docs/testing.md](docs/testing.md) describes what each layer proves and
[docs/releasing.md](docs/releasing.md) covers the release gates.

## Honest boundaries

- No live end-to-end call to any social platform has been made from this
  repository. Verification is against recorded API evidence (kept outside this
  repository at `outputs/provider-api-evidence.md`) and controlled fixtures.
- LinkedIn publishing pins an API version constant (`LINKEDIN_VERSION`) and is
  awaiting re-verification against LinkedIn's currently supported versions.
- Threads publishes in a single call with `auto_publish_text=true`.
- Threads Worker OAuth, the `server` deployment workflow, and manual CI setup are
  fixture-tested; they have not been deployed or run against a real Threads
  account. Automatic token refresh and key rotation are not implemented. See
  [docs/threads-ci.md](docs/threads-ci.md) for the scoped Worker and CI setup.
- A freshly deployed Cloudflare Worker has no tables: `status` fails until the
  first `connect` initializes storage. That is expected first-run behaviour.
- No npm publish, no deployment and no real credential use has been performed
  for this tree.

## Contributing and licence

Contributions require a Developer Certificate of Origin sign-off; see
[CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Grant Dai.

## More documentation

- CLI reference: [docs/cli-manual.md](docs/cli-manual.md)
- Agent quickstart: [docs/agent-quickstart.md](docs/agent-quickstart.md)
- Threads Worker and CI: [docs/threads-ci.md](docs/threads-ci.md)
- Self-hosted server and Worker: [docs/remote-compatibility.md](docs/remote-compatibility.md)
- Architecture v1 specs: [docs/superpowers/specs/architecture-v1/](docs/superpowers/specs/architecture-v1/)
