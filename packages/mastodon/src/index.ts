/**
 * Public surface of the private `@syndroo/mastodon` package.
 *
 * Platform-neutral: the production adapter has no Node imports, and the
 * transport is injected by the caller (the CLI injects the accepted safe
 * instance transport).
 */

export {
  MastodonLocalProvider,
  MASTODON_PAYLOAD_VERSION,
  mastodonTargetId,
  normalizeMastodonOrigin,
  parseMastodonTargetId,
  type MastodonLocalProviderOptions,
  type MastodonTargetIdentity,
} from "./local.js";

export {
  assertMastodonContentFits,
  assertMastodonStatusText,
  countMastodonCharacters,
  extractMastodonMentions,
  extractMastodonUrls,
  type MastodonMentionSpan,
  type MastodonTextSpan,
} from "./count.js";
