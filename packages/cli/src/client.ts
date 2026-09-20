import { SyndrooClient } from "@syndroo/sdk";

import type { ResolvedConfig } from "./config.js";

/**
 * The CLI owns no authentication, retry, or polling logic: it hands the
 * configuration to the SDK and calls exactly one SDK method per user request.
 * The abort signal travels per call, because the SDK owns that request's
 * lifetime.
 */
export function createClient(config: ResolvedConfig): SyndrooClient {
  return new SyndrooClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });
}
