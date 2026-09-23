# Task T6c1 evidence — portable OAuth driver contract, candidate codec, connect, callback, operation read

Status: **the first bounded OAuth scope is implemented and its focused suites,
the full application suite and the application type checks pass locally**
(attempt 2 of 3: attempt 1 was rejected with seven concrete findings, all of them
implemented here and covered by new regressions). Owner: Task T6c1.
Complete/refresh (T6c2), the concrete Worker driver
(T6c3) and runtime wiring (T6d) are out of scope and not implemented;
`docs/v0.5.0/acceptance-results.json` is unchanged and no broad acceptance is
claimed.

Files in scope (all new except the closed error additions):

- `packages/application/src/use-cases/oauth-driver.ts` (234 lines)
- `packages/application/src/use-cases/oauth-candidate.ts` (183)
- `packages/application/src/use-cases/oauth-connect.ts` (465)
- `packages/application/src/use-cases/oauth-callback.ts` (688)
- `packages/application/src/use-cases/auth-operation.ts` (116)
- `packages/application/src/use-cases/auth-errors.ts` (184, additive codes/reasons only)
- `packages/application/test/oauth-test-support.ts` (499)
- `packages/application/test/oauth-candidate.test.ts` (177, 9 tests)
- `packages/application/test/oauth-connect.test.ts` (455, 18 tests)
- `packages/application/test/oauth-callback.test.ts` (846, 24 tests)
- `packages/application/test/oauth-operation.test.ts` (259, 7 tests)
- this file

No frozen port, contract, fake, `index.ts`, Worker, transport, D1, cipher,
provider, SDK or manifest file was modified. The tests wrap the frozen snapshot
fake; no fake method or contract was extended.

## 1. Tree, runtime, commands

| Item | Value |
| --- | --- |
| Worktree | `/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050` |
| Branch / HEAD | `codex/v0.5.0` / `d8206f2` |
| Node | `v24.19.0` — bundled runtime prepended to `PATH` |
| TypeScript / Vitest | `7.0.2` / `4.1.11` |

```bash
node_modules/.bin/tsc -p packages/application/tsconfig.json --noEmit       # exit 0 (source)
node_modules/.bin/tsc -p packages/application/tsconfig.json                # exit 0 (build)
node_modules/.bin/tsc -p packages/application/tsconfig.test.json --noEmit  # exit 0 (source + tests)

# from packages/application
../../node_modules/.bin/vitest run test/oauth-candidate.test.ts   # 1 file,  9 tests passed
../../node_modules/.bin/vitest run test/oauth-connect.test.ts     # 1 file, 18 tests passed
../../node_modules/.bin/vitest run test/oauth-callback.test.ts    # 1 file, 24 tests passed
../../node_modules/.bin/vitest run test/oauth-operation.test.ts   # 1 file,  7 tests passed
../../node_modules/.bin/vitest run                                # 20 files, 265 tests passed, exit 0
                                                                  # final run start 04:05:09, 0.50s

git diff --check                                                  # exit 0
```

The full run is the 207 previously accepted application tests plus these 58 new
ones; no existing test was modified or skipped.

## 2. Implemented surface

### 2.1 Driver contract (`oauth-driver.ts`)

```ts
interface OAuthDriverSnapshot { platform; protocol: "oauth1"|"oauth2"; canonicalCallbackUrl; startConfigBinding }
interface OAuthDriver extends OAuthDriverSnapshot {
  begin({ state, now }): Promise<{ authorizationUrl; requestToken: string|null; requestSecret: Uint8Array|null }>;
  exchange({ callback, requestSecret, now }): Promise<{ plaintext; expiresAt; target; missingFields }>;
  confirm({ candidate, target, now }): { plaintext; target; missingFields };          // sync, T6c2
  readonly refresh?: ({ plaintext, now }) => Promise<{ plaintext; expiresAt }>;       // T6c2
}
type OAuthDriverResolver = (platform) => OAuthDriver | null | Promise<OAuthDriver | null>;
```

`OAuthDriverError` carries one fixed reason (`denied`, `invalid_response`,
`unavailable`) and is reconstructed from the allowlist, so a forged instance or
throwing getter cannot smuggle provider text. Stored failure codes
(`PROVIDER_DENIED`, `PROVIDER_FAILED`, `INVALID_RESPONSE`, `DECRYPTION_FAILED`,
`EXPIRED`, `CONFIG_CHANGED`, `TOKEN_MISMATCH`) and the **closed** candidate field
allowlist `author | api_version | blog` live here too. PKCE is intentionally not
part of the contract: the design forbids assuming an unsupported platform PKCE
capability, and a future concrete driver that needs it must add a reviewed field.

