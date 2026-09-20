import type { ParsedCommand } from "../args.js";
import { usageError } from "../cli-error.js";
import type { CliIo } from "../io.js";
import type { Reporter } from "../output.js";

/** Everything a command may use. No command reaches for `process.*` directly. */
export interface CommandContext {
  readonly parsed: ParsedCommand;
  readonly io: CliIo;
  readonly reporter: Reporter;
}

export function flagValue(
  context: CommandContext,
  name: string,
): string | undefined {
  const value = context.parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function hasFlag(context: CommandContext, name: string): boolean {
  return context.parsed.flags.get(name) === true;
}

export function requiredFlagValue(
  context: CommandContext,
  name: string,
): string {
  const value = flagValue(context, name);

  if (value === undefined) {
    throw usageError(`--${name} is required here.`, {
      usage: context.parsed.spec.usage,
    });
  }

  return value;
}

export function positional(context: CommandContext, index: number): string {
  const value = context.parsed.positionals[index];

  if (value === undefined) {
    throw usageError(`This command needs an argument.`, {
      usage: context.parsed.spec.usage,
    });
  }

  return value;
}
