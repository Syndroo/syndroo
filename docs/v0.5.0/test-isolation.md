# Worker test isolation

Root security decision for the remaining T9 test setup. The isolation/discovery/finite-runner slice is accepted after independent Node24 checks; see evidence/root-review.md and evidence/test-isolation.md. Main-suite RPC teardown remains unresolved after the third-attempt correction was disproved and reverted; four outside-scope type errors also remain open. This work does not grant another attempt for transport, D1, crypto/R2 or CLI command repairs.

The former main Worker Vitest configuration inherited production Wrangler configuration and had no outbound interceptor. It has been replaced with explicit synthetic bindings and a reviewed reject-all outbound service; the independent canary passed before the broader suite ran. Dedicated native configurations with their own outbound interceptor remain usable for their exact suites.

## Test configuration

Use explicit local test bindings and synthetic configuration. Never load local credential files or production account/resource settings through Wrangler. D1 migrations may be read from the immutable migration directory and applied only to disposable local test databases. Preserve the existing fixture queue semantics needed by legacy tests; no remote queue connection is permitted.

Every workerd test project must set an outbound service which handles only its fixture endpoints, rejecting every unrecognized request, with Cloudflare metadata fetching disabled. The main project's default outbound handler rejects all requests. Existing provider mocks may intercept earlier, but a missing mock must never make a real request. A fixed failure message must not contain the attempted URL, headers or body.

Separate the legacy/default tests from the dedicated crypto/R2, OAuth, runtime-dependency and HTTP-body projects. Every existing test must belong to exactly one appropriate project; dedicated native files must be included explicitly. Do not remove tests, add conditional skips, weaken assertions or silently omit a failing suite. Report known adapter and integration failures as failures, independently of successful isolation checks. One documented aggregate command must execute every project sequentially and preserve a nonzero outcome if any fails.

First verify outbound rejection through an isolated canary using the real configured handler, with no global fetch mock. Verify discovery inventory and local-only bindings before broader runs. A rejected outbound canary establishes the fixture behavior; it does not prove live-provider compatibility or retroactively establish absence of contact in the earlier ungated run.

## Finite watchdog

The accepted bounded-run helper terminates the owned child process group independently of optional diagnostics. At the deadline it sends SIGTERM, then SIGKILL after a bounded grace period even if diagnostic subprocesses hang. Diagnostic execution, output and the final process snapshot are bounded. Natural exit, timeout, spawn failure and signals preserve one latched terminal result. The helper does not print environment variables or unrelated process arguments. Child processes inherit the host environment; this is distinct from loading credential files as Worker bindings, which is prohibited.

Use disposable subprocess fixtures to prove natural child exit-code preservation, child spawn failure, timeout, hanging diagnostics and group cleanup. Diagnostics are optional evidence; their failure must never hold the test runner open. Do not kill unrelated processes.

## Acceptance

Root reviews configuration, fixture routing and subprocess cleanup, then independently runs the canary, discovery inventory and focused watchdog tests under bundled Node24. Broader Worker suites require the verified fail-closed setup and bounded execution. Node22 remains unverified until available. Runtime route cutover and the full120-gate product ledger remain separate acceptance work.
