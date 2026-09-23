# D1 implementation notes

Architecture constraints for Task 3, reviewed by root. These are implementation decisions, not execution evidence.

## One repository and additive upgrade

Keep one concrete `D1Repository` implementing the application ports. Its SQL and row decoders may be ordinary modules under `src/infrastructure/d1/`; no second repository or generic transaction framework. Preserve existing public read projections while runtime wiring changes in later tasks. Temporary compatibility methods must remain visibly legacy and must not become an alternative unfenced execution path in the final composition.

Append migration `0006_v050.sql`; migrations 0001–0005 remain byte-for-byte unchanged. New columns/tables preserve IDs, content, canonical request intent and idempotency keys. New jobs are not created by schema application: explicit cutover tooling owns reviewed backfill. Legacy publishing/ambiguous results cannot become executable jobs. Existing credential plaintext remains identifiable until the explicit encryption/CAS migration clears it; an encrypted slot must never fall back to stale plaintext or Env on decode failure.

## Guarded batches

Every semantic write executes in one D1 batch. An ordinary zero-row conditional statement does not roll back later statements, so all dependent statements must observe the winning mutation from that same invocation.

Use existing unpredictable claim identities where sufficient. For multi-row operations without an adequate identity, a private fresh mutation token on the owning row is acceptable. Generate it per invocation, write it only with the winning conditional update, and gate every dependent write on that exact token. Do not use a timestamp, provider payload, or a token shared by all replays as a successful-current-batch marker. Do not add an unbounded transaction-log table.

- Create: gate the parent insert on all current slot guards and idempotency uniqueness. Child inserts select the parent ID plus a fresh current-invocation mutation token. Parent ID alone is insufficient when the guard affects zero rows and that ID already exists. A generated-ID collision with eligible guards raises an error and rolls back; no collision can authorize extra children. Conflicting idempotency requests read the original request after the transaction.
- Claim: current job/entity/kind/attempt number, eligible publication status, due time, live transport intent, no DLQ, attempt budget and preparation-time slot revision all gate the same update. Aggregate updates require this invocation's winning claim. Return `unknown` on uncertain write acknowledgement; no provider call is then authorized.
- Outcome: exact claim token, attempt ID and current job gate the publication update. Job completion, optional successor insertion and parent aggregate require its winning mutation. Identical known-result replay returns `already_applied`; a different result is a conflict. No additional successor job may appear.
- Activation: operation phase/expiry/configuration, initial expected revision and actual slot revision gate one activation. New slot and stored receipt depend on the same winner. Completed-operation replay returns the original receipt regardless of the current connection.
- Refresh: acquire a persistent unique lease before network. An existing expired lease never becomes a new acquisition. Completion/failure requires its exact lease token and original slot revision; every conflict leaves all rows unchanged. Success preserves connection binding and target.
- Archive completion: match latest attempt and planned key; a late archive write cannot modify a newer attempt's status.

Read-after-write may diagnose a conflict or return an applied result; it cannot repair an earlier partial batch. SQL errors must map to a fixed safe storage error without raw SQL, bound parameters or provider text.

## Real execution evidence

Run the application shared contract scenarios against actual local D1, then add D1-specific fault and contention fixtures. Use test-only SQL triggers to abort after intermediate writes and compare full relevant snapshots. Exercise zero-row guards independently of SQL errors. Concurrent claims, activation versus direct set/remove, refresh versus direct set/remove, and outcome persistence failure require observed winner counts and unchanged losing state.

Seed representative rows before query-plan checks. Collect real statement counts and D1 rows-read/rows-written metadata from the same public methods used by runtime. Report measurements as local adapter evidence, not billing guarantees. Index due dispatch, stalled recovery, stale claims, operation state/expiry, publication lookup and idempotency paths. Every cleanup/recovery selector and mutation has an explicit finite limit.

DLQ-marked future jobs remain excluded from dispatch. Before due they retain schedule; at due maintenance conditionally records dead-lettered. Unknown-associated jobs and all domain/idempotency records are outside ordinary outbox GC.
