# Task T6a evidence — static platform preparation strategies

Status: **the scoped implementation is complete for this attempt (attempt 1 of
3) and its focused tests and scoped type checks pass locally.** Owner: Task T6a.
No broad 0.5.0 acceptance is claimed: `docs/v0.5.0/acceptance-results.json` is
unchanged, and the runtime route/composition wiring, the portable direct CAS use
case and the OAuth operation lifecycle remain other owners' scopes.

Files in scope (no other file was touched):

- `packages/cloudflare-worker/src/composition/platform-strategies.ts` (new, 692 lines)
- `packages/cloudflare-worker/src/composition/platform-credential-decoders.ts` (new, 509 lines)
- `packages/cloudflare-worker/test/platform-strategies-v050.spec.ts` (new, 1344 lines)
- `packages/cloudflare-worker/test/support/platform-strategies-v050-tsconfig.json` (new)
- this file

No dependency, manifest, migration, frozen-port, provider-package, `Env`,
`platform-descriptors.ts`, `publishers.ts` or runtime file was modified, and the
legacy descriptor logic that merges partial user credentials with Env is not
imported anywhere in these modules.

## 1. Tree, runtime, commands

| Item | Value |
| --- | --- |
| Worktree | `/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050` |
| Branch / HEAD | `codex/v0.5.0` / `d8206f2` |
| Node | `v24.19.0` — bundled runtime `/Users/daiyanze/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin` (prepended to `PATH`) |
| TypeScript / Vitest | `7.0.2` / `4.1.11` |

```bash
# from the repository root, bundled Node 24 first on PATH
node_modules/.bin/tsc -p packages/cloudflare-worker/test/support/platform-strategies-v050-tsconfig.json --noEmit
# -> exit 0 (source + spec, scoped include; no unrelated legacy module)

node_modules/.bin/tsc -p packages/cloudflare-worker/tsconfig.json --noEmit
# -> exit 1: exactly the two pre-existing errors in src/platform-descriptors.ts
#    (lines 308/309, LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET not in Env).
#    No error is reported for either new composition file.

# from packages/cloudflare-worker
../../node_modules/.bin/vitest run test/platform-strategies-v050.spec.ts
# -> 1 file passed, 97 tests passed, exit 0
#    (two identical runs on the frozen source: start 02:46:57, 2.86s; start 02:48:46, 2.83s)
```

**Environment note:** the Worker suite runs in the workerd vitest pool, which
binds `127.0.0.1`. Inside the sandbox that fails with `listen EPERM: operation
not permitted 127.0.0.1`, so the recorded run above is from a local-only
escalated invocation (no provider contact, synthetic credentials only). The
sandboxed attempt failed before collecting tests and is not counted as a test
result.

## 2. Implemented behaviour

### 2.1 Exported API

`platform-strategies.ts`

- `platformStrategyRegistry: PlatformStrategyRegistry` — `platforms` is exactly
  `["bluesky","threads","x","tumblr","linkedin"]`; `strategyFor()` uses an
  explicit literal switch and throws `UninstalledPublisherStrategyError` with a
  fixed message that never echoes the requested platform. It never returns a
  ready or blocked envelope for an uninstalled platform.
- `platformConfigView(platform, values: Readonly<Record<string, string | undefined>>, publicUrl = null)` —
  explicit string-map input, never an `Env` object. Only the platform's
  allowlisted configuration names are copied, values are trimmed, blanks and
  non-strings are dropped, unknown keys are ignored, and both the view and its
  `values` map are frozen.
- `installedPlatforms`, `platformCredentialSpecs`, `UninstalledPublisherStrategyError`.

`platform-credential-decoders.ts`

- `decodeDirectCredential(platform, input)` — the frozen direct decoder.
- `decodeCredentialPayloadBytes(platform, bytes)`, `parseCredentialFields`,
  `credentialSpecFor`, `platformConfigKeys`, `PLATFORM_CREDENTIAL_SPECS`,
  `CREDENTIAL_PAYLOAD_SCHEMA_VERSION`, `INSTALLED_PLATFORMS`,
  `PlatformCredentialInputError`.

