#!/usr/bin/env node
import { createProcessIo } from "./io.js";
import { run } from "./main.js";

/**
 * The published entry point.
 *
 * A signal stops this client. A local run never claims it cancelled a write
 * that already left the process, and a legacy `posts wait` only ever reads.
 * The exit code is 130 whenever this process was actually signalled, whatever
 * a raced-in result says.
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
 * `syndroo ... | head` closes the pipe while the CLI still writes. The result
 * was already produced and persisted, so the process leaves with a non-zero
 * code and no stack trace instead of dying on an unhandled `EPIPE`.
 */
const tolerateClosedPipe = (stream: NodeJS.WriteStream): void => {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(process.exitCode === 0 ? 1 : (process.exitCode ?? 1));
    }

    throw error;
  });
};

tolerateClosedPipe(process.stdout);
tolerateClosedPipe(process.stderr);

const io = createProcessIo(controller.signal);

run(process.argv.slice(2), io).then(
  code => {
    process.exitCode = stoppedBy === undefined ? code : 130;
  },
  () => {
    // `run` reports every failure itself, so reaching this handler means the
    // reporting path failed. Never print the raw error: it can carry a secret,
    // a path, or terminal control characters.
    process.stderr.write("syndroo: the command could not be reported\n");
    process.exitCode = stoppedBy === undefined ? 1 : 130;
  },
);
