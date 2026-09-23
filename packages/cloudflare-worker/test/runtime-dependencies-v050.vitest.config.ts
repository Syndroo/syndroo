/**
 * Dedicated vitest project for the lazy runtime dependency composition.
 *
 * Deliberately separate from the Worker's own project: it configures a
 * fail-closed outbound service, discovers exactly the `.native.ts` slice and
 * never reaches the network. The main Worker suite is not used because it has
 * no global outbound isolation.
 *
 * The Worker entry is this slice's own support stub, so the legacy entry graph
 * and its unrelated `Env` type errors stay outside this project.
 *
 * Run: ../../node_modules/.bin/vitest run --config test/runtime-dependencies-v050.vitest.config.ts
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: resolve(here, "support/runtime-dependencies-v050-worker.ts"),
      miniflare: {
        compatibilityDate: "2026-09-03",
        compatibilityFlags: ["nodejs_compat"],
        // Fail closed: this composition performs no outbound request, so any
        // egress attempt must fail loudly instead of leaving the machine.
        outboundService: async () => {
          throw new Error("unexpected outbound request from a composition test");
        },
        cf: false,
      },
    }),
  ],
  test: {
    include: ["test/runtime-dependencies-v050.native.ts"],
    maxWorkers: 1,
    testTimeout: 20_000,
  },
});
