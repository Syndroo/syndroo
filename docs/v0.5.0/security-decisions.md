# Security and concurrency implementation decisions

Root acceptance notes, 2026-09-23. These refine revision2; they are requirements to verify, not evidence of implemented guarantees.

## Persistence guards

Internal instants are canonical `YYYY-MM-DDTHH:mm:ss.sssZ` values whose parse/toISOString roundtrip is exact. Reject invalid calendar dates and noncanonical internal forms; normalize valid external input at the HTTP decoder boundary. D1 text ordering relies on this invariant.

One D1Repository implements the semantic ports. A batch transaction rolls back SQL errors, but a valid UPDATE affecting zero rows does not roll back unrelated statements. Every dependent statement must test the same successful logical mutation, within the same batch. No post-commit JavaScript check can repair partial writes. This follows the documented [D1 batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/); local D1 contract tests must establish actual SQL behavior.

Creation must identify a parent inserted by the current invocation. A fresh private mutation token on the parent can provide that marker; every child insert selects both parent ID and this token. Parent ID alone is insufficient: a zero-row guard combined with a preexisting ID could otherwise authorize child writes against an old parent. A preexisting ID collision with eligible guards raises a uniqueness error and rolls back. All expected credential-slot revisions/tombstones gate the parent insert. Idempotency collision reads/compares the existing canonical request, never partially replaces it.

Claim/outcome operations use an unpredictable claim token and exact current job/attempt identity. Parent aggregate updates and transport-intent cancellation must depend on the same winning claim or committed result. Retry creates its pre-generated successor ID once; same known commit replay must not create another intent. Preserve enough compact completion identity on the old job to distinguish applied replay from conflicting late input. No raw provider response or secret snapshot is a valid transaction marker.

If claim result is unknown, do not invoke the provider based on local optimism. A duplicate seeing a live claim settles; the authoritative stale-claim path eventually records unknown. If a known provider outcome cannot be persisted, retry only the exact local result commit with the exact pre-generated retry job ID, never the provider call.

Winning claim/lease results must carry the snapshot selected in the same transaction as that winning mutation. An unguarded read after the batch can observe a replacement connection or another lease and must never grant the first caller the second caller's authority. Capture the guarded result inside the batch or use an equivalent atomic returning statement. Mutation receipts report the revision produced by that mutation, not a later revision read from the slot. Tests must distinguish a SQL rollback from a committed transaction whose acknowledgement is lost.

Storage adapters expose fixed safe errors, without raw database causes, statements, parameters or secret values. Invalid nonempty encrypted records and unmigrated active plaintext records are corruption/migration conditions, never absent slots that permit Env fallback. Unsupported persisted job protocols cannot be coerced into the current executable protocol. An old job's DLQ message may update that job's transport metadata but cannot recover or terminate a newer attempt.

## Credential versions and leases

Slot revision is the CAS version. Payload revision binds the encrypted payload and changes only when that payload changes. A refresh lease cannot invalidate the stored ciphertext's AAD by equating these two versions. Acquisition must return the precise version/token needed for its completion; direct set/remove/activation must defeat a late lease holder.

Every successful explicit set/remove advances slot revision. Removing an already empty/tombstoned slot still fences an authorization started since the previous removal. These requests have no durable operation ID, so an old-revision retry is a conflict rather than an inferred replay. Same ciphertext alone cannot identify the same set request or justify ignoring a new binding/target.

Application chooses the next active-slot payload revision as `max(current.payloadRevision ?? 0, current.revision) + 1`, validating safe-integer bounds before encryption. This prevents deleting and recreating a slot from reusing an older payload's AAD generation even when the tombstone clears payload metadata. Slot revision remains the write fence; taking a refresh lease does not change or re-encrypt the current payload. OAuth request/candidate envelopes have separate operation identities and their own generation.

Only one refresh winner may send a token request. Expiration of its 60-second safety window authorizes reconnect-required handling, never another use of the same uncertain refresh token. Read-only status projects expiry safely without refreshing, unlocking or writing. Same-grant successful refresh preserves binding and target; a new direct set or completed authorization always creates a new connection identity.

Every refresh failure commit requires the exact lease token and slot revision. A missing lease is a conflict, not permission to mark a replacement connection unhealthy. Unknown, rejected and malformed exchange results all require explicit reconnection in this release; clearing the lease must not accidentally authorize another exchange. Success also checks unchanged target and connection identity. Late archive completion is guarded by the current attempt and planned archive key, so an older R2 write cannot change the newest attempt's diagnostic status.

## OAuth operation lifetime

An operation retains its initial expected slot revision. Complete requires the caller's observed revision to match both that initial value and the current slot. Changing the request revision to the newest slot value cannot revive an old authorization after set/delete/reconnect. Completed-operation replay returns its stored safe receipt and cannot write the slot again.

Guard conflicts leave every row unchanged, including operation phase and encrypted candidate. Expiry is projected by reads and cleaned by bounded maintenance. A repeated callback cannot expire or fail an already completed operation, and a token response arriving after operation expiry cannot persist a new candidate.

