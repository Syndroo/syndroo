# Legacy CLI fixture: @syndroo/cli 0.6.0-rc.1

`old-cli-0.6.0-rc.1.tgz` is the packed `@syndroo/cli` `0.6.0-rc.1` candidate
artifact, supplied with the project and stored here so the state-upgrade
compatibility test is self-contained.

- Package: `@syndroo/cli`
- Version: `0.6.0-rc.1`
- SHA-256: `b7805913fe3c8857f4c50699cf227d3c8f8ac56516880621e29ffe887f9d96d7`
- Provenance: the tarball shipped with the Syndroo R3 integration inputs; it was
  not rebuilt, refetched, or modified during integration.

`packages/cli/test/local/state-upgrade.test.ts` extracts this tarball and runs
its real `dist/bin.js` as a child process; the legacy executable is executed,
not mocked or skipped. The checksum above identifies the fixture bytes only and
is not a claim about any historical test report.
