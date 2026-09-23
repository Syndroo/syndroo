# Task T6c2b evidence — portable OAuth credential refresh

Status: **implemented and verified for this bounded scope** (attempt 1 of 3).
Owner: Task T6c2b. The concrete LinkedIn refresh driver (T6c3) and runtime wiring
(T6d) are out of scope; `docs/v0.5.0/acceptance-results.json` is unchanged and no
broad acceptance is claimed.

## 1. Changed paths

| Path | Lines | Change |
| --- | --- | --- |
| `packages/application/src/use-cases/oauth-refresh.ts` | 855 | new: `refreshOAuthCredential` |
| `packages/application/src/use-cases/oauth-refresh-driver.ts` | 72 | new: narrow refresh contract + captured snapshot |
| `packages/application/test/oauth-refresh.test.ts` | 961 (18 tests) | new focused suite |
| `packages/application/test/oauth-test-support.ts` | 790 | additive spies only (refresh driver/resolver spy, lease/commit/reconnect counters and hooks) |
| `packages/application/src/use-cases/auth-errors.ts` | 198 | additive closed reasons only: `no_refresh_payload`, `reconnect_required`, `lease_held`, `lease_mismatch` |
| this file | - | new evidence |

No frozen port, contract, fake, `index.ts`, Worker, SDK, crypto, D1, transport or
accepted connect/callback/complete/strategy module was changed.

## 2. Interface

```ts
// oauth-refresh-driver.ts — deliberately narrow: no callback URL and no
// start-configuration fingerprint, because refresh needs neither.
interface OAuthRefreshDriver {
  platform: Platform;
  canRefresh(plaintext: Uint8Array): boolean;                      // synchronous
  refresh(input: OAuthRefreshInput): Promise<OAuthRefreshResult>;  // one exchange
}
type OAuthRefreshDriverResolver =
  (platform: Platform) => OAuthRefreshDriver | null | Promise<OAuthRefreshDriver | null>;

// oauth-refresh.ts
interface RefreshOAuthCredentialInput { platform: Platform; expectedRevision?: number | null }
interface RefreshOAuthCredentialDependencies {
  credentials: CredentialStore;
  getCipher: () => CredentialCipher;        // resolved before the lease
  drivers: OAuthRefreshDriverResolver;
  strategies: PlatformStrategyRegistry;
  configFor: (platform: Platform) => PlatformConfigView;
  clock: UseCaseClock;
  leaseTokens: () => string;
}
export async function refreshOAuthCredential(input, dependencies): Promise<AuthMutationReceipt>;
```

Order: input snapshot, `readTrustedSlot`, guarded slot snapshot (nested
envelope/target/lease values copied), preflight (`no_refresh_payload`,
`revision_mismatch`, `reconnect_required`, `AUTH_IN_PROGRESS/lease_held`, then
cipher, active-payload decrypt, `canRefresh`, `nextPayloadRevision`), one
`acquireRefresh` with the observed revision and `REFRESH_LEASE_MS`, exact lease
and snapshot validation, one exchange, encrypt, fresh commit time, one
`completeRefresh`, receipt from the proposed committed snapshot.

Failure mapping: a live lease is `AUTH_IN_PROGRESS/lease_held`; an expired
unresolved lease or sticky reconnect state is `AUTH_CONFLICT/reconnect_required`;
an unknown or throwing acquisition is `STORE_UNAVAILABLE/store_unavailable`;
another holder finishing first is `AUTH_CONFLICT/lease_mismatch` with no
reconnect marking; a rejected, unknown or malformed exchange records
`reconnect_required` (`provider_rejected` / `unknown_result` / `invalid_response`)
fenced to the same lease and revision and reports `PROVIDER_ERROR`; an encryption
failure after a successful exchange records `unknown_result` and reports
`INSTANCE_NOT_READY/cipher_unavailable`; a thrown commit attempts the same fenced
failure record and reports `STORE_UNAVAILABLE/store_unavailable` — never a
success and never an automatic retry.

The receipt is the frozen `AuthMutationReceipt`
`{ platform, action: "refreshed", revision, configured, readiness, expiresAt }`.
The runtime maps `action: "refreshed"` onto the documented wire field
`refreshed: true`.

## 3. Review items applied

1. **Fresh commit clock after encryption.** The commit time is read after the
   awaited `encryptActivePayload`, and the lease-window check lives there; a
   cipher that pushes past the 60-second window produces no commit, records a
   fenced `reconnect_required` and reports `AUTH_CONFLICT/reconnect_required`.
   The pre-exchange window check (past window means no exchange, fenced
   reconnect) is unchanged.
