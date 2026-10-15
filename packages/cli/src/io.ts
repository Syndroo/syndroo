import { spawnSync } from "node:child_process";
import { closeSync, constants as fsConstants, openSync, readSync, writeSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { TextDecoder } from "node:util";

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
  /**
   * Terminal width in columns, when one can be read.
   *
   * Optional: an appended log with no readable width uses a fixed 80-column
   * layout instead. `--no-color` never changes this value.
   */
  readonly columns?: number | undefined;
  /**
   * Terminal height in rows, when one can be read.
   *
   * The dynamic publication block only redraws in place when it fits here;
   * a missing height degrades to the appended log rather than guessing.
   */
  readonly rows?: number | undefined;
  /**
   * Subscribes to terminal resize events and returns the unsubscribe function.
   *
   * Optional so a test double with a fixed size keeps working; a terminal that
   * cannot report resize simply never redraws on one.
   */
  readonly onResize?: (listener: () => void) => () => void;
  /** `true` when a controlling terminal can be opened for interactive confirmation. */
  readonly hasTty: () => boolean;
  /**
   * Writes to the controlling terminal, independent of stdout.
   *
   * A confirmation preview and its prompt must be visible even when stdout is
   * redirected, so they never share the machine output channel. Returns
   * `false` when no controlling terminal can be written; the caller must then
   * not block on an answer it cannot show. Optional so test doubles that never
   * touch a terminal keep working.
   */
  readonly writeTty?: (text: string) => boolean;
  /**
   * Reads one line from the controlling terminal. Reading from `/dev/tty`
   * rather than stdin matters: stdin may already be the post document.
   */
  readonly readTtyLine: (limitMs: number) => string | undefined;
  /**
   * Reads one secret line from the controlling terminal with echo disabled.
   *
   * Optional so every existing test double keeps working; production supplies
   * the real implementation. Never used for piped document stdin.
   */
  readonly readHiddenTtyLine?: (
    limitMs: number,
    signal?: AbortSignal,
    onReady?: () => void,
  ) => Promise<string | undefined>;
  readonly signal: AbortSignal;
}

/**
 * Bound for one interactive terminal read, in milliseconds.
 *
 * This is not an input timeout for a human: it only keeps a wedged terminal
 * from blocking forever. A read that already collected characters returns them
 * when the bound is reached, so a slow typist never loses a partial answer.
 */
export const INTERACTIVE_READ_LIMIT_MS = 600_000;

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

/** Longest secret line accepted from the terminal, in bytes. */
const MAX_HIDDEN_LINE_BYTES = 8_192;

/**
 * Echo control on the controlling terminal.
 *
 * `stty` receives only a flag (or the saved settings token) and a descriptor;
 * no secret is ever an argument or an environment value.
 */
function runStty(fd: number, args: readonly string[]): boolean {
  const result = spawnSync("stty", args, {
    stdio: [fd, "ignore", "ignore"],
  });

  return result.status === 0;
}

/**
 * Reads the current terminal settings so they can be restored exactly.
 *
 * The settings token is opaque: it is format-checked, then passed back as a
 * single `stty` argument. No shell is involved.
 */
