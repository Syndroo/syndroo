# Testing Syndroo

Architecture v1 replaces the earlier CLI-first release train. The product under
test is eleven packages: `provider-sdk`, `core`, five official providers, `sdk`,
`server`, `cli` and `cloudflare`. The `0.7.0` train is release-prepared but not
published and has no live-account acceptance.

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
| `node scripts/server-cli-artifact-smoke.ts` | Pack existing CLI/Worker bundles and install them in a disposable external project through a bounded loopback registry | The generated project resolves exact package versions, contains no source path dependency, passes help/doctor/module import, and completes a Wrangler deploy dry run |

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
  runtime adapters, the provider trust loader, transport policy, request journal,
  and the `server` init/doctor/deploy/Threads/CI command boundary. Server tests
  use injected process runners, fetch implementations, fake SDK clients, private
  temporary state roots, and failure injection. The publish output layer — the
  shared publication view and renderer, confirmation loop, and
  redraw-versus-appended output controller — is fixture-tested through scripted
  terminal seams.
- **SDK** (`packages/sdk`): the HTTP client, transport, error contract, and
  `wait` polling, with a fake HTTP implementation and wire fixtures. The wire
  fixtures cover a response with and without the optional `presentation`,
  `preview` and `diagnostic` fields, plus fail-safe handling of a malformed
  one.
- **Server** (`packages/server`): the HTTP handler, mandatory Bearer
  authentication, SQLite state, encrypted secret storage, and the Node provider
  composition. A socket-free publish round trip drives the real handler, Core and
  SQLite adapter through connect → prepare → execute and asserts that the frozen
  preview and presentation survive, that a terminal round answers `200`, and that
  no credential material reaches the response.
- **Cloudflare** (`packages/cloudflare`): D1 state, encrypted secrets with AAD
  binding and crypto-shred, the Worker entry gates, queue consumption and cron
  recovery, against the D1 test harness. The D1 publication fixture re-reads a
  prepared and an admitted operation through freshly constructed adapters, so the
  frozen preview, the account presentation and the round marker are proven to come
  out of the database rather than process memory.
- **Build graph** (`scripts/`): stage order, Node engine floor, the private Core
  boundary, and the three bundle checks. The artifact smoke packs existing
  builds with lifecycle scripts disabled so a stale or incomplete artifact
  cannot pass by rebuilding itself during the test.

## Server command boundary regressions

Three server-boundary behaviours are pinned by fixture tests, not live calls:

- **Documented project default.** `packages/cli/test/server-cli.test.ts` runs
  `server connect threads --app-id ... --json` from inside an initialized project
  with no `--project` and requires the command to reach its own secret
  requirement instead of a project-selection error. A second case keeps explicit
  `--project` resolution working.
- **Account guidance.** `server-cli.test.ts` asserts that
  `SERVER_DEPLOY_ACCOUNT_SELECTION_REQUIRED` renders the fixed guidance (run the
  project-local `./node_modules/.bin/wrangler whoami`, choose an ACCOUNT ID, an
  account ID is not a member ID, retry login only if the session failed) and that
  hostile "available account" values never reach stdout or stderr. Account
  selection itself keeps its existing `cloudflare.ts` behaviour and tests.
- **Deploy evidence classification.** `server-deploy.test.ts` separates a normal
  exit, a timeout, a spawn failure, a nonzero exit, an absent receipt, an empty
  receipt, invalid UTF-8, unreadable private state, invalid or incomplete JSON, a
  wrong Worker, and a wrong target. It also asserts an absent receipt is never
  reported as retained and that a receipt alone never promotes a deployment.
  A malformed (invalid UTF-8) receipt is exercised end to end: the first attempt
  reports `invalid` evidence after the simulated remote upload, an ordinary rerun
  fails closed without deploying, and verified recovery deploys a fresh version.
  A receipt that cannot be read keeps `SERVER_DEPLOY_RECEIPT_UNAVAILABLE` instead
  of being downgraded to unusable evidence. `server-cli.test.ts` checks that human
  guidance follows `nextAction` even when no evidence is present: generic retry
  without spawn evidence, reconciliation for `RERUN_DEPLOY_TO_RECONCILE` (and no
  `--recover` suggestion for a complete receipt), and the exact
  `{"workerTag":...,"versionId":...}` placeholder document only for
  `PROVIDE_DEPLOY_RECOVERY`. Hostile receipt, status and exit-code values are
  dropped by the renderer allowlist.

