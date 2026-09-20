# @syndroo/sdk

A thin TypeScript HTTP client for one deployed
[Syndroo](https://github.com/Syndroo/syndroo) instance.

The SDK wraps the documented `/v1` HTTP contract and adds no server behavior. It
has no runtime dependencies, ships no bundler or platform SDK, and never
reconciles your data on its own.

```text
your app / CLI / CI  ->  @syndroo/sdk  ->  Syndroo HTTP API  ->  Worker
```

## Requirements

Node.js 22 or newer. The client uses the runtime's global `fetch`, `AbortSignal`,
and Web Streams; there is no polyfill and no dependency to install.

```bash
npm install @syndroo/sdk
```

## Quickstart

```ts
import { SyndrooClient } from "@syndroo/sdk";

const syndroo = new SyndrooClient({
  baseUrl: process.env.SYNDROO_BASE_URL!,
  apiKey: process.env.SYNDROO_API_KEY!,
});

const receipt = await syndroo.posts.create(
  {
    content: "We just shipped a new release.",
    platforms: ["bluesky"],
  },
  { idempotencyKey: "release-announcement-001" },
);

const post = await syndroo.posts.get(receipt.id);
```

## Two boundaries

**A create receipt is not a delivery.** `posts.create` returns an acceptance
result. HTTP `202` means the request was accepted for processing, and `queued`
means "waiting for a publication job". Nothing has reached a platform yet. Read
the post back and check each publication before telling a user that a post is
live:

```ts
const post = await syndroo.posts.wait(receipt.id, { timeoutMs: 60_000 });

if (post.status === "published") {
  // Every selected platform confirmed.
} else if (post.status === "partial") {
  // Some platforms confirmed; inspect each publication and do not resend the
  // successful ones.
} else {
  // failed: read errorCode, errorMessage, and errorAmbiguous per publication.
}
```

A `failed` publication with `errorAmbiguous: true` may still have been accepted
by the platform. Check the platform account by hand; do not resend that content
automatically.

**The API key belongs in a trusted environment.** Keep it in a server, CLI, or
CI credential store. Do not put it in a static page, a browser bundle, or a
`NEXT_PUBLIC_*` variable: `SYNDROO_API_KEY` can publish, and anyone who reads the
page can use it. Platform credentials stay in the Worker's secrets and are never
part of this client. The unauthenticated `/health` call is the only request that
sends no `Authorization` header.

## API

### `new SyndrooClient(options)`

| Option | Default | Meaning |
|---|---|---|
| `baseUrl` | required | Origin of the instance, for example `https://syndroo.example.com`. `https` is required outside loopback; `http` is accepted for `localhost` and `127.0.0.1`, or anywhere with `allowInsecureHttp: true`. |
| `apiKey` | required | Instance API key, sent as a Bearer token. |
| `timeoutMs` | `30000` | Per-request deadline. |
| `waitTimeoutMs` | `60000` | Default total deadline for `posts.wait`. |
| `maxResponseBytes` | `8388608` | Response size limit. |
| `allowInsecureHttp` | `false` | Permit plaintext `http://` for a non-loopback host. |

Configuration problems throw `SyndrooConfigError` from the constructor, before
any request is made.

### Methods

| Call | HTTP | Notes |
|---|---|---|
| `syndroo.health()` | `GET /health` | Unauthenticated reachability check. Proves the URL answers, not that the key or the platform credentials work. |
| `syndroo.posts.create(input, options?)` | `POST /v1/posts` | One request, never retried. `options.idempotencyKey` makes a retry safe. |
| `syndroo.posts.get(id, options?)` | `GET /v1/posts/<id>` | Read-only; safe to repeat. |
| `syndroo.posts.list({ limit }, options?)` | `GET /v1/posts` | `limit` is 1-100. |
| `syndroo.posts.wait(id, options?)` | repeated `GET /v1/posts/<id>` | Reads until `published`, `partial`, or `failed`, or until `timeoutMs`. |

`create` accepts `content`, `platforms`, optional per-platform `overrides`, and
an optional `scheduledAt`. The client validates the structure and sends your
object unchanged; it does not rewrite, trim, or truncate content.
Platform-specific length limits are enforced by the server and surface as typed
errors or as publication failures.

`wait` options: `timeoutMs` (total budget), `pollIntervalMs` (default `250`),
`maxPollIntervalMs` (default `2000`), and `signal`. Reading never creates,
cancels, or resends anything, so a wait timeout leaves the server-side work
running; `SyndrooWaitTimeoutError` keeps `postId`, `lastStatus`, `lastPost`, and
`lastError` so you can resume instead of starting over.

`scheduledAt` is submitted to the server, so a scheduled post does not depend on
this process staying alive.

## Errors

Every failure is a `SyndrooError`. Use `isSyndrooError()` to narrow, or the
exported classes:

| Class | Raised when |
|---|---|
| `SyndrooConfigError` | The client configuration is unusable. No request is made. |
| `SyndrooValidationError` | An argument cannot become a valid request. No request is made. |
| `SyndrooApiError` | Syndroo answered with a documented error envelope. Carries `status`, `code`, `retryAfterMs`, and `retryable`. |
| `SyndrooResponseError` | The answer was not the documented JSON contract: not JSON, missing fields, or over the size limit. |
| `SyndrooAbortError` | You aborted through an `AbortSignal`. |
| `SyndrooTimeoutError` | The deadline elapsed before the response was received. |
| `SyndrooNetworkError` | No HTTP response arrived; `networkCode` carries codes such as `ECONNREFUSED`. |
| `SyndrooWaitTimeoutError` | `posts.wait` hit its deadline before a terminal status. |

Server codes such as `UNAUTHORIZED` (401), `POST_NOT_FOUND` (404),
`IDEMPOTENCY_CONFLICT` (409), `PLATFORM_NOT_CONFIGURED` (422), and
`SERVICE_UNAVAILABLE` (503) appear on `SyndrooApiError.code`.

`requestMayHaveBeenApplied` is the flag that decides whether a resend is safe. It
is `true` when a write may already have reached Syndroo: a timeout, an abort, a
network failure, or a 5xx after a `POST`. A 4xx is a decision, so it is `false`.
When it is `true`, look the post up with `posts.list` or repeat the identical
request with the same `Idempotency-Key` — never with a new key and never with
different content.

## Timeouts, aborts, and retries

- The SDK performs exactly one HTTP request per call. It never retries a write.
  A silent retry without a stable idempotency key can duplicate a post.
- A timed-out `POST` is reported as an unknown outcome, not as "not created".
- `AbortSignal` is supported on every method; aborting a read is always safe.
- API errors carry no retry attempt, only `retryable` and `retryAfterMs`, so your
  own policy decides.
- `posts.wait` absorbs transient failures (network errors, timeouts, 5xx, 429)
  with bounded exponential backoff, honours `Retry-After`, and stops at the
  first authentication, validation, or "not found" answer instead of polling.

## Redirects

The client never follows redirects. A `3xx` answer becomes a `SyndrooApiError`
with code `REDIRECT_NOT_FOLLOWED`, so the `Authorization` header can never be
forwarded to another host. Point `baseUrl` at the final API origin, for example
the `https://...workers.dev` URL of the deployment.

## Not in this version

The SDK is deliberately small. There is no preview, approval, retry, or cancel
endpoint, no dashboard, no media upload, and no OAuth handling, because the
server does not offer those operations yet. Direct HTTP remains the fallback for
anything this client does not cover.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
