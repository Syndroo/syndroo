# Testing Syndroo

The `0.6.0-rc.1` candidate is a CLI-first release: local publishing to Bluesky
and Threads is the product under test, and the pre-0.6 remote surface (Worker,
SDK, `doctor`, `posts ...`) is regression-tested because it is retained.

A pass at one layer never stands in for another. Local unit tests do not prove
packaging, packaging does not prove platform behavior, and no layer here proves
live-account acceptance on Bluesky or Threads.

## What each layer proves

| Layer | Entry point | What a pass means |
| --- | --- | --- |
| Workspace units | `npm test` | Per-package behavior: core contracts, adapters, CLI parsing and local use cases, Worker logic, SDK client, repository scripts |
| Types and bindings | `npm run check` | `tsc` for every workspace plus scripts and e2e types, and regenerated Worker bindings |
| CLI local end to end | `npm run e2e:cli-local` | The packed CLI installs outside the repository and runs the documented local workflow against fake providers |
| Remote (Worker) end to end | `npm run e2e:local` | Bundle → D1 → Queue → Cron → adapters → Mock SNS, for the retained remote path |
| Consumer packages | `npm run e2e:consumer -- --source tarball` | The packed artifacts install outside the repository and the real SDK and CLI run against them |
| Worker artifact | `npm run verify:package` | Packed Worker artifact, licence notices, isolated install |
| Release sets | `SYNDROO_RELEASE_SET=cli npm run release:train` | The self-contained CLI candidate is internally consistent and publishable alone |
| Legacy remote live check | `npm run e2e:live -- --plan <file>` | Only when an operator supplies an approved plan file: `doctor` and `posts ...` against a deployed instance |

## Local CLI coverage

The CLI suite is where the local design is actually proven:

- **Document input**: strict JSON, duplicate keys, escapes, key and content
  limits, source byte cap, override selection, provider availability.
- **Planning**: frozen content and payload, deterministic business timestamps,
  `skip`/`blocked` rehabilitation of existing records, plan signature, 24-hour
  lifetime, and replay of an admitted plan after expiry.
- **State**: real files and directories, atomic writes, permission and symlink
  refusal, HMAC integrity, tombstoned connections, and manifest admission.
- **Locking and recovery**: competing real processes, owner checks, quarantine,
  and orphan in-flight intent becoming `unknown`.
- **Process behavior**: the real binary under signals and broken pipes,
  including exit `130` and persisted success that could not be reported.
- **Providers**: protocol fixtures against controlled endpoints, covering
  identity checks, frozen payloads sent verbatim, timeouts, response caps, and
  the conservative `unknown` classification.
- **Guidance consistency**: the bundled Skill's commands, flags, exit codes, and
  links are checked against the built `--help` output.
- **Import boundaries**: `@syndroo/core` stays platform-neutral, and the pure
  local use cases import no filesystem, Worker, SDK, or concrete provider code.

## Remote regression scope

The pre-0.6 surface remains supported and must keep working:

- Worker behavior: request validation, idempotency, claim-before-send, Queue
  and Cron recovery, D1 migrations, and the 64 KiB body limit.
- API contract: `POST /v1/posts` returning `202`, the documented statuses and
  error shapes, and the Bearer-token rule on every `/v1/*` route.
- Remote CLI commands: `doctor` and `posts validate|create|list|get|wait`,
  including their exit codes and JSON shapes.
- Adapters: Bluesky, Threads, X, Tumblr, and LinkedIn, with X, Tumblr, and
  LinkedIn still marked experimental because their live publishing has not been
  validated.

Local publishing never falls back to this surface, and a remote failure is not
a reason to switch. The two paths share contracts, not code paths.

## Live validation

Two different things are called "live", and they are not interchangeable:

- `npm run e2e:live` is the **legacy remote** check. It runs `doctor` and
  `posts ...` against a deployed Syndroo instance using an approved plan file,
  and it validates only the remote path.
- **Local live acceptance** would publish real text to real Bluesky and Threads
  accounts through the local CLI. That run **has not been executed** for
  `0.6.0-rc.1`, and no dedicated runner for it exists yet; it needs a real
  account and an explicit operator decision. The local providers are covered by
  fixtures and labelled `fixture-tested`, which is not a substitute for that
  acceptance.

Any command that reaches a real platform, local or remote, does so only under
the operator's own authorization. No test in this repository contacts a real
social account.

## Running the gates

```bash
npm ci
# The candidate versions are split, so the release-set scripts need the CLI set.
export SYNDROO_RELEASE_SET=cli
npm test
npm run check
npm run e2e:cli-local
npm run e2e:local
npm run verify:package
npm run release:train
```

`npm test` and `npm run test:scripts` validate the publishable release set, so
they need `SYNDROO_RELEASE_SET=cli` while the three candidate versions differ.
The default set stays `all` and reports that mismatch as a failure until the
packages share one version.

Requirements: Node.js 22 or newer, npm, and a POSIX host. Local state
operations support macOS and Linux; Windows local writes are refused rather
than approximated.

Notes for a sandboxed environment: the provider and remote fixtures bind a
loopback port, so a sandbox that denies `listen` needs those tests to run
unsandboxed. Worker gates need the bundled Worker and its local services, which
`npm run e2e:local` starts for the run.

## What is not verified here

- Live-account publishing for any platform, local or remote.
- Execution on Linux: local evidence so far is macOS arm64.
- The Node.js 22 and 24 matrix on both macOS and Linux: CI runs it, but this
  checkout's own evidence does not include it.
- Registry installation: not verified; this task built and installed the local
  tarball only and performed no npm publish.
