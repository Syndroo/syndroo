# Task T6c3 evidence — concrete OAuth / refresh drivers

Status: **the scoped implementation is complete for this attempt (attempt 1 of
3); its dedicated native suite and scoped type checks pass locally.** Owner:
Task T6c3. No broad 0.5.0 acceptance is claimed:
`docs/v0.5.0/acceptance-results.json` is unchanged, and route wiring, the
Worker's legacy auth handler, manifests and production configuration remain
other owners' scopes.

Files in scope (no other file was touched):

- `packages/cloudflare-worker/src/composition/oauth-drivers.ts` (new, 943 lines)
- `packages/cloudflare-worker/src/composition/oauth-protocol-support.ts` (new, 259 lines)
- `packages/cloudflare-worker/test/oauth-drivers-v050.native.ts` (new, 1132 lines)
- `packages/cloudflare-worker/test/support/oauth-drivers-v050-fixtures.ts` (new, 332 lines)
- `packages/cloudflare-worker/test/support/oauth-drivers-v050-worker.ts` (new, 11 lines)
- `packages/cloudflare-worker/test/support/oauth-drivers-v050-tsconfig.json` (new)
- `packages/cloudflare-worker/test/oauth-drivers-v050.vitest.config.ts` (new, 42 lines)
- `packages/application/src/index.ts` (modified: additive exports only)
- this file

No dependency, manifest, migration, frozen port/contract, provider package,
transport, D1/crypto/R2 module, `Env`, `platform-descriptors.ts` or legacy
handler file was modified.

## 1. Tree, runtime, commands

| Item | Value |
| --- | --- |
| Worktree | `/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050` |
| Branch / HEAD | `codex/v0.5.0` / `d8206f2` |
| Node | `v24.19.0` — bundled runtime `/Users/daiyanze/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin` (prepended to `PATH`) |
| TypeScript / Vitest | `7.0.2` / `4.1.11` |

```bash
# from the repository root, bundled Node 24 first on PATH
node_modules/.bin/tsc -p packages/cloudflare-worker/test/support/oauth-drivers-v050-tsconfig.json --noEmit
# -> exit 0, zero diagnostics. `--listFiles` shows the program is exactly
#    src/composition/oauth-drivers.ts, oauth-protocol-support.ts,
#    platform-credential-decoders.ts, infrastructure/crypto/{hmac-binding-signer,keys}.ts,
#    test/support/oauth-drivers-v050-{worker,fixtures}.ts,
#    test/oauth-drivers-v050.native.ts and test/oauth-drivers-v050.vitest.config.ts.
#    Explicit two-file include; imports are followed, nothing is suppressed, and
#    no unrelated legacy module is dragged in by a wildcard.

# native suite: the ONLY configuration with a fail-closed outbound fixture
cd packages/cloudflare-worker
../../node_modules/.bin/vitest run --config test/oauth-drivers-v050.vitest.config.ts
# -> 1 test file, 33 tests, all passed (exit 0). Loads the config, so the
#    `./support/oauth-drivers-v050-fixtures.js` specifier is proven at runtime.
#    Needs loopback only (the cloudflare pool binds 127.0.0.1); every outbound
#    request is answered by the fixture and no destination outside it exists.

# worker source, unchanged baseline
node_modules/.bin/tsc -p packages/cloudflare-worker/tsconfig.json --noEmit
# -> exactly the two pre-existing errors in src/platform-descriptors.ts
#    (lines 308/309, LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET not in Env).
#    Neither new composition module reports a diagnostic.

# application package (index owner)
cd packages/application
../../node_modules/.bin/tsc -p tsconfig.json --noEmit      # -> exit 0
../../node_modules/.bin/tsc -p tsconfig.json               # -> exit 0 (dist rebuilt)
../../node_modules/.bin/tsc -p tsconfig.test.json --noEmit # -> exit 0
../../node_modules/.bin/vitest run                         # -> 23 files, 313 tests, all passed
```

## 2. What the drivers do

Both modules are Worker composition: they copy plain configuration strings once,
reuse the installed adapters' endpoint metadata and the shared bounded
transport, and touch no storage, no Env binding object and no network while
being built.

| Operation | X | Tumblr | LinkedIn |
| --- | --- | --- | --- |
| `begin` | one signed OAuth1 POST to `oauth/request_token`, `oauth_callback` = canonical callback + `?state=`; requires `oauth_callback_confirmed=true` | same | zero requests; authorization URL with `response_type`, `client_id`, `redirect_uri`, `state`, `scope` |
| `exchange` | one signed OAuth1 POST to `oauth/access_token` with the stored request token + secret and `oauth_verifier` | same | one form POST to `oauth/v2/accessToken` (`authorization_code`) |
| `confirm` | local only; `missingFields` empty | local only; requires an explicit `target.blog` | local only; requires explicit `author` + `api_version` |
| `refresh` | absent (OAuth1 has no refresh in this release) | absent | `canRefresh` preflight + one form POST (`refresh_token`) |

