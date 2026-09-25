# Distribute the Worker package through a thin deployment template

Status: decided, retained remote path. Not a commitment about future products.

## Context

Deployment copies of the source repository have no automatic upstream update
channel, and merging whole-source upgrades makes user customization harder to
preserve. The remote surface therefore needs a distribution shape that
separates the application from each operator's configuration.

## Decision

The remote path ships as one public Worker package that bundles the private
adapters, plus a thin deployment template that pins exact package versions with
a lockfile. Configuration, workflow, and template scripts are upgraded
manually and described in release notes, so a dependency update can be reviewed
before it reaches production.

Syndroo does not implement whole-repository upstream synchronization or
automatic merging.

## Consequences

- Operators review Worker changes, D1 migrations, and new secrets before
  merging; nothing merges or writes to production `main` on its own.
- The template is prepared but has not been rehearsed end to end; the packages
  it pins are not published yet.
- The local CLI path is independent of this decision: it needs no Worker, D1,
  Queue, or deployment template.
