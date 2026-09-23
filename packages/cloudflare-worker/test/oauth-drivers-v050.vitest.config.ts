/**
 * Dedicated native-workerd project for the concrete OAuth drivers.
 *
 * The suite runs inside workerd; every outbound request is answered by the
 * fail-closed fixture in `support/oauth-drivers-v050-fixtures.ts`, so nothing
 * here replaces `globalThis.fetch` and nothing reaches the internet.
 *
 * Run: ../../node_modules/.bin/vitest run --config test/oauth-drivers-v050.vitest.config.ts
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { createOAuthDriverFixture } from "./support/oauth-drivers-v050-fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = createOAuthDriverFixture();

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: resolve(here, "support/oauth-drivers-v050-worker.ts"),
      miniflare: {
        compatibilityDate: "2026-09-03",
        compatibilityFlags: ["nodejs_compat"],
        outboundService: fixture.handler,
        cf: false,
      },
    }),
  ],
  test: {
    // Deliberately not a default `*.spec.ts` name: this project owns the only
    // configuration with a fail-closed outbound fixture, and general discovery
    // must never pick the file up without it.
    include: ["test/oauth-drivers-v050.native.ts"],
    maxWorkers: 1,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
