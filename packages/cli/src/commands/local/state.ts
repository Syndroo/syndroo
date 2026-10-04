import { EXIT_CODE } from "../../exit-codes.js";
import type { LocalRunOverrides } from "../../local/composition.js";
import { resolveStateHome } from "../../local/config.js";
import {
  inspectLocalState,
  recoverLocalState,
} from "../../local/state/store.js";
import { upgradeLocalState } from "../../local/state/upgrade.js";
import { usageError } from "../../cli-error.js";
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
      upgradeInProgress: inspection.upgradeInProgress,
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
      `  upgrade   ${inspection.upgradeInProgress ? "interrupted; run state upgrade --to 2" : "none in progress"}`,
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

/**
 * `syndroo state upgrade --to 2 --confirm-no-writers --yes` — explicit migration.
 *
 * Both confirmations are mandatory, the same global write lock is used, and an
 * interrupted upgrade resumes only through this command.
 */
export async function runStateUpgrade(
  context: CommandContext,
  overrides: LocalRunOverrides = {},
): Promise<LocalCommandOutcome> {
  const stateHome = stateHomeOf(context, overrides);
  const raw = flagValue(context, "to");

  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    throw usageError("state upgrade needs --to 2");
  }

  const to = Number.parseInt(raw.trim(), 10);

  if (to !== 2) {
    throw usageError("this version can only upgrade local state to schema 2");
  }

  const report = await upgradeLocalState(stateHome, {
    to: 2,
    confirmNoWriters: hasFlag(context, "confirm-no-writers"),
    yes: hasFlag(context, "yes"),
  });

  return {
    ok: true,
    result: report,
    human: [
      "syndroo state upgrade",
      `  state       ${report.stateHome}`,
      `  from        schema ${report.fromVersion}`,
      `  to          schema ${report.toVersion}`,
      `  resumed     ${report.resumed ? "yes" : "no"}`,
      `  upgraded    ${report.upgraded ? "yes" : "already current"}`,
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}
