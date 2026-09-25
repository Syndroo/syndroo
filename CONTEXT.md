# Syndroo

Syndroo is a CLI-first publisher: the `syndroo` command publishes plain text to
Bluesky and Threads from the operator's own machine. A retained remote path
serves the same product through a deployed Cloudflare Worker for operators who
need an instance.

## Language

**Post**:
A publishing request with shared content, target platforms, and optional
platform-specific overrides. A publication schedule belongs to the retained
remote path only; local publishing is immediate.
_Avoid_: Publication when referring to the whole multi-platform request

**Frozen plan**:
A signed local record of exactly what a preview showed: the final text, the
target binding, the payload version, and a content digest. Executing a plan is
the only way local publishing sends anything, and the plan is never rebuilt
from the input file.
_Avoid_: Draft, preview when referring to the stored plan itself

**Local delivery**:
One frozen plan item's progress for one provider and one stable target id,
identified by `(namespace, key, provider, targetId)` and counted across every
plan and operation.
_Avoid_: Job, task when the identity matters

**Binding**:
The current local connection record for one provider: a stable account id, an
opaque connection id, and a revision that increases whenever the account or its
credential source changes.
_Avoid_: Login, session when the stable identity is meant

**Namespace**:
A local deduplication domain stored in the local config. It separates unrelated
publishing histories; it grants no permission and is not a repair for a failed
or unknown outcome.
_Avoid_: Profile, account, or tenant when deduplication is meant

**Receipt**:
The local record of what each target did, including an `unknown` outcome. A
receipt is evidence, not authorization, and reading one never contacts a
platform.
_Avoid_: Proof of publication, success report

**Publication**:
One Post's delivery to one platform, with its own content and delivery outcome.
_Avoid_: Post when referring only to one platform's delivery

**Ambiguous outcome**:
A publication outcome where the platform may have accepted the content but
Syndroo cannot confirm whether it was published.
_Avoid_: Confirmed failure, safe-to-retry failure

**Officially supported platform**:
A platform whose publishing integration has passed live validation for the
release being assessed.
_Avoid_: Implemented platform as a synonym for verified support

**Experimental platform**:
A provided publishing integration that has not met the release's live-validation
gate and is offered with explicitly documented validation limits.
_Avoid_: Uninstalled platform, disabled platform

**Deployment template**:
The starting configuration for an operator's self-hosted Syndroo deployment,
distinct from the Syndroo source project.
_Avoid_: Upstream fork

**Maintenance window**:
A planned interruption during which new publishing requests are rejected and
scheduled publications may be delayed until service resumes.
_Avoid_: Zero-downtime migration
