# Syndroo 0.7.0 release manifest

Status: release prepared, not published. This document records the intended npm
release train and its verification boundaries. Registry availability is a
separate result.

## Packages

| Package | Version | Publication |
| --- | --- | --- |
| `@syndroo/provider-sdk` | `0.7.0` | public |
| `@syndroo/provider-bluesky` | `0.7.0` | public |
| `@syndroo/provider-threads` | `0.7.0` | public |
| `@syndroo/provider-linkedin` | `0.7.0` | public |
| `@syndroo/provider-mastodon` | `0.7.0` | public |
| `@syndroo/provider-devto` | `0.7.0` | public |
| `@syndroo/sdk` | `0.7.0` | public |
| `@syndroo/cli` | `0.7.0` | public |
| `@syndroo/server` | `0.7.0` | public |
| `@syndroo/cloudflare` | `0.7.0` | public |
| `@syndroo/core` | `0.7.0` | private; bundled only |

The public packages use dist-tag `latest` and Node.js engine `>=24.19.0`.
The Worker package is an artifact for user-owned deployment; this release does
not deploy it.

## Local CLI install target

```bash
npm install --global \
  @syndroo/cli@0.7.0 \
  @syndroo/provider-sdk@0.7.0 \
  @syndroo/provider-bluesky@0.7.0 \
  @syndroo/provider-threads@0.7.0 \
  @syndroo/provider-linkedin@0.7.0 \
  @syndroo/provider-mastodon@0.7.0 \
  @syndroo/provider-devto@0.7.0
syndroo --version
```

After installation, the packaged Agent Skill is under:

```text
$(npm root --global)/@syndroo/cli/skills/syndroo/SKILL.md
```

## Artifact gates

- Every public package carries `LICENSE` and `NOTICE`.
- CLI, Server, and Worker distributions carry
  `dist/THIRD_PARTY_LICENSES.txt`, generated from their actual esbuild inputs.
- CLI, Server, and Worker inline private Core and do not declare it as a runtime
  dependency.
- The CLI tarball contains `dist/`, `skills/`, `README.md`, `LICENSE`, and
  `NOTICE`.
- Local pack tooling creates exactly ten public tarballs and no Core tarball.
- The seven-package local installation includes the CLI, provider contract, and
  all five official providers.

## Initial publish for absent package names

npm Trusted Publishing cannot create a package name's first version. An
authenticated maintainer must perform an explicitly authorized initial publish
for each absent name, using the already gated tarballs in `artifacts/`. For each
package in dependency order, run the matching `npm view` immediately before
deciding whether its publish line may run. A returned `0.7.0` means that version
exists and **must not** be republished. An `E404` means the version is absent and
the matching publish is eligible.

```bash
# Run one preflight at a time; run its publish line only after confirming E404.
# Do not paste this entire block into a shell.
npm whoami

npm view @syndroo/provider-sdk@0.7.0 version
npm publish ./artifacts/syndroo-provider-sdk-0.7.0.tgz --tag latest

npm view @syndroo/provider-bluesky@0.7.0 version
npm publish ./artifacts/syndroo-provider-bluesky-0.7.0.tgz --tag latest

npm view @syndroo/provider-threads@0.7.0 version
npm publish ./artifacts/syndroo-provider-threads-0.7.0.tgz --tag latest

npm view @syndroo/provider-linkedin@0.7.0 version
npm publish ./artifacts/syndroo-provider-linkedin-0.7.0.tgz --tag latest

npm view @syndroo/provider-mastodon@0.7.0 version
npm publish ./artifacts/syndroo-provider-mastodon-0.7.0.tgz --tag latest

npm view @syndroo/provider-devto@0.7.0 version
npm publish ./artifacts/syndroo-provider-devto-0.7.0.tgz --tag latest

npm view @syndroo/sdk@0.7.0 version
npm publish ./artifacts/syndroo-sdk-0.7.0.tgz --tag latest

npm view @syndroo/cli@0.7.0 version
npm publish ./artifacts/syndroo-cli-0.7.0.tgz --tag latest

npm view @syndroo/server@0.7.0 version
npm publish ./artifacts/syndroo-server-0.7.0.tgz --tag latest

npm view @syndroo/cloudflare@0.7.0 version
npm publish ./artifacts/syndroo-cloudflare-0.7.0.tgz --tag latest
```

Each publish is conditional on its preflight. Stop on any unexpected result,
version conflict, or authentication error. After a package exists, configure npm
Trusted Publisher for that package with GitHub repository `Syndroo/syndroo` and
workflow `release.yml`; repeat this per package. Local `npm login` and
`npm whoami` authenticate the maintainer CLI only. They do not configure GitHub
OIDC, create package names, or establish package-level trust.

## Release prerequisites

- Check local maintainer authentication separately with `npm whoami`. The
  preparation session received HTTP 401; no credential was entered and no
  authentication retry was attempted. Local npm credentials do not authorize
  the GitHub OIDC workflow.
- For every absent package name, follow the authorized, preflighted maintainer
  path in [Initial publish for absent package names](#initial-publish-for-absent-package-names).
  Never republish a version that already exists.
- After each package exists, configure its npm Trusted Publisher for the
  `Syndroo/syndroo` `release.yml` workflow. No long-lived npm publish token
  belongs in repository secrets for the OIDC workflow.
- Merge a reviewed release-preparation commit and create `v0.7.0` from it.
- Set repository variable `SYNDROO_PUBLISH_ON_RELEASE=true`, or dispatch the
  existing release workflow with `mode: publish`.
- Verify all ten public versions and a clean seven-package installation from the
  public registry before updating installation claims or the website product pin.

## Registry state at preparation

Read-only evidence on 2026-11-03 found only `@syndroo/cli@0.4.0-rc.1` available
from the public npm CLI and no `@syndroo/cloudflare` package. That evidence does
not establish the rest of the requested `0.7.0` train. Historical public
packages may exist; this document only classifies the `0.7.0` release.

## Verification boundaries

The product commit before release preparation,
`c606a64f0b0113612be6f2dc3fac037a7394c74a`, has successful remote CI evidence.
The release-preparation changes require their own build, tests, CI, and clean
installation. Fixture-tested provider and server behavior does not establish
live social-account acceptance, deployment, or npm publication.
