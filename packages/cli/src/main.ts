import { parseArgs, wantsJson, type ParsedCommand } from "./args.js";
import { CliError } from "./cli-error.js";
import type { CommandContext } from "./commands/context.js";
import { classifyFailure, runDoctor } from "./commands/doctor.js";
import {
  runCreate,
  runGet,
  runList,
  runValidate,
  runWait,
} from "./commands/posts.js";
import {
  runAuthComplete,
  runAuthConnect,
  runAuthOperation,
  runAuthRefresh,
  runAuthRemove,
  runAuthSet,
  runAuthStatus,
  runDiagnostics,
} from "./commands/auth.js";
import { runSkillPath } from "./commands/skill.js";
import { API_KEY_ENV } from "./config.js";
import { EXIT_CODE } from "./exit-codes.js";
import { commandHelp, generalHelp } from "./help.js";
import type { CliIo } from "./io.js";
import { Reporter, type CommandResult } from "./output.js";
import { cliVersion } from "./version.js";

type Handler = (context: CommandContext) => Promise<CommandResult>;

const HANDLERS: Readonly<Record<string, Handler>> = {
  doctor: runDoctor,
  "auth.status": runAuthStatus,
  "auth.set": runAuthSet,
  "auth.connect": runAuthConnect,
  "auth.operation": runAuthOperation,
  "auth.complete": runAuthComplete,
  "auth.refresh": runAuthRefresh,
  "auth.remove": runAuthRemove,
  diagnostics: runDiagnostics,
  "posts.validate": runValidate,
  "posts.create": runCreate,
  "posts.list": runList,
  "posts.get": runGet,
  "posts.wait": runWait,
  "skill.path": runSkillPath,
};

/**
 * Runs one command and returns its exit code. Nothing here throws: a failure
 * becomes a reported result, so `bin.ts` only has to set `process.exitCode`.
 */
export async function run(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  const reporter = new Reporter(io, wantsJson(argv));
  reporter.addSecret(io.env[API_KEY_ENV]);

  let parsed: ParsedCommand | undefined;

  try {
    parsed = parseArgs(argv);

    if (parsed.command === "help" || parsed.help) {
      const text =
        parsed.command === "help" ? generalHelp() : commandHelp(parsed.spec);
      reporter.finish({
        payload: { command: "help", ok: true, help: text },
        human: [text],
        exitCode: EXIT_CODE.SUCCESS,
      });
      return EXIT_CODE.SUCCESS;
    }

    if (parsed.command === "version") {
      const version = cliVersion();
      reporter.finish({
        payload: {
          command: "version",
          ok: true,
          name: "@syndroo/cli",
          version,
          node: process.versions.node,
        },
        human: [`@syndroo/cli ${version} (node ${process.versions.node})`],
        exitCode: EXIT_CODE.SUCCESS,
      });
      return EXIT_CODE.SUCCESS;
    }

    const handler = HANDLERS[parsed.command];

    if (handler === undefined) {
      throw new CliError(`no handler for "${parsed.command}"`, {
        exitCode: EXIT_CODE.USAGE,
        code: "USAGE",
      });
    }

    const result = await handler({ parsed, io, reporter });
    reporter.finish(result);
    return result.exitCode;
  } catch (error) {
    const failure = classifyFailure(error);
    const details =
      error instanceof CliError && error.details !== undefined
        ? error.details
        : undefined;

    if (failure.code === "ABORTED") {
      // A signal stops this process, never the server-side work. The advice
      // follows the command that ran, so an interrupted auth write never sends
      // the operator to a post key.
      reporter.diagnostic(
        parsed?.command?.startsWith("auth") === true
          ? "Stopped locally. Nothing was retried; inspect `syndroo auth status`, and `syndroo auth operation` for an operation you had already started, before trying again."
          : parsed?.command === "diagnostics" || parsed?.command === "doctor"
            ? "Stopped locally. This command only reads, so nothing changed on the instance."
            : "Stopped locally. The server-side post is unchanged; resume with `syndroo posts get` or `syndroo posts wait`.",
      );
    }

    reporter.fail({
      command: parsed?.command,
      code: failure.code,
      message: failure.message,
      details,
      exitCode: failure.exitCode,
    });

    return failure.exitCode;
  }
}
