# Server CLI and user-owned deployment repositories

Status: user approved full design on 2026-11-02. Implementation in progress; commands below are not yet claimed implemented.

## Goal and accepted choices

Extend the existing Syndroo CLI so a person or agent can generate and operate their own Cloudflare deployment repository without copying Syndroo source. First complete path: Threads OAuth and manual GitHub CI publishing.

- One `syndroo.config.jsonc` owns application settings. `wrangler.jsonc` owns Cloudflare resource configuration.
- `server init <directory>` creates a local repository. Only explicit `--github owner/repo` creates a remote and pushes. Skill asks whether GitHub is wanted before selecting this option. Private by default; public requires explicit selection.
- Existing remote names cause a safe stop; never overwrite or force-push. Preserve local results after remote failure.
- Independent commands: `server init`, `server doctor`, `server deploy`, `server connect threads`, `server ci setup github`. Skill orchestrates these; no separate all-in-one setup command.
- Normal configuration and secret references may be tracked. Secret values must not enter Git, command arguments, logs, JSON results or error messages. Users do not manually maintain secret files.
- Repeated commands preserve existing resources, data and encryption keys. Account authorization and browser login remain human actions. Setup never publishes a test post.

## Approaches

1. Skill wrapping existing monorepo instructions: smallest documentation change, but retains source builds, fragmented setup and unreliable recovery. Rejected in discussion.
2. Thin user repository plus reusable CLI commands and a coordinating skill: selected. Reuses Worker artifact and existing connect/publish protocol, makes recovery testable, and serves humans and agents alike.
3. One all-in-one setup command: unnecessary second orchestration path for the first version. User accepted independent commands instead.

## Repository and distribution

Generated repository contains application config, Wrangler config, private package manifest, exact dependency pins and lockfile, ignored local metadata, Git ignore rules, and a sample post. GitHub workflow is installed by CI setup, not silently activated by init. Do not copy product source or bespoke publishing helpers into each user repository.

Worker artifact comes from `@syndroo/cloudflare`; management and publishing tools ship with `@syndroo/cli`, reusing `@syndroo/sdk` and the existing Threads helper logic. Existing CLI commands are local-only. Add `server publish threads` as a narrow wrapper of the existing remote SDK flow, taking origin and connection from project config and scoped CI token from safe input/environment. It retains explicit publication confirmation and stable request identity. CI invokes the installed CLI, never repository-relative product scripts. Ship template assets in the CLI artifact; resolve pinned project-local Wrangler without shell interpolation. GitHub CLI is an external doctor-checked prerequisite only for GitHub operations.

Distribution acceptance uses locally packed artifacts installed into a disposable external directory. Public installation requires a verified published version; package publication is a separate authorized release, never implicit in init. If selected packages are unavailable, return an actionable error rather than silently using latest/source checkout.

## Configuration ownership

`syndroo.config.jsonc` has a versioned strict schema: public server origin (absent until first deployment), application scope, Threads App ID when supplied, and a named Threads connection reference after authorization. Secrets are represented by fixed named references, not user-supplied shell expressions. Avoid provider toggles and unrelated future-platform options.

`wrangler.jsonc` owns Worker name, compatibility, D1, queues, cron and public egress settings. Derive application environment bindings from Syndroo config at deployment, including PUBLIC_ORIGIN, SCOPE and CI connection mapping; never ask users to maintain duplicate values in both files. Derived queue environment values come from Wrangler queue declarations. Conflicting owned values fail validation with a specific repair instruction.

Use `server --project <directory>`, defaulting exactly to the current directory; never search parent directories. Resolve only that project's named config files. This is separate from existing local publishing `--config` and does not alter its absolute-path/XDG behavior. Server commands use a separate lazy context, never initialize the local publishing runtime, and use a `server` JSON operation plus a subcommand discriminator. The bounded JSONC loader rejects duplicate/unknown keys and preserves comments on atomic updates. Account-specific generated resource IDs and transient deployment state stay ignored, consistent with existing repository policy. Generate an ignored effective Wrangler file from tracked resource configuration, app settings and verified state; resolve relative paths against the original project. This generated file is never user-maintained.

