# CLI authorization implementation boundary

Root architecture decision supplementing public-api.md. This is a target contract, not verification evidence. Reuse the existing parser, Reporter, client factory, confirmation helper and exit-code model. No new CLI framework, browser launcher or secret store.

## Commands and revisions

Add the eight command families in public-api.md. `auth set <platform> --file <path|->` reads bounded secret JSON, defaulting to piped stdin when no file is named. TTY stdin without a file fails with guidance instead of echoing a password prompt. `auth complete` accepts only public `--author`, `--api-version`, and `--blog` target flags. All network commands use the existing environment-based instance/API-key configuration.

For set/remove, read the platform status, prepare a safe preview, obtain confirmation, and send exactly that observed revision. For complete, read both the operation and active status before confirmation. Submit the operation's expectedRevision, reject a current-slot mismatch locally for an unfinished operation, and preserve explicit replay of a completed operation even after the current slot changes. Never silently restart OAuth or change revision after a conflict. Connect/refresh also read and submit an observed revision, but the design's mandatory confirmation list remains set/complete/remove. Non-TTY set/complete/remove without `--yes` perform zero writes. A refused or unavailable prompt also performs zero writes.

The confirmation helper may accept a fixed command-specific prompt while preserving its existing post-create default. Preview only platform, public target, fixed credential field names and revision. No native credential JSON, callback state, operation ciphertext, binding material or raw provider error belongs in preview or error details. Show operation candidate separately from current active state.

## Secret and output boundaries

Read no more than 64KiB of secret JSON from the chosen input, with bounded chunk collection, cancellation and fixed parse/read errors. Reject arrays, null, primitives, unknown credential fields and control fields such as expectedRevision before sending. Register every submitted secret string with Reporter before any downstream validation or request; do not echo unparsed malformed input. Errors for invalid input paths are fixed and do not repeat the path or raw filesystem cause.

There are no token/password/secret command-line flags. Parser failures must not print rejected argument values: an unsupported `--token=sentinel` must not echo its value in either output stream. Safe diagnostics are primary; Reporter redaction is defense in depth. Preserve one valid JSON object even when a secret contains JSON escape characters. If Reporter changes are necessary, redact structured string values before serialization rather than replacing bytes in serialized JSON. Short secret values must also be covered without turning field names or structural keys into redacted text.

`--json` produces exactly one stdout object on success, cancellation, usage failure, conflict, abort and ambiguous write. Human preview, prompts and progress stay on stderr. `createRequests` continues to count post creation only; auth commands use their own truthful write-request count. Ambiguous auth failures advise status/operation inspection, never a new post idempotency key or blind refresh retry. Cancellation advice follows the command that ran. Generated diagnostics do not expose parsed caller-owned post snapshots.

## Authorization URL

Only connect's interactive result may print the provider URL. Validate HTTPS, no userinfo/fragment/non-default port, exact host/path and bounded query before display. The currently configured provider endpoints in this repository are:

| Platform | Authorization endpoint | Expected query keys |
| --- | --- | --- |
| x | https://api.twitter.com/oauth/authorize | oauth_token |
| tumblr | https://www.tumblr.com/oauth/authorize | oauth_token |
| linkedin | https://www.linkedin.com/oauth/v2/authorization | response_type, client_id, redirect_uri, state, scope |

Reject duplicate/unknown query keys and control characters; require protocol-required fields. LinkedIn response_type is code and redirect_uri must be an HTTPS callback URL without userinfo/fragment. Treat the URL as display data; do not execute any browser or shell command. No URL or credential values in saved test evidence.

## Verification scope

Run existing CLI tests plus real-process TTY/non-TTY fixtures for cancellation, stale revision, secret input boundaries, unsupported secret flags, short/escaped sentinel redaction, URL rejection, one-object JSON and command-aware ambiguity. Instrument all HTTP methods; counting only post creates cannot prove auth zero-write behavior. Remove the historical CLI keepalive only after the accepted standalone SDK wait evidence, then repeat real CLI wait success/timeout/abort with a finite parent watchdog and no replacement keepalive.

Doctor remains read-only and adds instance/platform readiness using auth.status. Local readiness never claims real-account or publish verification. SDK/CLI installed-artifact and isolated Worker lifecycle gates remain separate from loopback command tests. Shipped Skill updates follow the completed command contract in a separate bounded scope.

Doctor may report readiness unavailable for a legacy server's 404/405 response. Other readiness failures, including an aborted request or malformed successful response, remain failures; do not silently treat them as compatibility fallback. Secret-input cancellation uses the CLI's interrupted exit and fixed ABORTED code. Abort, overflow and read failure must release the input stream and pending iterator work, so a pipe held open by the parent cannot keep the CLI alive. Safe auth read/write attempt counts must survive error output as well as success/cancellation; they do not claim the number of server-side changes.