### 2.2 Selection and blocking

| Situation | Result |
| --- | --- |
| `slot.status` = `empty`/`tombstone` | complete Env user group; `source` = `env` when the user group resolves, else `null` |
| `slot.status` = `active` | only the decrypted D1 group; a user field never falls back to Env |
| `slot.status` = anything else | blocked `invalid_configuration`, `source` null |
| `platform` mismatch (call, slot or config view) | blocked `invalid_configuration` |
| `slot.revision` not a non-negative safe integer | blocked `invalid_configuration`, reported revision 0 |
| `refreshState` = `reconnect_required` | blocked `reconnect_required` |
| live (unexpired, parseable) refresh lease | blocked `unavailable` |
| expired or unparseable lease | blocked `reconnect_required` |
| active slot without envelope, with `payloadSchemaVersion != 1`, or without a usable `bindingId` | blocked `invalid_configuration` |
| active slot with `plaintext === null` | blocked `unavailable` (never an absent slot) |
| `expiresAt` not a canonical instant | blocked `unavailable`, reported `expiresAt` null |
| `expiresAt` at or before `now` | blocked `expired`, reported `expiresAt` echoed |
| payload not bounded UTF-8 JSON, not an object, unknown field, non-string value, empty/control value, over 64 KiB | blocked `invalid_configuration` |
| missing required user field | blocked `missing_credentials` |
| missing runtime app / target / configuration field | blocked `needs_configuration` |
| provider decoder or builder rejects a resolved group | blocked `invalid_configuration`, message retained nowhere |

Blocked readiness mapping: `missing_credentials` / `needs_configuration` /
`expired` / `reconnect_required` keep their names; `unavailable` and
`invalid_configuration` project to `unavailable`. `configured` is `true` only on
a ready envelope.

`now` must be a canonical instant; a non-canonical value throws
`InvalidContractInputError`, which the application already classifies as a
documented contract violation rather than caller input.

### 2.3 Field ownership (exactly the credential-resolution table)

| Platform | User group (D1: stored only; Env path: configuration) | Runtime app fields | Target/configuration fallback |
| --- | --- | --- | --- |
| Bluesky | `identifier`, `password` | none | `host`: stored, then `BLUESKY_HOST`, then `bsky.social` |
| Threads | `access_token` | none | none |
| X | `access_token`, `access_token_secret` | `X_API_KEY`, `X_API_SECRET` | none |
| Tumblr | `token`, `token_secret` | `TUMBLR_CONSUMER_KEY`, `TUMBLR_CONSUMER_SECRET` | `blog`: stored, then `TUMBLR_BLOG` |
| LinkedIn | `access_token`, `refresh_token` (optional) | none in this scope (`LINKEDIN_CLIENT_*` is out of scope) | `author`: stored, then `LINKEDIN_AUTHOR`; `api_version`: stored, then `LINKEDIN_API_VERSION`, then `202604` |

`missingFields` uses this fixed public configuration vocabulary (the documented
`BLUESKY_*` / `THREADS_*` / `X_*` / `TUMBLR_*` / `LINKEDIN_*` names) for both
sources, so a caller always sees the same allowlisted names. Only those
allowlisted names can appear; no token value, provider text or exception message
is ever copied.

Public target label and provenance: the label always comes from the
provider-validated credential (`credential.host`, `credential.blog`,
`credential.author`). `slot.target` is advisory provenance only: it upgrades the
source to `provider` only when its own label normalizes to exactly that
validated label; otherwise the source is `user`. An absent target is `null` for
threads/X, and the documented default produces the resolved label for
Bluesky/LinkedIn.

### 2.4 Connection identity

`encodeBindingMaterial` receives fixed ordered pairs and the selected source:

- Env path: complete user + app + target group, absent optionals as explicit
  `null` (for example `refresh_token`).
