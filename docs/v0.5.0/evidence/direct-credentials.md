# Task T6b evidence — portable preparation and direct credential CAS

Status: **the scoped implementation is complete for this attempt (attempt 1 of
3) and its focused suites, the full application suite and the application type
checks pass locally.** Owner: Task T6b. No broad 0.5.0 acceptance is claimed and
`docs/v0.5.0/acceptance-results.json` is unchanged. OAuth connect/complete/
refresh, the candidate lifecycle and the runtime route/composition wiring are
separate scopes and are not implemented here.

Files in scope (all new; no other file was touched):

- `packages/application/src/use-cases/auth-errors.ts` (152 lines)
- `packages/application/src/use-cases/prepare-publisher.ts` (242 lines)
- `packages/application/src/use-cases/direct-credentials.ts` (572 lines)
- `packages/application/test/prepare-publisher.test.ts` (658 lines, 20 tests)
- `packages/application/test/direct-credentials.test.ts` (978 lines, 30 tests)
- this file

No frozen port, contract, fake, `index.ts`, Worker, D1, cipher, provider or SDK
file was modified: the tests compose wrappers around the frozen snapshot fake
instead of extending it.

## 1. Tree, runtime, commands

| Item | Value |
| --- | --- |
| Worktree | `/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050` |
| Branch / HEAD | `codex/v0.5.0` / `d8206f2` |
| Node | `v24.19.0` — bundled runtime `/Users/daiyanze/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin` (prepended to `PATH`) |
| TypeScript / Vitest | `7.0.2` / `4.1.11` |

```bash
# from the repository root, bundled Node 24 first on PATH
node_modules/.bin/tsc -p packages/application/tsconfig.json --noEmit        # exit 0 (source)
node_modules/.bin/tsc -p packages/application/tsconfig.test.json --noEmit   # exit 0 (source + tests)
node_modules/.bin/tsc -p packages/application/tsconfig.json                 # exit 0 (build to dist/)

# from packages/application
../../node_modules/.bin/vitest run test/prepare-publisher.test.ts   # 1 file, 20 tests passed, exit 0
../../node_modules/.bin/vitest run test/direct-credentials.test.ts  # 1 file, 30 tests passed, exit 0
../../node_modules/.bin/vitest run                                  # 16 files, 207 tests passed, exit 0
                                                                    # (final run start 03:32:01, 0.41s)

git diff --check                                                     # exit 0
```

The full run (16 files, 207 tests) contains the 157 pre-existing application
tests plus the 50 new ones; no pre-existing test was modified or skipped.

## 2. Implemented behaviour

### 2.1 `preparePublisher(platform, now, deps)`

`createPreparePublisher(deps)` binds the same dependencies and matches the
frozen `PreparePublisher = (platform, now) => Promise<PublisherPreparation>`
signature used by create and execute. Dependencies: `credentials`,
`getCipher()` (lazy), `strategies`, `configFor(platform)`.

Order per call:

1. Reject an unknown platform and a non-canonical `now` before any I/O.
2. Resolve the strategy through the injected registry; a known-but-uninstalled
   platform becomes a controlled `INVALID_REQUEST` / reason `platform`.
3. `readSlot` once. A thrown storage failure becomes `STORE_UNAVAILABLE` /
   `store_unavailable` — never an absent slot, never revision 0, never an Env
   fallback.
4. Validate the trusted record: platform identity, a non-negative safe-integer
   revision and one of the three known statuses, all through a guarded read.
   Anything else is `STORE_UNAVAILABLE` / `corrupt_record`.
