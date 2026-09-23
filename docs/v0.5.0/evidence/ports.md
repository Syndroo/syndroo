# Task 1 evidence — portable contracts and atomic fake

Status: **T1 attempt 3 complete for review** (contracts, version envelope
validation, rollback-capable fake, shared contract suite). No product acceptance
ID is claimed: `docs/v0.5.0/acceptance-results.json` stays `NOT_RUN` for every
gate, because this task produces developer-side contracts and test doubles, not
evidence that D1/Queue/R2 behaviour exists. Owner: Task 1
(`packages/application/**` and this file only).

## 1. Tree, runtime, commands

| Item | Value |
| --- | --- |
| Worktree | `/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050` |
| Package | `packages/application` (`@syndroo/application`, private, `0.1.0`; T9 owns release versions) |
| Exports | `.` (ports + contracts) and `./testing` (fake, shared suite, fixtures) |
| Runtime | Node `v26.7.0`, npm `11.19.0`, TypeScript `7.0.2`, Vitest `4.1.11` |
| Dependency | `@syndroo/core` `0.1.0` only |

```bash
npm run build -w @syndroo/application   # tsc -p tsconfig.json        -> exit 0
npm run check -w @syndroo/application   # src --noEmit + tests        -> exit 0
npm run test  -w @syndroo/application   # build && vitest run         -> 9 files, 65 tests passed
```

Shared suite: **49 scenarios** in `src/testing/contract-suite.ts`, run against
the fake by `test/store-contracts.test.ts`. It imports no test framework and
takes a plain `StoreHarness`, so Task 3 can run the identical set on local D1.
`tsconfig.json` uses `"types": []` with `ES2022/DOM/DOM.Iterable`; only the test
tsconfig adds `"types": ["node"]` for the source-scanning test.

## 2. Failure-first evidence for this round

Written before the fixes, in the order root raised them.

1. **Interface red run** — adding the contract surface first made the build fail
   with `Property 'expectedRevision' is missing in type 'RefreshFailure'`,
   `Property 'recordArchiveResult' does not exist on type 'PublishingStore'`,
   missing `lastRefreshCommitFingerprint`, and an invalid claim reason. That is
   the recorded red state for the port changes.
2. **Behavior red run (temporary revert)** — reverting only the `acquireRefresh`
   lease guard reproduced the vulnerability root flagged:

   ```
   ❯ test/store-contracts.test.ts (11 tests | 1 failed)
   "refresh_expired_lease_blocks_new_exchange: expired lease must not hand out a
    new one (expected kind conflict, received acquired)"
   ```

   Restoring the guard returns the suite to green. The same red→green pattern
   drove the earlier scenarios: contract-suite failures revealed that the fake
   never linked `currentJobId`, that a retry could extend the attempt budget, and
   that a leaked CAS looked like a replay.
3. **Attempt 3 behavioral red run** — both defects were reproduced before the
   fix, with no compile error involved:

   ```
   + "archive_after_safe_retry: archive result for the completed attempt applies
      (expected kind applied, received conflict)",
   + "cleanup_expired_budget_is_bounded: second row untouched by the first call
      (expected \"pending_callback\", received \"expired\")",
   ```

   The first shows the safe-retry archive never landing; the second shows
   `cleanupExpired` spending two separate `limit` budgets in one call. Both
   scenarios pass after the fixes below.

## 3. Changes in this round

| # | Root finding | Fix |
| --- | --- | --- |
| 1 | Expired unfinished lease let a second exchange proceed | `acquireRefresh` refuses on any existing lease: `lease_held` while live, `reconnect_required` once expired, zero mutation; only explicit set/remove/complete resets |
| 2 | Stale failure token could poison a fresh direct set | `markReconnectRequired` requires matching lease token **and** `expectedRevision`; no lease means conflict |
| 2b | Only `unknown_result` blocked refresh | All three reasons (`unknown_result`, `provider_rejected`, `invalid_response`) set `reconnect_required` |
| 3 | `completeRefresh` could retarget; replay identity too weak | Input target must match the stored target or conflict; replay requires an exact fingerprint (token, revision, envelope, payload revision/schema, expiry, target) at `revision+1`; target and slot binding are preserved |
| 3b | Late results after a direct set | Fenced by revision and lease, so a replacement connection is untouched |
| 4 | Callback/activation conflicts mutated state | Phase is checked first; expiry and config conflicts are read-only; expiry transitions belong to `cleanupExpired` |
| 5 | Completed activation replay reported the current slot revision | Replay returns `receipt.revision` |
| 6 | Claim accepted cancelled jobs, settled rows, wrong attempts | New guards: `cancelled_job`, `publication_state`, `attemptNo === attempts + 1` |
| 7 | No per-attempt archive result port | `PublishingStore.recordArchiveResult` guarded on current attempt **and** planned key; late or other-key results conflict |
| 8 | Candidate could be stored after TTL | `saveCandidate` conflicts past TTL; `cleanupExpired` clears candidate/request secrets and expires non-terminal rows |
| 9 | Unknown-claim fixtures never committed | New `claimCommittedUnknownOnce`, `oauthClaimCommittedUnknownOnce`, `refreshClaimCommittedUnknownOnce` fixtures that commit and then report `unknown`, so duplicates provably do not exchange |
| 10 | `oldestDueAt` did not follow the dispatchable predicate | Uses `listReady`'s predicate: pending, due, `dlqSeenAt === null` |
| 11 | Evidence must be measured only | This file records commands, counts and the red/green runs above; no unverified invariant claims |
| 12 | Dispatched future jobs could never settle after a DLQ | DLQ-settled set covers `pending` and `dispatched`; `recordDispatch` conflicts after `dlqSeenAt` |
| 13 | GC deleted unknown/ambiguous records and could starve | GC keeps `failed` + (`errorAmbiguous` or `unknown`) rows, selects eligible rows before the limit; cleanup does the same with receipt retention |
| 14 | DLQ metadata written before the entity pair was proven | `job.aggregateId` must equal the publication id before any metadata write |
| 15 | Projection had no observation time | `projectAuthOperation({ now })` projects expired non-terminal operations as `expired` and hides `candidate`; stored records are untouched |
| 16 | OAuth/refresh unknown fixtures did not commit | Covered by the committed-unknown fixtures in item 9 |
| 17 | CAS semantics | No implicit replay: every satisfied set/migrate/remove bumps the revision, including remove on a tombstone, so an authorization created at the previous revision cannot complete after a delete |
| 18 | Create DTO drift | `publication.credentialRevision` must equal its platform's `credentialGuard.expectedRevision` |
| 19 | Archive `code` was regex-validated | Replaced with the fixed `ARCHIVE_CODES` union (core `PublishErrorCode` + transport/storage/DLQ codes) and a compile-time coverage check |
| 20 | Archive result could never land after a safe retry | Identity is the live attempt id, falling back to `committedOutcome.key` when a terminal commit cleared it; a new claim resets `archiveKey`/`archiveStatus` so the previous attempt's failure is never attributed to the new one |
| 21 | `cleanupExpired` could write 2×`limit` rows and under-report | One eligible union (past TTL and needs secret clearing or a phase change), sliced once, one merged write per row, `removed` = rows actually changed; terminal phases and receipts preserved |

