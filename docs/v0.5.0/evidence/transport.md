# Task 2 evidence — private transport and five migrated providers

Status: **implemented and verified locally**; NET-01's production-bundle
native chain and root-manifest integration remain open (see §5).

## 1. Scope and files

New private package `packages/transport` (no runtime dependencies; consumes only
web-standard APIs, so it never imports `@syndroo/core`):

* `src/errors.ts` — `TransportError` with fixed safe messages.
* `src/bounded-request.ts` — `boundedRequest`, `TransportRequest`, `TransportResponse`.
* `src/oauth1.ts` — `percentEncode`, `oauth1BaseStringUri`, `oauth1SignatureBaseString`, `oauth1Signature`, `oauth1AuthorizationHeader`.
* `src/retry-after.ts` — `parseRetryAfter`, `MAX_RETRY_AFTER_MS`.
* `src/index.ts` — the exported surface above.

Migrated providers (each now uses the transport instead of its own `fetch`):

| Package | New typed decoders / builders |
| --- | --- |
| `packages/threads` | `decodeThreadsCredential`, `buildThreadsPublisher` |
| `packages/linkedin` | `decodeLinkedInCredential`, `buildLinkedInPublisher` |
| `packages/tumblr` | `decodeTumblrUserCredential` (direct input), `decodeTumblrCredential` (resolved app+user), `buildTumblrPublisher` |
| `packages/bluesky` | `decodeBlueskyCredential`, `buildBlueskyPublisher`, `validateBlueskyHost` |
| `packages/x` | `decodeXUserCredential` (direct input), `decodeXCredential` (resolved app+user), `buildXPublisher` |

`packages/core/src/index.ts` — added `PublishErrorOptions { retryAfterAt?: string }`
and the optional `PublishError.retryAfterAt` field. The three-argument
constructor and `ErrorOptions.cause` keep working; no second retry policy was
added. Option shape for T5:

```ts
new PublishError(message, code, ambiguous, { retryAfterAt })   // string, normalized UTC
error.retryAfterAt                                             // string | undefined
```

Existing Worker call sites are unchanged: every adapter still exposes
`{ providerName, buildPublisher(Record<string, string>), oauth }`, and
`buildPublisher` now delegates to `decode*` + `build*`. No Worker, application,
manifest, lockfile, or design copy was modified.

## 2. Transport policy (as implemented)

* HTTPS only; userinfo, fragment, and non-HTTPS targets are rejected before any
  dispatch (`requestDispatched: false`).
* `redirect: "manual"` with every 3xx rejected; the redirect is never followed.
* Exactly one `fetch` per call; nothing is retried; no status interpretation.
* Deadline covers headers **and** the whole body read; reads race the deadline so
  even a signal-ignoring custom stream cannot block the return.
* Body cap: default 64 KiB, per-call values must be `1..65536`; `timeoutMs` must
  be `1..300000`. Invalid bounds raise `TypeError` before dispatch.
* `reader.cancel()` is never awaited; every failure path also calls
  `controller.abort()` and releases the reader.
