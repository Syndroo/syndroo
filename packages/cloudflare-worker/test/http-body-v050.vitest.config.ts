/**
 * Dedicated native-workerd project for the inbound HTTP body reader.
 *
 * The reader never makes an outbound request, so egress is fail-closed: any
 * outbound attempt answers with a fixed 500 instead of leaving the machine.
 * The suite is deliberately not named `*.spec.ts`, so general discovery cannot
 * pick it up without this configuration.
 *
 * Run: ../../node_modules/.bin/vitest run --config test/http-body-v050.vitest.config.ts
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: resolve(here, "support/http-body-v050-worker.ts"),
      miniflare: {
        compatibilityDate: "2026-09-03",
        compatibilityFlags: ["nodejs_compat"],
        // Fail closed: this boundary never makes an outbound request, so any
        // egress attempt must fail loudly instead of leaving the machine.
        outboundService: async () => {
          throw new Error("unexpected outbound request from an HTTP body test");
        },
        cf: false,
      },
    }),
  ],
  test: {
    include: ["test/http-body-v050.native.ts"],
    maxWorkers: 1,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