New contract surface for root review: `ClaimBlockReason` +`publication_state`
+`cancelled_job`, `CommitConflictReason` +`reconnect_required`,
`RefreshFailure.expectedRevision`, `EncryptedSlotSnapshot.lastRefreshCommitFingerprint`,
`PublishingStore.recordArchiveResult`, `ArchiveCode`/`ARCHIVE_CODES`, and the
`projectAuthOperation({ now })` parameter. Attempt 3 adds no contract type; it
fixes behavior plus the optional test-harness hook
`StoreHarness.placeResidualSecrets` used by the cleanup scenario (Task 3 can
implement it with a raw fixture write, or skip that single scenario and say so).

## 4. Why the first attempt missed these

The first suite mirrored the implementation instead of the invariant. Refresh
cases exercised only the live-lease path and marked reconnect while the lease was
still valid; replay was keyed on ciphertext+revision and the tests asserted that
same shape; OAuth conflict tests asserted the returned reason but never re-read
the record, so phase mutations were invisible; claim tests never tried a
cancelled job, a settled publication or a wrong attempt number; `currentJobId`
linking was only added after the first red run; archive had no per-attempt write
port, so a late-result case could not exist; diagnostics asserted only counts,
never the oldest-due predicate; and the unknown-claim fixture returned before
writing. The suite now asserts state invariants (zero-mutation conflicts, exact
replay identity, retained records) rather than echoing the code path.

## 5. Interface requirements handed to Task 3 (D1)

1. `committedOutcome { key, fingerprint }`: `key` is the attempt id for result
   commits and the job id for pre-execution rejections.
2. `ClaimCondition.credentialSlotRevision` is checked against the **current**
   slot revision, not `credentialRevisionAtCreate`.
3. `refreshState`, `refreshLease`, `lastRefreshCommitFingerprint`, and the
   read-only conflict rules (expiry/config/lease) must hold in SQL too.
4. `dlqSeenAt`/`transportReason` are written only after the entity pair matches;
   `listReady` excludes `dlqSeenAt IS NOT NULL`; settlement covers `pending` and
   `dispatched`.
5. GC and cleanup select eligible rows before applying `limit`; unknown and
   ambiguous results keep their transport records; completed receipts are
   retained with secrets cleared.
6. `compareAndSetSlot` has no implicit replay; every satisfied call bumps the
   revision.
7. Run `runStoreContractScenarios(harness)` from `@syndroo/application/testing`
   against local D1 and report per-scenario results (49 scenarios).
8. Archive identity and cleanup budget are behavioral, not just storage: a
   safe-retry completion must still accept its own archive result, a new claim
   must clear the old archive plan, and cleanup must change at most `limit` rows
   per call with the count matching the rows changed.

## 6. Remaining / limitations

- **Workspace linking:** root `npm install` is still needed for
  `node_modules/@syndroo/application`, and root build/test ordering does not
  include the package (T9 owns those manifests).
- **Tree-shaking:** the fake is reachable only via the `./testing` subpath; the
  production-bundle claim still needs verification once Worker wiring exists.
- **Fake cipher:** still a `test-double` (obfuscation + AAD checksum) refused by
  `assertProductionCipher`; real AES-256-GCM is Task 4.
- **Not verified here:** D1, Queue, R2, real Worker ambient types, provider SDKs,
  live accounts, deployment. No acceptance ID is marked PASS.
- **Process note:** T1 stops expanding after this round; further contract changes
  should come from T3/T5/T6 findings through root review.
