# Contributing to Syndroo

Thank you for helping improve Syndroo.

## Before opening a pull request

1. Open an issue before starting a large behavioral or architectural change.
2. Keep changes focused and preserve the reliability invariants in
   [AGENTS.md](AGENTS.md).
3. Add or update tests for behavior changes.
4. Run:

   ```bash
   export SYNDROO_RELEASE_SET=cli   # candidate versions are split
   npm test
   npm run check
   npm run e2e:cli-local            # local CLI packaging and workflow
   npm run bundle                   # Worker or Wrangler changes
   npm run startup                  # Worker imports or startup changes
   git diff --check
   ```

   The default `SYNDROO_RELEASE_SET=all` train stays strict and reports the
   current version mismatch by design; use the `cli` set while the candidate
   versions differ.

5. Documentation changes: keep the root `README.md` a local CLI operating guide,
   keep the retained remote path in
   [docs/remote-compatibility.md](docs/remote-compatibility.md), and keep
   [docs/testing.md](docs/testing.md) and
   [docs/releasing.md](docs/releasing.md) aligned with the real gates. Do not
   claim live validation or a published package before either exists.

## Developer Certificate of Origin

Every commit must include a `Signed-off-by` line certifying the
[Developer Certificate of Origin](DCO).

Create it with:

```bash
git commit --signoff
```

Pull-request CI checks every commit in the branch. Amend and force-push your
contribution branch if a sign-off is missing; never force-push repository
`main`.

By contributing, you agree that your contribution is licensed under
Apache License 2.0. Do not submit code you do not have the right to contribute.

## Security reports

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security advisory reporting for this repository.
