import { type Platform, type Publisher, PublishError } from "@syndroo/core";

import { ApiError } from "./http.js";
import { DESCRIPTORS, buildPublisher } from "./platform-descriptors.js";
import type { D1Repository } from "./repository.js";

export { DESCRIPTORS } from "./platform-descriptors.js";

export function isPlatformConfigured(platform: Platform, env: Env): boolean {
  return DESCRIPTORS[platform].installed && DESCRIPTORS[platform].isConfiguredFromEnv(env);
}

export function publisherFor(platform: Platform, env: Env): Publisher {
  if (!isPlatformConfigured(platform, env)) {
    throw new PublishError("Platform credentials are not configured: " + platform, "AUTH");
  }
  return buildPublisher(platform, null, env);
}

export async function resolvePublisher(
  platform: Platform,
  env: Env,
  repository: D1Repository,
): Promise<Publisher> {
  const cred = await repository.getCredential(platform);
  return buildPublisher(platform, cred, env);
}

export function providerFor(platform: Platform): string {
  const desc = DESCRIPTORS[platform];
  if (!desc.installed) {
    throw new ApiError("Platform is not configured yet: " + platform, 422, "PLATFORM_NOT_CONFIGURED");
  }
  return desc.adapter.providerName;
}
