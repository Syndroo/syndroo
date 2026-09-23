# Task T6c2a evidence — portable OAuth candidate completion and activation

Status: **implemented and verified for this bounded scope** (attempt 1 of 3).
Owner: Task T6c2a. Refresh (T6c2b), the concrete Worker driver (T6c3) and runtime
wiring (T6d) are out of scope and not implemented;
`docs/v0.5.0/acceptance-results.json` is unchanged and no broad acceptance is
claimed.

## 1. Changed paths

| Path | Lines | Change |
| --- | --- | --- |
| `packages/application/src/use-cases/oauth-complete.ts` | 775 | new: `completeOAuthOperation` |
| `packages/application/test/oauth-complete.test.ts` | 852 (17 tests) | new focused suite |
| `packages/application/test/oauth-test-support.ts` | 572 | additive spies only (confirm spy, activation hooks, slot injection) |
| `packages/application/src/use-cases/direct-credentials.ts` | 572 | reuse exports only: `nextPayloadRevision` and `projectStatus` exported, `projectStatus` deps narrowed to `Pick<DirectCredentialDependencies,"strategies"\|"configFor">`; no behaviour change |
| `packages/application/src/use-cases/auth-errors.ts` | 190 | additive closed reasons only: `candidate_expired`, `target`, `target_required` |
| `packages/application/src/use-cases/oauth-callback.ts` | - | one permitted comment correction in `encryptCandidate`; no behaviour change |
| this file | - | new evidence |

No frozen port, contract, fake, `index.ts`, Worker, SDK, crypto, D1, transport or
existing connect/callback module was changed. `oauth-driver.ts` needed **no**
change: `confirm` already returns `OAuthConfirmResult`, which this module
validates strictly.

## 2. Interface

```ts
export const ACTIVE_SLOT_PAYLOAD_SCHEMA_VERSION = 1;

interface CompleteOAuthOperationInput {
  platform: Platform;
  operationId: string;
  expectedRevision: number;
  // Wire `target: { author?, api_version?, blog? }` maps onto apiVersion here.
  target?: { author?: string | null; apiVersion?: string | null; blog?: string | null } | null;
}

interface CompleteOAuthOperationDependencies {
  credentials: CredentialStore;
  getCipher: () => CredentialCipher;          // lazy: replay needs no key
  drivers: OAuthDriverResolver;               // sync or async
  strategies: PlatformStrategyRegistry;
  configFor: (platform: Platform) => PlatformConfigView;
  clock: UseCaseClock;
  bindingIds: () => string;
}

export async function completeOAuthOperation(
  input: CompleteOAuthOperationInput,
  dependencies: CompleteOAuthOperationDependencies,
): Promise<CompleteReceiptRecord>;
```

Order: snapshot the caller input synchronously, one `readAuthOperation`, the
**replay branch** when the operation is completed (stored receipt validated and
returned with `replayed: true` before any key/driver/slot/generation check), then
phase must be `awaiting_confirmation` or `needs_configuration`, driver snapshot
must match the stored configuration binding and canonical callback, one
`readSlot`, `expectedRevision === operation.expectedRevision === slot.revision`,
clock, lazy cipher, candidate decrypt with
`{purpose:"oauth_candidate", recordId: operationId, schema 1, generation: candidatePayloadRevision}`,
strict codec decode, candidate-expiry check, synchronous
`driver.confirm({candidate, target, now})`, `nextPayloadRevision` plus a new
opaque binding id, active-slot encrypt with
`{purpose:"active_slot", recordId: platform}`, fresh clock (operation and
candidate expiry fences), receipt projected from the proposed committed snapshot
via `projectStatus`, exactly one `activateCandidate`, result validated, receipt
returned.

Failure mapping: a malformed id is `NOT_FOUND/operation_not_found`, a foreign
platform stays `NOT_FOUND`, a record whose id does not match the request is
`STORE_UNAVAILABLE/corrupt_record`, a revision or slot mismatch is
`AUTH_CONFLICT/revision_mismatch`, an expired operation is
`AUTH_CONFLICT/operation_expired`, an expired candidate grant is
`AUTH_CONFLICT/candidate_expired`, a missing or corrupt candidate is
`STORE_UNAVAILABLE/corrupt_record` or `.../candidate_invalid`, an unusable key is
`INSTANCE_NOT_READY/cipher_unavailable`, changed configuration is
`AUTH_CONFLICT/config_changed`, a rejected confirmation is
`INVALID_REQUEST/target` and remaining missing fields are
`AUTH_CONFLICT/target_required`, a generation overflow is
`INSTANCE_NOT_READY/payload_generation_overflow`, activation conflicts map onto
`NOT_FOUND`, `AUTH_CONFLICT/revision_mismatch`, `.../operation_expired`,
`.../config_changed`, `.../target_required` or `.../operation_phase`, and a
thrown or lost activation write is `STORE_UNAVAILABLE/store_unavailable` with no
retry.

