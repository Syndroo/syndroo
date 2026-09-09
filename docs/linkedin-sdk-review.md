# LinkedIn SDK review

Checked September 9, 2026. Published SDK: `linkedin-api-client@0.3.0`.

## Outcome: native HTTP selected

The user approved native HTTP after reviewing alternatives. Production now uses
`packages/linkedin`; unit and workerd tests cover that implementation. No SDK
code was copied. The official SDK is not installed in production. Its license is the custom
**LinkedIn API Development Software License Agreement**, not Apache-2.0 or MIT.
Sections 1 and 2 tie granted rights to the user's LinkedIn API agreement and
restrict copying, modification, and distribution, including public repository
copying subject to a GitHub-terms exception.

Syndroo plans to bundle its adapters into a publicly distributed npm Worker.
We have not established permission to redistribute this SDK in that artifact.
This is a release-risk finding, not a legal conclusion that every SDK use is
prohibited. Obtain explicit licensing clearance before bundling it.

Temporary experiment manifests and the SDK dependency were removed after this
finding. No SDK source was copied into Syndroo. Runtime tests were not run, so
workerd compatibility is **unverified**, not failed.

## Technical inspection

The published source exposes an Axios instance and per-request
`additionalConfig`. This offers transport/cancellation configuration options,
unlike the Tumblr SDK. The inspected create path contains no built-in retry
loop; retry support is illustrated separately with an additional library.
Actual timeout, response-size, redirect, and bundle behavior still need tests.
Debug logging can include authorization headers and must remain disabled.

## Native implementation decision

Prefer an independently written native HTTP adapter based on the public Posts
API documentation, without copying SDK code. Native HTTP avoids shipping the
SDK's licensed material; it does **not** remove LinkedIn API terms, application
approval, or account permission requirements. This changes the SDK-first plan
and was approved by the user.

Implemented v0.1 scope:

- Text-only `POST /rest/posts`, no media or OAuth login UI.
- User access token, author URN, and explicit supported API version.
- Member publishing (`w_member_social`); organization publishing
  additionally needs `w_organization_social` and an eligible Page role.
- Validate text and author before sending; preserve version and Rest.li headers.
- Do not buffer response bodies; cancel them after inspecting confirmation headers.
  Requests time out, and ambiguous writes are never retried.
- Confirm success from the documented status and created-post identifier header.
- Explicitly require a YYYYMM API version; the operator tracks retirements.

LinkedIn is now installed but returns `PLATFORM_NOT_CONFIGURED` without valid
settings. Three optional bindings were added. No migrations, deployment, OAuth
authorization, or real posts were performed.

## Alternative library review

The search found alternatives, not an absence of all libraries:

- [SimplePost](https://github.com/simple-post/core) offers a broader MIT-licensed
  multi-platform publishing layer. Adopting that orchestration layer is outside
  Syndroo's current narrow adapter design; it was not installed or runtime-tested.
- [PostEverywhere SDK](https://github.com/posteverywhere/sdk) targets its hosted
  service, adding a service dependency rather than direct self-hosted publishing.
- The official client retains the redistribution clearance issue above.

No suitable narrow replacement was established. The native adapter adds no
third-party runtime dependency. This review does not claim that every community
library is unsuitable or abandoned.

## Primary sources

- [Official SDK](https://github.com/linkedin-developers/linkedin-api-js-client)
- [SDK license](https://github.com/linkedin-developers/linkedin-api-js-client/blob/master/LICENSE.md)
- [Published package metadata](https://registry.npmjs.org/linkedin-api-client/0.3.0)
- [Posts API and permissions](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-04)
- [Cloudflare Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
