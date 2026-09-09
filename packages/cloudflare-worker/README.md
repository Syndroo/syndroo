# @syndroo/cloudflare-worker

Cloudflare Worker runtime for
[Syndroo](https://github.com/Syndroo/syndroo), open-source publishing
infrastructure for the social web.

Most users should deploy through
[syndroo-deploy-template](https://github.com/Syndroo/syndroo-deploy-template)
instead of importing this package directly.

The package contains:

- bundled Worker entry point;
- complete D1 migration history;
- `syndroo-deploy` command, which repairs a missing D1 database binding,
  applies remote migrations, and deploys the Worker.

It currently supports text publishing to Threads, Bluesky, X, Tumblr, and LinkedIn.

X uses the official `@xdevplatform/xdk` SDK. Configure all four optional secrets:
`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, and `X_ACCESS_TOKEN_SECRET`.
Use OAuth 1.0a user credentials for an app with Read and Write permissions.
Standard text posts are limited to 280 weighted characters; SDK retries are
disabled. Add these names to the local development secret list when upgrading
a deployment template, but not to production `secrets.required`.

Only `SYNDROO_API_KEY` is required for production deployment. Add
`BLUESKY_IDENTIFIER` and `BLUESKY_PASSWORD` to enable Bluesky, or
`THREADS_ACCESS_TOKEN` to enable Threads. `BLUESKY_HOST` defaults to
`bsky.social`. Keep these values in Worker secrets. Requests for an unconfigured
platform return `422 PLATFORM_NOT_CONFIGURED` before creating a post.

Bluesky uses the official `@atproto/api` SDK with application-controlled retries.
Existing `bluesky-native` publication identifiers are preserved. If upgrading a
deployment template, keep only `SYNDROO_API_KEY` in production `secrets.required`.
For local development, that list must include all platform secret names to load
them from `.dev.vars`; unused credentials may be omitted despite local warnings.

Tumblr uses native HTTP and OAuth 1.0a. Set `TUMBLR_CONSUMER_KEY`,
`TUMBLR_CONSUMER_SECRET`, `TUMBLR_TOKEN`, `TUMBLR_TOKEN_SECRET`, and
`TUMBLR_BLOG` (a blog name or tumblr.com hostname, not a URL). The authorized
user must be able to post to that blog. These settings are optional.
Add their names to the local secret list, not production `secrets.required`.
No D1 migration is needed. Text is one NPF block, at most 4,096 Unicode code
points; HTML/Markdown are not interpreted. Responses are bounded to 64 KiB
with a 15-second request deadline; ambiguous writes are never retried.

LinkedIn uses native HTTP, not the restricted SDK. Configure optional secrets
`LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_AUTHOR` (person or organization URN), and
`LINKEDIN_API_VERSION` (supported YYYYMM version, explicitly pinned).
Personal publishing needs `w_member_social`; organizations need
`w_organization_social`, API product access, and an eligible Page role.
v0.1 publishes public text only and limits escaped little-text commentary to
3,000 UTF-16 units. It requires a confirmed created-post ID header and cancels
unread response bodies. No automatic retries of ambiguous writes or token refresh.
Add binding names to the local secret list, not production `secrets.required`.
No migration is required. Review API versions before updating them.

## Direct use

```typescript
export { default } from "@syndroo/cloudflare-worker";
```

Point `migrations_dir` at the package migrations:

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "syndroo",
      "migrations_dir": "node_modules/@syndroo/cloudflare-worker/migrations"
    }
  ]
}
```

Run `syndroo-deploy` from an npm script so the local Wrangler executable is
available.

## License

Apache-2.0. Copyright 2026 Grant Dai.
