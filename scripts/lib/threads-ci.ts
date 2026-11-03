/**
 * Compatibility entry point for the historical repository scripts.
 *
 * The implementation now ships inside `@syndroo/cli`; keeping this re-export
 * means existing script callers and tests use the same protocol flow rather
 * than a second copy that can drift.
 */
export * from "../../packages/cli/src/server/threads-flow.js";