Transport policy is shared by every call: 15 s deadline, 64 KiB response cap,
manual redirects, exactly one fetch per operation, and a fixed
`OAuthDriverError` reason on failure (`400/401/403` -> `denied`, `429`/`5xx` ->
`unavailable`, redirect/oversize/undecodable -> `invalid_response`, network or
timeout -> `unavailable`). No provider text, body, code, state, verifier or
token value crosses that boundary.

### 2.1 One rule for opaque credential values

`isOpaqueCredentialValue` in `oauth-protocol-support.ts` is the single predicate
shared by the stored-native-payload parser and provider-output validation:
non-empty, no control character, and `value === value.trim()`. Values are never
trimmed; a padded value is rejected rather than silently becoming a different
token. This verifies consistent string validation for the covered responses. The portable candidate and refresh use cases separately enforce the final 64KiB payload bound; no claim is made that arbitrary combined token lengths always fit.

### 2.2 Resolver outcomes

| Situation | Result | Portable mapping |
| --- | --- | --- |
| Platform this build cannot drive (`bluesky`, `threads`, ...) | `null` | `INVALID_REQUEST` / `oauth_unsupported` |
| `SYNDROO_PUBLIC_URL` absent, non-HTTPS, or not a bare origin | throws fixed `OAuth configuration is unavailable` | `INSTANCE_NOT_READY` / `unavailable` |
| App group absent or only half supplied | throws fixed `OAuth configuration is unavailable` | `INSTANCE_NOT_READY` / `unavailable` |
| LinkedIn refresh resolver, platform not LinkedIn | `null` | `AUTH_CONFLICT` / `no_refresh_payload` |
| LinkedIn refresh resolver, app group absent/half | throws fixed `OAuth configuration is unavailable` | `INSTANCE_NOT_READY` / `unavailable` |

The throw happens at resolver invocation, not at factory construction; a
missing binding signer stays a construction-time wiring defect.

## 3. Review items applied

| Review item | Where |
| --- | --- |
| Native decoders validate, but the *original* untrimmed values are stored | `confirm` calls `decodeXUserCredential` / `decodeTumblrUserCredential` / `isLinkedInConfigurationValid`, then stores the original field values |
| Explicit domain and version in the configuration fingerprint | `bindingDigest` prefixes `["domain","syndroo-oauth-config"],["version","1"]` before protocol/endpoints/app group |
| Own-safe payload parsing, platform allowlist from the existing table | `parseNativePayload` accumulates into a `Map`; `requireNativeFields`/`readLinkedInRefreshPayload` call `parseCredentialFields` |
| `expires_in` bounded to the Date domain | `expiresAtFromSeconds` rejects non-safe integers and `|ms| > 8.64e15`, never throws |
| Signer captured once | `captureSigner` binds `sign` at construction; a later mutation of the caller's object changes nothing |
| `SYNDROO_PUBLIC_URL` validated in raw form | `parsePublicOrigin` rejects paths, `?`, `#`, backslash, surrounding whitespace and control characters with a raw-form regex *before* `URL` normalisation; the `URL` checks then reject userinfo, non-HTTPS and a non-root path |
| Tumblr confirm requires an explicit `target.blog` | a `blog` inside the candidate is not provider evidence; without an explicit target the result is `missingFields ["blog"]` |
| Provider-output validation aligned with native parsing | `requireOpaqueValue` on every provider token field and in `requireTokenResponse` |
| Resolver null only for genuinely unsupported platforms | platform guard before the origin/app checks; fixed configuration error otherwise |

## 4. Native coverage (33 tests, one file)

