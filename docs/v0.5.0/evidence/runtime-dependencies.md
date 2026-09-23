# Task 6d1 evidence — lazy runtime dependency composition

Status: **T6d1 attempt 1 complete for review.** Owner: T6d1 scope only (the six
files listed below). No product acceptance ID is claimed:
`docs/v0.5.0/acceptance-results.json` remains3PASS/117NOT_RUN with no promoted
gate for this slice, because this slice proves
composition order and wiring against the accepted application use cases and the
current concrete cipher/HMAC adapters — it does not resolve the separately
exhausted T4 boundary evidence, and it adds no route wiring.

## 1. Files, runtime, commands

```text
packages/cloudflare-worker/src/composition/runtime-dependencies.ts        (new)
packages/cloudflare-worker/test/runtime-dependencies-v050.native.ts      (new)
packages/cloudflare-worker/test/runtime-dependencies-v050.vitest.config.ts (new)
packages/cloudflare-worker/test/support/runtime-dependencies-v050-fixtures.ts (new)
packages/cloudflare-worker/test/support/runtime-dependencies-v050-worker.ts   (new)
packages/cloudflare-worker/test/support/runtime-dependencies-v050-tsconfig.json (new)
docs/v0.5.0/evidence/runtime-dependencies.md                             (new, this file)
```

| Item | Value |
| --- | --- |
| Worktree | `/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050` |
| Runtime | Node `v24.19.0` (bundled), Vitest `4.1.11` |
| App dependency | accepted `@syndroo/application` build (contracts, ports and the exported use cases `createPreparePublisher`, `createPost`, `setDirectCredential`, `removeDirectCredential`, `completeOAuthOperation`, auth errors) |
| Unchanged | application package, frozen contracts/ports/fake, `src/index.ts`, D1, crypto/R2/transport adapters, scheduler, manifests, input docs |

```bash
# scoped type check: exactly the new files plus their real dependencies
tsc -p test/support/runtime-dependencies-v050-tsconfig.json            # exit 0, zero errors, no suppressions

# dedicated native project (own fail-closed outbound service, exactly this file)
vitest run --config test/runtime-dependencies-v050.vitest.config.ts    # 1 file, 16 tests passed (07:01:34 run, 2.24s)
```

The native run needed only the already-documented local loopback escalation:
the Cloudflare vitest pool listens on `127.0.0.1`, which the sandbox blocks with
`EPERM`. The project's `outboundService` throws on any egress, and the
composition makes no request.

Broader Worker compile state, recorded and deliberately not fixed:

```text
tsc -p tsconfig.json --noEmit        # exit 1: 2 pre-existing errors in src/platform-descriptors.ts (LINKEDIN_CLIENT_ID/SECRET not in keyof Env)
tsc -p test/tsconfig.json --noEmit   # exit 1: the same 2 plus 2 pre-existing spec type errors (crypto-v050.spec.ts:268, r2-v050.spec.ts:144)
```

The scoped tsconfig avoids that unrelated graph on purpose: it uses
`@cloudflare/workers-types` for the Web globals and excludes
`worker-configuration.d.ts`, which imports the legacy Worker entry tree.

## 2. What was implemented

`createRuntimeDependencies({ credentials, values })`:

- copies the allowlisted plain-string configuration **once** into a frozen map
  and never retains the caller's object; every allowlisted name is read at most
  once (deduplicated with a `Set`, test-enforced)
- copies only: the three crypto settings
  (`SYNDROO_CREDENTIAL_KEY`, `SYNDROO_CREDENTIAL_KEY_ID`,
  `SYNDROO_BINDING_KEY`), `SYNDROO_PUBLIC_URL`, the accepted
  `platformConfigKeys` publishing names and the accepted OAuth app field lists
  (`X_APP_FIELDS`, `TUMBLR_APP_FIELDS`, `LINKEDIN_APP_FIELDS`); the API key and
  unrelated bindings are outside the list and never copied
- performs no key validation, storage, queue, provider or network work at
  construction time
- exposes lazy `getReadCipher` (credential key + key id only), `getWriteCipher`
  (additionally proves the independent binding key) and a `bindingSigner` whose
  first `sign` validates both configurations, then delegates to the accepted
  HMAC signer; every successful adapter — the AES cipher and the HMAC delegate —
  is frozen and cached at this composition boundary, so identity is stable and
  methods cannot be replaced through the returned objects