### 2.2 Candidate codec (`oauth-candidate.ts`)

Envelope `{"v":1,"p":"<base64 plaintext>","e":"<canonical instant>"|null}` with
`OAUTH_CANDIDATE_VERSION = 1` and the cipher's `MAX_OAUTH_CANDIDATE_BYTES =
64 KiB` bound applied to the encoded envelope (base64 inflation leaves about
48 KiB of native plaintext). Both directions are **total**: unsupported version,
unknown keys, non-canonical base64, invalid or non-canonical dates, malformed
JSON, empty payloads, hostile objects with throwing getters and oversized
envelopes all return a fixed `invalid` reason instead of throwing or truncating.
Buffers are copied in both directions.

### 2.3 Connect (`oauth-connect.ts`)

`beginOAuthConnect({ platform, expectedRevision? }, deps)` with `deps =
{ credentials, getCipher, drivers, clock, ids }`. Order: snapshot the input
synchronously → `await drivers(platform)` (a null driver is
`INVALID_REQUEST/oauth_unsupported`, a throw is `INSTANCE_NOT_READY/unavailable`)
→ validate the driver snapshot → one `readSlot` → revision guard → creation time
snapshot, expiry = creation + `AUTH_OPERATION_TTL_MS` (30 min) → two distinct
opaque identifiers → `getCipher()` readiness check (both protocols) → exactly one
`begin` call → copy URL/token/secret → request secret encrypted with
`{purpose:"oauth_request_secret", recordId: operationId, platform, schema 1,
generation 1}` → clock re-read, refusing to save an already expired operation →
exactly one `createAuthOperation`. A write failure is `STORE_UNAVAILABLE` with no
receipt, no retry and no second request-token call. The returned receipt is the
frozen public shape `{platform, operationId, url, expiresAt, expectedRevision}`.

### 2.4 Callback (`oauth-callback.ts`)

`completeOAuthCallback({ platform, state, code?, verifier?, requestToken?, denied? }, deps)`.
The snapshot is bounded and frozen before the first await; duplicate query
parameters are rejected by the HTTP runtime, which owns the raw query string (that
split is documented in the module). Then: resolve the driver → one
`claimOAuthCallback` with `currentConfigBinding` → identity re-check (platform,
state, phase, `startConfigBinding` **and** `canonicalCallbackUrl`, OAuth1 request
token, expiry) → denial handling → cipher readiness → request-secret decryption →
expiry check → one `exchange` → result validation → candidate encode/encrypt →
fresh completion time → one `saveCandidate`.

Failure mapping is fixed and text-free:

| Condition | Result |
| --- | --- |
| unknown claim result, claim throw, storage failure | `STORE_UNAVAILABLE/store_unavailable`, zero exchange |
| claim conflict `not_found` / `platform_mismatch` / `state_mismatch` | `NOT_FOUND/operation_not_found` |
| claim conflict `phase_mismatch` | `AUTH_CONFLICT/operation_phase` |
| claim conflict `expired` | `AUTH_CONFLICT/operation_expired` |
| claim conflict `request_token_mismatch` | `AUTH_CONFLICT/request_token_mismatch` |
| claim conflict `start_config_changed`, or a changed canonical callback | `AUTH_CONFLICT/config_changed` |
| explicit operator denial (`denied: true`) | persisted `PROVIDER_DENIED`, then `PROVIDER_ERROR/provider_error`, zero exchange |
| request secret missing/inconsistent/undecryptable | persisted `DECRYPTION_FAILED`, `INSTANCE_NOT_READY/request_secret_unavailable`, zero exchange |
| driver exchange throw | persisted `PROVIDER_DENIED` / `INVALID_RESPONSE` / `PROVIDER_FAILED`, `PROVIDER_ERROR/provider_error`, no retry |
| malformed exchange result or candidate codec rejection | persisted `INVALID_RESPONSE`, `PROVIDER_ERROR/invalid_driver_response` (oversize) or `.../candidate_invalid` |
| operation expired before the exchange or before the save | `AUTH_CONFLICT/operation_expired`, zero writes |
| non-applied candidate commit | `AUTH_CONFLICT/operation_phase`, `.../unexpected_result` or `NOT_FOUND`, never success |

Successful candidates are encrypted with
`{purpose:"oauth_candidate", recordId: operationId, platform, schema 1, generation 1}`
and saved with `phase = missingFields.length > 0 ? "needs_configuration" :
"awaiting_confirmation"`. The callback never calls `compareAndSetSlot` or
`activateCandidate`.

### 2.5 Operation read (`auth-operation.ts`)

`readAuthOperationProjection({ platform, operationId }, deps)` with `deps =
{ credentials, prepare, clock }`. Malformed identifiers and missing or
foreign-platform operations are all `NOT_FOUND/operation_not_found` (no existence
leak). The current active status comes from the accepted preparation path, then
the frozen `projectAuthOperation` applies the expiry projection. A completed
operation therefore replays its stored receipt with a *blocked* active status when
no usable cipher/configuration exists, and a failed store read stays the
controlled error it already is. Polling performs no claim, save, activation, slot
mutation, TTL renewal or provider request.

## 3. Verification inventory

| Required check | Test |
| --- | --- |
| operation id is not the OAuth state | `beginOAuthConnect` happy path (distinct ids asserted) and `rejects a bad identifier factory as a contract violation` |
| connect checks the observed revision and key/cipher/config before any request-token call | `performs zero provider calls on a revision mismatch`, `checks the cipher before the request-token call for both protocols`, `rejects an unsupported platform before reading storage` |
| one request-token call, one operation, no retry, no receipt on write failure | `creates one OAuth1 operation and encrypts the request secret`, `returns no receipt when the operation write fails, and never retries` |
| trusted operation-scoped request-secret AAD | `creates one OAuth1 operation and encrypts the request secret` |
| 30-minute TTL and late-creation refusal | `creates one OAuth1 operation...`, `refuses to create an operation that outlived its own window` |
| concurrent callback winner performs exactly one exchange | `lets exactly one concurrent callback exchange` |
| unknown / committed-lost-ack claim performs zero exchange and no replay | `exchanges nothing when the claim result is unknown`, `does not replay an exchange after a committed claim with a lost acknowledgement` |
| stale platform / config / canonical callback / request token denial | `keeps an unknown state, platform or request token opaque or conflicting`, `refuses a changed configuration binding or canonical callback` |
| provider denial claims state, persists fixed failure, zero exchange | `persists an explicit provider denial with zero exchange` |
| expiry during the request and during the save | `does not exchange when the claim consumed the last valid instant`, `rejects a late candidate without backdating a failure record` |
| candidate/request-secret encryption contexts and codec strictness | `creates one OAuth1 operation...`, callback happy path, `oauth-candidate.test.ts` (version, base64, dates, JSON, oversize, hostile input) |
| no active-slot write from the callback | callback happy path (`compareAndSetSlot` and `activateCandidate` counts are 0) |
| polling performs no writes and no renewal | `projects a pending operation...`, `projects an expired operation without renewing or writing`, `stays unchanged across repeated polls` |
| completed receipt replay with a blocked active status | `replays a completed receipt even when the active status is blocked` |
| closed candidate field allowlist | `rejects malformed exchange results and keeps a closed field allowlist` (arbitrary uppercase value, duplicates, too many fields) |
| fixed failures and sentinel/getter non-escape | `never lets a provider failure or its text escape`, `records a fixed failure when the request secret cannot be decrypted`, `reports a storage failure and a missing cipher without exchanging`, `never lets a hostile callback getter or driver snapshot escape`, `keeps storage and preparation failures fixed and text-free` |
| candidate absent after a late response | `rejects a late candidate without backdating a failure record` (stored `candidateEnvelope === null`, residual secret left to maintenance, projection phase `expired`) |
| captured driver snapshot survives mutation | `uses the captured identity and bound methods when the original mutates` |
| driver identity validation | `validates the callback origin, the binding and the method shapes` (short/whitespace binding, query/fragment/plain-HTTP callback, missing methods, non-function refresh) |
| TTL check after the awaited encryption | `refuses to create when the awaited encryption outlives the window` |
| protocol-specific callback inputs | `requires the protocol-specific callback values before claiming`, `exchanges an OAuth2 callback that carries only state and code` |
| cipher failures after the claim are recorded | `records a cipher failure when the candidate cannot be encrypted` and the missing-cipher case above (`CIPHER_UNAVAILABLE`) |
| late rejection or malformed response never backdates | `never backdates a failure record when a late rejection or response arrives` |
| forged failures from driver/resolver/prepare | `never reads a forged auth failure thrown by the driver`, `never reads a forged auth failure's properties`, `never reads a hostile input getter or a forged auth failure` |

