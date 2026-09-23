# Task 5b1 evidence — portable execution, outcome commit and archive

Status: **T5b1 attempt 1 complete for review.** Owner: T5b1 scope
(`packages/application/src/use-cases/{execute-publication,execution-policy,execution-archive}.ts`,
two named test files and this file only). No product acceptance ID is claimed:
`docs/v0.5.0/acceptance-results.json` stays `NOT_RUN`, because this task proves
portable consumer semantics against the rollback-capable fake, not D1/Queue/R2
runtime behaviour. The standalone DLQ consumer and all runtime wiring remain
later scope.

## 1. Runtime, commands, files

| Item | Value |
| --- | --- |
| Worktree | `/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050` |
| Runtime | Node `v24.19.0` (bundled `codex-primary-runtime`), Vitest `4.1.11` |
| Dependency | `@syndroo/core` + the frozen application contracts; no new dependency |
| Store | fake `src/testing/snapshot-fake.ts` (unchanged); provider/archive/logger via injected doubles |

```bash
tsc -p packages/application/tsconfig.json --noEmit      # exit 0
tsc -p packages/application/tsconfig.test.json          # exit 0
npm run check -w @syndroo/application                   # exit 0
npm run build -w @syndroo/application                    # exit 0
npm run test  -w @syndroo/application                   # 13 files, 147 tests passed
```

New tests: `test/execute-publication.test.ts` 30, `test/execution-policy.test.ts`
18. The previously accepted 11 files / 99 tests are unchanged and still pass.

```text
packages/application/src/use-cases/execute-publication.ts  (new)
packages/application/src/use-cases/execution-policy.ts     (new)
packages/application/src/use-cases/execution-archive.ts    (new)
packages/application/test/execute-publication.test.ts      (new)
packages/application/test/execution-policy.test.ts         (new)
docs/v0.5.0/evidence/execution.md                          (new, this file)
```

## 2. What was implemented

`execution-policy.ts` — pure decision logic: allowlisted provider-failure views,
the single retry/terminal policy, bounded provider identifiers, archive outcome
mapping, deterministic archive keys and the allowlisted archive payload builder.
Nothing here performs a store, queue, provider, clock or archive call.

`execution-archive.ts` — best-effort archive write that runs strictly after an
authoritative commit. One total budget covers the whole stage; the object-write
slice and the timeout-status marking slice are both inside that budget.

`execute-publication.ts` — `executePublication(message, deps)` returning a frozen
`ConsumerOutcome`:

1. strict `decodeQueueEnvelopeV1`; malformed input never loads or calls anything
2. exact `getExecution` load, then read-only eligibility: unsupported kind,
   entity/job mismatch, superseded job, cancelled intent, terminal publication,
   live claim, DLQ-seen job, future job, exhausted attempt budget, stale attempt
3. missing `credentialBinding` is rejected here, before preparation or signing
4. preparation + HMAC verification before any claim; temporary failures defer,
   permanent configuration failures and binding mismatches close as `AUTH`
5. one atomic claim with the prepared slot revision and freshly generated
   claim/attempt ids, read under a fresh clock after preparation
6. exactly one provider call inside its own catch; unresolved throws become an
   allowlisted ambiguous failure with no message or cause
7. one pre-built outcome object (ids, retry job and archive key generated before
   persistence) committed with at most three writes of the identical object
8. archive strictly after `applied`/`already_applied`, outside the provider catch

## 3. Review corrections folded into this attempt

1. **Archive stage total budget.** An earlier revision let the timeout-status
   marking run for 250 ms *after* the budget, i.e. 2250 ms worst case. The stage
   now splits one budget: reserve = `min(250, max(1, floor(budget/4)))`, object
   write deadline = `total - reserve`, marking shares the same total deadline.
   Nothing waits past the requested budget; a hanging status write may still
   report `available` (the object was written) without claiming the status row
   landed. Covered by real-timer bounded tests and a fake-timer test asserting
   the stage resolves at exactly 1000 ms with both phases hanging.
2. **Conservative failure normalization.** UNKNOWN or non-allowlisted codes are
   always ambiguous; only a literal `false` on a known code is no-side-effect
   proof; a non-boolean flag stays ambiguous; field reads are guarded so a
   throwing accessor (sentinel-bearing message) degrades to UNKNOWN. Covered by
   negative fixtures for typed-UNKNOWN-with-false, forged code + malformed flag
   and a throwing `ambiguous`/`retryAfterAt` getter, each asserting no retry.
3. **Fresh completion clock.** The queue-start timestamp is used only for the
   read-only due decision and as the preparation observation time. Every write
   reads the clock when it acts: the claim reads fresh after preparation, and one
   fresh completion read after the provider freezes `commit.now`, the 60s/120s
   retry base and the archive plan. An advancing-clock regression shows
   `retryAt - entry > 60s` and `updatedAt === retryAt - 60s`.
