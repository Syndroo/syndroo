# HTTP fallback

Use this only when the CLI cannot run in the current environment but an authorized HTTP tool can reach the instance. The workflow, the authorization rules, and the idempotency rules are the same as for the CLI; only the transport changes.

Direct HTTP is a fallback for a missing capability. It is not a second attempt after a CLI failure.

## Endpoints

| Request | Notes |
| --- | --- |
| `GET /health` | Unauthenticated. Proves reachability only, for example `{"status":"ok"}` |
| `POST /v1/posts` | Authenticated. Body is the document. Returns `202` when accepted and `200` when it replays a previous result |
| `GET /v1/posts?limit=50` | Authenticated. Returns `{"items":[...]}`. `limit` is 1-100 |
| `GET /v1/posts/{id}` | Authenticated. Returns one post with its publications. Unknown ids are `404` with `POST_NOT_FOUND` |

Every `/v1/*` route needs the instance API key as a Bearer header. `GET /health` does not. Error bodies are shaped `{"error":{"code":"...","message":"..."}}`, and the same document rules as [cli.md](cli.md) apply to the create body.

`POST /v1/posts` takes the `Idempotency-Key` header, with the same 1-128 character alphabet as the CLI flag. Same key and same body replays the original result; same key with a different body is a conflict, not a new post. A `503` with `SERVICE_UNAVAILABLE` means maintenance is on, and the documented response is to retry later with the same key and the same body.

```bash
curl -sS -X POST "$SYNDROO_BASE_URL/v1/posts" \
  -H "Authorization: Bearer $SYNDROO_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: release-announcement-001" \
  -d @post.json
```

## Rules that do not change

Show the platforms, the schedule, and the final content before the write, exactly as in the skill's workflow steps. Send the same one logical post under one key. Read `GET /v1/posts/{id}` afterwards and report each platform.

When the result is unknown, query. A timeout, a dropped connection, or an `errorAmbiguous` publication means the outcome is unknown, so read the post and keep the original key. Never re-send through another path, and never mint a new key to hide a failure.

An authentication or permission failure means the configuration is wrong. Stop and fix the credential or the instance setting rather than routing around it.

## No tools at all

If neither the CLI nor an authorized HTTP tool is available, report the environment gap and stop. Do not claim a post was published, drafted remotely, or scheduled, because nothing was submitted.
