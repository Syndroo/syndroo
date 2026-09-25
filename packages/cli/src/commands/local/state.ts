import { EXIT_CODE } from "../../exit-codes.js";
import type { LocalRunOverrides } from "../../local/composition.js";
import { resolveStateHome } from "../../local/config.js";
import {
  inspectLocalState,
  recoverLocalState,
} from "../../local/state/store.js";
import { flagValue, hasFlag, type CommandContext } from "../context.js";
import type { LocalCommandOutcome } from "./shared.js";

function stateHomeOf(
  context: CommandContext,
  overrides: LocalRunOverrides,
): string {
  void overrides;

  return resolveStateHome(
    context.io.env,
    flagValue(context, "state-home"),
    context.io.cwd,
  );
}

/**
 * `syndroo state inspect` — read-only.
 *
 * The lock view never carries the release token, and a corrupt file's contents
 * are never echoed: only which record failed and which code it failed with.
 */
export async function runStateInspect(
  context: CommandContext,
  overrides: LocalRunOverrides = {},
): Promise<LocalCommandOutcome> {
  const stateHome = stateHomeOf(context, overrides);
  const inspection = await inspectLocalState(stateHome);

  return {
    ok: true,
    result: {
      stateHome: inspection.stateHome,
      exists: inspection.exists,
      safe: inspection.safe,
      schemaVersion: inspection.schemaVersion,
      lock: {
        held: inspection.lock.held,
        ...(inspection.lock.owner === null
          ? {}
          : { owner: inspection.lock.owner }),
      },
      recoveryGuard: inspection.recoveryGuard,
      // Safe, bounded diagnostics: record names and fixed codes only, never a
      // corrupt file's contents and never the lock's release token.
      preparingOperations: inspection.preparingOperations,
      orphanInFlight: inspection.orphanInFlight,
      temporaryFiles: inspection.temporaryFiles,
      corrupt: inspection.corrupt,
    },
    human: [
      "syndroo state inspect",
      `  state     ${inspection.stateHome}`,
      `  exists    ${inspection.exists ? "yes" : "no"}`,
      `  safe      ${inspection.safe ? "yes" : "no"}`,
      `  lock      ${inspection.lock.held ? "held" : "not held"}`,
      `  recovery  ${inspection.recoveryGuard ? "guard present" : "no guard"}`,
      `  preparing ${inspection.preparingOperations.length} operation(s) not admitted`,
      `  in flight ${inspection.orphanInFlight.length} orphan record(s)`,
      `  temp      ${inspection.temporaryFiles.length} leftover file(s)`,
      `  defects   ${inspection.corrupt.length}`,
      ...inspection.orphanInFlight.map(id => `  orphan    ${id}`),
      ...inspection.preparingOperations.map(id => `  preparing ${id}`),
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}

/**
 * `syndroo state recover` — explicit repair after every writer has stopped.
 *
 * Both confirmations are mandatory and neither is implied by another command.
 */
export async function runStateRecover(
  context: CommandContext,
  overrides: LocalRunOverrides = {},
): Promise<LocalCommandOutcome> {
  const stateHome = stateHomeOf(context, overrides);
  const report = await recoverLocalState(stateHome, {
    confirmNoWriters: hasFlag(context, "confirm-no-writers"),
    yes: hasFlag(context, "yes"),
  });

  return {
    ok: true,
    result: report,
    human: [
      "syndroo state recover",
      `  state       ${report.stateHome}`,
      `  quarantined ${report.quarantined.length}`,
      `  recovered   ${report.recovered.length}`,
      `  unknown     ${report.orphanInFlight.length}`,
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}
