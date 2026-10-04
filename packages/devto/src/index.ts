/**
 * Public surface of the private `@syndroo/devto` package.
 *
 * Runtime-neutral: no Node imports, and the transport is injectable for tests.
 * The only production origin is the hardcoded `https://dev.to`.
 */

export { DevtoLocalProvider, type DevtoLocalProviderOptions } from "./local.js";

export {
  DEVTO_API_KEY_PATTERN,
  DEVTO_MAX_BODY_CODE_POINTS,
  DEVTO_MAX_CANONICAL_URL_CHARS,
  DEVTO_MAX_TAGS,
  DEVTO_MAX_TAG_CHARS,
  DEVTO_MAX_TITLE_CODE_POINTS,
  DEVTO_PAYLOAD_VERSION,
  buildDevtoArticlePayload,
  codePointCount,
  devtoPayloadMatches,
  devtoTargetId,
  parseDevtoTargetId,
  readDevtoUserId,
  validateDevtoApiKey,
  validateDevtoArticle,
  validateDevtoBody,
  validateDevtoCanonicalUrl,
  validateDevtoContentOptions,
  validateDevtoTags,
  validateDevtoTitle,
} from "./validation.js";

export {
  DEFAULT_TIMEOUT_MS,
  LocalTransportError,
  MAX_RESPONSE_BYTES,
  createDeadline,
  foremErrorEvidence,
  readRetryHint,
  requestBounded,
  type BoundedResponse,
  type Deadline,
  type RetryHint,
  type TransportFailure,
} from "./local-transport.js";
