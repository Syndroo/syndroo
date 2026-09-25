import type { ExitCode } from "./exit-codes.js";
import type { CliIo } from "./io.js";

/** What a command produced: machine payload, human lines, and how to exit. */
export interface CommandResult {
  readonly payload: Record<string, unknown>;
  readonly human: readonly string[];
  readonly exitCode: ExitCode;
}

/** The safe, bounded error object of the local envelope (`04` §5). */
export interface LocalEnvelopeError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown> | undefined;
}

/** The local command envelope. It has no `exitCode` field on purpose. */
export interface LocalEnvelope {
  readonly command: string;
  readonly ok: boolean;
  readonly result: unknown;
  readonly error: LocalEnvelopeError | null;
}

/**
 * Escape the control characters a terminal can act on.
 *
 * Line breaks are preserved so a caller can compose several lines, but CR, ESC,
 * tabs, and the C1 block are rendered as `\uXXXX`. JSON payloads are untouched:
 * `JSON.stringify` already escapes them, and the payload must stay byte-exact.
 */
export function escapeOutputText(value: string): string {
  return value
    .split("\n")
    .map(line =>
      line.replace(
        /[\u0000-\u001f\u007f-\u009f]/gu,
        character =>
          `\\u${(character.codePointAt(0) as number)
            .toString(16)
            .padStart(4, "0")}`,
      ),
    )
    .join("\n");
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

  /** Human-facing local diagnostic: redacted and control-escaped, on stderr. */
  localDiagnostic(message: string): void {
    this.#io.stderr.write(escapeOutputText(this.#redact(message)) + "\n");
  }

  /** Local prompt text without a trailing newline. Always stderr. */
  localPrompt(message: string): void {
    this.#io.stderr.write(escapeOutputText(this.#redact(message)));
  }

  /**
   * The one local result envelope.
   *
   * `--json` writes exactly one object to stdout; human mode writes the safe
   * lines to stdout and never appends the legacy `exitCode` field.
   */
  finishLocal(
    command: string,
    outcome: {
      readonly ok: boolean;
      readonly result: unknown;
      readonly error: LocalEnvelopeError | null;
      readonly human: readonly string[];
    },
  ): void {
    if (this.#json) {
      const envelope = {
        schemaVersion: 1,
        command,
        mode: "local",
        ok: outcome.ok,
        result: outcome.result,
        error: outcome.error,
      };

      this.#io.stdout.write(this.#redact(JSON.stringify(envelope) + "\n"));
      return;
    }

    const human = outcome.human
      .map(line => escapeOutputText(this.#redact(line)))
      .filter(line => line.length > 0);

    if (human.length > 0) {
      this.#io.stdout.write(`${human.join("\n")}\n`);
    }
  }

  /** A local failure before or after parsing: same envelope, `ok: false`. */
  failLocal(command: string, error: LocalEnvelopeError): void {
    const message = this.#redact(error.message);

    if (this.#json) {
      this.finishLocal(command, {
        ok: false,
        result: null,
        error: { ...error, message },
        human: [],
      });
      return;
    }

    // The code is part of the human line too, so a scriptless operator sees the
    // same distinction a `--json` consumer branches on.
    const text = message.startsWith(`${error.code}:`)
      ? message
      : `${error.code}: ${message}`;

    this.#io.stderr.write(`syndroo: ${escapeOutputText(text)}\n`);
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
