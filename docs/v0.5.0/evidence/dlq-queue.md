# Task 5b2 evidence — standalone DLQ consumer and narrow queue adapter

Status: **T5b2 attempt 1 complete for review.** Owner: T5b2 scope only
(the six files listed below). No product acceptance ID is claimed:
`docs/v0.5.0/acceptance-results.json` stays `NOT_RUN`, because this slice proves
portable DLQ semantics against the rollback-capable fake and the adapter's
contract against a structural recorder — not real Queue dispatch,
acknowledgement, redelivery or DLQ movement.

## 1. Root ruling recorded here

Design 07 §7 treats an undecodable DLQ message as a **quarantine + fixed alert**,
not as another ordinary retry. Concretely:

- the frozen `ConsumerOutcome` union is **unchanged**
- `settle-dead-letter.ts` adds a use-case-local
  `DlqConsumerOutcome = ConsumerOutcome | { kind: "quarantined"; reason:
  "malformed_envelope" }`
- a quarantined message produces one fixed code and fixed metadata only: zero
  domain reads/writes, and no id, field name or body fragment parsed out of the
  invalid input is echoed anywhere
- the runtime later turns this into an alert-and-ack; it never forwards the
  message to itself, and durable operational alert evidence stays runtime scope
- **D1 metadata failures are unchanged**: they remain
  `infrastructure_retry("dlq_metadata_write_failed")`, bounded by the DLQ
  runtime's own retries, with no second application-level attempt
- the main consumer's malformed-envelope behaviour is **unchanged**
  (`infrastructure_retry("malformed_envelope")`), proven by a test in this slice
- a local boundary guard was added in the new modules only (see §3)

## 2. Files, runtime, commands

```text
packages/application/src/use-cases/settle-dead-letter.ts              (new)
packages/application/test/settle-dead-letter.test.ts                  (new)
packages/cloudflare-worker/src/infrastructure/queue/job-queue.ts      (new)
packages/cloudflare-worker/test/job-queue-v050.spec.ts                (new)
packages/cloudflare-worker/test/support/job-queue-v050-tsconfig.json  (new)
docs/v0.5.0/evidence/dlq-queue.md                                     (new, this file)
```

| Item | Value |
| --- | --- |
| Worktree | `/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050` |
| Runtime | Node `v24.19.0` (bundled), Vitest `4.1.11` |
| Store | fake `src/testing/snapshot-fake.ts` (unchanged); queue binding is a structural recorder |
| Frozen inputs | T5a/T5b1 modules, contracts, ports, `src/index.ts`, D1, runtime, configs and manifests untouched |

```bash
npm run check -w @syndroo/application                  # exit 0
npm run build -w @syndroo/application                  # exit 0
npm run test  -w @syndroo/application                  # 14 files, 157 tests passed
tsc -p test/support/job-queue-v050-tsconfig.json       # scoped Worker tsc, exit 0
vitest run test/job-queue-v050.spec.ts                 # 6 tests passed (Worker package)
```

New tests: `test/settle-dead-letter.test.ts` 10, `test/job-queue-v050.spec.ts` 6.
The previously accepted application suite (13 files / 147 tests) is unchanged
apart from the one new file.

Sandbox note: the Worker vitest project starts a `cloudflare-pool` worker that
listens on `127.0.0.1`; the sandbox blocks that with `EPERM`, so the focused
Worker run required the same local-only escalation already recorded in
`baseline.md`. The scoped tsc check needs no escalation.

## 3. Boundary guard added in this slice

The frozen decoder already catches `JSON.stringify` failures and returns a frozen
copy, but a hostile input can still throw *after* serialisation — a throwing
getter on a required field, or a proxy whose descriptor trap only misbehaves on
the second pass (`Object.keys` / later property reads). Both new modules now wrap
their decode locally:

