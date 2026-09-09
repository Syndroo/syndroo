# Changelog

All notable Syndroo changes are recorded here. Releases use Semantic
Versioning and matching `v<version>` Git tags.

## Unreleased

### Changed

- Use the official `@atproto/api` SDK for Bluesky, retaining link facets,
  publication identifiers, bounded responses, and application-owned retries.
- Enable platforms independently from their credentials. Reject unconfigured
  platforms before persistence or enqueueing; default the Bluesky host to
  `bsky.social`.
- Require only `SYNDROO_API_KEY` during production setup. Configure platform
  secrets after deployment. Local development uses the `local` Wrangler
  environment to load optional platform credentials.

### Added

- Native LinkedIn public text publishing with explicit author/API version,
  little-text escaping, header-based confirmation, and ambiguous-write protection.

- Native Tumblr NPF text publishing with OAuth 1.0a, optional blog credentials,
  preflight text validation, bounded responses, and ambiguous-write protection.

- X text publishing through the official `@xdevplatform/xdk` SDK, optional
  OAuth 1.0a credentials, official weighted text validation, and bounded
  application-controlled requests without SDK retries.

- Thin deployment architecture with the public
  `@syndroo/cloudflare-worker` package.
- Apache License 2.0, NOTICE, DCO contribution policy, CI, and npm release
  workflow.
