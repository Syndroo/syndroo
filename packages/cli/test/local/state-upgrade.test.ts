import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { CliError } from "../../src/cli-error.js";
import { planLocalPublish } from "../../src/local/plan.js";
import {
  createLocalFileStore,
  readInstallationView,
  withLocalWriteLock,
} from "../../src/local/state/store.js";
import { upgradeLocalState } from "../../src/local/state/upgrade.js";
import {
  deliverOutcome,
  documentOf,
  makeLegacyState,
  openState,
  providerSet,
  seedConnection,
  stateSnapshot,
  succeededOutcome,
  type StateFixture,
} from "./support/plan-fixture.js";

/**
 * G1: the explicit, fail-closed state upgrade.
 *
 * Every case uses the real file store and the real global write lock. The old
 * tarball case runs the actual shipped 0.6.0-rc.1 binary as a child process.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD_TARBALL = path.resolve(
  HERE,
  "..",
  "fixtures",
  "old-cli-0.6.0-rc.1.tgz",
);

const cleanups: (() => void)[] = [];
let oldCliRoot = "";

afterAll(() => {
  if (oldCliRoot !== "") {
    rmSync(oldCliRoot, { recursive: true, force: true });
  }
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

async function state(): Promise<StateFixture> {
  const fixture = await openState();

  cleanups.push(fixture.cleanup);

  return fixture;
}

async function rejectionOf(run: () => Promise<unknown>): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }

  throw new Error("expected a CliError");
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));

  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  return dir;
}

/** A legacy state with one admitted operation, one delivery, and one receipt. */
async function legacyStateWithHistory(): Promise<{
  fixture: StateFixture;
  installationId: string;
}> {
  const fixture = await state();

  makeLegacyState(fixture);
  await seedConnection(fixture.store, { provider: "bluesky" });

  const plan = await planLocalPublish(documentOf(), {
    store: fixture.store,
    providers: providerSet().providers,
    namespace: "default",
    now: fixture.clock.now,
  });

  await fixture.store.putPlan(plan);
  await deliverOutcome(fixture.store, plan, succeededOutcome());

  const installation = await fixture.store.getInstallation();

  return { fixture, installationId: installation.installationId };
}

function withoutInstallation(entries: readonly string[]): readonly string[] {
  return entries.filter(entry => !entry.startsWith("installation.json:"));
}

/** Intent, operation, and delivery bytes: the history an upgrade must not touch. */
function historyEntries(entries: readonly string[]): readonly string[] {
  return entries.filter(
    entry =>
      entry.startsWith("intents/") ||
      entry.startsWith("operations/") ||
      entry.startsWith("deliveries/"),
  );
}

const CONFIRMED = {
  to: 2,
  confirmNoWriters: true,
  yes: true,
} as const;

describe("upgradeLocalState confirmations", () => {
  it("needs both explicit confirmations", async () => {
    const fixture = await state();

    makeLegacyState(fixture);

    for (const options of [
      { to: 2, confirmNoWriters: false, yes: true },
      { to: 2, confirmNoWriters: true, yes: false },
      { to: 2, confirmNoWriters: false, yes: false },
    ]) {
      const error = await rejectionOf(() =>
        upgradeLocalState(fixture.stateHome, options),
      );

      expect(error.code).toBe("CONFIRMATION_REQUIRED");
    }

    const wrongTarget = await rejectionOf(() =>
      upgradeLocalState(fixture.stateHome, { ...CONFIRMED, to: 3 }),
    );

    expect(wrongTarget.code).toBe("STATE_VERSION_UNSUPPORTED");
    expect((await fixture.store.getInstallation()).schemaVersion).toBe(1);
  });

  it("refuses a state that does not exist", async () => {
    const missing = path.join(tempDir("syndroo-upgrade-missing-"), "state");
    const error = await rejectionOf(() =>
      upgradeLocalState(missing, CONFIRMED),
    );

    expect(error.code).toBe("STATE_CORRUPT");
  });
});

