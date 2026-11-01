export { createHttpHandler } from './handler.js';
export type { Authentication, HttpHandlerOptions, Operation } from './handler.js';
export { inspectOAuthCallback, OAuthCallbackAdapter, normalizeOAuthConfig } from '../oauth/index.js';
export type {
  NormalizedOAuthConfig,
  OAuthAttemptRecord,
  OAuthAttemptStore,
  OAuthCallbackDependencies,
  OAuthCallbackInput,
  OAuthClaimResult,
} from '../oauth/index.js';
