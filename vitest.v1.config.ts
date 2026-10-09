/**
 * A0 root vitest config for the architecture-v1 packages only.
 *
 * The legacy package trees are intentionally not listed. Each v1 package also
 * has its own `npm test --workspace` entry; this config exists for one focused
 * run across the new tree (`npm run test:v1 -- <filter>`).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/provider-sdk/test/**/*.test.ts",
      "packages/core/test/**/*.test.ts",
      "packages/sdk/test/**/*.test.ts",
      "packages/cli/test/**/*.test.ts",
      "packages/server/test/**/*.test.ts",
      "packages/cloudflare/test/**/*.test.ts",
      "packages/provider-bluesky/test/**/*.test.ts",
      "packages/provider-threads/test/**/*.test.ts",
      "packages/provider-linkedin/test/**/*.test.ts",
      "packages/provider-mastodon/test/**/*.test.ts",
      "packages/provider-devto/test/**/*.test.ts",
      "tests/**/*.test.ts",
      "tests/**/*.spec.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.build/**"],
  },
});