describe("upgradeLocalState transition", () => {
  it("upgrades schema 1 to schema 2 and preserves history bytes", async () => {
    const { fixture, installationId } = await legacyStateWithHistory();
    const before = stateSnapshot(fixture.stateHome);

    const report = await upgradeLocalState(fixture.stateHome, CONFIRMED);

    expect(report).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      installationId,
      resumed: false,
      upgraded: true,
    });
    expect(await fixture.store.getInstallation()).toEqual({
      schemaVersion: 2,
      installationId,
    });
    expect(withoutInstallation(stateSnapshot(fixture.stateHome))).toEqual(
      withoutInstallation(before),
    );

    const installation = JSON.parse(
      readFileSync(path.join(fixture.stateHome, "installation.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(installation).toEqual({ schemaVersion: 2, installationId });
    expect(await readInstallationView(fixture.stateHome)).toEqual({
      kind: "upgraded",
      installationId,
    });
  });

  it("is idempotent once the state is schema 2", async () => {
    const { fixture, installationId } = await legacyStateWithHistory();

    await upgradeLocalState(fixture.stateHome, CONFIRMED);

    const again = await upgradeLocalState(fixture.stateHome, CONFIRMED);

    expect(again).toMatchObject({
      fromVersion: 2,
      toVersion: 2,
      installationId,
      upgraded: false,
      resumed: false,
    });
  });

  it("refuses a schema-2 installation with a broken key or layout", async () => {
    const { fixture } = await legacyStateWithHistory();

    await upgradeLocalState(fixture.stateHome, CONFIRMED);

    const key = path.join(fixture.stateHome, "integrity.key");
    const savedKey = readFileSync(key);

    rmSync(key);

    const missingKey = await rejectionOf(() =>
      upgradeLocalState(fixture.stateHome, CONFIRMED),
    );

    expect(missingKey.code).toBe("STATE_CORRUPT");

    writeFileSync(key, savedKey, { mode: 0o600 });
    chmodSync(key, 0o600);

    const intents = path.join(fixture.stateHome, "intents");

    rmSync(intents, { recursive: true, force: true });

    const missingLayout = await rejectionOf(() =>
      upgradeLocalState(fixture.stateHome, CONFIRMED),
    );

    expect(missingLayout.code).toBe("STATE_CORRUPT");
  });
});

describe("interrupted upgrade", () => {
  it("leaves a marker both this build and the old build refuse, then resumes", async () => {
    const { fixture, installationId } = await legacyStateWithHistory();
    const before = stateSnapshot(fixture.stateHome);

    const interrupted = await rejectionOf(() =>
      upgradeLocalState(fixture.stateHome, {
        ...CONFIRMED,
        fault: point => {
          if (point === "after-upgrade-marker") {
            throw new Error("the upgrade response was lost");
          }
        },
      }),
    );

    // The marker is durable: the write completed, only the response was lost.
    expect(interrupted.code).toBe("STATE_COMMIT_FAILED");
    expect(interrupted.details).toMatchObject({ committed: true });
    expect(await readInstallationView(fixture.stateHome)).toMatchObject({
      kind: "interrupted",
      installationId,
      marker: { from: 1, to: 2 },
    });

    // An ordinary client fails closed instead of migrating implicitly.
    const blocked = await rejectionOf(() => fixture.store.getInstallation());

    expect(blocked.code).toBe("STATE_VERSION_UNSUPPORTED");

    const resumed = await upgradeLocalState(fixture.stateHome, CONFIRMED);

    expect(resumed).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      installationId,
      resumed: true,
      upgraded: true,
    });
    expect(withoutInstallation(stateSnapshot(fixture.stateHome))).toEqual(
      withoutInstallation(before),
    );
  });

  it("distinguishes a lost response after the final write from a rollback", async () => {
    const { fixture, installationId } = await legacyStateWithHistory();

    const lost = await rejectionOf(() =>
      upgradeLocalState(fixture.stateHome, {
        ...CONFIRMED,
        fault: point => {
          if (point === "after-upgrade-final") {
            throw new Error("the final response was lost");
          }
        },
      }),
    );

    expect(lost.code).toBe("STATE_COMMIT_FAILED");
    expect(lost.details).toMatchObject({ committed: true });
    // The transition finished; only the response was lost. The state is schema
    // 2 and a later upgrade is idempotent, not a second migration.
    expect(await fixture.store.getInstallation()).toEqual({
      schemaVersion: 2,
      installationId,
    });

    const again = await upgradeLocalState(fixture.stateHome, CONFIRMED);

    expect(again).toMatchObject({ upgraded: false, resumed: false });
  });

  it("keeps the marker when the final write never starts, then resumes", async () => {
    const { fixture, installationId } = await legacyStateWithHistory();
    const before = stateSnapshot(fixture.stateHome);

    const failed = await rejectionOf(() =>
      upgradeLocalState(fixture.stateHome, {
        ...CONFIRMED,
        fault: point => {
          if (point === "before-upgrade-final") {
            throw new Error("the final write never started");
          }
        },
      }),
    );

    expect(failed.code).toBe("STATE_COMMIT_FAILED");
    expect(failed.details).toMatchObject({ committed: false });
    // The marker is durable, so both ordinary clients stay fail-closed.
    expect(await readInstallationView(fixture.stateHome)).toMatchObject({
      kind: "interrupted",
      installationId,
    });

    const blocked = await rejectionOf(() => fixture.store.getInstallation());

    expect(blocked.code).toBe("STATE_VERSION_UNSUPPORTED");

    const resumed = await upgradeLocalState(fixture.stateHome, CONFIRMED);

    expect(resumed).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      installationId,
      resumed: true,
      upgraded: true,
    });
    expect(historyEntries(stateSnapshot(fixture.stateHome))).toEqual(
      historyEntries(before),
    );
    expect(historyEntries(before).length).toBeGreaterThan(0);
  });

  it("leaves a legacy state untouched when the marker write never happened", async () => {
    const { fixture } = await legacyStateWithHistory();
    const before = stateSnapshot(fixture.stateHome);

    const failed = await rejectionOf(() =>
      upgradeLocalState(fixture.stateHome, {
        ...CONFIRMED,
        fault: point => {
          if (point === "before-upgrade-marker") {
            throw new Error("the upgrade never started");
          }
        },
      }),
    );

    expect(failed.code).toBe("STATE_COMMIT_FAILED");
    expect(failed.details).toMatchObject({ committed: false });
    expect(stateSnapshot(fixture.stateHome)).toEqual(before);
    expect((await fixture.store.getInstallation()).schemaVersion).toBe(1);
  });

  it("refuses an unrecognized marker instead of resuming it", async () => {
    const { fixture, installationId } = await legacyStateWithHistory();

    writeFileSync(
      path.join(fixture.stateHome, "installation.json"),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          installationId,
          upgrade: {
            from: 1,
            to: 3,
            startedAt: "2026-10-04T00:00:00.000Z",
            nonce: "a".repeat(32),
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    const error = await rejectionOf(() =>
      upgradeLocalState(fixture.stateHome, CONFIRMED),
    );

    expect(error.code).toBe("STATE_VERSION_UNSUPPORTED");
  });
});

