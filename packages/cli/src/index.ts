/**
 * Public entry point of `@syndroo/cli`.
 *
 * The package is primarily a command, so this surface exists for tests and for
 * embedders that want the same parsing and document rules without a subprocess.
 */
export { EXIT_CODE, type ExitCode } from "./exit-codes.js";
export { CliError, configError, usageError } from "./cli-error.js";
export {
  COMMAND_SPECS,
  parseArgs,
  wantsJson,
  type CommandSpec,
  type ParsedCommand,
} from "./args.js";
export { API_KEY_ENV, BASE_URL_ENV, inspectConfig, resolveConfig } from "./config.js";
export {
  DocumentError,
  canonicalRequestJson,
  escapeControls,
  freezePost,
  parsePostDocument,
  readPostSource,
  sha256,
  MAX_CONTENT_CODE_POINTS,
  type DocumentIssue,
  type FrozenPost,
  type ParsedDocument,
  type PostSource,
} from "./document.js";
export { parseDuration } from "./duration.js";
export { createProcessIo, type CliIo } from "./io.js";
export { Reporter, type CommandResult } from "./output.js";
export { previewText } from "./preview.js";
export { resolveSkillDirectory } from "./skill-path.js";
export { cliVersion } from "./version.js";
export { run } from "./main.js";
