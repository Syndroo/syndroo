import type { ExitCode } from "./exit-codes.js";
import type { CliIo } from "./io.js";

/** What a command produced: machine payload, human lines, and how to exit. */
export interface CommandResult {
  readonly payload: Record<string, unknown>;
  readonly human: readonly string[];
  readonly exitCode: ExitCode;
}

/**
 * The single writer for both streams.
 *
 * `--json` promises exactly one JSON object on stdout, so every result goes
 * through here and every human line goes to stderr. Redaction is applied to
 * both streams: a credential must not reach a log even when an error message
 * was assembled from unrelated parts.
 */
export class Reporter {
  readonly #io: CliIo;
  readonly #json: boolean;
  readonly #secrets: string[] = [];

  constructor(io: CliIo, json: boolean) {
    this.#io = io;
    this.#json = json;
  }

  get json(): boolean {
    return this.#json;
  }

  /** Register a value that must never appear in output. */
  addSecret(value: string | undefined): void {
    if (value !== undefined && value.length >= 8) {
      this.#secrets.push(value);
    }
  }

  /** Human-facing context: previews, progress, hints. Always stderr. */
  diagnostic(message: string): void {
    this.#io.stderr.write(this.#redact(message) + "\n");
  }

  /** Human-facing prompt text without a trailing newline. Always stderr. */
  prompt(message: string): void {
    this.#io.stderr.write(this.#redact(message));
  }

  finish(result: CommandResult): void {
    if (this.#json) {
      this.#io.stdout.write(
        this.#redact(
          JSON.stringify({ ...result.payload, exitCode: result.exitCode }) + "\n",
        ),
      );
      return;
    }

    if (result.human.length > 0) {
      this.#io.stdout.write(this.#redact(result.human.join("\n")) + "\n");
    }
  }

  /** A single JSON object in `--json` mode; a plain message otherwise. */
  fail(error: {
    command: string | undefined;
    code: string;
    message: string;
    details?: Record<string, unknown> | undefined;
    exitCode: ExitCode;
  }): void {
    const message = this.#redact(error.message);

    if (this.#json) {
      const payload: Record<string, unknown> = {
        ok: false,
        error: {
          code: error.code,
          message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
        exitCode: error.exitCode,
      };

      if (error.command !== undefined) {
        payload["command"] = error.command;
      }

      this.#io.stdout.write(this.#redact(JSON.stringify(payload) + "\n"));
      return;
    }

    this.#io.stderr.write(`syndroo: ${message}\n`);
  }

  #redact(text: string): string {
    let output = text;

    for (const secret of this.#secrets) {
      output = output.split(secret).join("[redacted]");
    }

    return output;
  }
}
