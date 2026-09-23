/**
 * Isolated egress canary for the main Worker test bindings.
 *
 * It reuses exactly the options the main project configures
 * (`support/worker-test-project-v050.ts`), so a passing canary is evidence that
 * the real configured outbound handler rejects unrecognised requests. The
 * canary is a separate project so it can be run on its own before any broader
 * suite, and it is not part of default discovery.
 *
 * Run: ../../node_modules/.bin/vitest run --config test/canary-v050.vitest.config.ts
 */
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { createWorkerTestProjectOptions } from "./support/worker-test-project-v050.js";

export default defineConfig({
  plugins: [cloudflareTest(async () => createWorkerTestProjectOptions())],
  test: {
    include: ["test/canary-v050.native.ts"],
    maxWorkers: 1,
    testTimeout: 20_000,
  },
});