function readTerminalSettings(fd: number): string | undefined {
  const result = spawnSync("stty", ["-g"], {
    stdio: [fd, "pipe", "ignore"],
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return undefined;
  }

  const settings = result.stdout.trim();

  // Printable ASCII only: no control characters and no newline injection. The
  // token is still passed as one argv element, never through a shell.
  return /^[\x20-\x7e]{1,4096}$/.test(settings) ? settings : undefined;
}

/**
 * Writes raw bytes to one controlling-terminal descriptor.
 *
 * `write` may accept fewer bytes than requested, so the loop continues until
 * every byte is written or the terminal reports an error.
 */
function writeTtyFromFd(fd: number, text: string): boolean {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;

  try {
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
  } catch {
    return false;
  }

  return true;
}

/** The writable controlling-terminal descriptor used only for `stty`. */
function openHiddenTtyControl(): number | undefined {
  try {
    return openSync(
      "/dev/tty",
      fsConstants.O_RDWR | fsConstants.O_NONBLOCK,
    );
  } catch {
    return undefined;
  }
}

/**
 * Reads one line with echo disabled, restoring echo on every exit path.
 *
 * Bytes are collected raw and decoded once as strict UTF-8, so a partial
 * multibyte character is never produced by a byte-at-a-time decode.
 */
async function readHiddenTtyLineFromFd(
  fd: number,
  limitMs: number,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const deadline = Date.now() + limitMs;
  const bytes: number[] = [];
  const byte = Buffer.alloc(1);

  for (;;) {
    if (
      (signal?.aborted ?? false) ||
      Date.now() > deadline ||
      bytes.length >= MAX_HIDDEN_LINE_BYTES
    ) {
      return undefined;
    }

    let read = 0;

    try {
      read = readSync(fd, byte, 0, 1, null);
    } catch (error) {
      if ((error as { code?: string }).code === "EAGAIN") {
        // A real await: timers, AbortSignal listeners, and signal callbacks run
        // while this loop is idle. A synchronous sleep would block them all.
        await delay(TTY_READ_SLICE_MS);
        continue;
      }

      return undefined;
    }

    if (read === 0) {
      break;
    }

    if (byte[0] === 0x0a) {
      break;
    }

    if (byte[0] !== 0x0d) {
      bytes.push(byte[0] as number);
    }
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
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
    /**
     * Read per access, not captured once: a redraw after a resize must see the
     * new width and height (`process.stdout.columns` is itself a live getter).
     */
    get columns(): number | undefined {
      return process.stdout.columns;
    },
    get rows(): number | undefined {
      return process.stdout.rows;
    },
    onResize: (listener: () => void) => {
      process.stdout.on("resize", listener);

      return () => {
        process.stdout.off("resize", listener);
      };
    },
    hasTty: () => {
      try {
        closeSync(openSync("/dev/tty", "r"));
        return true;
      } catch {
        return false;
      }
    },
    writeTty: (text: string) => {
      let fd: number;

      try {
        fd = openSync("/dev/tty", fsConstants.O_WRONLY);
      } catch {
        return false;
      }

      try {
        return writeTtyFromFd(fd, text);
      } finally {
        closeSync(fd);
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
    readHiddenTtyLine: async (
      limitMs: number,
      signal?: AbortSignal,
      onReady?: () => void,
    ) => {
      // Non-blocking, and the wait below is a real await, so an abort or a
      // deadline is observed while a human is still typing.
      const controlFd = openHiddenTtyControl();

      if (controlFd === undefined) {
        return undefined;
      }

      const saved = readTerminalSettings(controlFd);

      if (saved === undefined) {
        closeSync(controlFd);

        return undefined;
      }

      try {
        if (!runStty(controlFd, ["-echo"])) {
          return undefined;
        }

        // A fresh, read-only, non-blocking descriptor is opened only after echo
        // is off. It is never handed to a subprocess: `stty` on the control fd
        // cannot clear O_NONBLOCK on the descriptor this loop reads.
        const readFd = openSync(
          "/dev/tty",
          fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
        );

        try {
          // The prompt is emitted only after echo is really off, so a fast
          // typist can never race the echo change. It runs inside the cleanup
          // scope: a throwing callback must not leak the read descriptor.
          onReady?.();

          return await readHiddenTtyLineFromFd(readFd, limitMs, signal);
        } finally {
          closeSync(readFd);
        }
      } finally {
        // The original settings are restored exactly - even if echo was already
        // off - on success, refusal, deadline, and abort. Only SIGKILL bypasses
        // this.
        runStty(controlFd, [saved]);

        closeSync(controlFd);
      }
    },
    signal,
  };
}