- D1 path: `["slotBinding", bindingId]` plus app and target configuration only.

Consequences proven by tests: source switches change continuity; an app
credential or target change breaks continuity; a same-grant access/refresh token
rotation preserves it; unused Env user tokens never enter the D1 material.

## 3. Verification

### 3.1 Focused Worker suite — 97 tests, exit 0

`test/platform-strategies-v050.spec.ts`, one fail-loud `globalThis.fetch` spy
around every construction path.

| Acceptance item | Test |
| --- | --- |
| registry and controlled throw for uninstalled platforms | `installed strategy registry` (3) |
| plain-config mapping, string-map input, no Env binding | `plain configuration mapping` (3) |
| each platform ready from the complete Env group, zero provider calls, frozen status | `Env-only preparation` (2 x 5) |
| tombstone chooses Env even though a deleted slot exists | `treats a tombstoned %s slot as an Env selection` |
| each platform ready from the decrypted D1 group with no token in the material | `active D1 preparation` (5) |
| partial stored plus complete Env does not mix | `never completes a partial %s D1 group from Env user tokens` (5) |
| unused Env user tokens do not change a D1 binding | `keeps the selected %s D1 binding independent of unused Env user tokens` (3) |
| missing runtime app/target configuration | `blocks an active X slot without runtime app fields`, `blocks an active LinkedIn slot without a target author` |
| expired, invalid expiry, corrupt payload, missing plaintext, wrong generation, no binding id, no envelope | `D1 blocking without Env fallback` (6 x 5 plus 8) |
| live lease, expired lease, sticky reconnect state | `defers preparation while a refresh lease is live`, `requires reconnection for an expired unresolved lease`, `requires reconnection for sticky refresh state` |
| unknown persisted status, negative revision | `rejects an unknown persisted slot status`, `rejects a negative revision` |
| platform/slot/config mismatch fails closed | `fails closed on a platform mismatch` |
| source reflects the fields actually selected | `source of the selected fields` (6) |
| target/app/source changes alter the binding | `binding material` (5) |
| zero network work for all five platforms and both sources | `performs zero network work for every platform on both sources` |
| synchronous, frozen, per-call status copies | `returns a frozen synchronous envelope`, `exposes a frozen status copy per call` |
| mutation after prepare does not change the publisher | `is unaffected by mutation of the input plaintext or configuration map` |
| no synthetic secret in outward status | `keeps synthetic secrets out of every outward status` |
| direct decoder round trip, canonical bytes, unknown/app/control fields, incomplete group, invalid target values, non-object bodies, 64 KiB bound, hostile getter, uninstalled platform | `direct credential decoder` (11) |

The zero-call proof is behavioural: `globalThis.fetch` is replaced by a throwing
stub and the counter is asserted to be zero after construction for Bluesky,
Threads, X, Tumblr and LinkedIn on both the Env and the D1 path.

### 3.2 Type checks

- Scoped check (source plus spec, `lib` ES2022+DOM, Workers vitest types): exit 0.
- Worker source check: exit 1 with exactly the two pre-existing
  `platform-descriptors.ts` errors for `LINKEDIN_CLIENT_ID` /
  `LINKEDIN_CLIENT_SECRET`; those lines are outside this task's ownership and
  untouched, and no error is reported for the new files.
- `git diff --check`: exit 0 (no whitespace errors). The new files are untracked
  additions, so this check covers the tracked tree only.

## 4. Direct-input shape accepted by `decodeDirectCredential`

Reported as requested. `decodeDirectCredential(platform, input)` is synchronous
and returns exactly
`{ plaintext: Uint8Array, payloadSchemaVersion: 1, expiresAt: IsoInstant | null, target: SafeTarget | null }`.

- Accepted keys, per platform (runtime app secrets are never accepted):
  - bluesky: `identifier`*, `password`*, `host`
  - threads: `access_token`*
  - x: `access_token`*, `access_token_secret`*
  - tumblr: `token`*, `token_secret`*, `blog`
  - linkedin: `access_token`*, `refresh_token`, `author`, `api_version`
  (`*` = required; the missing-field error names exactly that own field.)
