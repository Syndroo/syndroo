/**
 * Dedicated vitest project for the scheduled-runtime deadline wrapper.
 *
 * Deliberately separate from the Worker's own project: it configures a
 * fail-closed outbound service, discovers exactly the `.native.ts` slice and
 * never reaches the network. The main Worker test setup/runner and its watchdog
 * are untouched by this project.
 *
 * Run (externally guarded, reviewed bounded-run.ts):
 *   node test/support/bounded-run.ts --timeout-ms 300000 --label scheduled-maintenance \
 *     --log /tmp/scheduled-maintenance.log -- ../../node_modules/.bin/vitest run \
 *     --config test/scheduled-maintenance-v050.vitest.config.ts
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Own support stub: the legacy Worker entry graph stays outside this project.
      main: resolve(here, "support/scheduled-maintenance-v050-worker.ts"),
      miniflare: {
        compatibilityDate: "2026-09-03",
        compatibilityFlags: ["nodejs_compat"],
        // Fail closed: this slice performs no outbound request, so any egress
        // attempt must fail loudly instead of leaving the machine.
        outboundService: async () => {
          throw new Error("unexpected outbound request from a scheduled-maintenance test");
        },
        cf: false,
      },
    }),
  ],
  test: {
    include: ["test/scheduled-maintenance-v050.native.ts"],
    maxWorkers: 1,
    testTimeout: 20_000,
  },
});
