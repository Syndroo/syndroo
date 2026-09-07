# Contributing to Syndroo

Thank you for helping improve Syndroo.

## Before opening a pull request

1. Open an issue before starting a large behavioral or architectural change.
2. Keep changes focused and preserve the reliability invariants in
   [AGENTS.md](AGENTS.md).
3. Add or update tests for behavior changes.
4. Run:

   ```bash
   npm test
   npm run check
   npm run bundle
   npm run startup
   git diff --check
   ```

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
