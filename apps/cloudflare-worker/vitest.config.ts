import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: {
        configPath: resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../../wrangler.jsonc",
        ),
      },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            resolve(dirname(fileURLToPath(import.meta.url)), "migrations"),
          ),
          SYNDROO_API_KEY: "test-api-key",
          BLUESKY_IDENTIFIER: "test.invalid",
          BLUESKY_PASSWORD: "not-a-real-password",
          BLUESKY_HOST: "bsky.social",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