2. **Fenced failed-save handling.** `commitRefresh` distinguishes a result from a
   throw; a throw first attempts `markReconnectRequired` with the exact lease
   token and revision — a conflict, which is what a genuinely committed revision
   produces because the lease is already cleared, leaves the new revision
   untouched — then reports `STORE_UNAVAILABLE/store_unavailable` as the explicit
   ambiguity. Mark results use a closed kind set: only `applied`/`already_applied`
   count as recorded. No blind-refresh advice; the operator inspects status and
   reconnects explicitly.
3. **Closed kinds everywhere.** `completeRefresh` must return `applied` or
   `already_applied` to reach a receipt; any other kind is
   `STORE_UNAVAILABLE/unexpected_result`. `markReconnectRequired` follows the same
   rule.
4. **Exact acquired identity.** The returned lease must match the acquisition
   instant and the requested 60-second expiry exactly, and the acquired snapshot
   is compared on platform, status, revision, binding id, payload revision,
   payload schema, envelope by value, target, expiry, refresh state and its
   embedded lease. Nested metadata is deep-copied at snapshot time, so no
   comparison reads a mutable store reference.
5. **Plaintext bound.** A refreshed native payload above the cipher's 64 KiB
   bound is rejected as `invalid_driver_response` before any encryption.

## 4. Verification

Commands, all with the bundled Node 24 first on `PATH`:

```bash
node_modules/.bin/tsc -p packages/application/tsconfig.json --noEmit       # exit 0 (source)
node_modules/.bin/tsc -p packages/application/tsconfig.json                # exit 0 (build)
node_modules/.bin/tsc -p packages/application/tsconfig.test.json --noEmit  # exit 0 (source + tests)

# from packages/application
../../node_modules/.bin/vitest run test/oauth-refresh.test.ts   # 1 file, 18 tests passed, exit 0
../../node_modules/.bin/vitest run                               # 22 files, 300 tests passed, exit 0
                                                                 # two clean runs: 05:04:45 (0.57s), 05:05:44 (0.58s)

git diff --check                                                 # exit 0
```

The full run is the 282 previously accepted application tests plus these 18 new
ones; no existing test was modified or skipped.

| Required check | Test |
| --- | --- |
| preflight performs zero outbound and zero lease work | `performs no lease or outbound work for every preflight rejection` (empty slot, revision mismatch, reconnect state, live lease, expired lease), `refuses a tombstoned slot, an unreadable payload or a missing capability` |
| competing refresh performs exactly one exchange | `lets exactly one of two competing refreshes reach the provider` |
| expired lease never re-acquires the uncertain token | the expired-lease case above plus `stops when the lease window elapses before the exchange, after it, or during encryption` |
| refresh versus set, remove and complete | `loses the commit cleanly when a set, remove or complete wins` (each winner bumps the revision and keeps its own connection) |
| unknown or throwing lease acquisition | `never exchanges when the lease result is unknown or throwing` (unknown, committed-lost-ack then held lease, thrown acquisition) |
| malformed, failed and expiring results | `records reconnect_required for a rejected, unknown or malformed exchange` (denied, sentinel-bearing failure, non-bytes, empty, non-canonical expiry, above 64 KiB) |
| encryption or store failure after the exchange | `records a fenced reconnect when encryption fails after a successful exchange`, `reports a committed-but-lost commit without damaging the new revision`, `fences a store failure that happened before the commit applied`, `never treats an arbitrary commit result as success` |
| a lost lease never poisons a replacement connection | `does not poison a replacement connection when the commit sees a lost lease` |
| binding id and target preserved, generation advanced | success case (slot snapshot: `bind-existing`, same target, revision 2, payloadRevision 2) |
| generation overflow before any exchange | `checks the generation bound before any lease` |
| hostile input, slot getters, forged failures and thenable preflight | `rejects malformed input before reading the slot`, `never lets a hostile slot, forged failure or thenable preflight escape`, `uses the captured driver methods when the injected object mutates during the lease` |

## 5. Unresolved / not verified

- The concrete refresh driver (LinkedIn `refresh_token` exchange, response merge
  and expiry rules) is T6c3; this scope uses a fake driver only.
- Runtime/API wiring, the `refreshed: true` mapping and the additive
  `index.ts` export remain T6d.
- The frozen fake is the only store implementation exercised here: real D1 lease
  acquisition, `completeRefresh` fingerprint replay and `markReconnectRequired`
  fencing stay separate gates.
- No full-repo gate (`npm test`, `npm run check`, bundle, startup, packaging) was
  run for this bounded scope, and no provider, credential or network resource was
  touched.
