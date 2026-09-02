# Crosspost + Bluesky + Cloudflare compatibility spike

## Conclusion

No. `@humanwhocodes/crosspost@1.0.4` is not compatible with Cloudflare Workers without patching or forking the package.

Wrangler bundles it, but workerd fails during module initialization before the Worker can serve `/health` or construct `BlueskyStrategy`.

## Scope

- Crosspost version: `1.0.4`
- Worker compatibility date: `2026-08-31`
- Node.js compatibility: explicitly enabled with `nodejs_compat`
- Wrangler version: `4.127.1`
- workerd version: `1.20260828.1`
- Platform: Bluesky
- The experiment itself has no D1, Queue, or CRUD API; those live in the production Worker app

## Crosspost evidence

These checks pass:

- TypeScript typecheck
- Node.js strategy construction
- Wrangler dry-run bundle: 124.79 KiB upload, 30.54 KiB gzip
- `wrangler check startup` profiling

Actual local workerd boot fails with:

```text
Uncaught TypeError: The argument 'path' The argument must be a file URL object, a file URL string, or an absolute path string.. Received 'undefined'
    at node:module:34:15 in createRequire
```

Crosspost's Bluesky facet module runs this at module initialization:

```js
const require = createRequire(import.meta.url);
const tlds = require("tlds");
```

Testing a fixed `import.meta.url` removes first error but exposes next incompatibility:

```text
Uncaught Error: No such module "tlds".
```

This is not a credential, fetch, or Bluesky API failure. Worker cannot boot because dynamic CommonJS loading is incompatible with bundled Workers module graph. `wrangler check startup` produced a false-positive for this case; `wrangler dev` was required to expose runtime failure.

Reproduce with:

```bash
npm run spike:crosspost:bundle
npm run spike:crosspost:dev
```

Reproduction Worker lives at `experiments/crosspost-cloudflare/src/index.ts` with its own `wrangler.jsonc`.

## Decision

- Keep one small Syndroo-owned `Publisher.publish()` contract.
- Do not fork Crosspost.
- Keep Crosspost imports isolated in `experiments/crosspost-cloudflare`.
- Use the native Bluesky publisher from `packages/bluesky/src/index.ts`.
- Re-evaluate future Crosspost releases before using it for other Worker adapters.

Crosspost cannot make a real Bluesky post from this Worker because module initialization fails. Real Crosspost publication test is therefore not applicable after boot failure.

## Native fallback

`packages/bluesky/src/index.ts` implements text-only Bluesky publication using standard Web APIs and AT Protocol XRPC endpoints:

- `com.atproto.server.createSession`
- `com.atproto.repo.createRecord`

Validated during the spike:

- Native Worker bundle and workerd startup
- workerd boots
- Outbound request reaches `bsky.social`
- Invalid test credentials return Bluesky's 401 response and normalize to `AUTH`, `ambiguous: false`
- Mocked successful record creation returns CID and public URL
- Post-stage network failures normalize to `NETWORK`, `ambiguous: true`

Successful real publication remains pending because no Bluesky test-account credentials were available.

The production Worker no longer exposes spike routes. Use the authenticated `/v1/posts` API documented in the repository README.

## Dependency security note

Crosspost 1.0.4 depends on `image-size@2.0.2`, affected by high-severity denial-of-service advisories for crafted ICNS, JXL, and HEIF inputs. Crosspost is therefore pinned as a development-only dependency for failure reproduction; production dependency audit is clean. Current spike accepts text only, so vulnerable image parsing path is unreachable. No patched `image-size` release was available during this spike. Do not enable untrusted image uploads through this Crosspost version.
