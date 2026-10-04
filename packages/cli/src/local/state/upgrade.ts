import { randomBytes } from "node:crypto";

import {
  admissionFailure,
  assertSupportedRuntime,
  atomicWriteFile,
  commitFailure,
  encodeStateRecord,
  requireStateDirectory,
  stateFailure,
  type FaultInjector,
} from "./atomic.js";
import { withLocalWriteLock } from "./lock.js";
import {
  INSTALLATION_FILE_NAME,
  readInstallationView,
  requireUpgradePreconditions,
  type InstallationRecord,
  type InstallationUpgradeMarker,
} from "./store.js";

/**
 * The explicit, operator-confirmed state upgrade.
 *
 * The transition is two durable atomic writes. The first publishes an
 * installation record that every ordinary client - old or new - refuses,
 * because the old strict parser rejects the extra `upgrade` field and the new
 * one refuses to migrate implicitly. The second publishes the final schema-2
 * record with the original installation id. A crash between the two leaves the
 * marker, which only this command may resume.
 *
 * History is never rewritten: no plan, delivery, receipt, signature, delivery
 * id, or integrity key is touched. The lock is the same global write lock every
 * other local command uses, so an active writer or a recovery guard refuses the
 * upgrade instead of racing it.
 */

export interface LocalUpgradeOptions {
  /** The only target this version can produce. */
  readonly to: number;
  readonly confirmNoWriters: boolean;
  readonly yes: boolean;
  /** Test-only fault injection, never reachable from a command line. */
  readonly fault?: FaultInjector;
  readonly now?: () => Date;
}

export interface LocalUpgradeReport {
  readonly stateHome: string;
  readonly fromVersion: 1 | 2;
  readonly toVersion: 2;
  readonly installationId: string;
  /** True when a recognized interrupted upgrade was finished. */
  readonly resumed: boolean;
  /** False when the state was already schema 2. */
  readonly upgraded: boolean;
}

export async function upgradeLocalState(
  stateHome: string,
  options: LocalUpgradeOptions,
): Promise<LocalUpgradeReport> {
  assertSupportedRuntime();

  if (options.to !== 2) {
    throw admissionFailure(
      "STATE_VERSION_UNSUPPORTED",
      "this version can only upgrade local state to schema 2",
    );
  }

  if (options.confirmNoWriters !== true || options.yes !== true) {
    throw admissionFailure(
      "CONFIRMATION_REQUIRED",
      "state upgrade needs both --confirm-no-writers and --yes",
    );
  }

  const now = options.now ?? (() => new Date());
  const startedAt = now();

  if (!Number.isFinite(startedAt.getTime())) {
    throw stateFailure(
      "LOCAL_RUNTIME_UNSUPPORTED",
      "the local clock is not usable",
    );
  }

  return withLocalWriteLock(stateHome, async () => {
    const root = await requireStateDirectory(stateHome);
    const view = await readInstallationView(root);

    // Every path, including an already-schema-2 state, is validated against the
    // same preconditions: a schema-2 installation record with a missing key or
    // an incomplete layout is corrupt, never "already upgraded".
    await requireUpgradePreconditions(root);

    if (view.kind === "upgraded") {
      return {
        stateHome: root,
        fromVersion: 2,
        toVersion: 2,
        installationId: view.installationId,
        resumed: false,
        upgraded: false,
      } satisfies LocalUpgradeReport;
    }

    const installationId = view.installationId;
    const resumed = view.kind === "interrupted";

    if (!resumed) {
      const marker = markerRecord(
        installationId,
        startedAt.toISOString(),
      );

      await injectFault(options.fault, "before-upgrade-marker", false, "upgrade-marker");
      await atomicWriteFile(
        root,
        INSTALLATION_FILE_NAME,
        encodeStateRecord(marker),
        options.fault,
      );
      await injectFault(options.fault, "after-upgrade-marker", true, "upgrade-marker");
    }

    const final: InstallationRecord = { schemaVersion: 2, installationId };

    await injectFault(options.fault, "before-upgrade-final", false, "upgrade-final");
    await atomicWriteFile(
      root,
      INSTALLATION_FILE_NAME,
      encodeStateRecord(final),
      options.fault,
    );
    await injectFault(options.fault, "after-upgrade-final", true, "upgrade-final");

    return {
      stateHome: root,
      fromVersion: 1,
      toVersion: 2,
      installationId,
      resumed,
      upgraded: true,
    } satisfies LocalUpgradeReport;
  });
}

function markerRecord(
  installationId: string,
  startedAt: string,
): InstallationRecord & { readonly upgrade: InstallationUpgradeMarker } {
  return {
    schemaVersion: 2,
    installationId,
    upgrade: {
      from: 1,
      to: 2,
      startedAt,
      nonce: randomBytes(16).toString("hex"),
    },
  };
}

/**
 * Runs one test-only fault point at an upgrade boundary.
 *
 * `committed` records what is already durable when the fault fires: a fault
 * before a write leaves the previous record, and a fault after it models a
 * completed write whose response was lost. The caller must not treat the latter
 * as a rollback.
 */
async function injectFault(
  fault: FaultInjector | undefined,
  point:
    | "before-upgrade-marker"
    | "after-upgrade-marker"
    | "before-upgrade-final"
    | "after-upgrade-final",
  committed: boolean,
  stage: string,
): Promise<void> {
  try {
    await fault?.(point);
  } catch (error) {
    throw commitFailure(stage, committed, error);
  }
}