describe("upgrade concurrency guards", () => {
  it("refuses an active writer", async () => {
    const fixture = await state();

    makeLegacyState(fixture);

    const error = await withLocalWriteLock(fixture.stateHome, async () =>
      rejectionOf(() => upgradeLocalState(fixture.stateHome, CONFIRMED)),
    );

    expect(error.code).toBe("STATE_BUSY");
  });

  it("refuses a lock without an owner record", async () => {
    const fixture = await state();

    makeLegacyState(fixture);

    const lock = path.join(fixture.stateHome, ".write-lock");

    mkdirSync(lock, { mode: 0o700 });
    chmodSync(lock, 0o700);

    const error = await rejectionOf(() =>
      upgradeLocalState(fixture.stateHome, CONFIRMED),
    );

    expect(error.code).toBe("STATE_BUSY");
  });

  it("refuses a recovery guard", async () => {
    const fixture = await state();

    makeLegacyState(fixture);

    const guard = path.join(fixture.stateHome, ".recovery-lock");

    mkdirSync(guard, { mode: 0o700 });
    chmodSync(guard, 0o700);

    const error = await rejectionOf(() =>
      upgradeLocalState(fixture.stateHome, CONFIRMED),
    );

    expect(error.code).toBe("STATE_BUSY");
  });
});

