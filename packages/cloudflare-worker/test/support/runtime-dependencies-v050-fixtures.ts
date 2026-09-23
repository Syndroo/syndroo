/**
 * Shared fixtures for the lazy runtime composition slice.
 *
 * The keys are synthetic, canonical padded base64 of exactly 32 bytes. They are
 * not credentials, and every test value is deliberately disposable.
 */

/** Canonical base64 of 32 zero bytes. */
export const VALID_CREDENTIAL_KEY = `${"A".repeat(43)}=`;

/**
 * A second, different 32-byte key for "wrong key" probes.
 *
 * The final character must encode zero trailing bits, otherwise the encoding is
 * not canonical and the accepted strict decoder rejects it.
 */
export const OTHER_CREDENTIAL_KEY = `${"E".repeat(43)}=`;

/** Canonical base64 of 32 bytes; independent of the credential key. */
export const VALID_BINDING_KEY = `${"I".repeat(43)}=`;

export const VALID_KEY_ID = "k1";

/** Sentinel text that must never appear in a fixed error or readiness report. */
export const SENTINEL_SECRET = "SENTINEL-runtime-dependency-3f9c";

/** A plain allowlisted configuration map; unrelated names stay outside it. */
export function instanceConfiguration(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    SYNDROO_CREDENTIAL_KEY: VALID_CREDENTIAL_KEY,
    SYNDROO_CREDENTIAL_KEY_ID: VALID_KEY_ID,
    SYNDROO_BINDING_KEY: VALID_BINDING_KEY,
    SYNDROO_PUBLIC_URL: "https://syndroo.test",
    BLUESKY_IDENTIFIER: "test.invalid",
    BLUESKY_PASSWORD: "fixture-password",
    BLUESKY_HOST: "bsky.social",
    THREADS_ACCESS_TOKEN: "fixture-threads-token",
    X_API_KEY: "fixture-x-key",
    X_API_SECRET: "fixture-x-secret",
    X_ACCESS_TOKEN: "fixture-x-access",
    X_ACCESS_TOKEN_SECRET: "fixture-x-access-secret",
    TUMBLR_CONSUMER_KEY: "fixture-tumblr-key",
    TUMBLR_CONSUMER_SECRET: "fixture-tumblr-secret",
    TUMBLR_TOKEN: "fixture-tumblr-token",
    TUMBLR_TOKEN_SECRET: "fixture-tumblr-token-secret",
    TUMBLR_BLOG: "fixture-blog",
    LINKEDIN_ACCESS_TOKEN: "fixture-linkedin-token",
    LINKEDIN_AUTHOR: "urn:li:person:fixture",
    LINKEDIN_API_VERSION: "202601",
    LINKEDIN_CLIENT_ID: "fixture-linkedin-client",
    LINKEDIN_CLIENT_SECRET: "fixture-linkedin-client-secret",
    // Unrelated bindings that must never be copied.
    SYNDROO_API_KEY: SENTINEL_SECRET,
    UNRELATED_SECRET: SENTINEL_SECRET,
    ...overrides,
  };
}
