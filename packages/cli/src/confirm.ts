import type { Reporter } from "./output.js";
import type { CliIo } from "./io.js";

/**
 * How long a single prompt may wait for a human. It is a guard against a
 * wedged terminal, not a limit on thinking time.
 */
const TTY_PROMPT_LIMIT_MS = 10 * 60 * 1000;

const AFFIRMATIVE = new Set(["y", "yes"]);

export interface PromptContext {
  readonly io: CliIo;
  readonly reporter: Reporter;
}

/**
 * Interactive means a human can actually answer.
 *
 * stdin being a terminal is part of the test on purpose: when the document
 * arrives on stdin, there is no second channel for an answer, and the CLI must
 * not pretend to prompt.
 */
export function canPrompt(context: PromptContext): boolean {
  return (
    context.io.stdinIsTty &&
    context.io.stdoutIsTty &&
    typeof context.io.readTtyLine === "function" &&
    context.io.hasTty()
  );
}

/**
 * Asks before a write and never guesses.
 *
 * Anything that is not `y` or `yes` is a refusal, including an empty answer and
 * a closed terminal, so a dropped connection cannot be read as consent.
 */
export function confirm(
  context: PromptContext,
  prompt = "Create this post? [y/N] ",
): boolean {
  context.reporter.prompt(prompt);

  const answer = context.io.readTtyLine(TTY_PROMPT_LIMIT_MS);
  context.reporter.diagnostic("");

  if (answer === undefined) {
    return false;
  }

  return AFFIRMATIVE.has(answer.trim().toLowerCase());
}
