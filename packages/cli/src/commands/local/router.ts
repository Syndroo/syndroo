import { parseArgs, type ParsedCommand } from "../../args.js";
import { CliError, usageError } from "../../cli-error.js";
import { EXIT_CODE, type ExitCode } from "../../exit-codes.js";
import { commandHelp } from "../../help.js";
import type { CliIo } from "../../io.js";
import type { LocalRunOverrides } from "../../local/composition.js";
import type { LocalEnvelopeError, Reporter } from "../../output.js";
import type { CommandContext } from "../context.js";
import {
  runAuthConnect,
  runAuthRemove,
  runAuthSet,
  runAuthStatus,
} from "./auth.js";
import { runDoctorLocal } from "./doctor.js";
import { runInit } from "./init.js";
import { runProvidersList } from "./providers.js";
import { runPublish } from "./publish.js";
import { runReceiptsList, runReceiptsShow } from "./receipts.js";
import { runRetry } from "./retry.js";
import { runStateInspect, runStateRecover } from "./state.js";
import type { LocalCommandOutcome } from "./shared.js";

type Handler = (
  context: CommandContext,
  overrides: LocalRunOverrides,
) => Promise<LocalCommandOutcome>;

const HANDLERS: Readonly<Record<string, Handler>> = {
  init: runInit,
  doctor: runDoctorLocal,
  "providers.list": runProvidersList,
  "auth.set": runAuthSet,
  "auth.status": runAuthStatus,
  "auth.remove": runAuthRemove,
  "auth.connect": runAuthConnect,
  publish: runPublish,
  retry: runRetry,
  "receipts.list": runReceiptsList,
  "receipts.show": runReceiptsShow,
  "state.inspect": runStateInspect,
  "state.recover": runStateRecover,
};

/**
 * Runs one local command and returns its exit code.
 *
 * The detected name is used for a pre-parse failure so a malformed invocation
 * still produces the local envelope, and no argument is ever repeated back.
 * The local error space is deliberately narrower than the legacy one: only a
 * `CliError` carries text, and every other failure becomes a static sentence.
 */
export async function runLocalCommand(
  detected: string,
  argv: readonly string[],
  io: CliIo,
  reporter: Reporter,
  overrides: LocalRunOverrides,
): Promise<number> {
  let parsed: ParsedCommand | undefined;

  try {
    parsed = parseArgs(argv);

    const name = parsed.spec.name;

    if (parsed.help) {
      const text = commandHelp(parsed.spec);

      const emitted = emit(() =>
        reporter.finishLocal(name, {
          ok: true,
          result: { command: name, help: text },
          error: null,
          human: [text],
        }),
      );

      return emitted
        ? EXIT_CODE.SUCCESS
        : outputFailureCode(io, EXIT_CODE.SUCCESS);
    }

    const handler = HANDLERS[name];

    if (handler === undefined) {
      throw usageError("this command has no local handler");
    }

    const outcome = await handler({ parsed, io, reporter }, overrides);

    const emitted = emit(() =>
      reporter.finishLocal(name, {
        ok: outcome.ok,
        result: outcome.result,
        error: outcome.ok
          ? null
          : (outcome.error ?? fallbackError(outcome.exitCode)),
        human: outcome.human,
      }),
    );

    // A result that could not be written is not a clean success.
    return emitted ? outcome.exitCode : outputFailureCode(io, outcome.exitCode);
  } catch (error) {
    const failure = localFailure(io, error);

    const emitted = emit(() =>
      reporter.failLocal(parsed?.spec.name ?? detected, failure.envelope),
    );

    return emitted
      ? failure.exitCode
      : failure.exitCode === EXIT_CODE.SUCCESS
        ? EXIT_CODE.FAILURE
        : failure.exitCode;
  }
}

/**
 * Writes once and never writes again.
 *
 * A closed stdout makes the write throw or emit `EPIPE`; the process boundary
 * owns that, and a second envelope would be a duplicate the contract forbids.
 */
function emit(write: () => void): boolean {
  try {
    write();
    return true;
  } catch {
    // The command's own exit code still describes what happened.
    return false;
  }
}

/** The exit code when the result itself could not be written out. */
function outputFailureCode(io: CliIo, intended: ExitCode): ExitCode {
  if (io.signal.aborted) {
    return EXIT_CODE.INTERRUPTED;
  }

  // An unknown write stays unknown; everything else becomes a plain failure.
  return intended === EXIT_CODE.AMBIGUOUS ? EXIT_CODE.AMBIGUOUS : EXIT_CODE.FAILURE;
}

function localFailure(
  io: CliIo,
  error: unknown,
): { envelope: LocalEnvelopeError; exitCode: ExitCode } {
  const normalized = normalizeAbort(io, error);

  if (normalized instanceof CliError) {
    return {
      envelope: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details === undefined
          ? {}
          : { details: normalized.details }),
      },
      exitCode: normalized.exitCode,
    };
  }

  // An unexpected error is never printed: it can carry a secret, a path, a
  // provider response, or terminal control characters.
  return {
    envelope: {
      code: "UNEXPECTED",
      message: "the local command failed unexpectedly",
    },
    exitCode: io.signal.aborted ? EXIT_CODE.INTERRUPTED : EXIT_CODE.FAILURE,
  };
}

/**
 * A reported abort is a signal exit only when this process really was signalled.
 *
 * A provider call bounded by `--timeout` also aborts, and that is an ordinary
 * runtime failure: it must not claim the operator pressed Ctrl-C. The reverse
 * also holds: a real signal outranks whatever the inner call reported.
 */
function normalizeAbort(io: CliIo, error: unknown): unknown {
  if (
    io.signal.aborted &&
    error instanceof CliError &&
    error.exitCode !== EXIT_CODE.USAGE &&
    error.exitCode !== EXIT_CODE.CANCELLED
  ) {
    return new CliError("INTERRUPTED: the local process stopped on a signal", {
      code: "INTERRUPTED",
      exitCode: EXIT_CODE.INTERRUPTED,
    });
  }

  if (
    error instanceof CliError &&
    error.code === "INTERRUPTED" &&
    !io.signal.aborted
  ) {
    return new CliError(
      "ABORTED: the local call did not complete before its deadline",
      { code: "ABORTED", exitCode: EXIT_CODE.FAILURE },
    );
  }

  return error;
}

/**
 * The envelope still needs a safe error when a handler reports `ok: false`.
 *
 * Handlers with a meaningful failure supply their own; this keeps the envelope
 * complete and documented if one ever does not.
 */
function fallbackError(exitCode: number): LocalEnvelopeError {
  switch (exitCode) {
    case EXIT_CODE.AMBIGUOUS:
      return {
        code: "OUTCOME_UNKNOWN",
        message:
          "at least one write result is unknown; read the receipt before retrying",
      };
    case EXIT_CODE.NOT_DELIVERED:
      return {
        code: "NOT_DELIVERED",
        message: "the run did not deliver every selected target",
      };
    case EXIT_CODE.INTERRUPTED:
      return {
        code: "INTERRUPTED",
        message: "the local process stopped on a signal",
      };
    default:
      return {
        code: "STATE_COMMIT_FAILED",
        message: "the local command did not complete successfully",
      };
  }
}
