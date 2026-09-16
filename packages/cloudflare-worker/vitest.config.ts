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
          THREADS_ACCESS_TOKEN: "not-a-real-token",
        },
      },
    })),
  ],
  test: {
    // The Worker suites each start their own workerd isolated-storage instance.
    // Running several files in parallel hangs the current vitest/vitest-plugin
    // pair, so the files run serially; concurrency inside a file is unchanged.
    maxWorkers: 1,
    setupFiles: ["./test/setup.ts"],
  },
});
