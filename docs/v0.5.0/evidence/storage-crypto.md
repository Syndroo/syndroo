# T4 evidence — credential cipher, binding signer, R2 archive/blob

Status: **implemented and verified locally** (attempt 1). Production wiring,
bucket ACL and full Worker integration remain T9.

## 1. Files

New adapters (Worker infrastructure only; no production wiring, no manifest edits):

* `packages/cloudflare-worker/src/infrastructure/crypto/keys.ts` — strict base64/key-id validation, encoded-length bounds, context validation.
* `packages/cloudflare-worker/src/infrastructure/crypto/aes-gcm-cipher.ts` — `createAesGcmCipher`, real AES-256-GCM.
* `packages/cloudflare-worker/src/infrastructure/crypto/hmac-binding-signer.ts` — `createHmacBindingSigner`, HMAC-SHA-256 lowercase hex.
* `packages/cloudflare-worker/src/infrastructure/r2/archive-store.ts` — `createR2ArchiveStore`.
* `packages/cloudflare-worker/src/infrastructure/r2/blob-store.ts` — `createR2BlobStore`.

Dedicated project (never touches the Worker's own config):

* `packages/cloudflare-worker/test/storage-v050.vitest.config.ts` — local `r2Buckets` (`ARCHIVE_BUCKET`, `MEDIA_BUCKET`), `nodejs_compat`, and a **fail-closed** `outboundService` that throws for every request.
* `packages/cloudflare-worker/test/crypto-v050.spec.ts`, `test/r2-v050.spec.ts`, `test/support/storage-v050-fixtures.ts`.

Frozen contracts consumed unchanged: `@syndroo/application` (`CredentialCipher`,
`ArchiveStore`, `BlobStore`, `BindingSigner`, `encodeCipherAad`,
`assertSanitizedArchive`, `archiveExpired`). The package link
(`node_modules/@syndroo/application`) was created locally; the manifest/lockfile
entry belongs to T9.

## 2. Crypto behaviour

* Key material: canonical padded base64 of exactly 32 bytes for the cipher, a
  separate >=32-byte base64 secret for the binding signer, fixed safe-charset key
  id. No derivation from the API key, no default, no fallback.
* AAD: `encodeCipherAad(requireCipherContext(context))` — the exact contract
  tuple. The context is validated first: fixed purpose, `isPlatform`, bounded
  opaque `recordId`, positive safe-integer schema/payload revisions.
* Envelope: unknown own fields, missing fields and non-string fields are
  rejected; version/algorithm are checked; the base64 strings are length-capped
  **before** decoding so an oversized input cannot allocate.
* Fresh CSPRNG 12-byte IV per envelope; 128-bit tag; `kind: "aes-256-gcm"`.
* Fixed safe errors: `CipherUnavailableError` for key/tag/AAD/key-id/crypto
  failures, `InvalidContractInputError` for malformed input. No cause, key,
  payload or runtime text is attached; `importKey`/`sign`/`encrypt` failures are
  wrapped.
* Payload copied before any await; empty and >64 KiB payloads rejected.
* Binding signer validates the material version and returns lowercase hex;
  `computeCredentialBinding` adds the `v1:` prefix.

## 3. R2 behaviour

* **Reference-adapter resource policy, not an R2 or product cap:** streamed blob
  input is buffered through `MAX_BLOB_BYTES = 8 MiB` with a total read deadline of
  15 s; both are configurable **downward only** (larger values are rejected at
  construction). The port still accepts a standard unknown-length
  `ReadableStream`.
* Empty blobs are valid (the port has no non-empty restriction).
* Metadata validated before writing: `byteLength` must be `null` or a
  non-negative safe integer, `checksum` must be `null` or lowercase SHA-256 hex
  (the adapter computes and returns SHA-256 hex itself), `contentType` must be a
  bounded string without control characters. Mismatches are rejected before any
  write.
* Streams are read in chunks, each chunk copied immediately, with a
  non-awaited `cancel()` on overflow, timeout or reader error.
* Reads bound the object **before** materialising it (`object.size` first, then
  a measured re-check) for both blobs and archives; archives additionally use
  the contract's 64 KiB bound.
* Every bucket failure (`put`/`get`/`delete`/`head`) becomes a fixed
  `StoreUnavailable`; a `put` that returns no object is never reported as
  success. Corruption errors are fixed text with no key or payload echo.
* Archive payloads are snapshotted into an explicit projection and the snapshot
  is validated; unknown own fields (including a caller `toJSON`) are rejected,
  so later mutation or a serialisation hook cannot change what is stored.
* The archive clock is validated as a canonical UTC instant before it decides
  expiry; expired or missing objects read as `null` while the underlying object
  remains.

## 4. Verification

```bash
cd packages/cloudflare-worker
../../node_modules/.bin/tsc -p tsconfig.json --noEmit
../../node_modules/.bin/vitest run --config test/storage-v050.vitest.config.ts
```

Result: **2 files, 55 tests passed, exit 0** (24 crypto + 31 R2/archive).
`tsc -p tsconfig.json` reports only the two pre-existing
`platform-descriptors.ts` `LINKEDIN_CLIENT_ID`/`_SECRET` errors; nothing from
`src/infrastructure/**`.

Covered: round trip; IV freshness per envelope; wrong key; unknown key id;
corrupted tag; **each** AAD field changed; malformed envelopes (empty/malformed/
wrong-length IV, empty/short ciphertext, unknown version, unknown algorithm,
unknown extra field); oversized *encoded* ciphertext rejected before decoding;
empty and oversized payloads; caller-buffer copy; invalid contexts (purpose,
platform, recordId, zero/negative/fractional versions); binding hex shape,
stability across cipher IVs, change with material and with key, short-key and
unsupported-version rejection.

**Interoperability both directions with `node:crypto`** (independent
implementation, via `nodejs_compat`): node-encrypted envelope decrypted by the
workerd cipher, and a workerd-produced envelope decrypted by `node:crypto`, with
the same AAD bytes.

R2 covered: archive put/get round trip, missing key -> `null`, expiry -> `null`
while the object still exists, allowlisted-field projection (exact key set),
non-allowlisted key/prefix and unknown field and non-allowlisted code rejected
before writing, non-JSON stored object -> fixed corruption error, `toJSON`
payload rejected, non-canonical clock rejected, oversized stored archive
refused before reading; blob put/get/exists/delete, stream body with real size,
empty blob, metadata length/checksum/control-character rejection, invalid
logical key, downward-only policy enforcement, oversized stored object refused,
stream bound overflow, and read-deadline timeout on a never-closing stream.

## 5. Open items

* The `r2-stream-probe` fixture hands an unknown-length `ReadableStream`
  straight to the local binding and pins whichever outcome the runtime produced
  (it accepts either, so no adapter behaviour depends on it). The official
  reference documents that R2 `put` accepts a `ReadableStream`; the adapter
  buffers anyway, as the reference-adapter resource policy above, and reports
  the runtime's observed outcome on demand rather than asserting it.
* Whether the `BlobStore` port should carry an explicit maximum instead of an
  adapter policy is an architecture question for T9; the port was **not**
  narrowed and no assertion was added to it.
* Bucket ACLs, public access settings, lifecycle/retention policy and the
  provider-archive 30 d / DLQ 90 d wiring are deployment-time checks, not
  claimed locally.
* Rotation/multi-key (`keyId`) support, KMS and migration tooling remain out of
  scope for 0.5.0 as designed; T6/T9 still need the composition-level
  key-independence check.
