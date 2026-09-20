import { PublishError, type Platform, type Publisher } from "@syndroo/core";

import { ApiError } from "./http.js";
import { DESCRIPTORS } from "./platform-descriptors.js";
import type { D1Repository } from "./repository.js";

export { DESCRIPTORS } from "./platform-descriptors.js";

export function isPlatformConfigured(platform: Platform, env: Env): boolean {
  return DESCRIPTORS[platform].installed && DESCRIPTORS[platform].isConfiguredFromEnv(env);
}

export function publisherFor(platform: Platform, env: Env): Publisher {
  const desc = DESCRIPTORS[platform];
  if (!desc.installed || !desc.isConfiguredFromEnv(env)) {
    throw new PublishError("Platform credentials are not configured: " + platform, "AUTH");
  }
  return desc.buildPublisher(null, env);
}

/**
 * Like `publisherFor`, but checks D1 credentials first and falls back to env
 * vars.  Used by the publication executor so that credentials stored through
 * the auth API take effect without a redeployment.
 */
export async function resolvePublisher(
  platform: Platform,
  env: Env,
  repository: D1Repository,
): Promise<Publisher> {
  const cred = await repository.getCredential(platform);
  return DESCRIPTORS[platform].buildPublisher(cred, env);
}

/**
 * Stored provider identifier for a platform.  The value is written to
 * `publications.provider`, so it is part of the stored-data contract and must
 * not change silently.
 */
export function providerFor(platform: Platform): string {
  const desc = DESCRIPTORS[platform];
  if (!desc.installed) {
    throw new ApiError(
      "Platform is not configured yet: " + platform,
      422,
      "PLATFORM_NOT_CONFIGURED",
    );
  }
  return desc.providerName;
}
