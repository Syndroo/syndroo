# Tumblr SDK / Cloudflare spike

Checked September 9, 2026. SDK: `tumblr.js@5.0.1` (the current npm release).

## Result

The unmodified official SDK can sign and send an NPF text post in workerd with
`nodejs_compat` and compatibility date `2026-09-03`. This is a local, mocked
transport result, not a live Tumblr account test.

The SDK is **not integrated into the production publisher**. The user approved
native HTTP; production now uses `packages/tumblr` with bounded fetch and
Web Crypto signing. This report preserves the original SDK experiment. The installed SDK's
private `#makeRequest` creates a Node HTTPS request without exposing a request
handle, AbortSignal, timeout, response limit, or injectable transport. Its
response handler concatenates the complete response into a string. Unlike the
X SDK's public transport hook, this cannot be bounded by a small per-instance
transport override.

## Reproduction

```bash
npm install
npm test --workspace @syndroo/tumblr-cloudflare-experiment
npm run check --workspace @syndroo/tumblr-cloudflare-experiment
```

The isolated experiment uses Miniflare's `outboundService` to intercept all
outbound traffic. No real credentials, account access, or external posts are
involved. Four passing tests establish:

1. An NPF text body and OAuth signature header reach the mocked endpoint.
2. HTTP 503 is surfaced as an SDK error.
3. A response larger than 64 KiB is accepted without a size guard.
4. After an application deadline wins `Promise.race`, the original request
   still completes. Racing a timeout does not cancel network activity.

Source inspection additionally found no automatic retry loop in the publishing
path. The promise form drops the structured HTTP response; callback form exposes
it but is deprecated. SDK errors may contain raw response text and must never
be stored directly in publication errors.

## Decision history (resolved: native HTTP)

Keep this dependency in `experiments/` only. Do not mutate global `https.request`
or patch SDK prototypes in production. Do not treat `Promise.race` as cancellation.

The options evaluated before implementation were:

- Prefer a small native API adapter, as with Threads, using bounded `fetch`,
  OAuth signing, and the existing normalized error/ambiguity rules. This departs
  from the SDK-first preference but avoids maintaining a fork.
- Maintain a pinned SDK patch/fork adding per-request cancellation and a bounded
  response reader, then test the patched code in Node and workerd. This creates
  an ongoing maintenance obligation; no fork or upstream PR has been created.
- Defer Tumblr until the upstream SDK exposes the needed controls, and proceed
  with the LinkedIn compatibility spike.

The native adapter is implemented and verified separately. Runtime compatibility
alone was not the production-readiness criterion. The experiment stays isolated.

## Primary references

- [Official Tumblr SDK](https://github.com/tumblr/tumblr.js)
- [Published 5.0.1 metadata](https://registry.npmjs.org/tumblr.js/5.0.1)
- [Tumblr API documentation](https://www.tumblr.com/docs/en/api/v2)
- [Cloudflare Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)

The findings above were verified against the installed 5.0.1 package source
(`lib/tumblr.js`) and the committed experiment, not inferred from upstream main.
