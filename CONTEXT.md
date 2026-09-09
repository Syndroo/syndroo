# Syndroo

Syndroo publishes content to multiple social platforms on behalf of a
self-hosting operator.

## Language

**Post**:
A publishing request with shared content, target platforms, optional
platform-specific overrides, and a publication schedule.
_Avoid_: Publication when referring to the whole multi-platform request

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