Canonical callback origin and app credentials participate in the operation's initial configuration fingerprint. Callback and complete reject changed configuration. OAuth state and operation ID are distinct unguessable values; operation lookup requires Bearer. OAuth1 also matches the original request token. Only an atomic pending_callback -> exchanging winner may exchange code/verifier; failed/expired/exchanging operations never reset to pending.

No unsupported platform PKCE capability is assumed. Preserve current confidential-client flow with fixed callback and one-time state; do not advertise PKCE without specific platform/application evidence. OAuth1 signing uses [RFC 5849](https://www.rfc-editor.org/rfc/rfc5849), including percent-encoding and sorting test vectors.

## Cipher and binding keys

Credential key is base64-encoded random 32 bytes for AES-256-GCM; binding key is a separate explicitly encoded random secret of at least 32 bytes, parsed consistently. API key is neither. No default key, API-derived key, unknown-key guessing, identity cipher or fallback to plaintext/another Env account.

Envelope AAD is exactly the versioned tuple in design §10. Trusted storage identity supplies its context; ciphertext cannot choose its own platform, record or purpose. Fresh 12-byte IV for each encryption, 128-bit tag, strict envelope validation and bounded decoded payload. Only standard WebCrypto primitives, supported by [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).

The runtime identity convention is fixed before wiring: an `active_slot` uses `recordId = platform`, matching the credential table's primary key; `oauth_request_secret`, `oauth_candidate` and any enabled `pkce_verifier` use the opaque operationId. Operation payload schema/generation starts at 1; activating a candidate re-encrypts it with the active-slot context and the next active payload generation. Direct set, preparation, refresh and cutover must use the same convention. Generic cipher contract fixtures may use arbitrary trusted IDs; they do not choose the runtime convention.

## External requests and diagnostics

Transport must impose a deadline on headers and body, reject redirects, cap bytes and avoid awaiting unbounded reader cancellation. It never retries or infers provider ambiguity from status alone. Every adapter decides whether its current protocol step may already have written. Official SDK retry machinery stays disabled for writes.

Provider endpoint hosts are fixed; custom Bluesky host is trusted operator configuration with strict HTTPS hostname validation, no userinfo/path/query/fragment, disallowed port or default private/loopback literal. This validation does not claim to defeat DNS rebinding. Production configuration has no broad user-controlled URL fetch capability; local outbound fixtures intercept the native request boundary without relaxing production validation.

Application/provider errors, console events, public DTOs and archive objects contain fixed safe codes and validated allowlisted fields. Do not attach raw transport causes or provider bodies merely because a serializer currently ignores them. OAuth responses are never archived. R2 archive failure follows successful D1 outcome commit and never enters the provider retry catch.

## Object adapter resource policy

The 0.5 reference BlobStore adapter buffers at most 8 MiB per object, accepts empty objects and unknown-length standard byte streams within that bound, and applies a 15-second total input-read deadline. Adapter options may lower these defaults. This is a bounded reference-adapter policy, not an R2 service limit or a new media product feature. Oversized or stalled streams fail with fixed safe errors; stream cancellation is never awaited indefinitely. Copy chunks when received, because a producer may reuse its buffer. Blob reads and archive reads validate stored size before buffering and enforce the measured byte bound as well.

This choice leaves space for buffer copies within the documented [128 MB per-isolate memory limit](https://developers.cloudflare.com/workers/platform/limits/#memory), which concurrent requests share. The [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) accepts stream bodies; any claim about a known-length restriction must additionally cite an actual local-runtime probe. There is no multipart implementation or new upload endpoint in this release.

Blob checksum metadata is SHA-256 encoded as lowercase hexadecimal when known. A supplied checksum is checked against actual bytes; a returned checksum describes the stored bytes. Content type rejects control characters. Every R2 operation translates raw storage errors without preserving their causes or echoing logical keys. Bucket privacy and lifecycle settings remain deployment-time checks; local bucket tests cannot establish production ACLs.

## Migration and deployment boundary

Legacy tasks are not newly authorized by schema/backfill. Automatic execution of missing binding remains blocked. Explicit review is limited to attempts=0, nonambiguous, unbound records; no provider-terminal/unknown record may be revived. Old publishing records receive no executable replacement job. Existing applied migrations are immutable.

Local tests may apply migrations only to disposable databases using synthetic credentials. Production migration, queue cutover, disabling deployed consumers, changing bucket policies, deployment, publication and live platform tests require separate authorization. Current source configuration may prepare those operations but never execute them.

Existing deploy.ts automatically applies remote migrations before deploying. The 0.5 integration must add an explicit upgrade/cutover preflight for an existing legacy database while preserving fresh-install provisioning and temporary configuration cleanup. A documented manual pause alone is insufficient if the deploy helper silently upgrades a database still served by old consumers. Verify refusal and fresh/acknowledged paths using a fake Wrangler executable; do not invoke the real remote command to test them.
