import { EXIT_CODE, type ExitCode } from "./exit-codes.js";

/** A failure this CLI predicted, with the exit code and detail it should report. */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    message: string,
    options: {
      exitCode?: ExitCode;
      code?: string;
      details?: Record<string, unknown> | undefined;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "CliError";
    this.exitCode = options.exitCode ?? EXIT_CODE.FAILURE;
    this.code = options.code ?? "CLI_ERROR";
    this.details = options.details;
  }
}

/** The invocation itself is wrong, so no request may be sent. */
export function usageError(
  message: string,
  details?: Record<string, unknown>,
): CliError {
  return new CliError(message, {
    exitCode: EXIT_CODE.USAGE,
    code: "USAGE",
    details,
  });
}

/** The instance configuration is missing or unusable. Read-only, no request sent. */
export function configError(
  message: string,
  details?: Record<string, unknown>,
): CliError {
  return new CliError(message, {
    exitCode: EXIT_CODE.USAGE,
    code: "CONFIG",
    details,
  });
}
