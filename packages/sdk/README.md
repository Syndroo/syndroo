# @syndroo/sdk

A thin TypeScript HTTP client for one deployed [Syndroo](https://github.com/Syndroo/syndroo)
instance.

The SDK wraps the documented HTTP contract — `connect`, `publish` and `status` —
and adds no server behaviour. It imports no `@syndroo/core` and no provider code,
at build time or at runtime, and it never reconciles your data on its own.

```text
your app / CI  ->  @syndroo/sdk  ->  Syndroo HTTP API  ->  server or Worker
```

## Requirements

Node.js 24.19.0 or newer, or any runtime with a global `fetch`, `AbortSignal` and
Web Streams. There is no polyfill and no runtime dependency to install.

```bash
npm install @syndroo/sdk
```

The server must be reachable over HTTPS. Plain HTTP is accepted only for a
loopback host, because the client sends a Bearer secret on every call.

## Quickstart

```ts
import { Syndroo } from "@syndroo/sdk";

const syndroo = new Syndroo({
  baseUrl: "https://syndroo.example",
  apiKey: process.env.SYNDROO_API_KEY!,
});

// prepare freezes the content and the target list and returns an approval token.
const prepared = await syndroo.publish({
  type: "prepare",
  content: { text: "hello from the SDK" },
  targets: [{ provider: "bluesky" }],
});

if (prepared.status === "confirmation_required") {
  // execute only against the token that the prepare step issued.
  const round = await syndroo.publish({
    type: "execute",
    approvalToken: prepared.approvalToken,
  });
  console.log(round.status, round.deliveries.map(delivery => delivery.outcome?.status ?? "pending"));
}
```

`connect` follows the same shape: `start` and `resume` return whichever step the
provider asks for (`credential_input`, `open_url`, `wait_for_callback`, or a
`done` connection), while `update` and `disconnect` always end in a bound
connection and fail the call if they do not.

## API

```ts
syndroo.connect(request, options?)   // start | resume | update | disconnect
syndroo.publish(request, options?)   // prepare | execute | retry
syndroo.status(request, options?)    // overview | provider | connections | operation | operations
syndroo.wait(operationId, options?)  // poll one operation until its round completes
```

Every call validates its argument against the wire schema before it sends
anything, refuses a redirect instead of following it, bounds the response it
will buffer, and rejects a response that does not answer the request it was
given.

### Transport options

| Option | Default | Meaning |
| --- | --- | --- |
| `idempotencyKey` | generated where the protocol requires request identity | Stable identity of one logical call, reused by every transport retry. Supply it to recover the same operation across processes. |
| `timeoutMs` | `30000` | Per-request deadline, up to `120000`. |
| `transportRetries` | `0` | Transport retries, `0`–`2`. Only a call that never reached the server is retried. |
| `signal` | – | Cancels the local call. It never cancels work the server already admitted. |

`SyndrooOptions` also accepts `fetch` and `sleep`, so a host can supply its own
transport and timer. `LIMITS` and `WAIT_LIMITS` export every bound above.

### Wait

`syndroo.wait(operationId, options?)` polls `status({ type: "operation" })` until
the execution round reaches a terminal state. The default interval is `2000 ms`
(`250`–`30000`) and the default deadline is `120000 ms`, up to `3600000`. It
reads status only: it never refreshes a provider token, never retries a write,
and never asks a platform what happened.

## Errors

Every failure is a `SyndrooError` with a fixed `code` and a message that is never
interpolated from your input or from a response body. Use `isSyndrooError` to
narrow an unknown value. The codes are `INVALID_ARGUMENT`, `INSECURE_BASE_URL`,
`INVALID_REQUEST`, `INVALID_RESPONSE`, `RESPONSE_TOO_LARGE`,
`REDIRECT_NOT_ALLOWED`, `TRANSPORT`, `HTTP_ERROR`, `PROTOCOL`, `TIMEOUT`,
`ABORTED`, `WAIT_TIMEOUT`, `CONFIRMATION_REQUIRED` and `CONFIRMATION_EXPIRED`.

A protocol rejection carries the server's `{ error: { code, message } }`
projection as a `SafeError`, so a caller can branch on `error.code` without
parsing English. Nothing in an error can contain a credential: secrets are never
placed in a URL, a log line or a thrown message.

## What the SDK does not do

- It does not execute anything locally and has no filesystem or state of its
  own; local execution is the CLI's job, and both surfaces call the same Core.
- It does not approve a write. A prepare result is a token, and a token is not
  proof that a human read anything.
- It does not make publishing synchronous. A `202`-class answer means the
  execution was durably admitted, never that a platform accepted the content.

## Status

Architecture v1 is unreleased. The SDK is fixture-tested against the wire
protocol; no live platform call has been made from this repository, and no
Syndroo package has been published.
