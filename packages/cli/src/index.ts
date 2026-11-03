/**
 * Programmatic surface of `@syndroo/cli`.
 *
 * The package is primarily a command. This entry point exists for embedders and
 * tests that want the same parsing, configuration and composition without a
 * subprocess. The reusable Node host pieces live on `@syndroo/cli/runtime`, and
 * the executable lives at `@syndroo/cli/bin`.
 */
export { EXIT_CODE, type ExitCode } from "./exit-codes.js";
export { CliError, configError, usageError } from "./cli-error.js";
export {
  CONFIG_VERSION,
  MAX_CONFIG_BYTES,
  defaultConfigFile,
  loadConfig,
  resolveConfigPath,
} from "./config.js";
export type { ConfigSelection, ResolvedConfig } from "./config.js";
export { createProcessIo, type CliIo } from "./io.js";
export { run } from "./main.js";
export {
  classify,
  exitForExecution,
  failureEnvelope,
  serverFailureEnvelope,
  staticMessage,
  successEnvelope,
} from "./render/envelope.js";
export type {
  CliEnvelope,
  Operation,
  SafeDetails,
  ServerEnvelope,
  ServerFailureDetails,
  ServerSubcommand,
} from "./render/envelope.js";
export { escapeControls, renderConnect, renderExecuteInstruction, renderStatus } from "./render/human.js";
export { renderPublication, type PublicationRenderOptions } from "./render/publication.js";
export { publicationView, type PublicationView, type PublicationTargetView, type PublicationMode } from "./render/publication-view.js";
export { summarizeText, displayWidth, truncateToWidth } from "./render/terminal-text.js";
export {
  createLocalRuntime,
  type LocalRuntime,
  type LocalRuntimeOverrides,
} from "./runtime/local/composition.js";
export { createLocalDigests, loadRuntimeKey } from "./runtime/local/digests.js";
export { createUnconfiguredRegistry } from "./runtime/local/registry.js";
export { mintRequestId, RequestJournal, REQUEST_ID_PATTERN } from "./request-journal/journal.js";
export type { JournalEntry } from "./request-journal/journal.js";
export type {
  ServerGlobals,
  ServerOverrides,
  ServerResult,
} from "./server/index.js";
export { cliVersion } from "./version.js";
