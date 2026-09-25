import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CliError } from "../../src/cli-error.js";
import { EXIT_CODE } from "../../src/exit-codes.js";
import {
  createLocalFileStore,
  inspectLocalState,
  recoverLocalState,
  withLocalWriteLock,
} from "../../src/local/state/store.js";
import {
  buildTestPlan,
  compileWriter,
  forgeRecord,
  runWriter,
  seedConnection,
} from "../fixtures/local-writer.js";

/**
 * REC-01..03: a killed writer leaves a durable `in_flight` intent that only an
 * explicit, confirmed recovery may turn into `unknown`; every unclear owner is
 * refused; inspection stays read-only.
 */

const TEMP_ROOTS: string[] = [];
const BUILD_ROOTS: string[] = [];
let writerEntry = "";

beforeAll(() => {
  const buildRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "syndroo-t03-rec-build-")),
  );

  BUILD_ROOTS.push(buildRoot);
  writerEntry = compileWriter(path.join(buildRoot, "build"));
}, 180_000);

afterEach(() => {
  for (const root of TEMP_ROOTS.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

afterAll(() => {
  for (const root of BUILD_ROOTS.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const base = realpathSync(
    mkdtempSync(path.join(tmpdir(), "syndroo-t03-rec-")),
  );

  TEMP_ROOTS.push(base);

  return base;
}

function makeStateHome(): string {
  return path.join(makeRoot(), "state");
}

async function expectCliError(
  action: () => Promise<unknown>,
): Promise<CliError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);

    return error as CliError;
  }

  throw new Error("expected a CliError");
}

function exists(target: string): boolean {
  return lstatSync(target, { throwIfNoEntry: false }) !== undefined;
}

const PROVIDER = "bluesky" as const;
const TARGET_ID = "did:plc:alice";
const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const NAMESPACE = "default";

async function writeOwner(
  stateHome: string,
  owner: {
    readonly token: string;
    readonly hostname: string;
    readonly pid: number;
    readonly createdAt: string;
  },
): Promise<void> {
  mkdirSync(path.join(stateHome, ".write-lock"), { mode: 0o700 });
  writeFileSync(
    path.join(stateHome, ".write-lock", "owner.json"),
    `${JSON.stringify({ schemaVersion: 1, ...owner })}\n`,
    { mode: 0o600 },
  );
}

async function initializedState(): Promise<{
  readonly stateHome: string;
  readonly store: ReturnType<typeof createLocalFileStore>;
}> {
  const stateHome = makeStateHome();
  const store = createLocalFileStore(stateHome);

  await withLocalWriteLock(stateHome, async () => {
    await store.initialize();
  });

  return { stateHome, store };
}

describe("REC-01 a killed writer becomes unknown", () => {
  it("turns a durable in-flight intent into unknown and keeps attempts", async () => {
    const stateHome = makeStateHome();
    const run = await runWriter({
      entry: writerEntry,
      mode: "intent-then-die",
      stateHome,
    });

    expect(run.signal).toBe("SIGKILL");

    const report = run.report as { operationId: string; deliveryId: string };
    const before = await inspectLocalState(stateHome);

    expect(before.orphanInFlight).toEqual([report.deliveryId]);
    expect(before.lock.held).toBe(true);
    expect(before.corrupt).toEqual([]);

    const recovery = await recoverLocalState(stateHome, {
      confirmNoWriters: true,
      yes: true,
    });

    expect(recovery.orphanInFlight).toEqual([report.deliveryId]);
    expect(recovery.recovered).toEqual([report.deliveryId]);
    expect(recovery.quarantined).toHaveLength(1);

    const store = createLocalFileStore(stateHome);
    const record = await store.getDelivery(report.deliveryId);

    expect(record?.status).toBe("unknown");
    expect(record?.attempts).toBe(1);
    expect(record?.outcome).toEqual({
      kind: "unknown",
      code: "RECOVERED_ORPHAN",
      writeDisposition: "unknown",
    });

    // The old lock is evidence, not garbage: it is quarantined with its owner
    // record, and the guard is released so a new writer can enter.
    const quarantined = path.join(
      stateHome,
      recovery.quarantined[0] as string,
    );

    expect(readdirSync(quarantined)).toContain("owner.json");
    expect(await inspectLocalState(stateHome)).toMatchObject({
      lock: { held: false, owner: null },
      recoveryGuard: false,
      orphanInFlight: [],
    });

    await withLocalWriteLock(stateHome, async () => undefined);
  });

  it("marks an orphan in flight even when no lock is left behind", async () => {
    const { stateHome, store } = await initializedState();

    await withLocalWriteLock(stateHome, async () => {
      await seedConnection(store, {
        provider: PROVIDER,
        targetId: TARGET_ID,
        connectionId: CONNECTION_ID,
        bindingRevision: 1,
      });
    });

    const plan = await buildTestPlan({
      store,
      namespace: NAMESPACE,
      key: "recovery-no-lock",
      content: "hello",
      provider: PROVIDER,
      targetId: TARGET_ID,
      connectionId: CONNECTION_ID,
      bindingRevision: 1,
    });
    const deliveryId = plan.items[0]?.delivery.deliveryId as string;

    await withLocalWriteLock(stateHome, async () => {
      const operation = await store.reserveOperation(plan);

      forgeRecord(stateHome, "deliveries", deliveryId, {
        schemaVersion: 1,
        delivery: plan.items[0]?.delivery,
        status: "in_flight",
        attempts: 2,
        operationId: operation.operationId,
        outcome: null,
        updatedAt: "2026-09-24T00:00:00.000Z",
      });
    });

    const recovery = await recoverLocalState(stateHome, {
      confirmNoWriters: true,
      yes: true,
    });

    expect(recovery.quarantined).toEqual([]);
    expect(recovery.recovered).toEqual([deliveryId]);
    expect((await store.getDelivery(deliveryId))?.attempts).toBe(2);
    expect((await store.getDelivery(deliveryId))?.status).toBe("unknown");
  });

  it("never touches a preparing record", async () => {
    const stateHome = makeStateHome();
    const run = await runWriter({
      entry: writerEntry,
      mode: "seed-and-crash",
      stateHome,
      env: { SYNDROO_T03_KILL_AT: "6" },
    });

    expect(run.signal).toBe("SIGKILL");

    const before = await inspectLocalState(stateHome);

    expect(before.preparingOperations).toHaveLength(1);

    const recovery = await recoverLocalState(stateHome, {
      confirmNoWriters: true,
      yes: true,
    });

    expect(recovery.recovered).toEqual([]);

    const after = await inspectLocalState(stateHome);

    expect(after.preparingOperations).toEqual(before.preparingOperations);
    expect(after.corrupt).toEqual([]);
  });
});

describe("REC-03 recovery refusals", () => {
  it("requires both confirmations", async () => {
    const { stateHome } = await initializedState();

    for (const options of [
      { confirmNoWriters: false, yes: true },
      { confirmNoWriters: true, yes: false },
    ]) {
      const error = await expectCliError(() =>
        recoverLocalState(stateHome, options),
      );

      expect(error.code).toBe("CONFIRMATION_REQUIRED");
      expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    }
  });

  it("refuses while a real writer is alive and still releases the guard", async () => {
    const stateHome = makeStateHome();
    const pending = runWriter({
      entry: writerEntry,
      mode: "hold-forever",
      stateHome,
    });
    let pid = 0;

    for (let attempt = 0; attempt < 200 && pid === 0; attempt++) {
      const inspection = await inspectLocalState(stateHome);

      if (inspection.lock.owner !== null) {
        pid = inspection.lock.owner.pid;
      } else {
        await new Promise(resolve => {
          setTimeout(resolve, 25);
        });
      }
    }

    expect(pid).toBeGreaterThan(0);

    const error = await expectCliError(() =>
      recoverLocalState(stateHome, { confirmNoWriters: true, yes: true }),
    );

    expect(error.code).toBe("STATE_BUSY");
    expect(exists(path.join(stateHome, ".write-lock", "owner.json"))).toBe(true);
    expect(exists(path.join(stateHome, ".recovery-lock"))).toBe(false);

    process.kill(pid, "SIGKILL");
    await pending;
  });

  it("refuses a lock owned by another host", async () => {
    const { stateHome } = await initializedState();

    await writeOwner(stateHome, {
      token: "a".repeat(64),
      hostname: `${os.hostname()}-elsewhere`,
      pid: 999_999,
      createdAt: "2026-09-24T00:00:00.000Z",
    });

    const error = await expectCliError(() =>
      recoverLocalState(stateHome, { confirmNoWriters: true, yes: true }),
    );

    expect(error.code).toBe("STATE_BUSY");
    expect(exists(path.join(stateHome, ".write-lock", "owner.json"))).toBe(true);
  });

  it("refuses a live process even when the pid belongs to this run", async () => {
    const { stateHome } = await initializedState();

    await writeOwner(stateHome, {
      token: "b".repeat(64),
      hostname: os.hostname(),
      pid: process.pid,
      createdAt: "2026-09-24T00:00:00.000Z",
    });

    const error = await expectCliError(() =>
      recoverLocalState(stateHome, { confirmNoWriters: true, yes: true }),
    );

    expect(error.code).toBe("STATE_BUSY");
  });

  it("refuses a lock whose owner record is unreadable", async () => {
    const { stateHome } = await initializedState();

    mkdirSync(path.join(stateHome, ".write-lock"), { mode: 0o700 });

    const error = await expectCliError(() =>
      recoverLocalState(stateHome, { confirmNoWriters: true, yes: true }),
    );

    expect(error.code).toBe("STATE_CORRUPT");
    expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
    expect(exists(path.join(stateHome, ".write-lock"))).toBe(true);
  });

  it("stops on an existing guard and never removes it", async () => {
    const { stateHome } = await initializedState();

    mkdirSync(path.join(stateHome, ".recovery-lock"), { mode: 0o700 });

    const error = await expectCliError(() =>
      recoverLocalState(stateHome, { confirmNoWriters: true, yes: true }),
    );

    expect(error.code).toBe("STATE_BUSY");
    expect(exists(path.join(stateHome, ".recovery-lock"))).toBe(true);
  });

  it("stops on a corrupt guard", async () => {
    const { stateHome } = await initializedState();

    writeFileSync(path.join(stateHome, ".recovery-lock"), "not a guard\n", {
      mode: 0o600,
    });

    const error = await expectCliError(() =>
      recoverLocalState(stateHome, { confirmNoWriters: true, yes: true }),
    );

    expect(error.code).toBe("STATE_CORRUPT");
  });
});

describe("recovery guard ownership", () => {
  it("leaves a guard that was replaced during the run", async () => {
    const { stateHome, store } = await initializedState();

    await withLocalWriteLock(stateHome, async () => {
      await seedConnection(store, {
        provider: PROVIDER,
        targetId: TARGET_ID,
        connectionId: CONNECTION_ID,
        bindingRevision: 1,
      });

      const plan = await buildTestPlan({
        store,
        namespace: NAMESPACE,
        key: "recovery-guard-race",
        content: "hello",
        provider: PROVIDER,
        targetId: TARGET_ID,
        connectionId: CONNECTION_ID,
        bindingRevision: 1,
      });
      const operation = await store.reserveOperation(plan);
      const deliveryId = plan.items[0]?.delivery.deliveryId as string;

      forgeRecord(stateHome, "deliveries", deliveryId, {
        schemaVersion: 1,
        delivery: plan.items[0]?.delivery,
        status: "in_flight",
        attempts: 1,
        operationId: operation.operationId,
        outcome: null,
        updatedAt: "2026-09-24T00:00:00.000Z",
      });
    });

    const guard = path.join(stateHome, ".recovery-lock");
    let writes = 0;
    const error = await expectCliError(() =>
      recoverLocalState(stateHome, {
        confirmNoWriters: true,
        yes: true,
        fault: point => {
          if (point === "before-temp-write") {
            writes++;
          }

          if (writes === 1 && point === "before-directory-sync") {
            // Another process replaced the guard while this run was inside its
            // own guard: the replacement must survive.
            rmSync(guard, { recursive: true, force: true });
            mkdirSync(guard, { mode: 0o700 });
          }
        },
      }),
    );

    expect(error.code).toBe("STATE_COMMIT_FAILED");
    expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
    expect(exists(guard)).toBe(true);
  });
});

describe("REC-01 recovery stays offline", () => {
  it("keeps the state modules free of any network call", () => {
    for (const name of ["atomic.ts", "lock.ts", "store.ts"]) {
      const source = readFileSync(
        path.join(
          path.dirname(new URL(import.meta.url).pathname),
          "..",
          "..",
          "src",
          "local",
          "state",
          name,
        ),
        "utf8",
      );

      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/node:https?/);
      expect(source).not.toMatch(/from\s+"undici"/);
    }
  });
});
