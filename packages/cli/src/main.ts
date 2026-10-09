import { Command, CommanderError } from "commander";

import { CliError } from "./cli-error.js";
import { loadConfig, resolveConfigPath } from "./config.js";
import { EXIT_CODE } from "./exit-codes.js";
import type { CliIo } from "./io.js";
import type { LocalRuntimeOverrides } from "./runtime/local/composition.js";
import { createCommandContext, usageError, type CommandContext } from "./commands/context.js";
import { runConnect, type ConnectOptions } from "./commands/connect.js";
import { runPublish, type PublishOptions } from "./commands/publish.js";
import { runStatus, type StatusOptions } from "./commands/status.js";
import {
  classify,
  failureEnvelope,
  staticMessage,
  type Operation,
} from "./render/envelope.js";
import { cliVersion } from "./version.js";

const COMMANDS: readonly Operation[] = ["connect", "publish", "status"];

/**
 * Global flags, extracted before Commander sees the line.
 *
 * Commander parses options per command, so a root-level `--json` would be an
 * unknown option after `status`. Scanning them here also means a duplicate flag
 * is a usage error instead of a silent last-one-wins, and it removes the need
 * for Commander to echo any part of the invocation.
 */
type Globals = {
  readonly configPath?: string;
  readonly json: boolean;
  readonly verbose: boolean;
  readonly noColor: boolean;
  readonly help: boolean;
  readonly version: boolean;
  readonly rest: readonly string[];
};

function scanGlobals(argv: readonly string[]): Globals {
  const rest: string[] = [];
  let configPath: string | undefined;
  let json = false;
  let verbose = false;
  let noColor = false;
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;

    if (token === "--") {
      rest.push(...argv.slice(index));
      break;
    }

    if (token === "--json") {
      if (json) {
        throw usageError("USAGE");
      }

      json = true;
      continue;
    }

    if (token === "--verbose") {
      if (verbose) {
        throw usageError("USAGE");
      }

      verbose = true;
      continue;
    }

    if (token === "--no-color") {
      if (noColor) {
        throw usageError("USAGE");
      }

      noColor = true;
      continue;
    }

    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }

    if (token === "--version") {
      version = true;
      continue;
    }

    if (token === "--config" || token.startsWith("--config=")) {
      if (configPath !== undefined) {
        throw usageError("USAGE");
      }

      const value = token === "--config" ? argv[index + 1] : token.slice("--config=".length);

      if (value === undefined || value.length === 0) {
        throw usageError("USAGE");
      }

      configPath = value;

      if (token === "--config") {
        index += 1;
      }

      continue;
    }

    rest.push(token);
  }

  return { ...(configPath === undefined ? {} : { configPath }), json, verbose, noColor, help, version, rest };
}

function detectOperation(rest: readonly string[]): Operation | undefined {
  for (const token of rest) {
    if (COMMANDS.includes(token as Operation)) {
      return token as Operation;
    }

    if (!token.startsWith("-")) {
      return undefined;
    }
  }

  return undefined;
}

function reportFailure(
  io: CliIo,
  json: boolean,
  operation: Operation | undefined,
  error: unknown,
): number {
  const failure = classify(error);

  io.stderr.write(`syndroo: ${staticMessage(failure.code)}\n`);

  if (json && operation !== undefined) {
    io.stdout.write(`${JSON.stringify(failureEnvelope(operation, failure.code))}\n`);
  }

  return failure.exit;
}

function buildProgram(io: CliIo): Command {
  const program = new Command();

  program
    .name("syndroo")
    .description("Local-first publish client: connect, prepare, execute and query status.")
    .exitOverride()
    .helpOption(false)
    .allowExcessArguments(false)
    .showHelpAfterError(false)
    .showSuggestionAfterError(false);

  program.configureOutput({
    // Help goes to the real stdout; Commander's own error text is suppressed
    // because it can echo an argv token that was meant to stay secret.
    writeOut: (chunk: string) => {
      io.stdout.write(chunk);
    },
    writeErr: () => undefined,
  });

  return program;
}

