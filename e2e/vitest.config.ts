import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const e2eDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * Node-side Vitest project for the Mock SNS end-to-end gate. Tests start their
 * own workerd instance through Miniflare, so the Workers Vitest pool is not
 * used here: the loopback Mock SNS server and socket-level fault injection must
 * run in Node, outside the Worker sandbox.
 */
export default defineConfig({
  root: e2eDirectory,
  test: {
    include: ["test/**/*.spec.ts"],
    environment: "node",
    // Each spec starts a workerd instance and two loopback servers.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