## Command behavior

### init

Validate directory, repository name and options before mutation. Create only an empty/new destination; preserve unrelated files and existing Git history. Generate template and initialize Git locally. A repeat against a recognized generated repository reports current state instead of overwriting edits.

GitHub creation uses authenticated GitHub CLI tooling, with preflight before remote effects. Explicit --github authorizes creating that named repository and the initial safe push. Stage only generated allowlisted files, never `git add .`. Preserve required contribution sign-off behavior. Remote creation success followed by ambiguous/failed push must retain local recovery metadata; inspect remote identity and branch state before resuming. Do not treat an unrelated same-name repository as resumable.

### doctor

Read-only checks: schema, dependency versions, installed tools/auth, configuration consistency, configured Worker health and required resource/secret presence where authorized access exists. No repairs, installs, generated keys or resource creation. Distinguish local checks from authenticated remote checks and unavailable checks. `/health` proves liveness only, not durable storage, OAuth or publishing readiness.

### deploy

Preflight selected account, Worker identity, resource bindings, tooling and package availability; show target and intended mutations. Use explicit deployment authorization from caller/skill; no deployment as a side effect of init/doctor.

Provision only missing resources with expected ownership, then deploy the bundled Worker. Preserve existing databases, queues, application state and secrets. Resolve canonical HTTPS origin from deployment; on first deployment apply the resulting origin before reporting OAuth readiness. Custom origin requires verification, not inference from untrusted Host headers. Update local application config with confirmed origin.

Handle first-deploy secret provisioning and subsequent updates distinctly. Record completed steps atomically so interruption can be reconciled with remote reality. Do not add an extra recovery daemon or background process. No destructive rollback after partial failure; report created resources and exact remaining step.

### connect threads

Use existing Core/SDK OAuth flow and canonical callback `/oauth/callback/threads`. Display exact Meta callback registration requirement. App ID can be stored in app config; receive App Secret through hidden prompt or safe input channel. Output authorization URL as an explicit user-action result. Never accept arbitrary callback targets or weaken state validation.

Bounded waiting returns connection reference only after verified completion. Persist reference to application config. Reconnect is explicit when credentials expire; setup does not add token refresh. Preserve existing helper behavior for uncertain outcomes and redacted failures.

### ci setup github

Require a connected Threads account and explicit target repository. Install a manual workflow and sample content path without auto-triggering a publication. Create/update GitHub environment settings with a scoped publishing credential; never upload admin/internal keys to GitHub. Configure Worker CI_BEARER and CI_CONNECTION_ID together.

Workflow uses stable publication identity and existing prepare/execute/status semantics, and rerunning the same logical publication must not duplicate a post. Existing unrelated workflows/secrets must be preserved; conflicting managed files stop with a useful diff. Local workflow creation is distinct from Git commit/push: report pending changes, and skill obtains or uses explicit authorization for publication of those changes.

## Secrets and recovery

Cloudflare secrets are not assumed readable after upload. CLI therefore cannot promise cross-machine recovery by downloading secret values. Use a CLI-managed private local credential store outside tracked repository content, with restrictive permissions, for admin/CI credentials needed by later commands and pending first-deploy keys. Users do not edit it. Bind entries to verified deployment identity; never use a credential solely because a matching project name exists.

First-version choice: a separate XDG state `syndroo/serverctl-v1` store, not the local provider credential store. Atomic files with mode 0600 under 0700 directories, ownership/symlink checks, and serialized mutations. This is permission protection, not encryption at rest; state this plainly. Bind records to a generated non-secret project identifier plus verified Cloudflare account/Worker identity. Do not implement a bespoke encryption scheme with a colocated key. Recovery is a hidden-input/import action within deploy, not an additional command family; unattended runs report action_required. A fresh clone alone cannot restore local secret values. Backup/recovery instructions are part of operator docs, and no recovery action may overwrite an existing deployment's encryption key.