4. **`AUTH` for known config/binding rejections, earlier legacy rejection.**
   `invalid_configuration`, `legacy_unbound` and `binding_mismatch` now record
   `errorCode: AUTH` (non-ambiguous). A null stored binding is rejected before
   preparation or signing, so a missing/unusable key cannot misclassify or defer
   it forever.
5. **Guarded provider metadata.** `runPublisher` snapshots `externalId`/`url`
   behind bounded guarded access; hostile metadata omits the value and the
   successful publish is preserved.

## 4. Behaviour covered by tests

| Required behaviour | Test |
| --- | --- |
| Malformed envelope: fixed reason, zero store reads, zero provider | `envelope and eligibility > rejects a malformed envelope ...` |
| Unknown, superseded, unsupported, cancelled, wrong entity | `... settles an unknown, superseded, unsupported or cancelled job ...` |
| Terminal publication and live claim (no placeholder retry) | `... settles a terminal publication and a live claim without a provider` |
| Concurrent duplicates: exactly one provider call | `... invokes exactly one provider across concurrent duplicates` |
| Future job re-armed with preserved `availableAt`; failed re-arm defers | `... re-arms a future current job and only settles once intent is durable` |
| DLQ-seen due job settles through the DLQ path only | `... settles a DLQ-seen due job through the DLQ path only` |
| Exhausted attempt budget closes without a provider | `... closes an exhausted attempt budget without a provider` |
| Temporary preparation failure defers, attempts unchanged | `preparation and rejection > defers temporary preparation failures ...` |
| Permanent config/binding rejection as AUTH | `... rejects a permanently misconfigured or mis-bound publication as AUTH` |
| Missing binding rejected before prepare/signer | `... rejects a missing binding before preparation or signing` |
| Same connection after a revision advance still executes | `... allows the same connection after a slot revision advance` |
| Credential revision race defers without a provider | `... defers when the slot revision changed between preparation and claim` |
| Unknown/throwing claim never reaches a provider | `... never calls a provider when the claim result is unknown or throws` |
| Success stores provider metadata, one call, job cancelled | `provider outcomes > publishes once through the frozen provider ...` |
| Hostile provider metadata cannot lose a success | `... keeps a successful publish when provider metadata is hostile` |
| Transient commit throw retried with the identical write | `... retries the identical local write after a transient commit failure` |
| Repeated commit failure/conflict never republishes | `... never republishes when the outcome write keeps failing or conflicts` |
| 60s/120s retries with a new job each time, then exhaustion, no 4th job | `... schedules 60s and 120s business retries, then closes the exhausted budget` |
| Retry base is the fresh completion time | `... bases the business retry on a fresh completion time, not on queue start` |
| Valid later hint preserved (no 24h truncation) | `... preserves a valid later retry hint end to end` |
| Ambiguous/unknown/malformed failures never retry | `... closes ambiguous, unknown and malformed failures without retrying` |
| Unambiguous non-safe code is a clean rejection | `... rejects an unambiguous non-safe provider code without retrying` |
| Archive after commit: allowlisted payload, 30d TTL, exact key | `archive > archives an allowlisted diagnostic after the outcome commit` |
| Archive rejection recorded without changing the outcome | `... records a failed archive without changing the publishing outcome` |
| Hanging object write bounded; hanging status write bounded | `... bounds a hanging archive object write ...`, `... bounds a hanging archive status write ...` |
| Stage finishes exactly at the requested total budget | `... finishes the archive stage exactly at the requested total budget` |
| No archive binding means no fake persistence | `... does not pretend to archive when no archive binding is injected` |
| Throwing logger cannot change the outcome | `... keeps the outcome when the archive logger throws` |
| Secrets absent from records, logs and archive objects | `... keeps secrets out of records, logs and archive objects` |
| Policy: retry schedule, hint handling, budget exhaustion, ambiguity | `execution-policy.test.ts` (18 tests) |

## 5. Limits and unresolved items

- No D1, Queue, R2 or Worker API is touched here; local runtime validation of
  these semantics stays in Task 3/T9 scope. Verification is fake-store behaviour
  proof plus pure-policy tests.
- The archive is optional: with no `ArchiveStore` injected the commit records
  `archive: null` and `archiveStatus: not_requested`; nothing pretends an object
  exists.
- `httpStatus` is always null in the planned archive object because the portable
  provider result carries no typed HTTP evidence. `SanitizedArchive` allows it,
  and no status is guessed from a message.
- A rejected/conflicted outcome persistence settles as `duplicate`/`terminal`/
  `stale_job` after a re-read; it never republishes. The live claim keeps the
  fence, and the watchdog path owns the eventual conservative `unknown`.
- Late archive results are fenced by the store contract on the exact attempt id
  plus the planned logical key (shared contract-suite coverage); this task always
  passes that exact pair, never a newer attempt's identity.
- Terminal rejections of a misconfigured/mis-bound record consume no attempt
  (`attempts` stays unchanged), matching the design's pre-provider semantics.
- `executePublication` returns the frozen `ConsumerOutcome`; broker
  acknowledgement, retry delay and DLQ movement remain runtime concerns.
