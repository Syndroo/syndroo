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

It currently supports text publishing to Threads and Bluesky.

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
