# SDK transport and error boundary

Root implementation decision for the remaining Task 7 scopes. This specifies expected behavior, not verification evidence.

## Operation context

SDK-generated errors carry a fixed `operation` identifying `health`, `posts.create`, `posts.get`, `posts.list`, `posts.wait`, `auth.status`, `auth.set`, `auth.connect`, `auth.operation`, `auth.complete`, `auth.refresh`, `auth.remove`, or `diagnostics`. Do not put a platform, post ID, operation ID, URL or caller-controlled value into that field. Preserve the existing `requestMayHaveBeenApplied` public name and error classes. Existing callers constructing errors themselves may omit operation.

Validate arguments and duration before any request. A pre-aborted call sends zero requests and reports false. In-flight abort, deadline and network failure after starting a write report true; malformed 2xx writes retain actual status and true. Reads always report false. Controlled 4xx/redirect rejection reports false; 5xx after a write remains uncertain. No SDK write automatically retries.

Recovery text follows operation. Post-create uncertainty may mention the same idempotency key and status reads. Auth uncertainty directs the caller to `auth.status` and, when applicable, `auth.operation`; it never suggests a post key or repeating a refresh exchange. Complete may be explicitly replayed for the same operation under the server contract, but the SDK performs no automatic replay.

## Safe diagnostics

SDK-generated diagnostics do not retain raw fetch exceptions, abort reasons, provider/server error bodies, invalid JSON previews, secret-bearing URLs or rejected response values in `message`, `cause`, `preview`, stack text or enumerable fields. Validation reports fixed field names and expected types, not rejected values or arbitrary override keys. Preserve the public optional preview property for compatibility, but do not populate it from untrusted responses. Constructors remain usable; this constraint covers errors produced by SDK operations. The existing documented `posts.wait` lastPost property remains the parsed resource snapshot, including the user's post content; it is not a generic diagnostic blob. Do not interpolate forward-compatible unknown status text from that snapshot into generated messages, and do not automatically log the snapshot.

Recognized public error codes may be preserved from a closed allowlist: existing request/auth/post/rate-limit/service codes plus the documented 0.5.0 auth and storage codes. An unrecognized response code becomes `HTTP_<status>`; do not echo arbitrary text merely because it matches an uppercase pattern. Network codes likewise use a fixed known runtime-code allowlist. No raw nested cause is retained. Public publication `terminalReason` remains forward-compatible as specified separately; diagnostic error sanitization does not narrow that wire field.

## Bounded requests

One transport supports GET, POST and DELETE. Duration validation uses the existing shared positive finite `<= 2_147_483_647ms` rule, including all new methods. One deadline covers response headers and body; a stalled read or cancellation cannot hold the call beyond that deadline. Cancel losing work, clear timers/listeners, and attach rejection handlers to abandoned promises. A hostile or injected fetch that ignores AbortSignal must still settle the SDK call at its deadline. Copy stream chunks before the next read to avoid mutable-buffer reuse. Redirects remain manual and never forward authorization.

The standalone process regression uses the runtime selected by the test runner or an explicit test override. Installed-package evidence must import built JavaScript outside the repository. Runtime support is reported from actual execution, not from a hardcoded local Node path.

## Scope sequence

The public facade must preserve documented overloads, including `auth.status(undefined, options)` and the separate fourth request-options argument of `auth.complete(platform, id, input, options)`. Validate supplied target keys and values locally, but let the server require target fields for unfinished operations: a completed-operation replay may omit a target, and Tumblr may use a provider-confirmed candidate blog. No SDK preflight request is added merely to decide those requirements. Operation missing fields and stored failure codes are distinct from platform configuration names and HTTP error codes; represent those separate closed sets. Validate nested operation/active/receipt identities, including the operation id, without assuming that a replay receipt matches the current active revision.

Implement and verify operation/error/transport behavior first. Then add the auth/diagnostics wire types and thin public facade against `public-api.md`, followed by CLI/Skill and installed-artifact integration. Each scope owns its named tests and evidence. Later scopes reuse the transport boundary and never implement separate request/retry logic.
