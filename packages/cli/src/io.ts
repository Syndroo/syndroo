import { closeSync, openSync, readSync } from "node:fs";
import type { Readable, Writable } from "node:stream";

/**
 * Everything the commands touch from the outside world. Tests build their own
 * implementation instead of reaching for `process.*`, so a test can prove what
 * the CLI did without redirecting global state.
 */
export interface CliIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  /** Only the process environment. The CLI never reads `.env`, `.dev.vars`, or a config file. */
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  /** `true` when a controlling terminal can be opened for interactive confirmation. */
  readonly hasTty: () => boolean;
  /**
   * Reads one line from the controlling terminal. Reading from `/dev/tty`
   * rather than stdin matters: stdin may already be the post document.
   */
  readonly readTtyLine: (limitMs: number) => string | undefined;
  readonly signal: AbortSignal;
}

const TTY_READ_SLICE_MS = 5;

/**
 * Blocking read from the controlling terminal.
 *
 * `readSync` can report `EAGAIN` on a non-blocking pty, so a bounded wait runs
 * between attempts instead of a busy spin. `limitMs` guards against a wedged
 * terminal; it is not an input timeout for a human.
 */
function readTtyLineFromFd(fd: number, limitMs: number): string | undefined {
  const deadline = Date.now() + limitMs;
  const byte = Buffer.alloc(1);
  let line = "";

  for (;;) {
    if (Date.now() > deadline) {
      return line.length > 0 ? line : undefined;
    }

    let read = 0;

    try {
      read = readSync(fd, byte, 0, 1, null);
    } catch (error) {
      if ((error as { code?: string }).code === "EAGAIN") {
        sleepSync(TTY_READ_SLICE_MS);
        continue;
      }

      return undefined;
    }

    if (read === 0) {
      return line.length > 0 ? line : undefined;
    }

    const character = byte.toString("utf8");

    if (character === "\n") {
      return line;
    }

    if (character !== "\r") {
      line += character;
    }
  }
}

/** Synchronous sleep so the terminal read stays a plain blocking call. */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

export function createProcessIo(signal: AbortSignal): CliIo {
  const stdin = process.stdin;

  return {
    stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    stdinIsTty: stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
    hasTty: () => {
      try {
        closeSync(openSync("/dev/tty", "r"));
        return true;
      } catch {
        return false;
      }
    },
    readTtyLine: (limitMs: number) => {
      let fd: number;

      try {
        fd = openSync("/dev/tty", "r");
      } catch {
        return undefined;
      }

      try {
        return readTtyLineFromFd(fd, limitMs);
      } finally {
        closeSync(fd);
      }
    },
    signal,
  };
}
