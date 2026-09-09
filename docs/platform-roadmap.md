# Platform SDK roadmap

Work proceeds in independently tested stages. No SDK may silently retry a write
with an ambiguous outcome. Every SDK must pass a workerd runtime check before
production use.

- [x] Make platform credentials optional while retaining the required API key.
- [x] Migrate Bluesky to the official `@atproto/api` SDK.
- [x] Add X using the official `@xdevplatform/xdk`, with OAuth 1.0a and workerd tests.
- [x] Run the official `tumblr.js@5.0.1` workerd compatibility spike.
- [x] Add Tumblr with native HTTP, OAuth 1.0a, bounded responses, and workerd tests.
  Native HTTP was approved after the [SDK spike](tumblr-cloudflare-spike.md).
- [x] Review the official LinkedIn SDK: custom redistribution restrictions found.
- [x] Add LinkedIn with independently written native HTTP, explicit API version,
  plain-text escaping, and workerd tests. See the [SDK review](linkedin-sdk-review.md).

Threads retains its existing HTTP adapter. SDK migration is excluded from this
roadmap because a suitable official publishing SDK has not been identified.
The planned adapter sequence is implemented. Live account posting remains a
separate, explicitly authorized validation step; no deployment or release was made.

Sources checked September 9, 2026:

- [Bluesky SDK source](https://github.com/bluesky-social/atproto/tree/main/packages/api)
- [Meta Threads sample](https://github.com/fbsamples/threads_api)
- [Meta Threads API collection](https://www.postman.com/meta/threads/overview)
- [X TypeScript SDK](https://docs.x.com/tools/typescript-xdk)
- [Tumblr JavaScript SDK](https://github.com/tumblr/tumblr.js)
- [LinkedIn JavaScript client](https://github.com/linkedin-developers/linkedin-api-js-client)
- [Cloudflare secret loading rules](https://developers.cloudflare.com/workers/configuration/secrets/)