- Control keys such as `expectedRevision` are rejected as unknown fields and are
  never stored.
- Unknown keys, non-object bodies, arrays, primitives, non-string/blank values
  and control characters are rejected, and the rejected key is never echoed, so
  a secret-looking key cannot travel outward.
- Values are validated through the provider decoders only
  (`decodeLinkedInCredential` with fixed probes for one field at a time,
  `validateBlueskyHost`, `normalizeTumblrBlog`); no provider regex is copied and
  no value is cast into a provider credential type.
- `plaintext` is canonical sorted-key bounded JSON (at most 64 KiB, matching the
  existing auth body limit; no invented per-field cap).
- `expiresAt` is always `null`: the frozen public contract defines no expiry
  field for a direct body, so an unknown expiry stays unknown instead of being
  asserted.
- `target` is derived from the provider-validated label (bluesky host, tumblr
  blog, linkedin author) with source `user`; it is `null` when the optional
  field was not submitted or the platform has no target (x, threads).
- Hostile bodies (a getter that throws, a proxy trap, a forged
  `PlatformCredentialInputError`) are caught at the boundary and re-thrown as a
  freshly built `PlatformCredentialInputError`, never as the original object.

## 5. Decisions a reviewer should confirm

1. **`missingFields` vocabulary.** Fixed public configuration names
   (`BLUESKY_PASSWORD`, `X_ACCESS_TOKEN_SECRET`, `TUMBLR_BLOG`, ...) are used for
   both sources, because that is the operator action vocabulary and a single
   allowlist. If raw provider field names (`password`, `access_token_secret`,
   `blog`) are preferred, the change is one function (`publicFieldName`).
2. **`slot.target` is advisory.** A stored label that is invalid or does not
   normalize to the validated label downgrades provenance to `user` instead of
   blocking, so corrupt metadata cannot brick a working credential and cannot
   reach a DTO.
3. **Structural source fallback.** When the selected D1 group cannot be resolved
   at all (corrupt payload, missing envelope/plaintext/binding id, lease or
   expiry blocks) the reported source is conservative: `mixed` for platforms
   that always need Env app fields (x, tumblr), otherwise `credential`. When the
   group resolves, only `resolution.envFieldsUsed` decides `mixed` versus
   `credential`.
4. **`oauthSupported`** is derived from the installed adapters' `oauth` metadata
   (x, tumblr, linkedin true; bluesky, threads false) instead of a duplicated
   boolean.
5. **Interface note for the OAuth/complete work:** the D1 payload must carry the
   completed target/configuration fields (`host`, `blog`, `author`,
   `api_version`) together with the token group, because the D1 path reads them
   from the decrypted record and never from `slot.target`. A provider-confirmed
   target therefore also needs to be written into the payload; `slot.target`
   alone carries provenance only.
6. **`bindingId` validation** uses the frozen `isOpaqueId` (1-128 characters,
   `[A-Za-z0-9][A-Za-z0-9_-]*`). A producer that emits another alphabet would be
   blocked as `invalid_configuration`.

## 6. Not verified here

- No provider request, live credential, live platform or production resource was
  used; the zero-call proof is a construction-time spy, not an end-to-end run.
- The runtime route/composition wiring, the portable preparation and direct CAS
  use case, OAuth connect/complete/refresh, status DTO assembly and `Env` binding
  glue are separate scopes.
- Full gates (`npm test`, `npm run check`, `npm run bundle`, `npm run startup`,
  `npm run build:package`) were not run for this bounded task; the worker source
  check still reports the two pre-existing `LINKEDIN_CLIENT_*` errors that the
  root already recorded for the later integration work.
- The `linkedin` refresh-token lifecycle (expiry from `expires_in`, "only when
  issued and valid") belongs to the OAuth refresh scope; this module only
  preserves an optional `refresh_token` and always excludes it from the D1
  binding material.
