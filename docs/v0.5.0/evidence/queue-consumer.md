# Task 5c evidence — native Queue/DLQ mapping

Status: **T5c attempt 2 complete for review** (attempt 1 was rejected once for
incomplete ordering/zero-call evidence; only tests, this file and the module's
top comment changed in attempt 2). Owner: T5c scope only (the files listed
below). The acceptance ledger is unchanged: **3 PASS / 117 NOT_RUN**, no gate is
promoted by this slice, because it proves the runtime mapping and its disposition
ordering against the accepted portable use cases and the frozen fake — not real
Cloudflare Queue behaviour, retry counts, DLQ topology or production
observability.

## 1. Authority followed

`docs/v0.5.0/runtime-composition.md` (Main queue and DLQ), including the
separate-module ruling:

- route by configured **exact** physical queue names; unknown names are a fixed
  operational error with zero provider calls
- main messages go straight to `executePublication`; settled acknowledges,
  infrastructure outcomes and unexpected exceptions request a bounded retry
- business retries are already committed as a future outbox job; the runtime
  never converts them into broker delays
- DLQ messages go only to `settleDeadLetterMessage`; a malformed message emits a
  fixed quarantine alert **before** acknowledgement and performs no domain write
- a swallowed optional log is not proof that the required alert succeeded
- the module may land before the coordinated index/route cutover, and accepting
  it is not accepting the still-legacy exported Worker entrypoint

## 2. Files, runtime, commands

```text
packages/cloudflare-worker/src/composition/queue-consumer.ts        (new)
packages/cloudflare-worker/test/queue-consumer-v050.native.ts      (new, 19 tests)
packages/cloudflare-worker/test/queue-consumer-v050.vitest.config.ts (new)
packages/cloudflare-worker/test/support/queue-consumer-v050-worker.ts   (new)
packages/cloudflare-worker/test/support/queue-consumer-v050-tsconfig.json (new)
docs/v0.5.0/evidence/queue-consumer.md                             (new, this file)
```

| Item | Value |
| --- | --- |
| Worktree | `/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050` |
| Runtime | Node `v24.19.0` (bundled), Vitest `4.1.11`, native workerd pool |
| Ports | accepted `executePublication` + `ExecutePublicationDependencies`, accepted `settleDeadLetterMessage` + `SettleDeadLetterDependencies` |
| Unchanged | `src/jobs.ts`, `src/index.ts`, other composition modules, adapters, application package, manifests and configs |

```bash
# scoped source + test + dedicated-config type check
tsc -p test/support/queue-consumer-v050-tsconfig.json                 # exit 0, no suppressions

# dedicated native project under a finite external watchdog (perl alarm 300s),
# because the T9a watchdog is not accepted yet
perl -e '$t=shift; alarm $t; exec @ARGV' 300 vitest run --config test/queue-consumer-v050.vitest.config.ts
# 1 file, 19 tests passed, exit 0 (07:54:23 run, 0.60s)
```

The native run needed only the already-documented local loopback escalation
(`cloudflare-pool` listens on `127.0.0.1`, which the sandbox blocks with
`EPERM`). The dedicated project sets `cf: false` and an `outboundService` that
always throws, and its Worker entry is this slice's own support stub, so the
legacy entry graph is not loaded and no broker, account or provider request is
made. The main Worker test setup/runner is untouched; its inventory was shared
read-only with the T9a isolation owner.

## 3. Implementation

`createQueueConsumer({ names, execute, settleDeadLetter, alert })` validates and
**copies** the two physical names once, requires an alert sink, and returns the
handler:

1. read `batch.queue`; membership is decided **before** the batch's messages are
   inspected, so an unknown or prefixed queue can never touch message state
2. main queue → `executePublication(message.body, execute)` per message,
   sequentially; `settled` acknowledges, `infrastructure_retry` and any
   unexpected exception request `retry({ delaySeconds: 60 })`
3. DLQ → `settleDeadLetterMessage(message.body, settleDeadLetter)` per message;
   `settled` acknowledges after metadata settlement, `infrastructure_retry`
   retries, and `quarantined` awaits the required alert before acknowledging
4. dispositions are attempted exactly once: a throwing `ack()`/`retry()` becomes
   a fixed `QueueConsumerError("QUEUE_DISPOSITION_FAILED")` instead of a second
   disposition attempt

There is no envelope decoding, no business retry policy, no `queue.send`, no
self-forwarding and no log sink other than the required alert. Queue names,
message ids, bodies and exception text never appear in an error or an alert.

## 4. Review corrections folded into this attempt

Attempt 2 replaced final-state assertions with pending-state ordering evidence
and closed the comment/type mismatch:

1. **Async alert ordering with one shared order log.** The quarantine test now
   uses a deferred promise written into the *same* order array as the batch
   dispositions: while the alert is pending the log is exactly
   `["alert-start"]` with no ack and no retry, then `alert-end` → `ack:0`, and a
   separate native batch records the completed acknowledgement.
2. **DLQ metadata ordering.** The settled-DLQ test defers the fake's semantic
   settlement: while it is pending the order log is `["settle-start"]`, there is
   no disposition, and the publication is still `pending`; after release the log
   is `settle-start → settle-end → ack:0` with exactly one settlement call, zero
   preparation calls (the provider gateway) and no alert.
3. **Sequential processing.** The multi-message test now holds the first
   message inside preparation: while held, only `prepare:0` has started, the
   provider has not been called and nothing is acknowledged; after release the
   order is `ack:0 → ack:1` with two provider calls.
