/**
 * Node-host project for the bounded-run watchdog and the discovery inventory.
 *
 * Both suites spawn or inspect host processes, so they must never run inside
 * workerd and must never be picked up by the Worker project's default
 * discovery. This project is the only owner of these two files.
 *
 * Run: ../../node_modules/.bin/vitest run --config test/host-v050.vitest.config.ts
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/{watchdog,inventory}-v050.native.ts"],
    environment: "node",
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