- delegates preparation to the **accepted** `createPreparePublisher` closure
  with `getCipher: getReadCipher`, the accepted `platformStrategyRegistry` and
  the composed `configFor`; no read, AAD, blocked-status or error policy is
  duplicated here
- reports instance readiness as `{ publishingReady, missingFields }` with the
  three fixed setting names only; a missing public URL affects OAuth connect,
  not publishing readiness
- provides a fresh canonical UTC clock and UUID-based opaque id hooks for
  publishing and execution identities; no `Env` object crosses to application
  code

`configFor` reuses the accepted `platformConfigView`, so the copied strings are
trimmed and frozen by the accepted code and the public origin is parsed by the
accepted `parsePublicOrigin`.

## 3. Behaviour covered by the native suite (16 tests)

| Required behaviour | Test |
| --- | --- |
| Construction with no keys touches no port and reports the three fixed names | `constructs without keys and touches no port` |
| Only allowlisted names are copied once; unrelated secrets never appear; caller mutation cannot change the capture | `copies only allowlisted names, once, and never echoes unrelated secrets` |
| Public URL stays out of publishing readiness | `keeps the public URL out of publishing readiness` |
| Absent/malformed keys keep the Env path (status, admission, replay) and fail cipher use closed | `keeps the Env path available with absent or invalid keys and fails cipher use closed` |
| Active unreadable slot stays selected (no Env fallback); the owning key reads it | `blocks an unreadable active slot and never falls back to Env` |
| Accepted `removeDirectCredential` with no key: 1 CAS, 0 slot reads, 0 cipher lookups, tombstone projects Env | `removes through the accepted use case with no key and exactly one CAS` |
| Accepted `setDirectCredential` fails before any mutation (write cipher gate) | `fails an accepted direct set closed before any mutation` |
| New create against an active D1 slot fails before write/enqueue/provider | `fails a new create closed before any write, enqueue or provider effect` |
| Env-ready create with only the binding key missing reaches the signer and fails there (`INSTANCE_NOT_READY`, 0 rows/queue) | `fails an Env-ready create at signing when only the binding key is missing` |
| Accepted `createPost` replay with absent keys and delegating counted callbacks: 0 prepare/sign/queue | `replays an accepted create without consulting prepare, signing or the queue` |
| Accepted `completeOAuthOperation` replay with an absent-key composition: stored receipt with `replayed: true`, 0 activation, 0 cipher/driver/binding lookups | `replays a completed authorization without activating again and needing a key` |
| Real AES-256-GCM round trip, AAD binding, real HMAC digest stability, frozen cached adapters | `drives the real AES-256-GCM cipher and HMAC signer with valid keys` |
| Read cipher usable without the binding key; write/sign fail | `keeps the read cipher usable when only the binding key is missing` |
| Accepted store failure is controlled and sentinel-free (`STORE_UNAVAILABLE`, no Env fallback) | `reports a failed slot read as a controlled, sentinel-free failure` |
| Corrupt active slot keeps accepted blocked semantics (source `mixed`, `oauthSupported: true`) | `keeps accepted blocked-status semantics for a corrupt active slot` |
| Every allowlisted configuration name is read at most once | `reads every allowlisted configuration name at most once` |

Fixture note: two synthetic base64 keys in the first draft were not canonical
encodings (the final character must encode zero trailing bits) and the strict
accepted decoder rejected them. They were corrected, which is why the fixture
values are `A…=`, `E…=`, `I…=`.

## 4. Limits and unresolved items

- **T4 boundary evidence stays exhausted.** The ciphers and HMAC signer are used
  here to prove composition order; this evidence does not resolve or re-open the
  separately exhausted T4 interop/boundary scope.
- **No route wiring.** HTTP handlers, OAuth connect/callback routes, admission
  and the queue/maintenance entry points are not touched: only the composition
  factory and its native tests are in scope.
- **Legacy Worker compile errors recorded, not fixed:** the two
  `src/platform-descriptors.ts` `Env` errors (and the two pre-existing spec type
  errors) remain outside this slice's ownership, so the Worker-wide `check`
  still fails on them.
- **Application package unchanged.** The current application suite baseline is
  root's (313 tests); this slice imports only already-exported use cases, and
  the native suite proves resolution and behaviour through them.
- **Runtime gates not claimed:** HTTP/Queue/Cron mapping and the full isolated
  Worker suite still require local verification. Production deployment and
  real-account compatibility remain separate unverified work. This evidence
  establishes none of those gates.