Source: [Cloudflare secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/) states values are not visible in Wrangler or dashboard after definition; checked 2026-11-02.

Generate keys once for a new deployment; persist safely before first remote write. Clean pending material only after confirmed deployment. Retain encryption keys securely for recovery; never regenerate SECRET_KEY or RUNTIME_KEY merely because local credentials are missing. Existing remote resources with missing local credentials return an explicit import/recovery action. Rotation is outside first-version scope.

App Secret passes through the existing connect protocol and is encrypted server-side. Do not retain an unnecessary additional local copy. Secret uploads use safe stdin/API channels, not command arguments. Child-process output is bounded and redacted. No shell interpolation for repository names, paths, URLs or settings.

## Agent contract and skill

Each command supports `--json`: exactly one structured stdout envelope, stable result/error codes, safe next-action details, and appropriate nonzero exit for blocked/incomplete/failed execution. Diagnostics go to stderr. Noninteractive commands never hang on a hidden prompt or silently grant consent. Missing input identifies the precise next human action.

Update the existing shipped skill source to teach server workflow without breaking local publishing. It asks about optional GitHub creation, collects repository identity/visibility, invokes CLI, guides login/Meta registration/OAuth, and reports partial progress. Prior authorization remains effective within scope; no repeated permission prompts for retries of already-authorized actions. Production deployments and real posts still require explicit user authorization. Skill contains orchestration, not duplicate deployment implementation.

## Implementation scope and compatibility

Expected scope: CLI parser/help, server commands/config/credential storage, packaging/templates, shared reusable Threads client logic, CLI fixture tests, generated workflow, bundled skill, operator docs and repository guide updates. Preserve local connect/publish/status behavior, Worker auth restrictions, Core protocol, encrypted credential storage and publication idempotency. Do not introduce platform management into Core. Any Worker environment/config additions require aligned binding docs/tests.

## Acceptance

- External disposable repository can initialize from packed CLI/Worker artifacts with no source checkout dependency; exact versions and lockfile verified.
- Default init makes no GitHub mutation. Explicit GitHub mode respects visibility, ownership, collision handling, safe staging and interrupted push recovery in mocked fixtures.
- JSONC changes preserve unrelated configuration/comments; malformed/unknown/conflicting input fails safely.
- Repeated deploy preserves resource identities and keys; injected failures at resource creation, secret upload, deploy and config write recover without destructive action.
- Fixtures prove secret values absent from tracked files, argv, stdout/stderr and failure output; credential files have required permissions. Missing credentials on an existing deployment never rotate encryption keys.
- Connect and manual CI retain existing OAuth, scoped authorization and no-duplicate-publication tests. CI never receives admin credentials and setup never publishes.
- Built CLI help, JSON envelopes, skill and docs agree. Run focused tests, required repository checks, package installation smoke test and isolated Wrangler dry run.
- Real Cloudflare deployment, GitHub mutation and Threads publication are separate authorized acceptance steps; simulated success never labelled live-validated.

## Proposed defaults awaiting full design approval

Manual CI trigger initially; no automatic publish on content push. CLI-managed local credential store rather than user-maintained secret files. No automatic package upgrades, token refresh, key rotation, destructive resource cleanup, multi-provider expansion or GUI in first version.

## Builder review

Native child `01a19c4b-bcbe-70d0-950e-91e546e45e69`, explicitly invoked as `opencode-go/deepseek-v4.1-flash`, completed read-only review. Root reconciled six findings: distributable remote publishing entry, server parser/context/envelope boundary, explicit project path behavior, distinct credential lifecycle, durable resource IDs/effective Wrangler file, and template/tool packaging. No product code or live resources changed. These design choices still require implementation tests; review is not execution evidence.
