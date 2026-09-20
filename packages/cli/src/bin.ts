#!/usr/bin/env node
import { createProcessIo } from "./io.js";
import { run } from "./main.js";

/**
 * The published entry point.
 *
 * A signal stops this client, not the post: `posts wait` only reads, so the
 * server-side work continues. The signal is turned into an abort so an
 * in-flight request is cut cleanly and the exit code still says what happened.
 */
const controller = new AbortController();

const stop = (signal: NodeJS.Signals): void => {
  controller.abort(new Error(`stopped by ${signal}`));
};

process.once("SIGINT", () => {
  stop("SIGINT");
});

process.once("SIGTERM", () => {
  stop("SIGTERM");
});

const io = createProcessIo(controller.signal);

run(process.argv.slice(2), io).then(
  code => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `syndroo: unexpected failure: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
