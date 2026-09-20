import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const e2eDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * Layer 2 project. It runs exactly one spec, which is only meaningful with
 * `SYNDROO_CONSUMER_DIR` pointing at an install performed by
 * `scripts/e2e-consumer.ts` outside this monorepo.
 */
export default defineConfig({
  root: e2eDirectory,
  test: {
    include: ["test/consumer.e2e.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
