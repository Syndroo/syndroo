# 0.5.0 public API contract

Implementation contract derived from revision2; root decision, 2026-09-23. This fixes wire choices omitted from illustrative design signatures. It describes the target API, not a claim that implementation or tests already pass.

## Shared rules

Existing posts routes, 202 acceptance/200 replay, error envelope and public status enums remain. `terminalReason?: string` is an additive publication field; consumers tolerate future strings. Internal claim tokens, binding HMACs, encrypted envelopes, token material and outbox implementation details never enter public post DTOs.

All `/v1/*` routes require Bearer except exact `GET /v1/auth/{x|tumblr|linkedin}/callback`. Unsupported method/path returns controlled 404/405; extra suffixes never match a valid action. Unknown platform remains controlled 404 or platform-not-configured, no external request. Auth JSON bodies have the existing 64KiB limit and reject nonobjects, arrays and unknown fields. Auth and diagnostics responses use Cache-Control: no-store. Callback also has Referrer-Policy: no-referrer and restrictive CSP without third-party resources.

All revisions are nonnegative safe integers; absent slot reports revision 0. No response claims real account verification merely from local configuration. Mutation failures use existing error envelope, with explicit 409 AUTH_CONFLICT / AUTH_IN_PROGRESS and controlled 503 INSTANCE_NOT_READY / STORE_UNAVAILABLE when applicable. Raw provider messages and storage errors are never echoed.

## Status

`GET /v1/auth` returns the existing `platforms` map plus `instance`:

```ts
type Readiness = "ready" | "missing_credentials" | "needs_configuration" |
  "expired" | "reconnect_required" | "unavailable";
interface PlatformStatus {
  platform: string;
  configured: boolean;
  source: "env" | "credential" | "mixed" | null;
  oauthSupported: boolean;
  readiness: Readiness;
  missingFields: string[];
  expiresAt: string | null;
  revision: number;
  target?: { label: string; source: "user" | "provider" };
}
interface AuthStatus {
  instance: { publishingReady: boolean; missingFields: string[] };
  platforms: Record<string, PlatformStatus>;
}
```

`GET /v1/auth/:platform` returns `PlatformStatus`. Missing field names are a fixed allowlist of public configuration names. Target label is strictly decoded identifier/blog/author/host data, never an arbitrary provider string or token. `source` reflects selected credentials, not the mere presence of unused Env values. `expiresAt:null` means unknown, not permanent validity. Instance readiness covers required publishing/binding/cipher configuration; absent canonical public URL affects OAuth connect independently.

## Direct set/remove/refresh

- `POST /v1/auth/:platform`: existing flat platform credential body, optional `expectedRevision` alongside fields. Server removes and validates that control field before the platform credential decoder. All submitted user token fields must form one complete group. Reply preserves `{platform,stored:true}`, adding revision, configured and readiness.
- `DELETE /v1/auth/:platform`: optional JSON body `{expectedRevision}`. Empty body is accepted for old clients; successful reply preserves `{platform,removed:true}`, adding revision, configured and readiness. A tombstone remains, and Env fallback is reported accurately.
- `POST /v1/auth/:platform/refresh`: optional JSON body `{expectedRevision}`. Empty body preserves existing client compatibility. Reply `{platform,refreshed:true,revision,configured,readiness,expiresAt}`. No automatic retry.

Old clients without expectedRevision use the revision read at request start for CAS; absence never disables the guard. New SDK/CLI mutation calls require an explicitly observed revision. Deletion remains recoverable when a cipher/binding key is missing; it clears ciphertext without needing to decrypt it. Reconnect/set must not bypass unresolved key validation by silently writing plaintext.

## OAuth connect / operation / complete

`POST /v1/auth/:platform/connect` accepts `{expectedRevision?:number}`; legacy `GET .../connect` invokes the same guarded operation with no-store. Response:

```ts
interface ConnectReceipt {
  platform: string;
  operationId: string;
  url: string;
  expiresAt: string;
  expectedRevision: number;
}
```

Only this authenticated interactive response may contain the provider URL's protocol-required state/request-token parameters. Do not copy the URL into logs or saved evidence. CLI validates provider authorization origin/path and prints it; never executes a browser shell command.

`GET /v1/auth/:platform/operations/:id` returns:

```ts
type AuthPhase = "pending_callback" | "exchanging" | "awaiting_confirmation" |
  "needs_configuration" | "completed" | "failed" | "expired";
interface AuthOperationStatus {
  platform: string;
  operationId: string;
  phase: AuthPhase;
  expiresAt: string;
  expectedRevision: number;
  missingFields: string[];
  candidate?: { target?: { label: string; source: "user" | "provider" } };
  active: PlatformStatus;
  receipt?: CompleteReceipt;
  errorCode?: string;
}
interface CompleteReceipt {
  platform: string;
  operationId: string;
  stored: true;
  revision: number;
  configured: boolean;
  readiness: Readiness;
  replayed?: boolean;
}
```

