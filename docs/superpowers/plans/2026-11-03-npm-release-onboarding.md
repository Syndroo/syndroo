# Syndroo 0.7.0 npm release and onboarding Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development; project delegation rules and existing execution authorization take precedence.

**Goal:** Deliver installable 0.7.0 npm artifacts and bilingual install/Agent onboarding without source builds.
**Architecture:** Existing ten-package release train, private bundled Core, explicit official provider installation. Prepare website locally until public installation works.
**Tech Stack:** TypeScript, npm workspaces, Next.js static export, GitHub Actions.
**Spec:** ../specs/2026-11-03-npm-release-onboarding-design.md (approved).

## Global Constraints
- Node.js >=24.19.0; macOS/Linux local writes. Version0.7.0, dist-tag latest.
- No native binaries, umbrella package, runtime provider downloading, real deployments or social posts.
- Preserve existing Server CLI changes. Root owns review, external release decisions and final acceptance.
- Exact native opencode-go/deepseek-v4.1-flash; two independent repository writers maximum; three attempts per subtask. No nested delegation or CLI drivers.
- Never claim registry availability or live account verification without evidence.

## Review Focus
- Installed CLI must find all five providers outside the checkout (Task1 smoke).
- Bundled private modules must not leak runtime dependencies (Task1 bundle/pack gates).
- Skill links and install snippets must resolve from actual package layout (Task2+3 verification).
- Server initialization must install exact public versions without a source checkout (Task3 artifact smoke).
- Website must not advertise unpublished packages; preserve current live site until release (Task4 ordering).

### Task1: Product release preparation
**Files:** root/package manifests and lockfile; scripts/bundle-v1-{cli,server,cloudflare}.ts; scripts/generate-package-licenses.ts and existing license helpers/tests as necessary; packages/*/NOTICE; generated provider catalog; CHANGELOG.md; README.md; docs/releasing.md, agent-quickstart.md, cli-manual.md; packaged Skill docs; .github/workflows/release.yml only for verified packaging gates.
**Produces:** coherent0.7.0 packages, generated license inventories, complete release notes, artifact/install test evidence; no publication.
- [x] Inspect current package and license checks before modifications.
- [x] Align manifests/internal pins/generated version claims; retain historical version fixtures when intentional.
- [x] Reuse existing license tooling in artifact builds; test required inventories ship with bundles.
- [x] Update product install guidance and release notes without false publication/live claims.
- [x] Run focused checks/build/package tests; report exact changed files and unresolved blockers.

### Task2: Website install and Agent onboarding
**Files:** syndroo-web packages/content/site-data.ts; apps/website/app/(en)/page.tsx and (zh)/zh/page.tsx; shared header/footer/behaviors/styles; affected bilingual docs; tests/content.test.ts, docs-commands.test.ts and focused interaction tests; README.md, AGENTS.md.
**Consumes:** fixed0.7.0 package names, seven-package install, bundled skills/syndroo path.
**Produces:** prepared unpublished website updates, copyable install/Agent sections, consistent bilingual docs and checks.
- [x] Replace main source-build CTAs with Install and Agent setup links.
- [x] Add copyable installation and Agent prompts using existing styling/behavior patterns.
- [x] Update obsolete unreleased/build-only claims and tests; retain honest live-verification caveats.
- [x] Keep mobile menu scroll fix and locale routing intact; no dependencies.
- [x] Build and check website; root runs command contract against final product build.

### Task3: Root release verification
- [ ] Review both changes and existing Server CLI acceptance record; obtain independent scoped review of release-critical changes.
- [ ] Run product build/check/tests/release-tooling/provider-catalog/pack gates, then clean-prefix install and Server artifact smoke.
- [ ] Verify npm publishing prerequisites read-only; create concrete release manifest and notes.
- [ ] Run website build/check/tests against0.7.0 CLI and CUA install/copy/Agent/mobile checks.

### Task4: Authorized release and website rollout
- [ ] Commit reviewed product changes with DCO, integrate available release commit, publish through existing authorized workflow. Stop only for concrete missing external authorization/setup.
- [ ] Verify all required public versions and clean public npm install. Do not deploy Worker or post content.
- [ ] Update website CI pin to actual product commit; push website only after install availability confirmed.
- [ ] Record completed evidence, actual release URLs and remaining live-account limitations.

## Acceptance record (2026-11-03)

- Product: build/check/tests 11/11, release scripts186/186, ten packs, catalog and release metadata pass.
- Root: temporary-prefix install finds five official0.7.0 providers and bundled Skill; external Server init/doctor/import and Wrangler dry-run pass.
- Website: bilingual build/check and48tests pass; final Server-install paragraph is under final build verification. CUA confirms EN/ZH copying,390px no overflow, sidebar reaches bottom and navigates.
- Independent scoped review: package metadata/inventories consistent; missing manual Server installation corrected. Initial npm publish requires maintainer auth; OIDC setup alone cannot create missing package names.
- npm authentication401 unresolved. No npm publication, Worker deployment, OAuth or social post performed. Website rollout and its new product CI pin wait for verified public installation.