| Area | Cases |
| --- | --- |
| X `begin` | signed POST, callback with `state`, one request, captured request signature compared with the accepted OAuth1 signer (not an independent cryptographic oracle) |
| X `begin` failures | duplicate/unconfirmed/missing/empty/not-form/redirect/oversized/denied/unavailable, padded secret, control-bearing token — one request each, fixed message, no sentinel leak |
| X `exchange` | signature over token+secret+verifier, native payload, and duplicate/incomplete/padded/control responses |
| X `confirm` | local validation, byte-identical storage, every override rejected, malformed/unknown-key/padded/`__proto__`/invalid-UTF-8 payloads with zero requests |
| Tumblr | `begin` signature, unconfirmed and padded request tokens, `exchange` payload `{token,token_secret}` + `missingFields ["blog"]`, padded access token |
| Tumblr `confirm` | candidate carrying `blog` still defers, explicit `My-Blog` -> `my-blog`, `alice.tumblr.com` -> `alice`, invalid blog throws, overrides rejected, zero requests |
| LinkedIn `begin` | zero requests, exact authorization query parameters |
| LinkedIn `exchange` | form body, strict JSON, expiry zero/absent, and the failure matrix (bad JSON, array, empty/missing/padded/control token, empty/null/padded refresh, negative/float/string/huge expiry, `400`) |
| LinkedIn `confirm` | missing/explicit `author`+`api_version`, invalid values, `blog` override, malformed candidates, byte-identical deferral |
| LinkedIn refresh | `canRefresh` preflight with zero requests, rotation, preserved `author`/`api_version`, provider-omitted refresh token preserved, empty/padded/control rejected, refusal -> `denied`, unusable stored payload fails before any request |
| Readability | the exchange output re-enters `confirm`, and a refreshed payload must pass `canRefresh` |
| Resolver | fingerprint stability/format/domain separation from the publishing binding, app-secret and origin sensitivity, unrelated-value insensitivity, signer capture, single fingerprint computation |
| Resolver errors | unsupported -> `null`; missing/invalid origin and app group -> fixed configuration error; portable `beginOAuthConnect` mapping (`oauth_unsupported` vs `INSTANCE_NOT_READY`/`unavailable`) with zero outbound |
| Protocol helpers | `parsePublicOrigin` raw-form matrix, `expiresAtFromSeconds` Date-domain matrix |
| Fail-closed fixture | an unlisted destination is counted and refused (500 to the caller), never a real network answer |

### 4.1 Why the file is `*.native.ts`

Vitest's default include is
`["**/*.{test,spec}.?(c|m)[jt]s?(x)"]` (`node_modules/vitest/dist/chunks/defaults.9aQKnqFk.js:5`),
so a `*.spec.ts` name would be collected by general discovery *without* the
outbound fixture. Verified with the installed vitest:

```bash
node --input-type=module -e 'import { configDefaults } from "vitest/config"; import pm from "picomatch"; const m = pm(configDefaults.include); console.log(JSON.stringify({include: configDefaults.include, nativeFile: m("test/oauth-drivers-v050.native.ts"), existingSpec: m("test/publishers.spec.ts")}))'
# -> {"include":["**/*.{test,spec}.?(c|m)[jt]s?(x)"],"nativeFile":false,"existingSpec":true}
```

The file therefore runs only under
`test/oauth-drivers-v050.vitest.config.ts`. There is no conditional skip and no
shared-config edit; T9 must aggregate dedicated native projects explicitly.

## 5. Application index

`packages/application/src/index.ts` gained additive exports for the accepted publishing, preparation, direct credential and OAuth APIs/types. The final addition also exports `runMaintenance` plus `MaintenanceLimits`, `RunMaintenanceDependencies`,
`MaintenanceReport`, `MaintenancePhase`, `MaintenancePhaseStatus`,
`MaintenancePhaseCode`, `RecoveryPhaseReport`, `ExpiredCleanupPhaseReport`,
`FinishedCollectionPhaseReport` and `DispatchPhaseReport` from the accepted
`use-cases/run-maintenance.ts`. The module itself was not altered. Both
`tsconfig.json` and `tsconfig.test.json` type-check, the package builds, and its
suite is green (23 files / 313 tests).

## 6. Limitations

- The dedicated native suite uses a fail-closed outbound fixture; its provider responses are local synthetic data. Real provider compatibility is unverified. This isolation claim applies to that dedicated suite only: the terminated earlier main-config run retained insufficient output to establish whether it contacted a provider. No absence-of-egress claim is made for that run.
- The Worker's routes, legacy auth handler and composition root are untouched;
  nothing calls these drivers in production yet (T9 wiring).
- The `@syndroo/application` link under `packages/cloudflare-worker/node_modules`
  is local; the manifest/lockfile entry belongs to T9.
- The package's *main* vitest config is not acceptance for this task: it has no
  outbound fixture, and its run is already red from other suites (for example
  `test/r2-v050.spec.ts` fails there with `bindings.ARCHIVE_BUCKET` undefined).
  An earlier ungated main-config run started before that decision was made was
  terminated by instruction; its output had been piped through a filter, so it
  produced no captured diagnostics and none are reconstructed here.
- Not verified in this attempt: OAuth1 nonce/timestamp uniqueness across
  processes, provider clock skew handling, and refresh of a slot whose stored
  payload carries an unknown future field (rejected by design).

## Root acceptance

Astra independently reviewed source, fixture boundaries and native cases; Node24 scoped tsc5fbf42 exit0; exact dedicated native session96732 at2026-09-23 06:30:36:33tests, exit0 (aed0fd). Application rebuilt and tested after index updates: session7144 at06:29:24,23files313tests, exit0 (01ded1). The concrete driver slice and additive index are accepted after attempt1, with the above evidence wording corrected by root. Runtime routes, actual D1/OAuth lifecycle, T2/T4 adapter limitations and production compatibility remain unaccepted.
