/**
 * Node-side project for the transport.
 *
 * The native workerd fixtures live in `test-workerd` and run through
 * `vitest.workerd.config.ts`; this project must not collect them, because
 * without the Workers pool they would run in plain Node and fail.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.spec.ts"],
  },
});
