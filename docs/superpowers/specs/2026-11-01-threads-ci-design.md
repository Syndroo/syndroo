# Threads through Cloudflare Worker and CI

User direction: persistent Syndroo service on Cloudflare Worker owns SNS App authorization; CI submits content. First platform is Threads. Root owns architecture, security and acceptance; implementation is explicitly delegated to `opencode-go/deepseek-v4.1-flash`.

## Outcome

Connect one Threads account through a stable HTTPS Worker callback, keep credentials encrypted in D1, then submit a plain-text publication from CI and observe its final result. A repeated logical publication must use the same durable request identity and must not blindly publish again.

## Chosen approach

Use existing Core, Threads provider, SDK, Worker queue and D1 state. Port the existing server OAuth adapter to Web Crypto and an asynchronous structural attempt store, retaining Node server behavior. Add the D1 store and Worker wiring. Do not duplicate Core connect, confirmation, execution or idempotency logic.

Direct CLI execution in an ephemeral runner was considered and rejected as the primary path: it puts OAuth and durable state management back into CI. A separate Worker-only OAuth implementation would duplicate security logic; prefer sharing the existing adapter while testing both runtimes.

## Contracts

- Add optional `PUBLIC_ORIGIN`: canonical HTTPS origin, no credentials, path other than `/`, query or fragment. When absent, existing Worker behavior stays unchanged. When present, enable Threads OAuth only in this first slice; callback is exactly `${PUBLIC_ORIGIN}/oauth/callback/threads`.
- Keep existing Threads connect schema, including `options.redirectUri`. Remote helper generates that exact URI. Reject conflicting redirect input; do not infer the public origin from untrusted forwarding headers.
- App credentials arrive through the existing credential-input resume protocol over HTTPS and enter encrypted Core state. They do not enter CI, argv, previews or logs. No new deployment-level Threads App secrets are required for this slice.
- OAuth attempts use keyed state digests, scope/provider/session/revision/redirect binding, 15-minute maximum TTL and atomic single-use claims. Register attempts for both direct start-to-open-url and credential-resume-to-open-url. Replay of an existing Core result must retain the original OAuth state, never bind a fresh draft to an old authorization URL.
- Callback admission requires no deployment bearer, but requires valid state and binding. Callback data is staged through CredentialStore and StateStore.acceptCallback. No callback content or authorization code is printed. The client resumes `callback_complete` until Core reports the connected account.
- Add optional `CI_BEARER` and `CI_CONNECTION_ID` as a pair. CI key must differ from admin key. It authenticates as a distinct `threads-ci:<connectionId>` principal, may prepare/retry exactly one explicitly selected Threads connection, execute its own approval tokens, and query its own operation. Binding the principal to the configured connection also prevents old approvals from authorizing another account after configuration changes. It cannot connect/disconnect accounts, list connections, or query admin operations. Existing `API_BEARER` remains admin-only in the supplied workflow.
- Client helpers use `SYNDROO_URL`; bootstrap uses `SYNDROO_ADMIN_TOKEN`, `THREADS_APP_ID`, `THREADS_APP_SECRET`; publish uses `SYNDROO_TOKEN` and `SYNDROO_CONNECTION_ID`. Secret values come only from environment or a protected local environment file loaded by the invoking runtime, never flags.
- Publishing reads one strict `{ "text": "..." }` JSON file. Caller supplies a non-secret stable request ID, derived in the workflow from repository, content revision and target identity, not run attempt. Wrapper calls prepare, confirms only when explicitly invoked with `--yes`, executes the returned frozen approval and waits for terminal state. Replayed execution results go directly to status/wait, never another prepare with a fresh key.
- No automatic retries for unknown/partial/failed business results. CI exits success only for fully succeeded execution. Waiting timeout is nonzero and reports the operation ID; it does not cancel or republish.
- Provide a workflow template and bootstrap guide. Initial workflow is manual to make the first real publication intentional. No actual workflow dispatch or SNS post is authorized without a concrete account/content selection.

## Scope and constraints

Plain text, one Threads connection. Preserve other providers and protocol v1. No token-refresh scheduler, management website, batch/media support, new IAM framework, npm publication, push or production deployment in the implementation stage. Automatic refresh remains an explicit follow-up; this slice must surface expiry/reconnect failures.

Node >=24.19.0. TypeScript executable files. No runtime npm install, no new runtime dependencies, no Node imports in Worker bundle. Preserve source checkout's untracked notes/; use isolated scratch checkout. Sources/ remains read-only.

## Acceptance

1. Executed Worker fixture covers credential input -> authorization URL -> callback -> callback_complete -> bound Threads account, with no live service requests.
2. Wrong/expired state, mismatched origin/provider/session revision, duplicate parameters, forged callback_complete and parallel replay cannot produce a second token exchange or bypass authentication. Secret values do not appear in response/log output.
3. Node OAuth regression suite stays passing; D1 concurrent claim and lost-acknowledgement behavior has execution evidence.
4. CI credential cannot exercise admin operations or a different connection; cross-principal operation and approval access is rejected.
5. Client fixture covers success, durable pending, replay, failure, partial, unknown and timeout; rerun of a stable request does not generate new publication identity.
6. Required repository tests/checks and fresh Worker bundle/dry-run pass, or exact baseline/environment limitations are reported.
7. Live acceptance is separate: authenticated Cloudflare account, deployed Worker, registered Threads callback, user-authorized account and exact test content, then one resulting Threads post and a rerun with no duplicate.

## Known environment limits

Cloudflare CLI currently reports expired login that cannot refresh non-interactively. Meta documentation fetch returned 429; provider behavior remains based on existing verified fixtures and Meta's official sample. Do not claim live platform acceptance. Native DeepSeek override was accepted and recorded; no upstream billing trace is available.