## 3. Early-draft review items applied

1. `readOperation` validates **both** the requested `operationId` and the
   platform before any phase check or decryption, snapshots the record fields
   defensively in one guarded read, and reports an id mismatch as
   `corrupt_record` (a foreign platform stays `NOT_FOUND`).
2. `requireStoredReceipt` requires `stored === true`, a boolean `configured` and a
   closed-enum `readiness`; it no longer synthesises or coerces values, and any
   deviation is a fixed `corrupt_record`.
3. The activation result must be exactly `activated` or `replayed`; `activated`
   additionally requires `result.revision === receipt.revision === proposed
   revision`, and `replayed` requires `result.revision === receipt.revision`.
   Nothing is inferred from the live slot.
4. A thenable `confirm` result is a fixed `invalid_driver_response`, and its
   rejection is disposed without ever being awaited, so a hostile driver cannot
   leave an unhandled rejection behind.
5. The internal `apiVersion` naming and the wire `api_version` mapping are
   documented in the module and in this file.

## 4. Verification

Commands, all with the bundled Node 24 first on `PATH`:

```bash
node_modules/.bin/tsc -p packages/application/tsconfig.json --noEmit       # exit 0 (source)
node_modules/.bin/tsc -p packages/application/tsconfig.json                # exit 0 (build)
node_modules/.bin/tsc -p packages/application/tsconfig.test.json --noEmit  # exit 0 (source + tests)

# from packages/application
../../node_modules/.bin/vitest run test/oauth-complete.test.ts   # 1 file, 17 tests passed, exit 0
../../node_modules/.bin/vitest run                               # 21 files, 282 tests passed, exit 0
                                                                 # two clean runs: start 04:44:08 (0.54s), start 04:45:06 (0.51s)

git diff --check                                                 # exit 0
```

The full run is the 265 previously accepted application tests plus these 17 new
ones; no existing test was modified or skipped.

| Required check | Test |
| --- | --- |
| zero network work, one atomic write, full slot snapshot | `activates the candidate with no network work and one atomic write` (fetch spy, `begins`/`exchanges` empty, one `activateCandidate`, slot and stored receipt asserted) |
| requested id supplies the candidate AAD and the activation identity | same test (decrypt context `recordId: "op-1"`, active context `recordId: "x"`, activation input id `op-1`) |
| replay ordering and replay safety | `returns the stored receipt with replayed=true before any other check` (stale revision + throwing resolver + throwing cipher, no new binding, no extra slot read) |
| completed operation without a receipt | `reports a completed operation without a stored receipt as corrupt` |
| strict receipt validation (no coercion) | `rejects a malformed stored receipt instead of coercing it` (stored/configured/readiness/revision/identity cases) |
| stale revised input cannot revive an old operation | `cannot revive an older operation with a stale revision`, `requires the caller revision to match the slot as well as the operation` |
| foreign / mismatched / missing operation | `keeps a foreign or mismatched operation opaque` |
| missing, corrupt, expired operation and candidate | `rejects a missing, corrupt or expired candidate before activation` |
| target omission and no old-target inheritance | `never inherits an old active target and reports what is still missing` (confirm input target is all null) |
| configuration change | `refuses a changed driver configuration` |
| generation overflow before encryption | `checks the generation bound before encrypting` |
| concurrent completions: one activation, exact saved receipt replay | `activates once when two completions race` |
| complete versus set/remove losing the CAS | `loses the CAS cleanly when a direct set or remove wins` |
| committed activation lost acknowledgement, then explicit replay | `recovers a lost activation acknowledgement through an explicit replay` (one encryption, one binding, no second activation, replayed receipt) |
| activation result kind/revision validation | `validates the activation result kind and revision` |
| input, getter, sentinel and thenable safety | `rejects malformed input and targets before reading storage`, `never lets hostile input, a forged failure or a thenable confirm escape` |

## 5. Unresolved / not verified

- Refresh, the `canRefresh` preflight and lease handling are T6c2b.
- The concrete worker driver, HTTP wiring (`api_version` mapping), status DTO
  assembly and the additive `index.ts` export remain T6c3/T6d.
- The frozen fake is the only store implementation used here; real D1 activation
  atomics, the `oauth_state`/credential-slot transaction and production cleanup
  stay separate gates.
- No full-repo gate (`npm test`, `npm run check`, bundle, startup, packaging) was
  run for this bounded scope, and no provider, credential or network resource was
  touched.
