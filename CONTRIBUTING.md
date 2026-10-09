# Contributing to Syndroo

Thank you for helping improve Syndroo.

## Before opening a pull request

1. Open an issue before starting a large behavioral or architectural change.
2. Keep changes focused and preserve the protocol invariants described in
   [AGENTS.md](AGENTS.md) and the specs under
   [docs/superpowers/specs/architecture-v1/](docs/superpowers/specs/architecture-v1/).
3. Add or update tests for behavior changes.
4. Run, from the repository root:

   ```bash
   npm ci
   npm run build        # build all eleven v1 packages
   npm run check        # type-check and bundle assertions
   npm test             # per-package tests
   git diff --check
   ```

5. Documentation changes: keep the root `README.md` a local CLI operating guide,
   keep the self-hosted and Worker surface in
   [docs/remote-compatibility.md](docs/remote-compatibility.md), and keep
   [docs/testing.md](docs/testing.md) and
   [docs/releasing.md](docs/releasing.md) aligned with the real commands and
   unverified areas. Never claim a live validation, a published package or a
   deployment before one exists.

Release automation now belongs to architecture v1: `.github/workflows/ci.yml`
runs the v1 gates, and `.github/workflows/release.yml` validates the ten-package
train and publishes only after an operator opts in — repository variable
`SYNDROO_PUBLISH_ON_RELEASE` set to `true` on a release event, or a manual
dispatch with `mode: publish`. Add new acceptance gates to the workflow rather
than reintroducing the deleted pre-v1 scripts.

## Developer Certificate of Origin

Every commit must include a `Signed-off-by` line certifying the
[Developer Certificate of Origin](DCO).

Create it with:

```bash
git commit --signoff
```

Pull-request CI runs `npm run dco:check` over the branch's commit range, which
requires `SYNDROO_BASE_SHA` and `SYNDROO_HEAD_SHA` to hold full commit SHAs. There
is no bare local form of that command; locally, just use `git commit --signoff`.
Amend and force-push your contribution branch if a sign-off is missing; never
force-push repository `main`.

By contributing, you agree that your contribution is licensed under
Apache License 2.0. Do not submit code you do not have the right to contribute.

## Security reports

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security advisory reporting for this repository.
