import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The suite starts real subprocesses and, for the TTY cases, a real
    // pseudo-terminal. Both are far slower than in-process assertions.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