Expired read is a read-only projection; no token exchange, silent mutation or state revival. Auth operations belong to one platform. Operation ID is opaque and separate from OAuth state. Safe fixed errorCode only, no raw error descriptions. `active` and `candidate` remain separate even when they refer to the same human-readable target.

`POST /v1/auth/:platform/operations/:id/complete` body `{expectedRevision:number,target?:{author?:string,api_version?:string,blog?:string}}`. Reject target keys irrelevant to selected platform. LinkedIn requires explicitly chosen author and valid API version; Tumblr requires explicit blog or strictly validated provider-confirmed candidate blog. Never silently inherit the previous active account's target. X accepts no target overrides. Successful activation and saved CompleteReceipt are atomic. Repeated completed operation returns its original receipt with replayed=true even if a subsequent set/remove changed the slot; it never activates again.

TTL is 30 minutes from connect creation and never renewed by reads or retries. Token exchange deadline 15 seconds, refresh safety window 60 seconds. Unknown refresh result requires reconnect, never lease-expiry retry of the same token.

## Diagnostics

`GET /v1/diagnostics` is read-only and returns:

```ts
interface Diagnostics {
  observedAt: string;
  pendingOutbox: number;
  oldestDueAt: string | null;
  oldestAgeSeconds: number | null;
  retryScheduled: number;
  deadLettered: number;
  latestAttemptArchiveFailures: number;
  storage: {
    approximateBytes: number | null;
    limitBytes: number | null;
    utilization: number | null;
    reason: string | null;
    observedAt: string;
  };
}
```

Counts describe current rows, not lifetime totals. OldestDueAt concerns eligible pending jobs due at observedAt; age is nonnegative elapsed seconds, null when none due. `deadLettered` counts publications with terminalReason=dead_lettered plus current waiting publications whose current job has dlqSeenAt and awaits its due-time settlement, deduplicated by publication. Late DLQ for published/unknown outcomes and superseded jobs does not add to this count. Dispatch excludes dlqSeenAt jobs even before due, so diagnostics can reveal that transport failure without authorizing another send. Storage size/limit unknown => null with fixed reason; utilization uses 0..1 only when size and limit are known. No remote administration token is requested to compute this read.

The reference adapter's current fixed storage reason is `size_unavailable`. SDK accepts that code or null, never arbitrary storage-error prose; unknown size/limit requires the fixed reason. Adding a new diagnostic reason is a deliberate wire-contract update. New auth and diagnostics timestamps are canonical UTC ISO instants with milliseconds; impossible calendar dates are malformed responses.

## SDK and CLI mapping

SDK methods: `auth.status(platform?, options?)`, `auth.set(platform, credential, {expectedRevision,...requestOptions})`, `auth.connect(platform, {expectedRevision,...requestOptions})`, `auth.operation(platform, id, options?)`, `auth.complete(platform,id,{expectedRevision,target?},options?)`, `auth.refresh(platform,{expectedRevision,...requestOptions})`, `auth.remove(platform,{expectedRevision,...requestOptions})`, `diagnostics(options?)`.

All new SDK auth mutations, including connect, require an explicitly observed revision. Optional expectedRevision on the HTTP endpoint exists for legacy clients; it does not permit a new SDK to omit the revision. This clarifies the earlier illustrative optional connect-options signature in favor of design section 7.5.

SDK publicly declares its own wire types and runtime validation. `operation` context distinguishes posts.create, auth.set/connect/complete/refresh/remove and reads. Malformed 2xx after any write preserves actual status and `requestMayHaveBeenApplied=true`; advice directs auth calls to status/operation rather than a new post key. Request transport supports GET/POST/DELETE only, deadlines and AbortSignal, with zero write retries.

CLI adds `auth status [platform]`, `auth set <platform>`, `auth connect <platform>`, `auth operation <platform> <id>`, `auth complete <platform> <id>`, `auth refresh <platform>`, `auth remove <platform>`, and `diagnostics`. Set consumes bounded secret JSON from stdin or explicitly named file. Target/config flags may carry public author/blog/API version only, never token/password fields. Set/complete/remove preview safe field names, target and observed revision, then TTY confirmation or --yes. Fetch revision before confirmation and submit the same revision; a conflict never automatically repeats the write. In non-TTY without --yes, write count is zero. Every --json command emits one object; createRequests counts only post writes and cannot stand in for total auth mutations. Doctor remains read-only and adds instance/platform readiness checks.
