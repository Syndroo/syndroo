import { existsSync } from "node:fs";

import { EXIT_CODE } from "../exit-codes.js";
import type { CommandResult } from "../output.js";
import { resolveSkillDirectory } from "../skill-path.js";
import type { CommandContext } from "./context.js";

/**
 * `syndroo skill path`.
 *
 * The path is derived from the installed file's own location, so it is correct
 * for a global install, an `npx` run, and a checkout. Whether the directory
 * exists yet is reported instead of assumed.
 */
export async function runSkillPath(context: CommandContext): Promise<CommandResult> {
  const directory = resolveSkillDirectory();
  const exists = existsSync(directory);

  if (!exists) {
    context.reporter.diagnostic(
      `the bundled Skill directory is not present in this build: ${directory}`,
    );
  }

  return {
    payload: {
      command: "skill.path",
      ok: exists,
      path: directory,
      exists,
      createRequests: 0,
    },
    human: [directory],
    exitCode: exists ? EXIT_CODE.SUCCESS : EXIT_CODE.FAILURE,
  };
}
