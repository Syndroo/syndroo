# Testing Syndroo

Architecture v1 replaces the earlier CLI-first release train. The product under
test is eleven packages: `provider-sdk`, `core`, five official providers, `sdk`,
`server`, `cli` and `cloudflare`. The `0.7.0-rc.1` tree is unreleased and has no
live-account acceptance.

A pass at one layer never stands in for another. Unit tests do not prove
packaging, packaging does not prove platform behaviour, and no layer here proves
live-account acceptance on any provider.

## Gates

| Command | What it does | What a pass means |
| --- | --- | --- |
| `npm run check:v1-tools` | `tsc` over the build/check tooling | The build graph and scripts type-check |
| `npm run check` | `check:v1-tools` then `scripts/check-v1.ts` | Every v1 package type-checks; each built bundle inlines private Core and keeps it out of `dependencies` |
| `npm test` | `scripts/check-v1.ts --tests` | Every package with tests runs its own `npm test` |
| `npm run test:v1` | `vitest --config vitest.v1.config.ts` | The same tests under one run, useful while iterating |
| `npm run build` | `scripts/build-v1.ts` | All eleven packages build in dependency order |
| `npm run check:provider-catalog` | `generate-provider-catalog.ts --check` | The checked-in CLI provider catalog matches the built official providers |
| `npm run check:pack` | `check-v1.ts --pack` | Each stage's `npm pack --dry-run` succeeds |

`npm run check` is deliberately honest about unbuilt bundles: a package with no
`dist/` is reported `PENDING`, never `ok`, and a `PENDING` row does not fail the
run, because the check graph does not build. A *fully* cold checkout is a
different case: each workspace type-checks against its siblings' built
declarations, so with no `dist/` anywhere the type step fails with import errors
that say nothing about the code. Run `npm run build` first, which is what CI does
and what `check:allow-missing` exists for in the other direction.

`npm run check:pack` runs `npm pack --dry-run` per stage, and each stage's
`prepack` script builds that package. It passes end to end — `11 checked,
0 failed` with a `pack ok` row per stage — but it needs a writable npm cache:
run it with `npm_config_cache` pointing at a directory the process may write, or
every stage fails with `EPERM` against `~/.npm/_cacache` instead of a product
error. The failure mode looks like ten real pack failures, so check the cache
path before reading anything into it.

## What each layer proves

- **Core** (`packages/core`): protocol validation, connect/publish/status state
  transitions, idempotency, retry eligibility, and the shared result model.
- **Provider SDK** (`packages/provider-sdk`): the plugin contract, `defineProvider`
  validation, capability/manifest rules, egress rules and the contract-test
  helper.
- **Official providers**: platform authentication, identity verification, frozen
  payloads and write-outcome classification, each against controlled endpoint
  fixtures.
- **CLI** (`packages/cli`): argument parsing, human and JSON rendering, the local
  runtime adapters, the provider trust loader, transport policy, and the request
  journal. Provider-loader and egress tests cover trust, fingerprinting and
  fail-closed origins.
- **SDK** (`packages/sdk`): the HTTP client, transport, error contract, and
  `wait` polling, with a fake HTTP implementation and wire fixtures.
- **Server** (`packages/server`): the HTTP handler, mandatory Bearer
  authentication, SQLite state, encrypted secret storage, and the Node provider
  composition.
- **Cloudflare** (`packages/cloudflare`): D1 state, encrypted secrets with AAD
  binding and crypto-shred, the Worker entry gates, queue consumption and cron
  recovery, against the D1 test harness.
- **Build graph** (`scripts/`): stage order, Node engine floor, the private Core
  boundary, and the three bundle checks.

## Bundles

Three artifacts inline private `@syndroo/core` and are checked by
`scripts/check-v1.ts`:

| Artifact | Entry |
| --- | --- |
| `@syndroo/cli` | `dist/bin.js` |
| `@syndroo/server` | `dist/index.js` |
| `@syndroo/cloudflare` | `dist/worker.js` |

Each check asserts the entry exists, inlines Core, and that Core stays out of the
package's `dependencies`. `dist/bundle.json` records the generator, entrypoints,
external packages and inlined workspace packages.

## Fixture versus live

- **Fixture-tested**: every provider path here. Requests, responses, timeouts and
  error classification run against controlled endpoints, never a real account.
- **Recorded evidence**: `outputs/provider-api-evidence.md`, kept outside this
  repository, is the API research the providers were written against. It is not
  a test result.
- **Live-account acceptance**: **not run**. No real credential has been used and
  no post has been published to a real platform from this repository.

Any command that would reach a real platform runs only under the operator's own
authorization. No test in this repository contacts a real social account.

## Requirements

- Node.js `>=24.19.0`, npm, and a POSIX host.
- Provider, SDK and server fixtures bind a loopback port, so a sandbox that
  denies `listen` needs those tests to run unsandboxed.

## Release tooling tests

`npm run test:scripts` compiles the build/release tooling and runs its own Node
test suites (`128` tests at the time of writing). It covers packaging, licences,
the release train and artifact handling. It is a tooling suite, not product
acceptance, and it is not part of the v1 protocol gates above.

## What is not verified

- Live-account publishing for any provider.
- A deployed Cloudflare Worker against a real Cloudflare account. The Worker's
  deployment configuration is not part of this tree; see
  [remote-compatibility.md](remote-compatibility.md).
- The macOS/Linux and Node.js matrix: this checkout has run on Node.js 24.19.0
  only.
- Registry installation: no package in this tree has been published, so install
  from a registry is untested.