- DLQ consumer → `decodeEnvelopeOrNull` → fixed quarantine, zero store calls
- producer adapter → the whole validate/encode step inside one guard → fixed
  `failed` / `INVALID_ENVELOPE`, zero binding calls

Tests cover both hostile shapes in each module and assert that the sentinel text
never reaches the outcome, the logs, the error message, the error `cause` or the
stack.

## 4. Behaviour covered

Portable DLQ consumer (`settle-dead-letter.test.ts`):

| Required behaviour | Test |
| --- | --- |
| Malformed message: fixed quarantine code, zero domain calls, nothing echoed | `quarantine > quarantines a malformed message with a fixed code and zero domain calls` |
| Hostile getter/proxy that throws after serialisation | `quarantine > quarantines hostile inputs that throw after serialisation` |
| Due unclaimed current job becomes `dead_lettered`, no attempt consumed | `settlement > dead-letters a due, unclaimed current job without executing anything` |
| Future DLQ records metadata while preserving the due time | `... records a future DLQ while preserving the job's due time` |
| Live claim and terminal publication stay protected | `... leaves a live claim and a terminal publication protected` |
| Stale claim recovers conservatively as `unknown` | `... recovers a stale claim conservatively as unknown` |
| Superseded job and cross-entity message never revive anything | `... never revives a superseded job or a cross-entity message` |
| Store failure defers once with no raw detail | `... defers on a store failure without a second attempt or raw detail` |
| Throwing logger cannot change the settlement | `... keeps a settlement when the logger throws` |
| No claim/provider/re-arm/schedule port is reachable; main consumer unchanged | `... cannot reach a claim, provider, re-arm or schedule port at all` |

Queue adapter (`job-queue-v050.spec.ts`):

| Required behaviour | Test |
| --- | --- |
| One validated JSON send, bytes equal the frozen encoding, no broker delay | `sends exactly one validated JSON envelope with no broker delay` |
| Repeated wakes deliver identical bytes for the same persisted job | `delivers identical bytes when the same persisted job is sent again` |
| Bounded trace id stays inside the 2KiB envelope bound | `accepts a bounded trace id and keeps the envelope inside the 2KiB bound` |
| Unsendable envelopes: fixed `failed`/`INVALID_ENVELOPE`, zero binding calls | `rejects an unsendable envelope before the binding is touched` |
| Hostile getter/proxy: same fixed failure, zero binding calls | `fails closed on hostile inputs that throw after serialisation` |
| Every binding failure → fixed cause-free `unknown`/`QUEUE_SEND_UNKNOWN` | `translates every binding failure into one fixed, cause-free unknown error` |

## 5. Limits and unresolved items

- **No archive in this slice.** A DLQ archive (`archive/dlq/YYYY/MM/<jobId>.json`,
  90-day retention, DLQ category/stage) is deliberately omitted: it would add a
  second diagnostic path with no provider attempt metadata to write, and the
  export/wiring for it belongs to the runtime integration scope. Pending runtime
  diagnostic integration, as allowed by the task.
- **Queue runtime mapping is not implemented or claimed**: consumption,
  acknowledgement, redelivery policy, DLQ movement and the quarantine
  alert-and-ack handling are runtime scope. The adapter is exercised against a
  structural recorder, not a live Miniflare Queue binding or a real Cloudflare
  account.
- No D1 runtime validation of the settlement guards here; those semantics are
  proven against the rollback-capable fake and remain Task 3/T9 scope.
- The Worker package's broader test-tree tsc currently reports the same
  pre-existing errors as before this slice (`platform-descriptors.ts` LinkedIn
  env keys, `crypto-v050.spec.ts:268`, `r2-v050.spec.ts:144`); the scoped
  `test/support/job-queue-v050-tsconfig.json` check passes and covers exactly the
  new adapter and its spec.
- The new Worker spec joins the Worker suite (`test/*.spec.ts`), which is
  serialized (`maxWorkers: 1`) and subject to the documented local
  workerd/listen constraints when run inside the sandbox.
