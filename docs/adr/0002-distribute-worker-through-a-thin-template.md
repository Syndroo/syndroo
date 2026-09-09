# Distribute the Worker package through a thin deployment template

Deployment copies of the source repository have no automatic upstream update
channel, and merging whole-source upgrades makes user customization harder to
preserve. Syndroo will distribute one public Worker package with bundled private
adapters and a thin deployment template using exact package versions and a
lockfile, so weekly dependency update PRs can be reviewed before production changes.

This deliberately leaves configuration, workflow, and template script upgrades
manual and documented in release notes; it does not implement whole-repository
upstream synchronization or automatic merging. Existing source-based deployments
receive a documented manual migration path that preserves data, bindings,
credentials, and pending work, with a maintenance window allowed.
