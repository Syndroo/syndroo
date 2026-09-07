# Releasing Syndroo

`packages/cloudflare-worker/package.json` is the version source for public
releases. Stable Git tags and GitHub Releases use the matching
`v<major>.<minor>.<patch>` name.

Only `@syndroo/cloudflare-worker` is public. Core and platform adapter
workspaces remain private implementation details and are bundled into the
Worker artifact.

## Release checks

Before creating a release:

1. Update `packages/cloudflare-worker/package.json`.
2. Update `CHANGELOG.md` and release notes, including new D1 migrations, secrets,
   bindings, compatibility changes, and breaking changes.
3. Run:

   ```bash
   npm test
   npm run check
   npm run bundle
   npm run startup
   npm run build:package
   npm pack --workspace @syndroo/cloudflare-worker --dry-run
   git diff --check
   ```

4. Merge through `main`.
5. Create tag `v<version>`.
6. Publish a non-prerelease GitHub Release from that tag.

The release workflow validates the tag against the package version, rebuilds
and tests the repository, checks whether the exact npm version already exists,
and publishes only a missing version. It never publishes from
`workflow_dispatch`.

## npm trusted publishing

The release workflow uses npm trusted publishing. It does not use an npm token.
Configure `@syndroo/cloudflare-worker` on npm with:

- provider: GitHub Actions;
- organization: `Syndroo`;
- repository: `syndroo`;
- workflow filename: `release.yml`;
- direct `npm publish`: allowed.

Trusted publishing requires an existing npm package. Bootstrap the package with
one reviewed manual publication, then configure the trusted publisher before
later releases. If the bootstrap version already exists when its GitHub Release
is created, the workflow detects it and exits without publishing a duplicate.

Never store an npm publish token in repository secrets after trusted publishing
is configured.

## First-release bootstrap

There is no package for npm to attach a trusted publisher to before the first
publication. For `0.1.0` only:

1. Review and merge the package, license, release workflow, and documentation.
2. Run every release check above from the exact `main` commit.
3. Publish `@syndroo/cloudflare-worker@0.1.0` manually with npm two-factor
   authentication. Do not use a long-lived automation token.
4. Configure the trusted publisher on npm using the values above.
5. Create the matching `v0.1.0` tag and non-prerelease GitHub Release. The
   workflow will detect the existing npm version and will not publish it again.
6. In `Syndroo/syndroo-deploy-template`, run `npm install`, commit the generated
   lockfile, run `npm run check`, `npm run bundle`, and `npm run startup`, then
   publish that repository.
7. Verify its Deploy to Cloudflare flow, then change this repository's deploy
   button to the template URL.

Steps 3-7 change remote state and require explicit maintainer approval. This
repository does not automate first-package creation or repository creation.

## Release compatibility policy

- Patch and minor releases must not add a required secret or binding.
- Required secret or binding changes are breaking changes.
- Published D1 migrations are immutable and remain in every later package.
- Migrations must preserve compatibility with the previous deployed Worker so
  a failed code deployment does not leave the database unusable.
- Releases are never published from a fork.
