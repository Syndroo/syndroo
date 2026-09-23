# Delivery semantics

Read this once a create or a wait has returned and you have to explain the outcome.

## Acceptance is not delivery

`POST /v1/posts` answers `202` for a newly accepted document and `200` when the
same idempotency key replays an earlier result; either way a zero exit from
`posts create` reports that receipt. It means the instance accepted or replayed
one logical post. It says nothing about any platform.

A post is delivered only when its status is `published`, which means every selected platform succeeded. Read the post, or wait for it, before claiming that anything reached a platform.

## Statuses

| Post status | Meaning |
| --- | --- |
| `scheduled` | Waiting for its `scheduledAt` instant |
| `queued` | Accepted and waiting for the instance to dispatch it |
| `publishing` | At least one platform is in flight |
| `published` | Terminal. Every selected platform succeeded |
| `partial` | Terminal. Some platforms succeeded and others did not |
| `failed` | Terminal. Nothing was delivered, or the outcome for a platform is unknown |

`published`, `partial`, and `failed` are terminal; the rest keep changing on their own. Each publication also carries its own status, its attempt count, and an optional `errorCode` such as `AUTH`, `RATE_LIMIT`, `INVALID_CONTENT`, `PROVIDER_UNAVAILABLE`, `NETWORK`, or `UNKNOWN`.

## Unknown is a third outcome

A publication with `errorAmbiguous` set describes a genuinely unknown outcome, for example a provider that may have accepted the post before the connection dropped. Report it as unknown. A `failed` post whose publications include an ambiguous entry is not a clean failure, and treating it as one invites a duplicate post.

The CLI reports these the same way it reports its exit codes:

- `0` - the post is `published`; in a create, only that the request was accepted
- `3` - the wait deadline passed; the post still exists, so resume with another wait or a read
- `4` - the outcome is unknown, so query with the original idempotency key instead of re-sending
- `6` - the post ended as `failed` or `partial`, with nothing to resend under a new key

## What to report

State the post id, the target platforms, the scheduled time or its absence, and then each platform's own result. When some platforms succeeded, name them before the ones that did not. Keep the three outcomes separate: delivered, not delivered, and unknown.

Waiting only reads. A timeout never cancels the server-side post, so the honest resume is another `posts wait` or a `posts get`, not a new submission.
