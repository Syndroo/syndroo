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
  #requestCounts: Record<string, unknown> | undefined;

  constructor(io: CliIo, json: boolean) {
    this.#io = io;
    this.#json = json;
  }

  get json(): boolean {
    return this.#json;
  }

  /**
   * Records what this command actually sent, so a failure payload carries the
   * same truthful counts a success payload would. Nothing that failed before
   * dispatch can therefore look like a sent request.
   */
  setRequestCounts(counts: Record<string, unknown>): void {
    this.#requestCounts = counts;
  }

  /** Register a value that must never appear in output. */
  addSecret(value: string | undefined): void {
    if (value !== undefined && value.length > 0) {
      this.#secrets.push(value);
    }
  }

  /** Human-facing context: previews, progress, hints. Always stderr. */
  diagnostic(message: string): void {
    this.#io.stderr.write(this.#redactText(message) + "\n");
  }

  /** Human-facing prompt text without a trailing newline. Always stderr. */
  prompt(message: string): void {
    this.#io.stderr.write(this.#redactText(message));
  }

  finish(result: CommandResult): void {
    if (this.#json) {
      this.#io.stdout.write(
        JSON.stringify(
          this.#redactValue({ ...result.payload, exitCode: result.exitCode }),
        ) + "\n",
      );
      return;
    }

    if (result.human.length > 0) {
      this.#io.stdout.write(this.#redactText(result.human.join("\n")) + "\n");
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
    const message = this.#redactText(error.message);

    if (this.#json) {
      const payload: Record<string, unknown> = {
        ok: false,
        ...(this.#requestCounts === undefined
          ? {}
          : { authRequests: this.#requestCounts }),
        error: {
          code: error.code,
          message,
          ...(error.details === undefined
            ? {}
            : { details: this.#redactValue(error.details) }),
        },
        exitCode: error.exitCode,
      };

      if (error.command !== undefined) {
        payload["command"] = error.command;
      }

      this.#io.stdout.write(JSON.stringify(this.#redactValue(payload)) + "\n");
      return;
    }

    this.#io.stderr.write(`syndroo: ${message}\n`);
  }

  #redactText(text: string): string {
    let output = text;

    for (const secret of this.#secrets) {
      output = output.split(secret).join("[redacted]");
    }

    return output;
  }

  /**
   * Redacts structured values before serialization.
   *
   * Replacing bytes in already-serialized JSON cannot see an escaped secret and
   * can corrupt the document. Redacting values first keeps exactly one valid
   * JSON object and never rewrites a key, so short secrets are covered without
   * turning field names into "[redacted]".
   */
  #redactValue(value: unknown): unknown {
    if (typeof value === "string") {
      return this.#redactText(value);
    }

    if (Array.isArray(value)) {
      return value.map(entry => this.#redactValue(entry));
    }

    if (typeof value === "object" && value !== null) {
      const copy = Object.create(null) as Record<string, unknown>;

      for (const key of Object.keys(value)) {
        copy[key] = this.#redactValue((value as Record<string, unknown>)[key]);
      }

      return copy;
    }

    return value;
  }
}
