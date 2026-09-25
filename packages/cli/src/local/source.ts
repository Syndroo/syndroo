import { constants as FS, promises as fs } from "node:fs";
import path from "node:path";

import { CliError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import type { CliIo } from "../io.js";
import { MAX_LOCAL_SOURCE_BYTES } from "./document.js";
import { localError } from "./errors.js";

/**
 * Reading the one document a local command was asked about.
 *
 * This is the only place a local command touches the file system for input, and
 * it is outside the pure parser on purpose: `local/document.ts` never reads a
 * file, an environment variable, or stdin. Bytes are read exactly once and
 * bounded twice: a hard 64 KiB source limit and, for stdin, an elapsed-time
 * limit so a pipe that never closes cannot hang the CLI.
 */

/** How long `--input -` waits for EOF before giving up. */
export const LOCAL_STDIN_TIMEOUT_MS = 15_000;

export interface ReadLocalInputOptions {
  /** Overrides the stdin deadline. Tests only; never a CLI flag. */
  readonly stdinTimeoutMs?: number;
}

function interrupted(): CliError {
  return new CliError("INTERRUPTED: the local process stopped on a signal", {
    code: "INTERRUPTED",
    exitCode: EXIT_CODE.INTERRUPTED,
  });
}

/**
 * The bytes of one local publish document.
 *
 * `-` means stdin, and only an explicit `-` reads stdin: a bare `publish` never
 * waits on a stream that may never close. Paths resolve against the caller's
 * working directory, and no path is ever repeated back in an error.
 */
export async function readLocalInputBytes(
  source: string,
  io: CliIo,
  options: ReadLocalInputOptions = {},
): Promise<Uint8Array> {
  if (io.signal.aborted) {
    throw interrupted();
  }

  return source === "-"
    ? readStdinBytes(io, options.stdinTimeoutMs ?? LOCAL_STDIN_TIMEOUT_MS)
    : readFileBytes(source, io);
}

async function readFileBytes(
  source: string,
  io: CliIo,
): Promise<Uint8Array> {
  const absolute = resolveAgainst(io.cwd, source);
  let handle;

  try {
    handle = await fs.open(
      absolute,
      FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK,
    );
  } catch {
    throw localError("INVALID_DOCUMENT", "the input file cannot be read");
  }

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw localError("INVALID_DOCUMENT", "the input must be a regular file");
    }

    if (stats.size > MAX_LOCAL_SOURCE_BYTES) {
      throw localError(
        "INPUT_TOO_LARGE",
        "the document exceeds the 64 KiB source limit",
      );
    }

    const buffer = Buffer.allocUnsafe(MAX_LOCAL_SOURCE_BYTES + 1);
    let total = 0;

    for (;;) {
      if (io.signal.aborted) {
        throw interrupted();
      }

      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        total,
      );

      if (bytesRead === 0) {
        break;
      }

      total += bytesRead;

      if (total > MAX_LOCAL_SOURCE_BYTES) {
        throw localError(
          "INPUT_TOO_LARGE",
          "the document exceeds the 64 KiB source limit",
        );
      }
    }

    return new Uint8Array(buffer.subarray(0, total));
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    throw localError("INVALID_DOCUMENT", "the input file cannot be read");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readStdinBytes(
  io: CliIo,
  timeoutMs: number,
): Promise<Uint8Array> {
  if (io.stdinIsTty) {
    throw localError(
      "INVALID_DOCUMENT",
      "the document cannot be read from a terminal; pass a file path",
    );
  }

  const iterator = io.stdin[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  const deadline = Date.now() + timeoutMs;
  let total = 0;

  try {
    for (;;) {
      const remaining = deadline - Date.now();

      if (remaining <= 0) {
        throw localError(
          "INVALID_DOCUMENT",
          "the document did not arrive before the input deadline",
        );
      }

      const next = await withDeadline(iterator.next(), remaining, io.signal);

      if (next.done === true) {
        break;
      }

      const chunk = toBytes(next.value);
      total += chunk.byteLength;

      if (total > MAX_LOCAL_SOURCE_BYTES) {
        throw localError(
          "INPUT_TOO_LARGE",
          "the document exceeds the 64 KiB source limit",
        );
      }

      chunks.push(chunk);
    }
  } catch (error) {
    // A parent that holds the pipe open must not keep this process alive after
    // a deadline, an abort, or an oversized document. Release the stream, then
    // report the real reason.
    await releaseStdin(iterator, io);
    throw error;
  }

  const combined = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return combined;
}

/**
 * Stops consuming stdin and destroys the handle; never throws.
 *
 * The destroy happens first: an async iterator's `return()` queues behind a
 * pending `next()`, so awaiting it on a pipe that never closes would hang. The
 * pending cleanup is observed and dropped instead.
 */
async function releaseStdin(
  iterator: AsyncIterator<unknown>,
  io: CliIo,
): Promise<void> {
  try {
    io.stdin.destroy();
  } catch {
    // Nothing else can be done; the exit code already carries the reason.
  }

  try {
    io.stdin.pause();
  } catch {
    // A stream that refuses to pause is already failing.
  }

  const pending = iterator.return?.(undefined);

  if (pending !== undefined) {
    void Promise.resolve(pending).catch(() => undefined);
  }
}

/** One read, bounded by a deadline and by the process abort signal. */
function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(interrupted());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const finish = (run: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      run();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          localError(
            "INVALID_DOCUMENT",
            "the document did not arrive before the input deadline",
          ),
        ),
      );
    }, timeoutMs);
    const onAbort = (): void => {
      finish(() => reject(interrupted()));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

function resolveAgainst(cwd: string, source: string): string {
  return path.resolve(cwd, source);
}

function toBytes(value: unknown): Uint8Array {
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }

  if (value instanceof Uint8Array) {
    return value;
  }

  throw localError("INVALID_DOCUMENT", "the input stream is not readable");
}