* Timer and both abort listeners are removed in `finally`.
* `bodyPolicy: "discard"` releases a body without reading it while preserving
  status and headers (LinkedIn's 201 + `x-restli-id` contract); error statuses
  and `Retry-After` stay readable in that mode.
* `requestDispatched` records only that `fetch` was invoked, never that bytes
  reached the provider.
* `parseRetryAfter` accepts delta-seconds or HTTP-date, ignores missing/invalid/
  past values, and clamps to a 24 h maximum. Adapters attach it only to an
  explicit 429 rejection (provider `PublishError.retryAfterAt`).

## 3. Commands and results (Node 26.7.0, Vitest 4.1.11)

```bash
# transport (unit + failure fixtures)
cd packages/transport && ../../node_modules/.bin/tsc -p tsconfig.json \
  && ../../node_modules/.bin/tsc -p tsconfig.test.json --noEmit \
  && ../../node_modules/.bin/vitest run

# transport native workerd fixtures (needs loopback permission)
cd packages/transport && ../../node_modules/.bin/tsc -p tsconfig.workerd.json \
  && ../../node_modules/.bin/vitest run --config vitest.workerd.config.ts

# core + providers
cd packages/core && ../../node_modules/.bin/vitest run
cd packages/<provider> && ../../node_modules/.bin/tsc -p tsconfig.json \
  && ../../node_modules/.bin/tsc -p tsconfig.test.json --noEmit \
  && ../../node_modules/.bin/vitest run
```

| Target | build | check | tests | exit |
| --- | --- | --- | --- | --- |
| `packages/transport` | 0 | 0 | 76 passed (3 files) | 0 |
| `packages/transport` (workerd config) | 0 | 0 | 11 passed (1 file) | 0 |
| `packages/core` | 0 | 0 | 4 passed | 0 |
| `packages/bluesky` | 0 | 0 | 49 passed | 0 |
| `packages/threads` | 0 | 0 | 19 passed | 0 |
| `packages/x` | 0 | 0 | 33 passed | 0 |
| `packages/tumblr` | 0 | 0 | 35 passed | 0 |
| `packages/linkedin` | 0 | 0 | 45 passed | 0 |

Note: the Node project now pins `include: ["test/**/*.spec.ts"]`; before that it
also collected `test-workerd/**`, which is why the Node count moved from 61 to
76 while the workerd project stayed separate.

Failure fixtures were written before the implementation and observed red
(`2 failed (2)`, missing module, exit 1) before the transport source existed.

### Write accounting (single write attempt per publish)

Each provider counts real `fetch` invocations, so an SDK-internal refresh or
retry would show up as an extra call:

* Bluesky: session step + one `createRecord` step = 2 calls; a 401 or 503 on the
  write does **not** produce a third call (no implicit `refreshJwt` exchange, no
  write retry).
* X: a 503 followed by an available success response still reports exactly one
  call — the queued success is never consumed, so `retry: false` is proven
  behaviourally rather than by reading SDK options.
* Threads and Tumblr are single-write protocols; both assert one call.
* LinkedIn uses `bodyPolicy: "discard"`, so a stalled body neither blocks the
  201 confirmation nor gets buffered.

These are adapter-level counts in a JS-hosted runtime. They are **not** native
workerd proof and do not close NET-01/NET-04 on their own.

### Signing vectors

* Percent-encoding table from RFC 5849 §3.6.
* Canonical OAuth 1.0a signature example reproduced exactly; the expected value
  `hCtSmYh+iHYCEqBWrE7C7hYmtUk=` was independently derived with
  `openssl dgst -sha1 -hmac "<consumerSecret>&<tokenSecret>" -binary | base64`
  over the same base string, and is asserted both in Node and inside workerd.
* An in-test `node:crypto` HMAC over the same base string cross-checks the
  WebCrypto implementation.

### Native workerd fixtures

`vitest.workerd.config.ts` reuses the isolated-experiment shape
`cloudflareTest({ miniflare: { outboundService: async request => … } })` with a
**fail-closed** handler (`test-workerd/outbound-fixture.ts`): listed destinations
get deterministic answers, every other origin/method/path throws, so no fixture
can reach the internet. Counters live in the handler closure and are read from
inside workerd through the `stats.invalid/_stats` control route, reset per test;
production code contains no fixture special case.

Eleven fixtures run in real workerd:

* a real 200 response through the transport;
* an unlisted destination (fails closed: 500 plus `unexpected = 1`);
* 301/302/303/307/308 each rejected as `redirect`, with the second-hop counter
  and the "second hop received Authorization or body" counter both `0`;
* an oversized native body bounded as `response_too_large`;
* a stalled native stream bounded as `timeout` within the deadline;
* all five providers publishing successfully through workerd's own `fetch`
  (host hit counts asserted for `graph.threads.net`, `api.linkedin.com`,
  `api.tumblr.com`, `api.x.com`, `bsky.social`);
* the published RFC 5849 signature vector computed with workerd WebCrypto.

No `fetchMock`, no `globalThis.fetch` replacement. NET-01's production-bundle
chain still belongs to the integration task.

## 3a. Signer, credential types and retry-hint rules (attempt 3 corrections)

OAuth 1.0a (`packages/transport/src/oauth1.ts`):

* URL query parameters are collected into the signature base string, with
  duplicate names and empty values preserved (RFC 5849 §3.4.1.3.1).
* `parameters` carries form-body/protocol parameters; `oauthParameters` carries
  additional OAuth protocol parameters that are also emitted in the
  Authorization header, so nothing is signed without being sent.
* `oauth_signature` is excluded wherever it appears; `realm` is excluded only as
  a protocol parameter — an ordinary query or form parameter named `realm` is
  signed (tests cover both).
* `oauthParameters` refuses core-parameter overrides (`oauth_consumer_key`,
  `oauth_nonce`, `oauth_signature*`, `oauth_timestamp`, `oauth_token`, `realm`),
  duplicate names, and names outside
  `oauth_callback`/`oauth_verifier`/`oauth_version`.
* `oauth_version` is never implied.
* The published RFC vector is asserted as a fixed base string plus signature
  (`r6/TJjbCOr97/+UU0NsvSne7s5g=`) in Node and in workerd; `openssl dgst -sha1
  -hmac` over the RFC's own parameter set independently reproduces that value.

Compile-negative credential fixtures: every provider now has
`test/credential-types.ts` with `@ts-expect-error` lines compiled by the package
`check`. Three directives were initially unused (fixtures that were valid
TypeScript) and were deleted, so each remaining directive is load-bearing.

Retry hints: `parseRetryAfter` validates `maxDelayMs` as a finite positive value
no greater than 24 h (otherwise `TypeError`), accepts delta-seconds or an
IMF-fixdate HTTP date, ignores missing/empty/negative/past values, rejects
arbitrary `Date.parse`-only inputs, and clamps the result to the 24 h bound.

Provider regressions: Bluesky rejects `localhost.`, dotted and hex IPv4-mapped
IPv6 (`[::ffff:127.0.0.1]`, `[::ffff:192.168.1.1]`) and URL-normalised IPv4
aliases (`127.1`, `0x7f000001`, `2130706433`); X copies and freezes its options
so later caller mutation cannot swap the account it signs with; each provider has
a pure-construction/zero-fetch test.

## 4. Deliberate changes to existing provider assertions

* `packages/tumblr/test/index.test.ts` and `packages/linkedin/test/index.test.ts`
  asserted `redirect: "error"`. Both now assert `redirect: "manual"` plus 3xx
  rejection, matching design §8 and workerd's actual behaviour. No behavioural
  assertion was removed.
* LinkedIn's stalled-body test still asserts the body was cancelled exactly once
  and the request signal ended aborted; the abort now happens on the discard
  path instead of in the provider's `finally`.

## 5. Open items and follow-ups (root/T9 owned)

* Root `build`/`check` scripts must include `packages/transport`, and the
  lockfile must record the new workspace plus `@syndroo/transport` dependencies
  added to the five provider manifests. Locally the workspace link was created by
  hand (`node_modules/@syndroo/transport`).
* Provider builds resolve `@syndroo/core` through `dist`, so core must be built
  before provider builds; the integration task owns build ordering.
* NET-01/NET-04 full chain (production bundle, real Queue/Cron, native workerd
  outbound policy end to end) remains NOT_RUN here.
* Observed and unexplained: workerd logs `uncaught exception ... Network
  connection lost` for the deliberately refused loopback connection. The
  promise rejection is handled; the runtime still logs the underlying I/O
  error. It carries no request data, but the integration task may want to
  confirm it cannot pollute production logs.
* `terminalReason` was not added to the public `Publication` projection: nothing
  in Task 2 needed it, and the projection belongs to the Task 3/Task 5 contract
  change.
