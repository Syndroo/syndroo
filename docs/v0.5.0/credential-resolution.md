# Credential resolution implementation boundary

Root architecture decision for Task 6. This document specifies the implementation target; it is not a test result.

## One preparation path

Application preparation reads the encrypted slot, decrypts an active payload using trusted slot identity, then invokes the injected synchronous `PublisherStrategy.prepare`. The same returned status serves auth reads, admission and execution. The Worker owns the static strategy registry and Env-to-plain-config mapping. No provider or Cloudflare type enters application.

The registry builds typed provider credentials through each package's existing decoders/builders. JSON records end at that boundary. Preparing or reading status performs no platform request, token refresh or storage mutation. Publisher constructors cannot log in during preparation.

An absent slot or explicit tombstone selects the complete Env user group. An active slot selects the complete encrypted user group; missing fields, invalid payload, invalid/expired expiry or decryption failure block it. None permits another Env account to be selected. A live refresh lease defers new preparation; an expired unresolved lease or sticky reconnect state reports reconnect_required. These reads never clear the lease.

## Field ownership

| Platform | Complete user group | Runtime app fields | Explicit target/config fallback |
| --- | --- | --- | --- |
| Bluesky | identifier + password | none | host: stored value, then BLUESKY_HOST, then bsky.social |
| Threads | access_token | none | none |
| X | access_token + access_token_secret | X_API_KEY + X_API_SECRET | none |
| Tumblr | token + token_secret | TUMBLR_CONSUMER_KEY + TUMBLR_CONSUMER_SECRET | blog: stored value, then TUMBLR_BLOG |
| LinkedIn | access_token; refresh_token only when issued and valid | OAuth client fields used only for authorization/refresh | author: stored value, then LINKEDIN_AUTHOR; api_version: stored value, then LINKEDIN_API_VERSION, then existing default 202604 |

Fallback concerns optional target/config fields only; it never fills half of a user token pair. OAuth complete applies stricter target confirmation rules from [public-api.md](public-api.md): it must not inherit the previous active connection's target. Explicitly completed target values are stored with the candidate's token group.

`source` describes fields actually selected. Env-only is env even if a deleted slot exists. Active D1 plus selected Env app/target fields is mixed. Active D1 requiring no Env fields is credential. Unused Env tokens do not change source. A missing user group has source null; a blocked selected D1 group retains its selected source where known.

Missing field names use a fixed allowlist. Only validated author/blog/identifier/host labels may become public targets; tokens, provider descriptions and exception messages cannot. Invalid internal dates are unavailable, known expiry at/before observation time is expired, unknown expiry remains null.

## Connection identity

Env-only binding material includes the complete selected user/app/target field group, with explicit null for absent optional fields. D1 binding material includes the slot's random bindingId and selected app/target configuration; it excludes refresh-varying access/refresh tokens. Both include platform and selected source through `encodeBindingMaterial`.

Application signs that material through `BindingSigner`. Slot bindingId is never used directly as publication credentialBinding. Source changes, explicit set/remove/reconnect and app/target changes break continuity; same-grant refresh preserves it. Field arrays are fixed and passed to the canonical encoder; no generic serialization of all configuration or plaintext is used.

## Direct mutation

Direct input rejects unknown fields and incomplete user groups before encryption. An injected per-platform decoder produces bounded canonical JSON bytes and safe target metadata. Application reads the slot, checks the operator's observed revision, creates a new bindingId, computes the next payload generation as `max(payloadRevision ?? 0, revision) + 1`, encrypts, then calls one CAS mutation. Validate safe-integer overflow before encryption. Do not automatically repeat set after a conflict or uncertain response.

Remove uses revision CAS and requires no decryption, signer or encryption key. Every explicit remove advances revision. If an explicit expectedRevision is supplied, removal can fence and clear an unreadable payload without decoding it; compatibility requests without a revision need a safe metadata read or a controlled error, never an unguarded delete. The existing frozen port currently exposes readSlot, so any additional metadata-only read must be resolved before implementing a parallel port change.

The portable direct decoder is injected as a synchronous function returning `{plaintext, payloadSchemaVersion: 1, expiresAt, target}`. It owns platform field validation; the application copies the byte buffer and safe metadata before its first await. Control fields such as expectedRevision do not belong inside that payload. The Worker supplies the concrete platform decoder; application never imports provider packages.

With explicit expectedRevision, remove calls `compareAndSetSlot` directly and needs no preliminary read. On success, its receipt uses the returned revision and the resulting tombstone's Env preparation. A compatibility remove without revision reads once before CAS and returns a controlled storage error if that read cannot be decoded. It does not guess revision zero. No new metadata port is required for these behaviors.

Set validates and snapshots the input, reads the existing slot, checks the observed revision, computes a safe new payload generation and binding ID, encrypts, and issues exactly one CAS. An uncertain mutation response must not trigger another set/remove. Readiness in a successful receipt describes that committed mutation's snapshot; a concurrent later mutation is observed through a separate status read. Pure preparation may report missing runtime app/target configuration without rejecting storage of an otherwise complete user group.

Status reads never infer an absent slot from a failed store read. A storage failure produces a controlled error; it does not expose a usable revision zero. When an active slot is known but decryption/configuration is unavailable, preparation reports a blocked status for that selected slot and never switches to Env user credentials. Read-only resolution and removal do not eagerly construct cryptographic adapters they do not need.

Composition is lazy about publishing keys: authenticated reads, idempotent post replay and removal must remain possible. Required cipher/binding configuration is checked before new publishing admission or sensitive writes, and reported independently from platform readiness. Missing canonical public URL blocks OAuth connect without disabling a correctly configured direct Publisher.

The runtime supplies a write cipher factory that validates both required key configurations before returning the real cipher to set/connect/complete/refresh. Read preparation may use a cipher-only factory; it does not need to sign a publication merely to report a slot. Both factories remain lazy, and explicit removal calls neither. This is composition behavior still requiring runtime tests; the portable direct-usecase tests exercise the injected factory boundary.

For the Cloudflare profile, the lazily injected publishing signer validates the required cipher and binding configuration when signing is first requested, then delegates HMAC to the real signer. This places the instance-readiness check after create's idempotent replay without changing the accepted create contract. The shared raw platform resolver still permits Env-only status preparation without constructing an unused cipher. Runtime tests must verify that missing cipher configuration blocks new admission even for Env-only publishing, while replay/status/removal remain available.

## Verification divisions

Implement distinct initial scopes: static platform strategies; portable preparation and direct CAS; OAuth operation lifecycle; runtime route/composition integration. Each gets focused tests and disjoint files, preserving all Task 6 acceptance requirements. Frozen Task 1 contracts remain unchanged unless root resolves an explicit compatibility need and applicable attempt budget.

Required checks include zero platform calls on reads/preparation, whole-group selection, blocked corrupt/expired slot despite valid Env credentials, source and binding changes, refresh continuity, exact revision conflict, delete without keys, input mutation during await, and absence of synthetic secrets in outward errors/status/logs.
