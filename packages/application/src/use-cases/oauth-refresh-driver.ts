/**
 * Narrow refresh capability contract.
 *
 * Refresh has different requirements from connect/complete: it needs no
 * canonical callback URL and no start-configuration fingerprint, only a local
 * preflight and one exchange. The captured snapshot therefore carries just the
 * platform, a synchronous network-free `canRefresh` and the async `refresh`
 * operation, both bound to the original receiver.
 *
 * The concrete driver owns the native payload's refresh-token presence, the
 * provider response merge and the expiry rules; the application owns the lease,
 * the AAD, the generation and the atomic commit.
 */

import type { Platform } from "@syndroo/core";

import { AuthUseCaseError, authFailure } from "./auth-errors.js";
import type { OAuthRefreshInput, OAuthRefreshResult } from "./oauth-driver.js";

export interface OAuthRefreshDriver {
  readonly platform: Platform;
  /**
   * Synchronous, network-free preflight over the stored native payload: does it
   * carry a usable refresh token for a supported protocol?
   */
  readonly canRefresh: (plaintext: Uint8Array) => boolean;
  /** One exchange attempt per refresh; no automatic retry is performed. */
  readonly refresh: (input: OAuthRefreshInput) => Promise<OAuthRefreshResult>;
}

/** Resolve the immutable refresh snapshot for one platform, or null. */
export type OAuthRefreshDriverResolver = (
  platform: Platform,
) => OAuthRefreshDriver | null | Promise<OAuthRefreshDriver | null>;

/**
 * Validate and capture a refresh snapshot.
 *
 * Identity and method references are read once and bound to the original
 * receiver; the returned object is frozen, so a later mutation of the injected
 * driver cannot change this operation's behaviour.
 */
export function requireRefreshDriverSnapshot(
  value: unknown,
  platform: Platform,
): OAuthRefreshDriver {
  try {
    if (typeof value !== "object" || value === null) {
      throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
    }
    const candidate = value as Record<string, unknown>;
    if (candidate["platform"] !== platform) {
      throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
    }
    const canRefresh = candidate["canRefresh"];
    const refresh = candidate["refresh"];
    if (typeof canRefresh !== "function" || typeof refresh !== "function") {
      throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
    }
    // The casts only restore the checked method signatures to `unknown` values
    // that the `typeof` guard above has already proven callable.
    const canRefreshMethod = (canRefresh as OAuthRefreshDriver["canRefresh"]).bind(value);
    const refreshMethod = (refresh as OAuthRefreshDriver["refresh"]).bind(value);
    return Object.freeze({
      platform,
      canRefresh: canRefreshMethod,
      refresh: refreshMethod,
    });
  } catch (error) {
    throw authFailure(error, "INSTANCE_NOT_READY", "invalid_driver_response");
  }
}
