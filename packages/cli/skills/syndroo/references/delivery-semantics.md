# Local delivery semantics

Read this once a preview or a run has returned and you have to explain what happened.

## A plan is not a publication

A preview writes a signed local plan and reports it. Nothing was sent. The exit code `0` on a preview says the plan exists, not that anything reached a platform.

Only an execution sends content, and only its per-target results say what each platform did. A run is complete when every selected target succeeded and the result was persisted (`status: "succeeded"` with `durability: "committed"`).

## Target statuses

| Status | Meaning |
| --- | --- |
| `not_started` | Frozen but not attempted. A deadline or a stop before the first attempt leaves it here |
| `in_flight` | An attempt is recorded but no outcome is committed. While a writer is alive this is "in progress"; after a crash it is unknown |
| `succeeded` | The provider accepted the content and returned an id |
| `failed` | The provider refused it, or the request provably never reached it |
| `unknown` | The write may have reached the platform. This is the honest answer for a timeout, a dropped connection, or a success response without a usable id |

`writeDisposition` carries the same distinction in machine-readable form: `applied`, `not_applied`, or `unknown`.

## Aggregate status and exit codes

| Aggregate | When |
| --- | --- |
| `succeeded` | Every target succeeded |
| `partial` | Some targets succeeded and others failed or never started |
| `failed` | No target succeeded and at least one definitely failed |
| `unknown` | At least one target is `unknown`, or a writer is still in flight |
| `blocked` | Nothing was attempted, for example a deadline that passed before the first attempt |

Exit codes follow the same order: `4` for an unknown write, then `1` for a result that could not be persisted, then `6` for a run that ended without full delivery, then `0`. A refusal before any content request is `2`, a declined prompt is `5`, and a signal is `130`.

## Unknown is a third outcome

Report unknown as unknown. A provider that may have accepted the post before the connection dropped is not a clean failure, and treating it as one invites a duplicate.

When a result is unknown, read it back with `syndroo receipts show <operation-id> --json` and stop. Do not send the post again under a new key, a new namespace, or a fresh state directory; that would publish the same text under a new identity. A retry is a separate, explicit decision: preview it with `syndroo retry <operation-id> --to <csv> --dry-run`, and select only targets whose outcome is provably safe.

## Retry rules

- A succeeded target is never republished. Replaying its plan reports the original result with `reused: true` and sends nothing.
- Only a definite `not_applied` failure is retryable, and only within the three-attempt budget for that logical delivery.
- `retryNotBefore`, when present, must have passed.
- A selection that includes an unknown target blocks the whole retry. The user can narrow the selection to other safe targets; the unknown record stays unknown.
- Retrying after a credential change requires re-verifying the same stable account, and the preview shows the old and new binding so the user can confirm the change.

## Durability

`durability: "failed"` means a trusted provider result could not be written to local state. The result is still reported, the exit code is `1`, and the same content must not be sent again. If a later query finds only an in-flight record, that record is unknown, because the outcome was never committed.

## What to report

State the operation id, the plan id, the aggregate status, and the durability, then every target: provider, stable account id, status, attempt count, and remote id when one exists. Name the targets that succeeded before the ones that did not, and keep delivered, not delivered, and unknown in three separate buckets. When a link is `null`, say that no verified link is known rather than constructing one.