The read-only recovery snippet in `references/server.md` was checked during this
change with an isolated offline harness. It exercised six cases — success, auth subprocess failure, invalid auth JSON, HTTP error,
invalid tag, and a thrown fetch — against fake `execFileSync`, `fetch` and
`process`, without authentication or network access. It requires the explicit
`stdio: ["ignore","pipe","pipe"]` capture and that every failure prints only the
fixed message with a nonzero exit. This was a manual verification, not a
repository test command.

These are controlled runners, fetch fixtures and temporary private state roots.
No Cloudflare account, Worker, Wrangler login or real deployment was used.

## Bundles

Three artifacts inline private `@syndroo/core` and are checked by
`scripts/check-v1.ts`:

| Artifact | Entry |
| --- | --- |
| `@syndroo/cli` | `dist/bin.js` |
| `@syndroo/server` | `dist/index.js` |
| `@syndroo/cloudflare` | `dist/worker.js` |

Each check asserts the entry exists, inlines Core, keeps Core out of the
package's `dependencies`, and ships the generated
`dist/THIRD_PARTY_LICENSES.txt`. `dist/bundle.json` records the generator,
entrypoints, external packages and inlined workspace packages.

## Fixture versus live

- **Fixture-tested**: every provider path here. Requests, responses, timeouts and
  error classification run against controlled endpoints, never a real account. The
  publication-output fixtures are fixture-tested in the same sense: fake providers,
  wire fixtures, a scripted terminal and an isolated state root, never a real
  account or post.
- **Recorded evidence**: `outputs/provider-api-evidence.md`, kept outside this
  repository, is the API research the providers were written against. It is not
  a test result.
- **Live-account acceptance**: **not run**. No real credential has been used and
  no post has been published to a real platform from this repository.
- **Deployment acceptance**: **not run**. The Worker deployment APIs, GitHub
  environment calls, Meta callback, Wrangler upload, and Threads publication are
  covered by fake runners/fetch fixtures only. A Wrangler local `deploy --dry-run`
  checks the generated bundle and binding shape; it proves no remote deployment.

Any command that would reach a real platform runs only under the operator's own
authorization. No test in this repository contacts a real social account.

## Requirements

- Node.js `>=24.19.0`, npm, and a POSIX host.
- Some fixtures bind a loopback port, so a sandbox that denies `listen` fails
  them with `listen EPERM: operation not permitted 127.0.0.1` — the same error a
  bare `node -e` gets when it binds a port. That currently covers the four
  real-socket cases in `packages/server/test/http/server.test.ts`, the nine in
  `packages/server/test/oauth/callback.test.ts`, and the CLI OAuth
  listener/loopback/loop tests. It is an environment failure, not a product
  failure; those tests need to run unsandboxed. The CLI, SDK, Core, provider and
  Cloudflare suites do not need a port and are unaffected.

## Release tooling tests

`npm run test:scripts` compiles the build/release tooling and runs its own Node
test suites (`128` tests at the time of writing). It covers packaging, licences,
the release train and artifact handling. It is a tooling suite, not product
acceptance, and it is not part of the v1 protocol gates above.

## External artifact smoke

Run the focused build and smoke in this order after source changes are stable:

```bash
npm run build --workspace @syndroo/cli
npm run build --workspace @syndroo/cloudflare
node scripts/server-cli-artifact-smoke.ts
```

The script packs only the already-built CLI and Worker with `--ignore-scripts`.
A temporary HTTP server on `127.0.0.1` serves their exact-version metadata and
tarballs; the npm scoped-registry setting points only `@syndroo` there. Public
dependencies resolve through the operator's npm cache or normal registry. The
generated project stays outside the checkout and is removed on exit unless
`--keep` is passed.

The loopback server has a request cap and wall-clock limit and exists only for
the smoke process. It contacts no Cloudflare, GitHub, Meta, or Threads service,
uses no real credential, and publishes nothing.

## What is not verified

- Live-account publishing for any provider.
- The physical terminal behaviour behind the output seams: real resize, real
  Ctrl-C during a redraw and a genuine `EPIPE` are argued from the scripted
  `rows`, `onResize`, `signal` and `stdout.emit("error")` seams rather than
  observed on a real pseudo-terminal, because no pseudo-terminal tool is
  available here.
- Cross-version client/server combinations: the optional-field extension is
  argued from the strict validator, so only same-version pairings have fixture
  coverage; see [remote-compatibility.md](remote-compatibility.md).
- A deployed Cloudflare Worker against a real Cloudflare account. The generated
  project and deployment path are fixture-tested; see
  [remote-compatibility.md](remote-compatibility.md).
- The macOS/Linux and Node.js matrix: this checkout has run on Node.js 24.19.0
  only.
- Public-registry installation: the `0.7.0` train is unverified and not
  advertised as available. The loopback artifact smoke exercises the packed
  install path without claiming publication.
