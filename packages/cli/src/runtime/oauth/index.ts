/**
 * The local OAuth callback adapter.
 *
 * Exposed as its own module so the composition can wire it and a test can drive
 * one redirect without a live provider: the attempt store, the redirect-URI
 * shaping and the verification path are all reachable directly.
 */
export {
  DEFAULT_ATTEMPT_TTL_MS,
  DEFAULT_OAUTH_PROVIDERS,
  MAX_ATTEMPT_TTL_MS,
  LocalOAuthCallback,
} from "./callback.js";
export type {
  ArmedDraft,
  CallbackOutcome,
  LocalOAuthCallbackOptions,
} from "./callback.js";
export { digestsEqual, FilesystemOAuthAttempts } from "./attempts.js";
export type { ClaimResult, OAuthAttempt } from "./attempts.js";
export { OAuthError } from "./errors.js";
export {
  CALLBACK_PATH_PREFIX,
  DEFAULT_LOOPBACK_PORT,
  LOOPBACK_HOSTS,
  defaultRedirectUri,
  parseCallbackUrl,
  parseRedirectUri,
} from "./redirect.js";
export type { LoopbackTarget, RedirectTarget, RemoteTarget } from "./redirect.js";
export { startLoopbackListener } from "./listener.js";
export type { ListenerOutcome, ListenerVerdict, LoopbackListener } from "./listener.js";
