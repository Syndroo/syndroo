# Syndroo

Publish to Bluesky, Threads, LinkedIn, Mastodon and DEV.to from your own
machine, or run the same product as an authenticated HTTP service. Every
surface speaks one protocol generation, **v1**, with three operations:
`connect`, `publish` and `status`.

This is the unreleased `0.7.0-rc.1` architecture-v1 tree. Nothing here has been
published to npm, deployed, or run against a real social account. Provider
behaviour is covered by tests against recorded API evidence and controlled
fixtures; see [Honest boundaries](#honest-boundaries).

## Surfaces

| Surface | What runs | Entry point |
| --- | --- | --- |
| Local CLI | `syndroo` on your machine, private filesystem state | `@syndroo/cli` |
| Self-hosted server | Node HTTP service, SQLite state, encrypted secrets | `@syndroo/server` |
| Cloudflare Worker | D1 state, Queues, Cron recovery | `@syndroo/cloudflare` |
| HTTP client | Thin HTTP client plus status polling | `@syndroo/sdk` |
| Provider plugins | Platform authentication, payloads, write outcomes | `@syndroo/provider-*` |

The CLI and the server share contracts and semantics, not processes or state. A
failure on one surface is not a reason to switch to the other.

## Requirements

- Node.js `>=24.19.0` (the same floor every v1 package declares).
- npm.
- A POSIX host for local CLI state. Windows local writes are refused rather
  than approximated.

## Build and run the CLI

```bash
npm ci
npm run build                 # builds all eleven v1 packages in dependency order
node packages/cli/dist/bin.js --help
```

`@syndroo/cli` is not published, so run it from the build output as above. Once
that works, the three commands are all you need:

```bash
node packages/cli/dist/bin.js connect bluesky
node packages/cli/dist/bin.js publish --input post.json
node packages/cli/dist/bin.js status
```

## Quickstart

### 1. Connect an account

```bash
node packages/cli/dist/bin.js connect bluesky
```

On a terminal the CLI prompts for the credential fields the provider declares
and reads secret fields with echo disabled. With no terminal, or with `--json`,
it prints the pending action and exits `0` instead of blocking.

To import credentials once, from a JSON file you own or from one environment
variable:

```bash
node packages/cli/dist/bin.js connect bluesky --credential-file ./bluesky.json
SYNDROO_CREDENTIALS='{"identifier":"you.bsky.social","password":"APP_PASSWORD"}' \
  node packages/cli/dist/bin.js connect bluesky --from-env
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
node packages/cli/dist/bin.js publish --input post.json --dry-run
node packages/cli/dist/bin.js publish --input post.json
```

`publish` prepares one frozen snapshot, prints the full preview, asks for an
explicit yes on the terminal, and only then executes that same snapshot. An
optional `--dry-run` previews without writing state, resolving credentials or
making a network call. A request without a `type` is an ordinary document and
becomes a `prepare` request; `{"type":"execute","approvalToken":"..."}` is only
read from standard input.

Agents should use `--json` and pass a machine request on stdin:

```bash
echo '{"type":"prepare","content":{"text":"Hello"},"targets":[{"provider":"bluesky"}]}' \
  | node packages/cli/dist/bin.js publish --input - --json
```

### 3. Inspect state

```bash
node packages/cli/dist/bin.js status                       # overview
node packages/cli/dist/bin.js status --connections         # stored connections
node packages/cli/dist/bin.js status --provider bluesky    # one provider's schema
node packages/cli/dist/bin.js status --operation <op_id>   # one operation
node packages/cli/dist/bin.js status --operations --limit 20
```

`status` is read-only: it never calls a provider, reads a secret, or writes
state.

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
- Self-hosted server and Worker: [docs/remote-compatibility.md](docs/remote-compatibility.md)
- Architecture v1 specs: [docs/superpowers/specs/architecture-v1/](docs/superpowers/specs/architecture-v1/)