describe("old 0.6.0-rc.1 binary", () => {
  function runOldCli(stateHome: string, configHome: string): {
    readonly status: number;
    readonly stdout: string;
  } {
    try {
      const stdout = execFileSync(
        process.execPath,
        [
          path.join(extractOldCli(), "package", "dist", "bin.js"),
          "publish",
          "--data",
          '{"key":"old-k","content":"hello","platforms":["bluesky"]}',
          "--dry-run",
          "--state-home",
          stateHome,
          "--json",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            XDG_CONFIG_HOME: configHome,
            HOME: configHome,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      return { status: 0, stdout };
    } catch (error) {
      const failure = error as {
        readonly status?: number;
        readonly stdout?: string;
      };

      return { status: failure.status ?? -1, stdout: failure.stdout ?? "" };
    }
  }

  function extractOldCli(): string {
    if (oldCliRoot !== "") {
      return oldCliRoot;
    }

    // Extracted once for the whole file; it must survive the per-test cleanup.
    oldCliRoot = mkdtempSync(path.join(tmpdir(), "syndroo-old-cli-"));
    execFileSync("tar", ["-xzf", OLD_TARBALL, "-C", oldCliRoot]);

    return oldCliRoot;
  }

  function writeConfig(configHome: string): void {
    const dir = path.join(configHome, "syndroo");

    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(
      path.join(dir, "config.json"),
      '{"schemaVersion":1,"namespace":"default"}\n',
      { mode: 0o600 },
    );
    chmodSync(path.join(dir, "config.json"), 0o600);
  }

  it("refuses an upgraded state and changes no bytes", async () => {
    extractOldCli();

    const { fixture } = await legacyStateWithHistory();

    await upgradeLocalState(fixture.stateHome, CONFIRMED);

    const before = stateSnapshot(fixture.stateHome);
    const configHome = tempDir("syndroo-old-cfg-");

    writeConfig(configHome);

    const result = runOldCli(fixture.stateHome, configHome);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { code: string } | null;
    };

    expect(result.status).toBe(1);
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("STATE_VERSION_UNSUPPORTED");
    // The refusal happened before any credential read or content request, and
    // every legacy intent/operation/delivery byte is still the pre-run byte.
    expect(historyEntries(before).length).toBeGreaterThan(0);
    expect(historyEntries(stateSnapshot(fixture.stateHome))).toEqual(
      historyEntries(before),
    );
    expect(stateSnapshot(fixture.stateHome)).toEqual(before);
  });

  it("refuses an interrupted-upgrade marker", async () => {
    extractOldCli();

    const { fixture } = await legacyStateWithHistory();

    await rejectionOf(() =>
      upgradeLocalState(fixture.stateHome, {
        ...CONFIRMED,
        fault: point => {
          if (point === "after-upgrade-marker") {
            throw new Error("stop after the marker");
          }
        },
      }),
    );

    const before = stateSnapshot(fixture.stateHome);
    const configHome = tempDir("syndroo-old-cfg-");

    writeConfig(configHome);

    const result = runOldCli(fixture.stateHome, configHome);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { code: string } | null;
    };

    expect(result.status).toBe(1);
    expect(envelope.ok).toBe(false);
    expect(["STATE_VERSION_UNSUPPORTED", "STATE_CORRUPT"]).toContain(
      envelope.error?.code,
    );
    expect(historyEntries(stateSnapshot(fixture.stateHome))).toEqual(
      historyEntries(before),
    );
    expect(stateSnapshot(fixture.stateHome)).toEqual(before);
  });
});
