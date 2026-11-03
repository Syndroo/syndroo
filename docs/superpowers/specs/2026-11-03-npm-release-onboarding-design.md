# Syndroo 0.7.0: npm release and onboarding

Status: approved by the user; npm distribution selected and development authorized.

## Outcome

Users install compiled Syndroo packages without cloning or building the product.
Both English and Chinese websites offer installation and an Agent setup entry.
English remains the default. Existing URLs remain valid.

## Approaches

- Selected: npm packages, using the existing release train. Requires Node.js
  24.19+ and macOS/Linux for supported local writes.
- Deferred: standalone native binaries. These require a new packaging and
  platform-validation path and are unnecessary for removing source builds.

## Installation

Publish the existing ten public packages at 0.7.0 under `latest`; keep Core
private. Preserve the existing explicit provider discovery and trust model.
Do not add an umbrella package or runtime plugin downloads in this release.

The default website install snippet is one copyable npm command installing CLI,
provider-sdk, and all five official providers, pinned to 0.7.0. Long commands
may wrap visually, but copying must yield an executable command. Explain only
that the command installs Syndroo and its official platform plugins.

The self-hosted Server guide may use CLI-only installation. `server init`
continues to install CLI, Cloudflare, and Wrangler in the generated user project.
All required public package versions must exist before advertising this flow.

## Website and Agent entry

Replace the main source-build CTA with **Install Syndroo / 安装 Syndroo**.
It leads to an on-page installation section with prerequisites, the copyable
command, and `syndroo --version` for verification. Keep source builds as a
secondary contributor path in the docs.

Add **Set up with an Agent / 交给 Agent 设置** alongside it. This leads to a
copyable setup prompt and the Agent guide. The prompt instructs a local-shell
Agent to verify prerequisites, install the pinned packages, read the bundled
`skills/syndroo/SKILL.md` under the installed CLI package, and continue with
the user's requested local or Server workflow. Locate the global package via
`npm root --global`; do not invent a `syndroo skill install` command or claim
automatic activation in every Agent client.

For Server setup, the Agent asks whether GitHub is wanted; it creates/pushes a
repository only when explicitly requested. Existing authorization is reused.
Keep secrets out of prompts, arguments, logs, and tracked files. Publishing
content still requires authorization for that content and destination.

Update bilingual homepages, installation/Agent/Server docs, shared version
metadata, relevant README/agent guidance, and tests. Other docs only change
where obsolete build-only or unreleased claims would contradict the release.

## Release sequence

1. Review the existing uncommitted Server CLI work and preserve unrelated work.
2. Align versions, internal pins, generated catalogs, changelog and notices.
   Generate the required third-party license inventories in published artifacts.
3. Run product checks and package tests; install packed artifacts into a clean
   temporary npm prefix outside the checkout. Verify version, provider discovery,
   bundled Skill and Server initialization without real deployment or posting.
4. Prepare release notes and exact package/version manifest. Verify npm publishing
   prerequisites through the existing workflow; report any external setup blocker.
5. Publish the reviewed 0.7.0 release through the authorized release workflow.
   Do not claim availability before registry verification.
6. Verify public-registry installation, then publish website installation claims
   and update its CI product pin to the corresponding available product commit.

Website changes can be prepared and tested before package publication, but must
not go live with unavailable commands. Public package publication is a distinct
external action; prepare a concrete release result before any needed final approval.

## Acceptance

- Clean install requires no product checkout or user build step.
- CLI version is 0.7.0; five official providers are discoverable with expected
  trust state; the shipped Skill and references are present and usable.
- Generated Server project resolves exact released dependencies, passes its
  artifact smoke checks, and supports Wrangler's deployment dry-run.
- Both website languages provide working copy actions, installation guidance,
  Agent prompts, and mobile layouts; documented commands match the shipped CLI.
- Product and website checks pass. Registry availability, fixture evidence and
  live-account evidence remain distinct in docs and release notes.

## Limits

No native executable, universal Agent installer, production Worker deployment,
or real social post is included. Unverified live-account behavior remains stated;
publishing a package alone does not establish live platform acceptance.
