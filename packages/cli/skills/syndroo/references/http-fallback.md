# Remote HTTP path (retained, user-selected)

This is the pre-0.6 remote surface: a deployed Syndroo instance reached over HTTP. It is a separate, explicitly chosen path. The local publish workflow never falls back to it, and a local failure is not a reason to switch.

Use it only when the user asks for the deployed-instance path and an authorized HTTP tool can reach that instance. When the CLI itself can run here, prefer `syndroo posts validate`, `syndroo posts create`, and `syndroo posts get`, which speak to the same API with the same rules.

## Endpoints

| Request | Notes |
| --- | --- |
| `GET /health` | Unauthenticated. Proves reachability only, for example `{"status":"ok"}` |
| `POST /v1/posts` | Authenticated. Body is the remote document. Returns `202` when accepted and `200` when it replays a previous result |
| `GET /v1/posts?limit=50` | Authenticated. Returns `{"items":[...]}`; the limit is 1-100 |
| `GET /v1/posts/{id}` | Authenticated. Returns one post with its publications. An unknown id is `404` with `POST_NOT_FOUND` |

Every `/v1/*` route needs the instance API key as a Bearer header; `GET /health` does not. Error bodies are shaped `{"error":{"code":"...","message":"..."}}`, and the remote document rules in [cli.md](cli.md) apply to the create body.

`POST /v1/posts` takes the `Idempotency-Key` header. Same key and same body replays the original result; same key with a different body is a conflict, not a new post. A `503` with `SERVICE_UNAVAILABLE` means maintenance is on, and the documented response is to retry later with the same key and the same body.

```bash
curl -sS -X POST "$SYNDROO_BASE_URL/v1/posts" \
  -H "Authorization: Bearer $SYNDROO_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: release-announcement-001" \
  -d @post.json
```

## Rules that do not change

Show the platforms, the schedule, and the final content before the write, exactly as in the local workflow. Send one logical post under one key. Read `GET /v1/posts/{id}` afterwards and report each platform separately.

When the result is unknown, query it. A timeout, a dropped connection, or an ambiguous publication means the outcome is unknown, so read the post and keep the original key. Sending it again through another path, or minting a new key to hide the failure, is how one post becomes two.

An authentication or permission failure means the configuration is wrong. Stop and fix the credential or the instance setting rather than routing around it.

## No tools at all

If neither the CLI nor an authorized HTTP tool is available, report the environment gap and stop. Do not claim a post was published, drafted remotely, or scheduled, because nothing was submitted.
