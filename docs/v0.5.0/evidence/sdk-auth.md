# Task T7b2 evidence — public auth facade and diagnostics

Status: **implemented and verified locally**; attempt 2 of 3 (attempt 1 was
rejected after a built-JS probe found unsafe validation, see §4a). Owner: Task T7b2
(`packages/sdk/src/{auth,auth-types,diagnostics,client,types,index}.ts`, the SDK
tests listed in §6, and this file). No CLI, Worker, application, root, manifest,
version, or private package file was touched; `http.ts` and `errors.ts` are
unchanged by this scope.

## 1. Tree, runtime, commands

| Item | Value |
| --- | --- |
| Worktree | `/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050` |
| Branch / HEAD | `codex/v0.5.0` / `d8206f2` |
| Node | `v24.19.0` (bundled runtime, PATH-prefixed) |
| TypeScript / Vitest | `7.0.2` / `4.1.11` |

```bash
tsc -p packages/sdk/tsconfig.json --noEmit          # exit 0
npm run build --workspace @syndroo/sdk              # exit 0
npm run check --workspace @syndroo/sdk              # exit 0
git diff --check                                    # exit 0
# from packages/sdk
<bundled-node> ../../node_modules/vitest/vitest.mjs run
# -> 11 files, 231 tests passed, ~1.6s  (T7b1 was 9 files / 187 tests)
```

New tests: `test/auth.test.ts` 37, `test/diagnostics.test.ts` 7,
`test/public-api.compile.ts` (compile-time fixture, not collected by Vitest).
Loopback fixtures still need a loopback-permitting run inside the sandbox.

## 2. Public surface

```ts
auth.status(options?): Promise<AuthStatus>
auth.status(platform, options?): Promise<PlatformStatus>
auth.status(undefined, options?): Promise<AuthStatus>
auth.set(platform, credential, { expectedRevision, signal?, timeoutMs? }): Promise<AuthSetReceipt>
auth.connect(platform, { expectedRevision, signal?, timeoutMs? }): Promise<ConnectReceipt>
auth.operation(platform, id, options?): Promise<AuthOperationStatus>
auth.complete(platform, id, { expectedRevision, target? }, options?): Promise<CompleteReceipt>
auth.refresh(platform, { expectedRevision, signal?, timeoutMs? }): Promise<AuthRefreshReceipt>
auth.remove(platform, { expectedRevision, signal?, timeoutMs? }): Promise<AuthRemoveReceipt>
diagnostics(options?): Promise<Diagnostics>
```

`complete` keeps the documented four-argument form: the mutation object is the
third argument and request options the fourth, exactly as `public-api.md`
specifies. `test/public-api.compile.ts` asserts each signature and uses
`@ts-expect-error` where a mutation without `expectedRevision` must not compile.

## 3. Wire alignment with the frozen application projection

| Concern | Decision |
| --- | --- |
| Operation `errorCode` | Exactly the application's `OAuthStoredErrorCode`: `PROVIDER_DENIED`, `PROVIDER_FAILED`, `INVALID_RESPONSE`, `DECRYPTION_FAILED`, `CIPHER_UNAVAILABLE`, `EXPIRED`, `CONFIG_CHANGED`, `TOKEN_MISMATCH` |
| Operation `missingFields` | The operation's own top-level list of candidate fields it still needs, restricted to `author`, `api_version`, `blog`; `candidate` carries only `target?` and unknown extras inside it are not projected |
| Phases | The `public-api.md` set: `pending_callback`, `exchanging`, `awaiting_confirmation`, `needs_configuration`, `completed`, `failed`, `expired` |
| Readiness / source | Closed sets from `public-api.md`; `source` also allows `null` |
| Missing-field names | Closed public configuration allowlist, including `SYNDROO_BINDING_KEY` |
| LinkedIn credential | `access_token` required; `author`, `api_version`, `refresh_token` optional |
| Storage reason | `null` or the one documented code `size_unavailable`; an unknown size or limit must carry the code |
| Date fields | Normalized UTC ISO-8601 instants with a `toISOString()` round trip, so `"1"` and `2026-02-30T00:00:00.000Z` are rejected |

Responses are projected into fresh objects, so unknown fields never reach the
caller, and every documented field is checked (`revision` a nonnegative safe
integer, `stored`/`removed`/`refreshed` literally `true`, counts whole and
nonnegative, date-times parseable).

## 4. Guarded behavior

Every method runs through the accepted transport: one request, no mutation
retry, the fixed `auth.*`/`diagnostics` operation, correct path encoding, and
`redirect: "manual"`.

- **Revision**: every new mutation requires an explicitly observed nonnegative
  safe integer. Omitting it, or passing a fractional, negative, non-safe, or
  non-numeric value, fails before any request. The SDK never infers `revision+1`
  and never assumes a replay.
- **Identity**: the single-platform read, the status map key, and every receipt
  must name the requested platform; `operation` and `complete` must answer the
  requested operation id; the connect receipt's `expectedRevision` must equal
  the submitted revision; inside an operation, `active.platform` must match the
  top-level platform and a nested `receipt` must match both the platform and the
  operation id.
