/**
 * Native workerd project for the transport.
 *
 * These tests run inside the real Workers runtime, so they prove the policy is
 * accepted by workerd's own `fetch` implementation rather than by a JavaScript
 * stub. They are partial evidence for NET-03/NET-04: the production-bundle
 * end-to-end chain is assembled by the integration task.
 *
 * Run: ../../node_modules/.bin/vitest run --config vitest.workerd.config.ts
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { createOutboundFixture } from "./test-workerd/outbound-fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outbound = createOutboundFixture();

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: resolve(here, "test-workerd/fixture-worker.ts"),
      miniflare: {
        compatibilityDate: "2026-09-03",
        compatibilityFlags: ["nodejs_compat"],
        // Fail closed: the handler answers listed fixtures and throws for every
        // other destination, so no test can reach the real internet. It is the
        // same shape the isolated crosspost experiment uses.
        outboundService: outbound.handler,
        cf: false,
      },
    }),
  ],
  test: {
    include: ["test-workerd/**/*.spec.ts"],
    maxWorkers: 1,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