## 4. Decisions a reviewer should confirm

### 4.0 Attempt-2 review findings, as implemented

| Finding | Implementation |
| --- | --- |
| 1. resolver type did not accept a promise | `OAuthDriverResolver` is `(platform) => OAuthDriver \| null \| Promise<OAuthDriver \| null>`; the test support no longer casts, and the resolver test is typed async |
| 2. driver snapshot was the original object | `requireDriverSnapshot` captures identity (`platform`, `protocol`, canonical HTTPS callback without userinfo/query/fragment, meaningful 16-256 character binding) and the method references once, binds them to the original receiver, and returns a frozen snapshot; a regression mutates the original during the awaited slot read |
| 3. only one clock check before encryption | connect re-reads the clock after the awaited request-secret encryption and refuses to create when the window elapsed |
| 4. no protocol-specific callback inputs | `requireProtocolInputs` runs before the claim: OAuth1 needs its request token and a verifier and refuses `code`; OAuth2 needs `code` and refuses `verifier`/`requestToken`; a denial may omit the verifier/code but still needs the OAuth1 request token; every value must be an exact opaque string (whitespace is rejected, not trimmed) |
| 5. failure persistence used a pre-await timestamp | `persistFailure` reads a fresh clock inside itself and writes nothing at or after the operation expiry; regressions cover a late *rejection* and a late *malformed response*, not only a late success |
| 6. new catches rebuilt errors ad hoc | every new boundary uses the guarded `authFailure` helper; the callback snapshot and the operation read input are wrapped too, and forged `AuthUseCaseError` instances with throwing `code`/`reason` getters are covered by regressions on both paths |
| 7. cipher failures after the claim left `exchanging` | a missing cipher and a candidate-encryption failure both persist the new closed `CIPHER_UNAVAILABLE` stored code (when still within the window) and return `INSTANCE_NOT_READY/cipher_unavailable`; `persistFailure` inspects the commit result and never implies success. The runtime DTO projection must include `CIPHER_UNAVAILABLE` in its error-code allowlist — that is a runtime mapping change, not a frozen-file change |