5. Decrypt only when the status is `active` and the record can describe a
   context: a non-null envelope, `payloadSchemaVersion === 1` and a non-negative
   safe-integer `payloadRevision`. The AAD is
   `{ purpose: "active_slot", recordId: platform, platform, payloadSchemaVersion, payloadRevision }`
   — `recordId` is the **platform value** (the credential table's primary key),
   taken from the trusted snapshot.
6. Any cipher lookup, key, decryption or payload failure returns `plaintext:
   null` instead of throwing: the pure strategy then reports its own blocked
   status for that slot (`unavailable` with the actual revision) and Env user
   credentials are never selected.
7. Map the plain instance configuration once and call the pure strategy. A
   throwing strategy or configuration provider becomes a controlled failure
   without its text, cause or extra fields.

An empty or tombstoned slot never constructs a cipher: `getCipher()` is not
called at all. Preparation performs no CAS, no encryption, no refresh and no
platform request; the returned `status` is the same value an auth read or an
admission check uses.

### 2.2 `setDirectCredential(input, deps)`

Input: `{ platform, credential, expectedRevision? }`. Order:

1. Synchronously (before the first `await`): validate the platform, require an
   installed strategy, validate `expectedRevision` (absent/null or a
   non-negative safe integer), decode the body with the injected decoder, and
   copy the plaintext bytes plus the safe metadata (bounded, control-free target
   label with `user`/`provider` provenance, canonical `expiresAt` or null).
2. Read the slot once through the same guarded trusted reader.
3. Compare the operator's observed revision (or the read revision when omitted)
   with the slot. A mismatch performs zero encryption and zero writes and
   returns `AUTH_CONFLICT` / `revision_mismatch`.
4. Compute `max(payloadRevision ?? 0, revision) + 1` with a safe-integer check
   before any encryption; an exhausted generation is
   `INSTANCE_NOT_READY` / `payload_generation_overflow`.
5. Create one new opaque connection id through the injected factory
   (`isOpaqueId` validated; a bad factory is a wiring `InvalidContractInputError`).
6. Encrypt once with the active-slot context above and validate the envelope
   shape. A missing cipher, a throwing cipher or a malformed envelope is
   `INSTANCE_NOT_READY` / `cipher_unavailable`.
7. Issue exactly one `compareAndSetSlot`. A conflict is `AUTH_CONFLICT`; any
   other non-`applied` outcome is `AUTH_CONFLICT` / `unexpected_result`; a
   thrown failure is `STORE_UNAVAILABLE` / `store_unavailable` and is **never
   retried**, because the store may already have committed.
8. Validate the applied revision (safe integer, strictly greater than the
   guarded revision) and build the receipt from the committed projection plus
   the already-decoded plaintext — never from a second read that could observe
   another winner.

### 2.3 `removeDirectCredential(input, deps)`

- With an explicit `expectedRevision`: no read, no decryption, no binding signer
  and no cipher lookup. The removal fences and clears an unreadable payload
  directly (`slot.bindingId`/`envelope` never inspected).
- Without a revision (compatibility): exactly one guarded read, then the same
  CAS using that revision. A failed or malformed read is a controlled failure —
  revision 0 is never guessed and there is no unguarded delete.
- `expectedRevision === Number.MAX_SAFE_INTEGER` cannot safely advance the
  revision, so it is refused before the CAS (zero read for the explicit path,
  zero writes) with `INSTANCE_NOT_READY` / `payload_generation_overflow`.
- The applied revision is validated exactly as for set, then the receipt
  readiness comes from the resulting tombstone plus the pure Env strategy, so a
  correctly configured Env instance is reported as ready rather than
  unconfigured. Repeated removals keep advancing the revision through the store.
- Removal deliberately does not require an installed strategy: an operator must
  always be able to fence a legacy slot.

### 2.4 Fixed error surface

`AuthUseCaseError` carries one code from
`INVALID_REQUEST | AUTH_CONFLICT | AUTH_IN_PROGRESS | INSTANCE_NOT_READY | STORE_UNAVAILABLE`
and one reason from a closed allowlist (`platform`, `expected_revision`,
`credential_body`, `revision_mismatch`, `unexpected_result`,
`payload_generation_overflow`, `cipher_unavailable`, `store_unavailable`,
`corrupt_record`, `unavailable`). Messages are fixed per code and never
interpolate a value. Runtime mapping: `INVALID_REQUEST` -> 400,
`AUTH_CONFLICT`/`AUTH_IN_PROGRESS` -> 409, `INSTANCE_NOT_READY` /
`STORE_UNAVAILABLE` -> controlled 503. `AUTH_IN_PROGRESS` is declared for the
refresh/operation scope and is not produced by this module.

`preserveAuthFailure`/`authFailure` guard `instanceof` and every inspected
property, rebuild only the two allowlisted enums and never throw; a forged
instance, a proxy trap or a throwing getter degrades to the caller's fixed
fallback.

Receipts are the frozen `AuthMutationReceipt` variants
(`{ platform, action: "stored"|"removed", revision, configured, readiness }`,
the removed variant gaining no extra fields) and are frozen before return.

## 3. Verification inventory

| Required check | Test |
| --- | --- |
| correct AAD context on preparation | `decrypts an active payload with the trusted slot identity`, `uses the platform value as the AAD record id for every platform` (x, linkedin) |
| correct AAD context on set | `stores a complete group with the active-slot context`, `uses the platform value as the AAD record id for x and linkedin` |
| active failed decrypt selects no Env group | `blocks an unreadable active payload without selecting Env credentials`, `blocks when the cipher is unavailable instead of throwing`, `blocks when a throwing decrypt error carries a sentinel`, `treats a record without a usable active context as unreadable` |
| empty/tombstone preparation is crypto-free | `prepares empty and tombstoned slots without touching a cipher` |
| status/admission reads write nothing | `writes nothing while preparing` |
| set generation after remove / higher revision | `derives the next generation from payloadRevision and revision` (1, 6, 10) |
| malformed input, unknown platform, overflow: zero encryption | `rejects malformed revisions with zero store contact`, `rejects an uninstalled platform with zero store contact`, `rejects malformed decoder output before encrypting`, `checks the generation bound before encrypting`, `rejects malformed removal input with zero store contact` |
| concurrency: stale set and stale remove conflict | `conflicts when the slot moved between the read and the write`, `conflicts when a concurrent removal wins the same revision`, `conflicts on a stale explicit revision with a single attempt` |
| exactly one mutation, even when the commit is followed by a lost acknowledgement | `issues one mutation and never retries a committed-but-lost write`, `issues one mutation and never retries a committed-but-lost removal`, `reports a store failure as a controlled error with one attempt` |
| caller mutation during the await cannot change the payload or receipt | `keeps caller mutation during the read out of the stored payload` (buffer zeroed and target renamed while the read is pending) |
| explicit removal of an unreadable slot with no read and no key | `fences an unreadable active slot with an explicit revision and no key` |
| compatibility removal reads once; unreadable read is controlled | `uses the read revision once when the caller omits expectedRevision`, `returns a controlled error when the compatibility read fails` |
| repeated removal advances the revision | `advances the revision on every repeated removal` (1 -> 2 -> 3) |
| Env fallback readiness in the removal receipt | `reports the resulting Env readiness instead of claiming unconfigured` |
| removal cannot persist an unsafe next revision | `refuses an unadvanceable revision before any write`, `refuses an unadvanceable revision discovered by the compatibility read` |
| applied revision validated before a receipt | `validates the applied revision before projecting a receipt`, `validates the applied revision before projecting a removal receipt` |
| complete user group stores with missing runtime configuration | `stores a complete group whose runtime app configuration is missing` (write succeeds, receipt reports `needs_configuration`) |
| injected exceptions, getters and sentinels never escape | `never lets a decoder failure escape, even with hostiles`, `never lets hostile snapshot getters escape`, `never lets hostile snapshot getters escape a removal`, `never lets an injected strategy error escape`, `never lets a failing configuration provider escape`, `ignores forged instances and their messages`, `never reads a hostile getter outside a guard` |
| legacy platform removal stays possible | `removes a legacy slot for a platform without an installed strategy` |

Every failure-path assertion also checks the specific fixed code and reason and
that the injected sentinel text is absent from the message or status.

## 4. Decisions a reviewer should confirm

1. **Decoder error detail is not inspected.** A decoder failure becomes
   `INVALID_REQUEST` / `credential_body`; the use case never reads an injected
   error's `code`, `field` or message, because a forged object could smuggle a
   secret outward. A runtime that wants field-level detail (for example the CLI
   preview of safe field names) can pre-validate the body with the same injected
   decoder before calling the use case.
2. **Set requires an installed strategy; remove does not.** Storage for a
   platform this build cannot dispatch fails closed before any read, while a
   legacy slot stays fencable.
3. **Receipt readiness is a projection, not a re-read.** The committed snapshot
   for set follows the documented `set` semantics (new connection identity,
   target, no lease, refresh state ready) and for remove the documented
   tombstone; the D1 adapter's own contract tests must keep those semantics.
4. **`ACTIVE_SLOT_RECORD_ID` was removed.** Both the encrypt and decrypt
   contexts use `recordId: platform` (the credential table's primary key), and
   regressions pin the exact contexts for `x` and `linkedin`.
5. **Wiring defect versus caller error.** A clock that does not return a
   canonical instant and a binding-id factory that does not return an opaque id
   throw `InvalidContractInputError` (a documented contract violation), matching
   the existing create use case; caller and storage problems use
   `AuthUseCaseError`.
6. **Export gap for the next scope.** These modules are intentionally not
   exported from `packages/application/src/index.ts`, which is outside this
   task's ownership. The runtime wiring scope must export them (and the decoder
   dependency type) before the Worker can inject them through
   `@syndroo/application`.

## 5. Not verified here

- OAuth connect/complete/refresh, the candidate lifecycle, refresh leases and
  the `AUTH_IN_PROGRESS` path are out of scope and unimplemented.
- No Worker, D1, cipher, status-DTO or route test was run; the D1 repository's
  actual `set`/`remove` behaviour (including the documented revision bump) is
  proven by its own contract suite, not by these fakes.
- No provider request, live credential or production resource was touched, and
  no end-to-end or packaging gate (`npm test`, `npm run check`, `bundle`,
  `startup`) was run for this bounded task.