function attachCommands(
  program: Command,
  ensureContext: () => Promise<CommandContext>,
  state: { exit: number },
): void {
  program
    .command("connect")
    .description("Connect, update or disconnect a provider account.")
    .argument("[provider]", "provider id, for example bluesky")
    .option("--label <label>", "connection label")
    .option("--connection <connectionId>", "reconnect or refresh an existing connection")
    .option("--from-env", "import credentials from SYNDROO_CREDENTIALS")
    .option("--credential-file <path>", "import credentials from a JSON file")
    .option("--update <connectionId>", "change a connection's label or default flag")
    .option("--disconnect <connectionId>", "disconnect a stored connection")
    .option("--input <file>", "machine ConnectRequest; '-' reads standard input")
    .option("--redirect-uri <uri>", "OAuth redirect URI (default: a loopback URI)")
    .option("--callback-url <url>", "redirected URL to verify; '-' reads it from standard input")
    .option("--default", "mark the connection as default")
    .option("--no-default", "clear the default flag")
    .action(async (provider: string | undefined, options: Record<string, unknown>, command: Command) => {
      const ctx = await ensureContext();
      const source = command.getOptionValueSource("default");
      const defaultFlag =
        source === "cli" && typeof options["default"] === "boolean"
          ? options["default"]
          : undefined;
      const connectOptions: ConnectOptions = {
        ...(typeof options["label"] === "string" ? { label: options["label"] } : {}),
        ...(typeof options["connection"] === "string" ? { connection: options["connection"] } : {}),
        ...(options["fromEnv"] === true ? { fromEnv: true } : {}),
        ...(typeof options["credentialFile"] === "string" ? { credentialFile: options["credentialFile"] } : {}),
        ...(typeof options["update"] === "string" ? { update: options["update"] } : {}),
        ...(typeof options["disconnect"] === "string" ? { disconnect: options["disconnect"] } : {}),
        ...(typeof options["input"] === "string" ? { input: options["input"] } : {}),
        ...(typeof options["redirectUri"] === "string" ? { redirectUri: options["redirectUri"] } : {}),
        ...(typeof options["callbackUrl"] === "string" ? { callbackUrl: options["callbackUrl"] } : {}),
        ...(defaultFlag === undefined ? {} : { default: defaultFlag }),
      };

      state.exit = await runConnect(ctx, provider, connectOptions);
    });

  program
    .command("publish")
    .description("Prepare, execute or retry a publication.")
    .option("--input <file>", "request document; '-' reads standard input")
    .option("--data <json>", "inline request document")
    .option("--retry <operationId>", "retry an operation's eligible targets")
    .option("--to <connectionId>", "retry target connection (repeatable)", collectTo, [])
    .option("--request-id <id>", "stable request identity for this logical call")
    .option("--dry-run", "offline preview; no state, credential or network access")
    .action(async (options: Record<string, unknown>) => {
      const ctx = await ensureContext();
      const publishOptions: PublishOptions = {
        ...(typeof options["input"] === "string" ? { input: options["input"] } : {}),
        ...(typeof options["data"] === "string" ? { data: options["data"] } : {}),
        ...(typeof options["retry"] === "string" ? { retry: options["retry"] } : {}),
        ...(Array.isArray(options["to"]) ? { to: options["to"] as string[] } : {}),
        ...(typeof options["requestId"] === "string" ? { requestId: options["requestId"] } : {}),
        ...(options["dryRun"] === true ? { dryRun: true } : {}),
      };

      state.exit = await runPublish(ctx, publishOptions);
    });

  program
    .command("status")
    .description("Query providers, connections and operations.")
    .option("--provider <providerId>", "one provider")
    .option("--connections", "list stored connections")
    .option("--operation <operationId>", "one operation")
    .option("--operations", "page through operation summaries")
    .option("--limit <count>", "page size for --operations (1-100)")
    .option("--cursor <cursor>", "opaque cursor for --operations")
    .action(async (options: Record<string, unknown>) => {
      const ctx = await ensureContext();
      const statusOptions: StatusOptions = {
        ...(typeof options["provider"] === "string" ? { provider: options["provider"] } : {}),
        ...(options["connections"] === true ? { connections: true } : {}),
        ...(typeof options["operation"] === "string" ? { operation: options["operation"] } : {}),
        ...(options["operations"] === true ? { operations: true } : {}),
        ...(typeof options["limit"] === "string" ? { limit: options["limit"] } : {}),
        ...(typeof options["cursor"] === "string" ? { cursor: options["cursor"] } : {}),
      };

      state.exit = await runStatus(ctx, statusOptions);
    });
}

function collectTo(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

function isCommanderHelp(error: unknown): boolean {
  return (
    error instanceof CommanderError &&
    (error.code === "commander.helpDisplayed" || error.code === "commander.help")
  );
}

/**
 * Run one invocation and return its exit code. This never throws: every failure
 * becomes a stable code, a static message on stderr, and an exit family.
 */
export async function run(
  argv: readonly string[],
  io: CliIo,
  overrides: LocalRuntimeOverrides = {},
): Promise<number> {
  let globals: Globals;

  try {
    globals = scanGlobals(argv);
  } catch (error) {
    return reportFailure(io, false, undefined, error);
  }

  const operation = detectOperation(globals.rest);
  const program = buildProgram(io);
  const state = { exit: EXIT_CODE.SUCCESS as number };
  let context: CommandContext | undefined;

  /**
   * Attaching the commands must happen before help is rendered, so `--help`
   * lists the real surface. Reading the configuration stays lazy: help, version
   * and a bare invocation must work on a machine that never configured Syndroo
   * and must create nothing.
   */
  async function ensureContext(): Promise<CommandContext> {
    if (context === undefined) {
      const config = await loadConfig(resolveConfigPath(io.env, globals.configPath), io.env);
      const color =
        !globals.noColor &&
        (io.env["NO_COLOR"] ?? "") === "" &&
        io.stdoutIsTty;

      context = createCommandContext({
        io,
        json: globals.json,
        verbose: globals.verbose,
        color,
        config,
        overrides,
      });
    }

    return context;
  }

  attachCommands(program, ensureContext, state);

  if (globals.version) {
    io.stdout.write(`${cliVersion()} (node ${process.versions.node})\n`);

    return EXIT_CODE.SUCCESS;
  }

  if (globals.help) {
    const named = COMMANDS.find((command) => globals.rest.includes(command));
    const target = named === undefined ? undefined : program.commands.find((command) => command.name() === named);

    if (target === undefined) {
      program.outputHelp();
    } else {
      target.outputHelp();
    }

    return EXIT_CODE.SUCCESS;
  }

  // A bare invocation answers from the help text and touches nothing.
  if (globals.rest.length === 0) {
    program.outputHelp();

    return EXIT_CODE.SUCCESS;
  }

  try {
    await program.parseAsync([...globals.rest], { from: "user" });
  } catch (error) {
    if (isCommanderHelp(error)) {
      return EXIT_CODE.SUCCESS;
    }

    // Commander raises `CommanderError` for its own refusals (an unknown
    // command or option, excess arguments). Those are reporting-free usage
    // errors. Anything else came out of a command body and already carries its
    // own stable code, so it must not be flattened into `USAGE`.
    return error instanceof CommanderError
      ? reportFailure(io, globals.json, operation, usageError("USAGE"))
      : reportFailure(io, globals.json, operation, error);
  }

  return state.exit;
}

export { CliError };
