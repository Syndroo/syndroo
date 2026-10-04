import {
  detectLocalCommand,
  parseArgs,
  wantsJson,
  type ParsedCommand,
} from "./args.js";
import { CliError } from "./cli-error.js";
import type { CommandContext } from "./commands/context.js";
import { classifyFailure, runDoctor } from "./commands/doctor.js";
import { runLocalCommand } from "./commands/local/router.js";
import {
  runCreate,
  runGet,
  runList,
  runValidate,
  runWait,
} from "./commands/posts.js";
import { runSkillPath } from "./commands/skill.js";
import { API_KEY_ENV } from "./config.js";
import { EXIT_CODE } from "./exit-codes.js";
import { commandHelp, generalHelp } from "./help.js";
import type { CliIo } from "./io.js";
import type { LocalRunOverrides } from "./local/composition.js";
import { Reporter, type CommandResult } from "./output.js";
import { cliVersion } from "./version.js";

type Handler = (context: CommandContext) => Promise<CommandResult>;

const HANDLERS: Readonly<Record<string, Handler>> = {
  doctor: runDoctor,
  "posts.validate": runValidate,
  "posts.create": runCreate,
  "posts.list": runList,
  "posts.get": runGet,
  "posts.wait": runWait,
  "skill.path": runSkillPath,
};

/**
 * True when the invocation answers from local metadata only.
 *
 * `help`, `version`, and `skill path` (and any `--help`/`-h` request) never
 * contact an instance, so they must not read the remote key or start the
 * keep-alive timer. Every other legacy command keeps the remote behavior.
 */
function isStaticMetadataInvocation(argv: readonly string[]): boolean {
  if (argv.some(token => token === "--help" || token === "-h")) {
    return true;
  }

  const [first, second] = argv.filter(token => !token.startsWith("-"));

  return (
    first === undefined ||
    first === "help" ||
    first === "version" ||
    (first === "skill" && second === "path")
  );
}

/**
 * Runs one command and returns its exit code. Nothing here throws: a failure
 * becomes a reported result, so `bin.ts` only has to set `process.exitCode`.
 *
 * The optional overrides exist for tests: they inject a fake provider or clock
 * into the local composition. No command-line flag reaches them, so a released
 * binary has exactly one production wiring.
 */
export async function run(
  argv: readonly string[],
  io: CliIo,
  overrides: LocalRunOverrides = {},
): Promise<number> {
  const reporter = new Reporter(io, wantsJson(argv));

  const localCommand = detectLocalCommand(argv);

  if (localCommand !== undefined) {
    return runLocalCommand(localCommand, argv, io, reporter, overrides);
  }

  return runLegacy(argv, io, reporter);
}

/**
 * The legacy remote surface, unchanged.
 *
 * The referenced keep-alive timer exists for `posts wait` only: the SDK
 * unrefs its polling timers, and a CLI must stay alive until its own deadline.
 * Local commands never create it.
 */
async function runLegacy(
  argv: readonly string[],
  io: CliIo,
  reporter: Reporter,
): Promise<number> {
  const staticMetadata = isStaticMetadataInvocation(argv);

  if (!staticMetadata) {
    // The remote instance key is registered only for the remote surface. A
    // static metadata command must never read it, so an unrelated environment
    // value cannot influence its output.
    reporter.addSecret(io.env[API_KEY_ENV]);
  }

  // The keep-alive timer exists for `posts wait` only: the SDK unrefs its
  // polling timers, and a CLI must stay alive until its own deadline. A static
  // metadata command finishes without it.
  const keepAlive = staticMetadata
    ? undefined
    : setInterval(() => {}, 1_000);
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
      // A signal stops this process, never the post: waiting only reads.
      reporter.diagnostic(
        "Stopped locally. The server-side post is unchanged; resume with `syndroo posts get` or `syndroo posts wait`.",
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
  } finally {
    if (keepAlive !== undefined) {
      clearInterval(keepAlive);
    }
  }
}
