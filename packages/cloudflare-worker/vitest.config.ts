/**
 * Main Worker test project (legacy/default suite).
 *
 * This project no longer inherits the production Wrangler configuration. It
 * declares explicit local-only bindings, a disposable local D1 database, the
 * fixture publication queue and a fail-closed outbound service, so a missing
 * provider mock fails locally instead of making a real request.
 *
 * Dedicated suites own their own configuration and are excluded here:
 * `test/{storage,oauth-drivers,runtime-dependencies,http-body,queue-consumer}-v050.vitest.config.ts`
 * plus the Node-host watchdog project. `test/support/run-worker-tests.ts` runs
 * every project sequentially and keeps a failing project's exit code.
 */
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

import { createWorkerTestProjectOptions } from "./test/support/worker-test-project-v050.js";

export default defineConfig({
  plugins: [cloudflareTest(async () => createWorkerTestProjectOptions())],
  test: {
    include: ["test/**/*.spec.ts"],
    // The crypto/R2 adapters run under `test/storage-v050.vitest.config.ts`,
    // which supplies the local R2 buckets this project does not declare.
    exclude: [...configDefaults.exclude, "test/{crypto,r2}-v050*.spec.ts"],
    // The Worker suites each start their own workerd isolated-storage instance.
    // Running several files in parallel hangs the current vitest/vitest-plugin
    // pair, so the files run serially; concurrency inside a file is unchanged.
    maxWorkers: 1,
    setupFiles: ["./test/setup.ts"],
  },
});