The proposed T6c2 `canRefresh(plaintext)` preflight is deliberately **not** added
here: the snapshot capture already binds an optional method generically, so a
future additive `canRefresh` needs no restructuring of this module. That contract
decision stays with root after T6c1 acceptance.

1. **No PKCE in the contract.** The design says no unsupported PKCE capability is
   assumed; a future driver that needs a verifier requires a reviewed contract
   addition rather than an unused field today.
2. **Denial is an explicit input flag.** A browser denial cannot be expressed by a
   driver error thrown after the network, so `denied: true` claims the matching
   state first and persists `PROVIDER_DENIED` with zero exchange.
3. **Failure persistence respects the frozen store.** `saveCandidate` refuses every
   outcome at or after `expiresAt`, so a late attempt writes nothing at all: the
   read projection reports `expired`, the residual request secret is left for the
   bounded maintenance sweep, and `now` is never backdated to force a record
   through.
4. **The candidate commit result is checked.** A conflict or `already_applied`
   never reaches the caller as success; it maps to `operation_phase`,
   `unexpected_result` or `operation_expired`.
5. **Resolver contract.** Returning null means "no OAuth flow in this build"
   (`oauth_unsupported`); throwing means mapped configuration is missing or
   invalid (`INSTANCE_NOT_READY/unavailable`). Sync and async resolvers are both
   supported, and nothing happens before the snapshot is taken.
6. **Malformed optional callback parameters are rejected**, not silently treated as
   absent, so a truncated or duplicated redirect cannot pass as "no parameter".
   Duplicate query-parameter detection itself stays in the HTTP runtime.
7. **Callback outcome shape** `{ platform, operationId, phase, expiresAt,
   missingFields, target }` was approved by root; the runtime owns the redirect
   response and the authenticated route.
8. **Export gap for the next scope.** These modules are still imported by relative
   path in tests; `packages/application/src/index.ts` (outside this task's
   ownership) still needs the additive export update that root coordinates before
   the concrete driver and runtime wiring can inject them.

## 5. Not verified here

- Complete/refresh, target confirmation, candidate activation and receipt replay
  precedence are T6c2 and are not implemented.
- No concrete OAuth driver, Worker route, transport call or provider fixture was
  exercised; no live account, credential or network call was used.
- The frozen fake is the only store implementation used here; real D1 OAuth
  concurrency, expiry cleanup and the `oauth_state` table behaviour remain
  separate gates.
- Full-repo gates (`npm test`, `npm run check`, `bundle`, `startup`, packaging)
  were not run for this bounded scope.
