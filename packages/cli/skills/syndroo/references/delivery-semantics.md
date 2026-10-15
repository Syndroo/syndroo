# Delivery semantics

Read this once a prepare, execute or status result has returned and you must
explain what happened.

## A prepare is not a publication

A `prepare` validates the request, freezes one snapshot and returns an approval
token. It sends nothing to any platform. Exit `0` means the prepare succeeded,
not that anything was published.

Only an `execute` sends content, and only its per-target `deliveries` say what
each platform did.

## Prepare result

```json
{
  "status": "confirmation_required",
  "operationId": "op_example",
  "approvalToken": "at_example",
  "expiresAt": "2026-10-09T03:00:00.000Z",
  "preview": []
}
```

`preview` contains every target: its provider, its `connectionId`, the resolved
`account`, the frozen provider `preview` (`content` + `fields`) and any options.
A target can also carry a `presentation` (`accountName`, `profileUrl`, `label`).
Show it before asking for confirmation; that frozen `preview` is what the execute
will send, not a re-derivation. The token is consumed by the matching execute and
never proves a human read the preview.

## Execution result

```json
{
  "phase": "execution",
  "operationId": "op_example",
  "status": "succeeded",
  "deliveries": [
    { "deliveryId": "dl_example", "connectionId": "conn_example", "account": { "provider": "bluesky", "accountId": "did:plc:…", "origin": "https://bsky.app" }, "attempts": 1, "outcome": { "status": "succeeded", "remoteId": "…", "url": "https://…" } }
  ]
}
```

| Aggregate `status` | Meaning |
| --- | --- |
| `pending` / `running` | Admitted, not finished. Keep waiting; do not re-send. |
| `succeeded` | Every target succeeded. |
| `partial` | Some targets succeeded and others failed or did not start. |
| `failed` | No target succeeded and at least one definitely failed. |
| `unknown` | At least one target may have reached the platform, or a writer is still in flight. |

A `durabilityWarning` of `OUTCOME_NOT_DURABLE` means a trusted result could not
be written to local state. Report it and do not re-send.

## Per-target outcome

| `outcome.status` | Meaning |
| --- | --- |
| `succeeded` | The provider accepted the content and returned an id (and usually a url). |
| `failed` | The provider refused it, or the request provably never reached it (`disposition: "not_applied"`). |
| `unknown` | The write may have reached the platform (`disposition: "unknown"`). The honest answer for a timeout, a dropped connection, or a response without a usable id. |
| `not_started` | Frozen but never attempted (`disposition: "not_applied"`). |
| `null` | No outcome is recorded yet; treat it as unresolved. |

## Display metadata and diagnostics

These optional fields are presentation only: they never change stable identity
(`provider` + `origin` + `accountId`), target selection or the provider payload.
The frozen presentation snapshot *is* covered by the intent digest, because it is
frozen with the rest of the intent at prepare time; a later rename therefore
cannot change what an already-reviewed approval covered.

- `presentation` (`accountName`, `profileUrl`, and a target-only `label`) is the
  account's display metadata as resolved when the intent was frozen. A later
  reconnect or rename does not rewrite it in a historical record.
- `preview` (`content` + `fields`) is the provider preview that was frozen.
- `diagnostic` (`SafeDiagnostic`: `providerCode`, `httpStatus`, `message`) can appear on a
  failed or unknown delivery. It is limited to verified code values and reviewed
  text — never a raw provider body, a raw HTTP header or an `error.message`
  stack. A missing diagnostic is not an error.

`publish` and `status --operation` render the same shared view, so a status means
the same thing in both. The human wording from that view:

| Stored state | Rendered |
| --- | --- |
| `prepared` | `Awaiting confirmation`, or `Expired` past `expiresAt` |
| `dry_run` | `Preview only` |
| `succeeded` | `Successful` |
| `failed` | `Failed` |
| `not_started` | `Not sent` |
| `unknown` | `Unknown` |
| `in_flight` | `Publishing` |
| `ready` | `Waiting` |

A `status --operation` read of a record that has not settled is prefixed with
`Last recorded status:`. It reports the stored record, not a live check, so it is
not proof that a platform is still working.

## Unknown is a third outcome

Report unknown as unknown. A provider that may have accepted the post before the
connection dropped is not a clean failure, and treating it as one invites a
duplicate.

When a result is unknown, read it back with `syndroo status --operation
<operationId> --json` and stop. Do not send the post again under a new request id
or a fresh state directory. A retry is a separate, explicit decision.

## Retry rules

- A succeeded target is never resent.
- Only a definite `not_applied` failure is eligible, and only within the
  per-target attempt budget.
- A selection that includes an `unknown` target blocks the whole retry. Narrow it
  to other safe targets; the unknown record stays unknown.
- Retrying after a credential change requires the same stable account to be
  re-verified.

```bash
syndroo publish --retry op_example --to conn_example
```

## What to report

State the `operationId`, the aggregate status, and then every target: provider,
stable account id, outcome status, attempt count and any remote id or url. Put the
succeeded targets before the ones that did not, and keep delivered, not delivered
and unknown in three separate buckets. When a url is absent, say no verified link
is known rather than constructing one.
