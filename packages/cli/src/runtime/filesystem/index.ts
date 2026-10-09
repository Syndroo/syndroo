/**
 * Local filesystem runtime for the architecture-v1 CLI.
 *
 * Exposes the frozen `StateStore` and `CredentialStore` ports over private
 * files, plus the clock and entropy Core needs. Command parsing, rendering and
 * composition live in B3 (`runtime/local`), not here.
 */
export { FilesystemCredentials } from "./credentials.js";
export type { CredentialsOptions } from "./credentials.js";
export { Database, emptyData } from "./database.js";
export type {
  ApprovalEntry,
  Data,
  FaultInjector,
  FaultPoint,
  Journal,
  JournalEntry,
  MetaRecord,
  RecordKind,
  RequestEntry,
  StepEntry,
  WriteSession,
} from "./database.js";
export { CryptoEntropy, SystemClock, createFilesystemRuntime } from "./runtime.js";
export type { FilesystemRuntime, RuntimeOptions } from "./runtime.js";
export { FilesystemState } from "./state.js";
export type { StateOptions } from "./state.js";
export {
  RUNTIME_FORMAT,
  defaultStateRoot,
  generationDirectory,
  layoutOf,
} from "./paths.js";
export type { Layout } from "./paths.js";
