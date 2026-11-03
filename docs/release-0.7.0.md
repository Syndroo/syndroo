# Syndroo 0.7.0 release manifest

Status: published. This document records the npm release train and its
verification boundaries.

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

## Local CLI installation

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

## Initial publication for absent package names

npm Trusted Publishing cannot create a package name's first version. The
`0.7.0` train was bootstrapped from the gated tarballs in `artifacts/`. All ten
public package publish commands were accepted under `latest`. The audit
sequence below is retained for the release record; do not run it again for
`0.7.0`.

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

Each publish was conditional on its preflight. Do not republish an existing
`0.7.0` version. Trusted Publisher configuration is separate from the initial
bootstrap and must be checked before a future OIDC release.

## Publication record

- All ten public package publish commands were accepted by npm under `latest`.
- All ten public versions, `latest` tags, and artifact integrity values were verified.
- A clean seven-package public installation passed with all five providers available.
- Public CLI installation, Server initialization, and read-only doctor passed outside the source checkout.
- Trusted Publisher settings and future release automation are separate from
  the accepted initial publication.
- No Worker or server has been deployed, and no live account has been used.

## Registry state at preparation

Read-only evidence before publication on 2026-11-03 found only
`@syndroo/cli@0.4.0-rc.1` available from the public npm CLI and no
`@syndroo/cloudflare` package. The ten `0.7.0` publish commands were then
accepted under `latest`; independent public installation subsequently passed.

## Verification boundaries

Release-preparation commit
`c656b5ec999bb8363e0f63451df492b825d4ba2f` has successful Linux and macOS
remote CI evidence. Documentation checks and clean public-registry installation passed. Fixture-tested provider and
server behavior does not establish live social-account acceptance or deployment.
