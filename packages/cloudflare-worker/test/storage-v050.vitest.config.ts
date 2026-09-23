/**
 * Dedicated vitest project for the 0.5.0 crypto and R2 adapters.
 *
 * Deliberately separate from the Worker's own project: it configures local R2
 * buckets and a fail-closed outbound service without touching production
 * configuration, and it never reaches the network.
 *
 * Run: ../../node_modules/.bin/vitest run --config test/storage-v050.vitest.config.ts
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: resolve(here, "../src/index.ts"),
      miniflare: {
        compatibilityDate: "2026-09-03",
        compatibilityFlags: ["nodejs_compat"],
        r2Buckets: {
          ARCHIVE_BUCKET: "syndroo-archive-v050-fixture",
          MEDIA_BUCKET: "syndroo-media-v050-fixture",
        },
        // Fail closed: these adapters never make an outbound request, so any
        // egress attempt must fail loudly instead of leaving the machine.
        outboundService: async () => {
          throw new Error("unexpected outbound request from a storage/crypto test");
        },
        cf: false,
      },
    }),
  ],
  test: {
    include: ["test/{crypto,r2}-v050*.spec.ts"],
    maxWorkers: 1,
    testTimeout: 20_000,
  },
});