4. **Zero-call routing proof without a nullable escape.** The unknown/prefixed
   queue cases now use a *forbidden* dependency set whose every semantic method,
   preparation, signer, clock, id factory and alert sink counts its invocation
   and throws; the direct fixed `QUEUE_ROUTING_INVALID` error is asserted, the
   batch's structural dispositions are empty and every counter stays zero. A
   real native `MessageBatch` on an unknown queue produces the same fixed error.
5. **Comment corrected.** The module header no longer says "synchronous": it
   states that the alert sink may be synchronous or return a promise, that its
   completion is awaited, and that a synchronous throw and a rejected promise
   behave alike.

Attempt 1 already contained these two corrections, which remain in place:

1. **Route before messages.** The batch's `messages` access moved after the
   queue-membership decision and inside its own guard, so a hostile or malformed
   shape yields the fixed routing error instead of leaking a raw `Error`.
   Regression: `fails a hostile batch shape with the fixed routing error and no
   domain work` runs a batch whose `messages` getter throws (carrying a sentinel)
   for unknown, main and DLQ queue names, and asserts the fixed code, zero
   provider calls, zero alerts, an unchanged store and no sentinel.
2. **Alert completion before ack.** `QuarantineAlertSink` may return a promise;
   the consumer awaits it, so a rejected promise behaves exactly like a
   synchronous throw: fixed retry, no acknowledgement. Two regressions cover an
   asynchronous alert that resolves later (`alert-start`, `alert-end`, `ack:0`
   order) and one that rejects (native retry result plus a structural batch with
   no ack attempt). Wording here claims successful alert completion before
   acknowledgement only — not deployment log-export durability.

## 5. Behaviour covered by the native suite (19 tests)

| Required behaviour | Test |
| --- | --- |
| Missing, empty, whitespace, equal or absent-alert configuration fails at creation | `queue routing validation > rejects missing, empty, equal or whitespace names and a missing sink` |
| Unknown/prefixed/other queue names: fixed error, every counted semantic call zero, no disposition (structural and native batch) | `batch routing > performs no domain work or disposition for unknown, prefixed or missing queue names` |
| Names are copied once; the caller's object is never re-read | `batch routing > copies the physical names once and never re-reads the caller's object` |
| Hostile batch shape → fixed routing error, zero domain work | `batch routing > fails a hostile batch shape with the fixed routing error and no domain work` |
| Main malformed input → one fixed 60s retry, zero provider calls | `main queue mapping > retries a malformed message once with the fixed delay and no provider call` |
| Settled execution acknowledges; duplicate/terminal never resend | `... acknowledges a settled execution and never resends duplicates or terminal work` |
| Future and unknown work acknowledge without sending | `... acknowledges future and unknown work without sending anything` |
| Business retry acknowledges and is not a broker retry | `... acknowledges a business retry without turning it into a broker retry` |
| Unexpected use-case exception → one fixed retry | `... maps an unexpected use-case exception to one fixed retry` |
| Sequential processing: second message cannot start and no ack while the first is held, then ordered `ack:0 → ack:1` | `... processes several messages sequentially with one disposition each` |
| Settled DLQ message: no disposition while settlement is pending, then `settle-end → ack`, provider gateway 0 | `dead-letter queue mapping > acknowledges a settled DLQ message after metadata settlement` |
| Quarantine alert is emitted before the ack | `... emits the fixed alert before acknowledging a quarantined message` |
| Malformed DLQ message acknowledges only after the alert (native batch) | `... acknowledges a malformed DLQ message after the alert in a native batch` |
| Throwing alert → retry with no ack attempt | `... retries without acknowledging when the quarantine alert throws` |
| Store failure → retry, no alert | `... retries a store failure without alerting` |
| Asynchronous alert: zero ack/retry while pending, then `alert-end → ack`, native ack after completion | `... waits for an asynchronous alert to complete before acknowledging` |
| Asynchronous alert rejection → retry, no ack | `... retries without acknowledging when an asynchronous alert rejects` |
| Throwing native ack → fixed operational error, one attempt | `disposition safety > surfaces a fixed operational error when a native disposition throws, with one attempt only` |
| Throwing native retry → fixed operational error | `... surfaces a fixed operational error when a retry disposition throws` |

## 6. Limits and unresolved items

- **No real broker, account or provider call.** Native `createMessageBatch` /
  `getQueueResult` prove ack/retry mapping and ordering locally; deployment
  retry-count limits, the versioned DLQ resource topology and real Queue
  behaviour remain T9 source-configuration and deployment verification.
- **No R2 DLQ archive here.** A separate bounded 90-day DLQ diagnostic remains
  separate work; this module never touches `recordArchiveResult` or a provider
  outcome archive.
- **Alert sink is narrow on purpose.** The tests prove alert emission/completion
  ordering and failure handling; production log-export durability and
  observability configuration are out of scope, and a swallowed optional log is
  explicitly not accepted as proof of delivery.
- **Legacy entry untouched.** `src/jobs.ts` and `src/index.ts` still contain the
  old queue path; accepting this module does not accept the legacy entrypoint,
  and the coordinated cutover is later work.
- The dedicated project is not the main Worker runner: it includes exactly one
  `.native.ts` file, uses its own stub and fail-closed outbound service, and
  leaves the T9a isolation work (main test setup/runner) to its owner.