- **Targets**: keys are restricted per platform (LinkedIn `author`/`api_version`,
  Tumblr `blog`, X and unknown platforms none) and supplied values are checked
  locally (LinkedIn URN and `YYYYMM`). Required target fields are the server's to
  enforce, so a replay of a completed operation with no target is not blocked.
- **Credentials**: the five documented direct field sets, snapshotted
  synchronously before validation. App-secret, control, and unknown keys are
  rejected; a throwing getter becomes a controlled error. Zero network calls on
  every validation failure.
- **Outcomes**: malformed 2xx writes keep the real status and
  `requestMayHaveBeenApplied: true`; reads (including `diagnostics`) report
  false; 409/5xx auth recovery text names `auth.status` and never a post key or
  an automatic refresh.

## 4a. Attempt-2 fixes

Root's built-JS probe found four unsafe paths; all four are fixed and probed
again through `packages/sdk/dist`:

| Defect | Fix | Probe result |
| --- | --- | --- |
| `{"__proto__":{...}}` credential/target: a plain `{}` snapshot routed the key through the prototype setter, so the unknown key vanished and a required field was satisfied by inheritance | Snapshots are built as null-prototype records, so every key stays an own data property | `SyndrooValidationError`, zero requests, no sentinel |
| Required field present only on the prototype | Own-key snapshots mean inherited values are never read | `SyndrooValidationError`, zero requests |
| `DIRECT_CREDENTIAL_FIELDS["constructor"]` / `COMPLETE_TARGET_FIELDS["constructor"]` answered with inherited members, producing a raw `TypeError` | Own-entry lookup (`Object.hasOwn`) with a fixed SDK error | `SyndrooValidationError` with `operation: "auth.set"` / `"auth.complete"`, zero requests |
| `observedAt: "1"` / `2026-02-30T00:00:00.000Z"` and raw `storage.reason` text were accepted | Strict instant reader with round-trip validation, and a closed storage-reason set | `SyndrooResponseError`, `operation: "diagnostics"`, `requestMayHaveBeenApplied: false` |

Reads are deliberately not restricted: `auth.status("constructor")` still sends
its GET, because only the mutation tables need a documented field schema.

## 5. Focused verification

`test/auth.test.ts` covers, with a stubbed `globalThis.fetch` that records
method, URL, body, and authorization: list vs single status, every mutation's
exact method/path/body and exactly one call, `DELETE` for remove, encoded
operation ids, candidate vs active separation, completed replay receipt,
identity mismatches (platform, operation id, connect revision, active,
receipt), the malformed-2xx table per mutation and per read, unknown/missing
field rejection, the stored error-code allowlist, missing/invalid revisions,
app-secret and control keys, throwing credential getters, per-platform target
key and value rejection, invalid durations, in-flight abort and deadline per
operation, and 409/5xx advice. `test/diagnostics.test.ts` covers the counters,
null storage metrics, utilization rules, unknown-field projection, malformed
reads, and out-of-range rejection.

These are new-surface tests: there is no previous behavior to regress, so no
revert-based red proof applies. The compile-time fixture is the guard against
signature drift.

## 6. Changed files

| File | Change |
| --- | --- |
| `packages/sdk/src/auth-types.ts` | new — wire types, runtime readers, identity/argument validation |
| `packages/sdk/src/auth.ts` | new — `AuthResource` with the seven documented methods |
| `packages/sdk/src/diagnostics.ts` | new — `Diagnostics` types and reader |
| `packages/sdk/src/client.ts` | adds `auth` and `diagnostics()` |
| `packages/sdk/src/index.ts` | exports `AuthResource` and the auth/diagnostics types |
| `packages/sdk/src/types.ts` | exports the existing shape-only readers and adds `requireBoolean`, `requireRevision`, `requireStringArray`, `requireNullableString`, `requireNullableNumber`, `requireNonNegativeInteger`, `optionalRecord` |
| `packages/sdk/test/auth.test.ts` | new — 37 cases |
| `packages/sdk/test/diagnostics.test.ts` | new — 7 cases |
| `packages/sdk/test/public-api.compile.ts` | new — compile-time signature fixture |
| `docs/v0.5.0/evidence/sdk-auth.md` | this file |

## 7. Unresolved and limits

* **Phases.** `needs_configuration` is the current phase; root confirmed
  `awaiting_configuration` was a wording slip and it is not added. `CIPHER_UNAVAILABLE`
  is approved from T6c1 and stays in the stored-code allowlist.
* **`SYNDROO_BINDING_KEY`** is confirmed as the source-config target name in
  `docs/v0.5.0/design/01-DESIGN.md:249` and
  `docs/v0.5.0/design/02-ARCHITECTURE-DECISIONS.md:87`.
* **Unknown platforms cannot be set** through `auth.set`, because the SDK has no
  documented direct-field schema for them; they are rejected before any request
  rather than forwarded unvalidated.
* **No installed-package, CLI, or full-product claim.** Auth driver behavior,
  the OAuth lifecycle, and installed-artifact evidence are other scopes.
* **Node 22 remains unavailable locally**, so runtime support is reported from
  the Node 24 run only.
* **Sandbox.** Loopback fixtures need escalation; the reported suite numbers come
  from a loopback-permitting run.
