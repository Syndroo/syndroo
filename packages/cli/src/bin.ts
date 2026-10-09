#!/usr/bin/env node
import { EXIT_CODE } from "./exit-codes.js";
import { createProcessIo } from "./io.js";
import { run } from "./main.js";

/**
 * The published entry point.
 *
 * A signal stops this client. Local cancellation never claims it cancelled a
 * write that already left the process, so a signalled run exits 130 whatever a
 * raced-in result says.
 */
const controller = new AbortController();
let stoppedBy: NodeJS.Signals | undefined;

const stop = (signal: NodeJS.Signals): void => {
  stoppedBy = signal;
  controller.abort(new Error(`stopped by ${signal}`));
};

process.once("SIGINT", () => {
  stop("SIGINT");
});

process.once("SIGTERM", () => {
  stop("SIGTERM");
});

/**
 * A closed consumer is not a crash.
 *
 * `syndroo status | head` closes the pipe while the CLI still writes. The result
 * was already produced, so the process leaves with a non-zero code and no stack
 * trace instead of dying on an unhandled `EPIPE`.
 */
function tolerateClosedPipe(stream: NodeJS.WriteStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(process.exitCode === 0 ? EXIT_CODE.USAGE : process.exitCode ?? EXIT_CODE.USAGE);
    }

    throw error;
  });
}

tolerateClosedPipe(process.stdout);
tolerateClosedPipe(process.stderr);

const io = createProcessIo(controller.signal);

run(process.argv.slice(2), io).then(
  (code) => {
    process.exitCode = stoppedBy === undefined ? code : EXIT_CODE.INTERRUPTED;
  },
  () => {
    // A failure here means the reporting path itself failed. Never print the raw
    // error: it can carry a secret, a path, or terminal control characters.
    process.stderr.write("syndroo: the command could not be reported\n");
    process.exitCode = stoppedBy === undefined ? EXIT_CODE.FAILURE : EXIT_CODE.INTERRUPTED;
  },
);
