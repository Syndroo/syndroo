import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CliError } from "../../src/cli-error.js";
import { EXIT_CODE } from "../../src/exit-codes.js";
import type { LocalPlan, LocalStore } from "../../src/local/ports/local-store.js";
import {
  createLocalFileStore,
  inspectLocalState,
  recoverLocalState,
  withLocalWriteLock,
} from "../../src/local/state/store.js";
import {
  buildTestPlan,
  compileWriter,
  connectionRecord,
  forgeRecord,
  runWriter,
  seedConnection,
  sha256Hex,
} from "../fixtures/local-writer.js";

/**
 * STO-01..05: controlled permissions and types, atomic write fault points,
 * multi-file admission, corruption and new-version fail-closed behaviour.
 */

const TEMP_ROOTS: string[] = [];
const BUILD_ROOTS: string[] = [];
let writerEntry = "";

beforeAll(() => {
  const buildRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "syndroo-t03-build-")),
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
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "syndroo-t03-")));

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

async function initialize(store: LocalStore, stateHome: string): Promise<void> {
  await withLocalWriteLock(stateHome, async () => {
    await store.initialize();
  });
}

const PROVIDER = "bluesky" as const;
const TARGET_ID = "did:plc:alice";
const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const NAMESPACE = "default";
const KEY = "t03-key-1";
const CONTENT = "hello from t03";

interface Seeded {
  readonly stateHome: string;
  readonly store: LocalStore;
  readonly plan: LocalPlan;
  readonly deliveryId: string;
}

async function seededState(
  options: { readonly now?: () => Date } = {},
): Promise<Seeded> {
  const stateHome = makeStateHome();
  const store = createLocalFileStore(
    stateHome,
    options.now === undefined ? {} : { now: options.now },
  );

  await initialize(store, stateHome);

  let plan!: LocalPlan;

  await withLocalWriteLock(stateHome, async () => {
    await seedConnection(store, {
      provider: PROVIDER,
      targetId: TARGET_ID,
      connectionId: CONNECTION_ID,
      bindingRevision: 1,
    });
    plan = await buildTestPlan({
      store,
      namespace: NAMESPACE,
      key: KEY,
      content: CONTENT,
      provider: PROVIDER,
      targetId: TARGET_ID,
      connectionId: CONNECTION_ID,
      bindingRevision: 1,
      ...(options.now === undefined ? {} : { createdAt: options.now() }),
    });
    await store.putPlan(plan);
  });

  return {
    stateHome,
    store,
    plan,
    deliveryId: plan.items[0]?.delivery.deliveryId as string,
  };
}

describe("STO-01 controlled layout", () => {
  it("creates owner-only directories and files", async () => {
    const stateHome = makeStateHome();
    const store = createLocalFileStore(stateHome);

    await initialize(store, stateHome);

    const root = statSync(stateHome);

    expect(root.mode & 0o777).toBe(0o700);
    expect(root.uid).toBe(process.getuid?.());

    for (const name of [
      "connections",
      "plans",
      "operations",
      "deliveries",
      "quarantine",
    ]) {
      expect(statSync(path.join(stateHome, name)).mode & 0o777).toBe(0o700);
    }

    for (const name of ["installation.json", "integrity.key"]) {
      const file = statSync(path.join(stateHome, name));

      expect(file.mode & 0o777).toBe(0o600);
      expect(file.nlink).toBe(1);
      expect(file.uid).toBe(process.getuid?.());
    }

    expect(readFileSync(path.join(stateHome, "integrity.key")).byteLength).toBe(
      32,
    );
  });

  it("is idempotent and keeps one installation identity", async () => {
    const stateHome = makeStateHome();
    const store = createLocalFileStore(stateHome);

    await initialize(store, stateHome);

    const first = await store.getInstallation();

    await initialize(store, stateHome);

    const second = await store.getInstallation();

    expect(second.installationId).toBe(first.installationId);
    expect(second.installationId).toMatch(/^inst_[0-9a-f]{32}$/);
  });

  it("fails closed when the identity is incomplete", async () => {
    for (const kept of ["installation.json", "integrity.key"]) {
      const stateHome = makeStateHome();
      const store = createLocalFileStore(stateHome);

      await initialize(store, stateHome);
      rmSync(path.join(stateHome, kept));

      const error = await expectCliError(() =>
        withLocalWriteLock(stateHome, async () => {
          await store.initialize();
        }),
      );

      expect(error.code).toBe("STATE_CORRUPT");
      expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
    }
  });

  it("fails closed when history exists without an identity", async () => {
    const stateHome = makeStateHome();

    mkdirSync(stateHome, { mode: 0o700 });
    mkdirSync(path.join(stateHome, "deliveries"), { mode: 0o700 });
    writeFileSync(path.join(stateHome, "deliveries", `${"a".repeat(64)}.json`), "{}\n", {
      mode: 0o600,
    });

    const store = createLocalFileStore(stateHome);
    const error = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => {
        await store.initialize();
      }),
    );

    expect(error.code).toBe("STATE_CORRUPT");
    expect(existsSync(path.join(stateHome, "installation.json"))).toBe(false);
  });

  it("fails closed when quarantine holds evidence without an identity", async () => {
    const stateHome = makeStateHome();

    mkdirSync(stateHome, { mode: 0o700 });
    mkdirSync(path.join(stateHome, "quarantine"), { mode: 0o700 });
    mkdirSync(path.join(stateHome, "quarantine", "lock-0123456789abcdef"), {
      mode: 0o700,
    });

    const store = createLocalFileStore(stateHome);
    const error = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => {
        await store.initialize();
      }),
    );

    expect(error.code).toBe("STATE_CORRUPT");
  });

  it("refuses a symlinked state root", async () => {
    const base = makeRoot();
    const real = path.join(base, "real");

    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, path.join(base, "state"));

    const error = await expectCliError(() =>
      withLocalWriteLock(path.join(base, "state"), async () => undefined),
    );

    expect(error.code).toBe("STATE_CORRUPT");
    expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
  });

  it("refuses a symlinked component in a caller-supplied path", async () => {
    const base = makeRoot();
    const real = path.join(base, "real");

    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, path.join(base, "link"));

    const error = await expectCliError(() =>
      withLocalWriteLock(path.join(base, "link", "state"), async () => undefined),
    );

    expect(error.code).toBe("STATE_CORRUPT");
  });

  it("accepts a state path under the system temporary alias", async () => {
    // os.tmpdir() resolves through /var on macOS; the alias is the one symlink
    // component the store is allowed to follow.
    const stateHome = makeStateHome();
    const store = createLocalFileStore(stateHome);

    await initialize(store, stateHome);

    expect((await store.getInstallation()).schemaVersion).toBe(1);
  });

  it("refuses an existing state root with group or other bits", async () => {
    const { stateHome, store } = await seededState();

    chmodSync(stateHome, 0o755);

    const error = await expectCliError(() => store.getInstallation());

    expect(error.code).toBe("STATE_CORRUPT");
    expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
  });

  it("refuses an existing state file with group or other bits", async () => {
    const { stateHome, store } = await seededState();

    chmodSync(path.join(stateHome, "installation.json"), 0o644);

    const error = await expectCliError(() => store.getInstallation());

    expect(error.code).toBe("STATE_CORRUPT");
  });

  it("refuses a symlinked record file", async () => {
    const { stateHome, store } = await seededState();
    const decoy = path.join(stateHome, "decoy.json");
    const id = "b".repeat(64);

    writeFileSync(decoy, "{}\n", { mode: 0o600 });
    symlinkSync(decoy, path.join(stateHome, "deliveries", `${id}.json`));

    const error = await expectCliError(() => store.getDelivery(id));

    expect(error.code).toBe("STATE_CORRUPT");
  });

  it("refuses a FIFO record path without hanging", async () => {
    const { stateHome, store } = await seededState();
    const id = "c".repeat(64);

    execFileSync("mkfifo", [path.join(stateHome, "deliveries", `${id}.json`)]);

    const started = Date.now();
    const error = await expectCliError(() => store.getDelivery(id));

    expect(error.code).toBe("STATE_CORRUPT");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("refuses a record larger than the accepted bound", async () => {
    const { stateHome, store } = await seededState();
    const id = "d".repeat(64);

    writeFileSync(
      path.join(stateHome, "deliveries", `${id}.json`),
      `{"schemaVersion":1,"data":{"pad":"${"x".repeat(1_200_000)}"}}`,
      { mode: 0o600 },
    );

    const error = await expectCliError(() => store.getDelivery(id));

    expect(error.code).toBe("STATE_CORRUPT");
  });
});

describe("STO-05 corruption and versions", () => {
  it("refuses truncated JSON instead of an empty history", async () => {
    const { stateHome, store } = await seededState();
    const id = "e".repeat(64);

    writeFileSync(
      path.join(stateHome, "deliveries", `${id}.json`),
      '{"schemaVersion":1,"data":{',
      { mode: 0o600 },
    );

    const error = await expectCliError(() => store.getDelivery(id));

    expect(error.code).toBe("STATE_CORRUPT");
  });

  it("refuses a newer schema version", async () => {
    const { stateHome, store } = await seededState();
    const id = "f".repeat(64);

    writeFileSync(
      path.join(stateHome, "deliveries", `${id}.json`),
      `${JSON.stringify({
        schemaVersion: 2,
        data: {},
        mac: "0".repeat(64),
      })}\n`,
      { mode: 0o600 },
    );

    const error = await expectCliError(() => store.getDelivery(id));

    expect(error.code).toBe("STATE_VERSION_UNSUPPORTED");
    expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
  });

  it("refuses a record copied to another delivery file", async () => {
    const { stateHome, store, plan } = await seededState();

    await withLocalWriteLock(stateHome, async () => {
      await store.reserveOperation(plan);
    });

    const other = "1".repeat(64);
    const source = path.join(
      stateHome,
      "deliveries",
      `${plan.items[0]?.delivery.deliveryId as string}.json`,
    );

    copyFileSync(source, path.join(stateHome, "deliveries", `${other}.json`));
    chmodSync(path.join(stateHome, "deliveries", `${other}.json`), 0o600);

    const error = await expectCliError(() => store.getDelivery(other));

    expect(error.code).toBe("STATE_CORRUPT");
  });

  it("returns null only for an intended missing record", async () => {
    const stateHome = makeStateHome();
    const store = createLocalFileStore(stateHome);
    const id = "2".repeat(64);

    const missing = await expectCliError(() => store.getDelivery(id));

    expect(missing.code).toBe("STATE_CORRUPT");

    await initialize(store, stateHome);

    expect(await store.getDelivery(id)).toBeNull();
    expect(await store.getPlan(`plan_${"3".repeat(32)}`)).toBeNull();
    expect(await store.getConnection("threads")).toBeNull();
  });

  it("does not cache a missing record across mutations", async () => {
    const { stateHome, store, plan, deliveryId } = await seededState();

    expect(await store.getDelivery(deliveryId)).toBeNull();

    await withLocalWriteLock(stateHome, async () => {
      await store.reserveOperation(plan);
    });

    expect(await store.getDelivery(deliveryId)).not.toBeNull();
  });

  it("verifies the plan digest and MAC on read", async () => {
    const { stateHome, store, plan } = await seededState();
    const file = path.join(stateHome, "plans", `${plan.planId}.json`);
    const stored = JSON.parse(readFileSync(file, "utf8")) as {
      items: { delivery: { content: string } }[];
    };

    (stored.items[0] as { delivery: { content: string } }).delivery.content =
      "tampered";
    writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });

    const error = await expectCliError(() => store.getPlan(plan.planId));

    expect(error.code).toBe("PLAN_TAMPERED");
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
  });

  it("refuses a plan signed for another installation", async () => {
    const first = await seededState();
    const second = await seededState();
    const foreign = await buildTestPlan({
      store: first.store,
      namespace: NAMESPACE,
      key: "t03-foreign",
      content: CONTENT,
      provider: PROVIDER,
      targetId: TARGET_ID,
      connectionId: CONNECTION_ID,
      bindingRevision: 1,
    });

    const error = await expectCliError(() =>
      withLocalWriteLock(second.stateHome, async () => {
        await second.store.putPlan(foreign);
      }),
    );

    expect(error.code).toBe("PLAN_TAMPERED");
  });

  it("refuses a plan that is valid for longer than a day", async () => {
    const { stateHome, store } = await seededState();
    const longLived = await buildTestPlan({
      store,
      namespace: NAMESPACE,
      key: "t03-long",
      content: CONTENT,
      provider: PROVIDER,
      targetId: TARGET_ID,
      connectionId: CONNECTION_ID,
      bindingRevision: 1,
      ttlMs: 25 * 60 * 60 * 1000,
    });

    const error = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => {
        await store.putPlan(longLived);
      }),
    );

    expect(error.code).toBe("STATE_CORRUPT");
  });
});

describe("STO-02 atomic writes and fault points", () => {
  const preRename = [
    "before-temp-write",
    "after-file-sync",
    "before-rename",
  ] as const;
  const postRename = ["after-rename", "before-directory-sync"] as const;

  it.each(preRename)(
    "keeps the old record when %s fails",
    async point => {
      const { stateHome, store } = await seededState();
      const failing = createLocalFileStore(stateHome, {
        fault: injected => {
          if (injected === point) {
            throw new Error(`injected:${injected}`);
          }
        },
      });

      const error = await expectCliError(() =>
        failing.putConnection(
          connectionRecord({
            provider: PROVIDER,
            targetId: TARGET_ID,
            connectionId: CONNECTION_ID,
            bindingRevision: 2,
          }),
          1,
        ),
      );

      expect(error.code).toBe("STATE_COMMIT_FAILED");
      expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
      expect(error.details).toMatchObject({ committed: false });

      const kept = await store.getConnection(PROVIDER);

      expect(kept?.target.bindingRevision).toBe(1);
      expect(
        readdirSync(path.join(stateHome, "connections")).filter(name =>
          name.startsWith(".tmp-"),
        ),
      ).toEqual([]);
    },
  );

  it.each(postRename)(
    "reports an indeterminate commit when %s fails",
    async point => {
      const { stateHome, store } = await seededState();
      const failing = createLocalFileStore(stateHome, {
        fault: injected => {
          if (injected === point) {
            throw new Error(`injected:${injected}`);
          }
        },
      });

      const error = await expectCliError(() =>
        failing.putConnection(
          connectionRecord({
            provider: PROVIDER,
            targetId: TARGET_ID,
            connectionId: CONNECTION_ID,
            bindingRevision: 2,
          }),
          1,
        ),
      );

      expect(error.code).toBe("STATE_COMMIT_FAILED");
      expect(error.details).toMatchObject({ committed: true });
      expect((await store.getConnection(PROVIDER))?.target.bindingRevision).toBe(
        2,
      );
    },
  );

  it("fails the outcome commit without a usage error", async () => {
    const { stateHome, store, plan, deliveryId } = await seededState();
    const failing = createLocalFileStore(stateHome, {
      fault: injected => {
        if (injected === "before-outcome-commit") {
          throw new Error("injected:outcome");
        }
      },
    });

    await withLocalWriteLock(stateHome, async () => {
      const operation = await store.reserveOperation(plan);

      await store.beginAttempt(
        operation.operationId,
        deliveryId,
        plan.items[0]?.delivery.target as never,
      );

      const error = await expectCliError(() =>
        failing.commitOutcome(operation.operationId, deliveryId, 1, {
          kind: "succeeded",
          remoteId: "at://did:plc:alice/app.bsky.feed.post/1",
          url: null,
        }),
      );

      expect(error.code).toBe("STATE_COMMIT_FAILED");
      expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
    });

    // The intent is still durable: the delivery stays in flight, never
    // silently "not started", so a later run must report it as unknown.
    expect((await store.getDelivery(deliveryId))?.status).toBe("in_flight");
  });
});

describe("STO-03 multi-file admission", () => {
  it("writes the preparing manifest before any delivery and commits ready last", async () => {
    const stateHome = makeStateHome();
    const observations: string[] = [];
    const store = createLocalFileStore(stateHome, {
      fault: point => {
        if (point !== "before-temp-write") {
          return;
        }

        const operations = readdirSync(path.join(stateHome, "operations")).filter(
          name => name.endsWith(".json"),
        );
        const deliveries = readdirSync(path.join(stateHome, "deliveries")).filter(
          name => name.endsWith(".json"),
        );
        let state = "none";

        if (operations.length > 0) {
          const parsed = JSON.parse(
            readFileSync(
              path.join(stateHome, "operations", operations[0] as string),
              "utf8",
            ),
          ) as { data: { admissionState: string } };

          state = parsed.data.admissionState;
        }

        observations.push(`${state}|${deliveries.length}`);
      },
    });

    await initialize(store, stateHome);

    let plan!: LocalPlan;

    await withLocalWriteLock(stateHome, async () => {
      await seedConnection(store, {
        provider: PROVIDER,
        targetId: TARGET_ID,
        connectionId: CONNECTION_ID,
        bindingRevision: 1,
      });
      plan = await buildTestPlan({
        store,
        namespace: NAMESPACE,
        key: KEY,
        content: CONTENT,
        provider: PROVIDER,
        targetId: TARGET_ID,
        connectionId: CONNECTION_ID,
        bindingRevision: 1,
      });
      await store.putPlan(plan);
    });

    observations.length = 0;

    let operation!: Awaited<ReturnType<LocalStore["reserveOperation"]>>;

    await withLocalWriteLock(stateHome, async () => {
      operation = await store.reserveOperation(plan);
    });

    expect(observations).toEqual([
      "none|0",
      "preparing|0",
      "preparing|1",
    ]);
    expect(operation.admissionState).toBe("ready");

    const record = await store.getDelivery(plan.items[0]?.delivery.deliveryId as string);

    expect(record?.status).toBe("not_started");
    expect(record?.attempts).toBe(0);
    expect(record?.outcome).toBeNull();
    expect(record?.operationId).toBe(operation.operationId);
  });

  it("re-enters the same operation after a crash before ready", async () => {
    const stateHome = makeStateHome();
    const run = await runWriter({
      entry: writerEntry,
      mode: "seed-and-crash",
      stateHome,
      env: { SYNDROO_T03_KILL_AT: "7" },
    });

    expect(run.signal).toBe("SIGKILL");

    const inspection = await inspectLocalState(stateHome);

    expect(inspection.preparingOperations).toHaveLength(1);
    expect(inspection.temporaryFiles.length).toBeGreaterThan(0);
    expect(inspection.corrupt).toEqual([]);

    // A crashed writer leaves its lock behind, so re-entry needs the explicit
    // maintenance path first.
    await recoverLocalState(stateHome, { confirmNoWriters: true, yes: true });

    const store = createLocalFileStore(stateHome);
    const planId = readdirSync(path.join(stateHome, "plans"))[0]?.replace(
      ".json",
      "",
    ) as string;
    const plan = await store.getPlan(planId);

    expect(plan).not.toBeNull();

    const before = readdirSync(path.join(stateHome, "deliveries")).length;
    let operation!: Awaited<ReturnType<LocalStore["reserveOperation"]>>;

    await withLocalWriteLock(stateHome, async () => {
      operation = await store.reserveOperation(plan as LocalPlan);
    });

    expect(operation.operationId).toBe(inspection.preparingOperations[0]);
    expect(operation.admissionState).toBe("ready");
    expect(readdirSync(path.join(stateHome, "deliveries")).length).toBe(before);

    const record = await store.getDelivery(operation.deliveryIds[0] as string);

    expect(record?.status).toBe("not_started");
    expect(record?.attempts).toBe(0);
  });

  it("completes a crash between the manifest and its first delivery", async () => {
    const stateHome = makeStateHome();
    const run = await runWriter({
      entry: writerEntry,
      mode: "seed-and-crash",
      stateHome,
      env: { SYNDROO_T03_KILL_AT: "6" },
    });

    expect(run.signal).toBe("SIGKILL");

    const inspection = await inspectLocalState(stateHome);

    expect(inspection.preparingOperations).toHaveLength(1);

    await recoverLocalState(stateHome, { confirmNoWriters: true, yes: true });

    const store = createLocalFileStore(stateHome);
    const planId = readdirSync(path.join(stateHome, "plans"))[0]?.replace(
      ".json",
      "",
    ) as string;
    const plan = (await store.getPlan(planId)) as LocalPlan;
    let operation!: Awaited<ReturnType<LocalStore["reserveOperation"]>>;

    await withLocalWriteLock(stateHome, async () => {
      operation = await store.reserveOperation(plan);
    });

    expect(operation.admissionState).toBe("ready");
    expect(await store.getDelivery(operation.deliveryIds[0] as string)).not.toBeNull();
  });

  it("refuses to resume an expired preparing plan", async () => {
    const clock = { value: new Date("2026-09-24T00:00:00.000Z") };
    const stateHome = makeStateHome();
    let writes = 0;
    const store = createLocalFileStore(stateHome, {
      now: () => clock.value,
      fault: point => {
        if (point === "before-temp-write") {
          writes++;

          return;
        }

        if (point === "before-rename" && writes === 7) {
          throw new Error("injected crash before ready");
        }
      },
    });

    await initialize(store, stateHome);

    let plan!: LocalPlan;

    await withLocalWriteLock(stateHome, async () => {
      await seedConnection(store, {
        provider: PROVIDER,
        targetId: TARGET_ID,
        connectionId: CONNECTION_ID,
        bindingRevision: 1,
      });
      plan = await buildTestPlan({
        store,
        namespace: NAMESPACE,
        key: KEY,
        content: CONTENT,
        provider: PROVIDER,
        targetId: TARGET_ID,
        connectionId: CONNECTION_ID,
        bindingRevision: 1,
        createdAt: clock.value,
      });
      await store.putPlan(plan);
    });

    const crash = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => {
        await store.reserveOperation(plan);
      }),
    );

    expect(crash.code).toBe("STATE_COMMIT_FAILED");
    expect((await inspectLocalState(stateHome)).preparingOperations).toHaveLength(
      1,
    );

    clock.value = new Date(Date.parse(plan.expiresAt) + 1000);

    const error = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => {
        await store.reserveOperation(plan);
      }),
    );

    expect(error.code).toBe("PLAN_EXPIRED");
    expect((await inspectLocalState(stateHome)).preparingOperations).toHaveLength(
      1,
    );
  });

  it("stops when a preparing manifest conflicts with an in-flight record", async () => {
    const stateHome = makeStateHome();
    let writes = 0;
    const store = createLocalFileStore(stateHome, {
      fault: point => {
        if (point === "before-temp-write") {
          writes++;

          return;
        }

        if (point === "before-rename" && writes === 7) {
          throw new Error("injected crash before ready");
        }
      },
    });

    await initialize(store, stateHome);

    let plan!: LocalPlan;
    let operationId!: string;

    await withLocalWriteLock(stateHome, async () => {
      await seedConnection(store, {
        provider: PROVIDER,
        targetId: TARGET_ID,
        connectionId: CONNECTION_ID,
        bindingRevision: 1,
      });
      plan = await buildTestPlan({
        store,
        namespace: NAMESPACE,
        key: KEY,
        content: CONTENT,
        provider: PROVIDER,
        targetId: TARGET_ID,
        connectionId: CONNECTION_ID,
        bindingRevision: 1,
      });
      await store.putPlan(plan);
    });

    await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => {
        await store.reserveOperation(plan);
      }),
    );

    operationId = await store.operationIdFor(plan.planId);

    const deliveryId = plan.items[0]?.delivery.deliveryId as string;

    forgeRecord(stateHome, "deliveries", deliveryId, {
      schemaVersion: 1,
      delivery: plan.items[0]?.delivery,
      status: "in_flight",
      attempts: 1,
      operationId,
      outcome: null,
      updatedAt: "2026-09-24T00:00:00.000Z",
    });

    const error = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => {
        await store.reserveOperation(plan);
      }),
    );

    expect(error.code).toBe("STATE_CORRUPT");
    expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
  });

  it("refuses a retry whose authoritative record is gone", async () => {
    const { stateHome, store, plan, deliveryId } = await seededState();
    let operationId!: string;

    await withLocalWriteLock(stateHome, async () => {
      const operation = await store.reserveOperation(plan);

      operationId = operation.operationId;
    });

    rmSync(path.join(stateHome, "deliveries", `${deliveryId}.json`));

    const retry = await buildTestPlan({
      store,
      namespace: NAMESPACE,
      key: KEY,
      content: CONTENT,
      provider: PROVIDER,
      targetId: TARGET_ID,
      connectionId: CONNECTION_ID,
      bindingRevision: 1,
      action: "retry",
      kind: "retry",
      parentOperationId: operationId,
    });

    const error = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => {
        await store.reserveOperation(retry);
      }),
    );

    expect(error.code).toBe("STATE_CORRUPT");
    expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
    expect(readdirSync(path.join(stateHome, "deliveries"))).toEqual([]);
  });

  it("admits a skip against an older recorded binding without rewriting it", async () => {
    const { stateHome, store, plan, deliveryId } = await seededState();
    let operationId!: string;

    await withLocalWriteLock(stateHome, async () => {
      const operation = await store.reserveOperation(plan);

      operationId = operation.operationId;
      await store.beginAttempt(
        operation.operationId,
        deliveryId,
        plan.items[0]?.delivery.target as never,
      );
      await store.commitOutcome(operation.operationId, deliveryId, 1, {
        kind: "succeeded",
        remoteId: "at://did:plc:alice/app.bsky.feed.post/2",
        url: null,
      });
      await store.putConnection(
        connectionRecord({
          provider: PROVIDER,
          targetId: TARGET_ID,
          connectionId: CONNECTION_ID,
          bindingRevision: 2,
        }),
        1,
      );
    });

    const skip = await buildTestPlan({
      store,
      namespace: NAMESPACE,
      key: KEY,
      content: CONTENT,
      provider: PROVIDER,
      targetId: TARGET_ID,
      connectionId: CONNECTION_ID,
      bindingRevision: 2,
      action: "skip",
    });

    let admitted!: Awaited<ReturnType<LocalStore["reserveOperation"]>>;

    await withLocalWriteLock(stateHome, async () => {
      admitted = await store.reserveOperation(skip);
    });

    expect(admitted.admissionState).toBe("ready");

    const record = await store.getDelivery(deliveryId);

    expect(record?.status).toBe("succeeded");
    expect(record?.attempts).toBe(1);
    expect(record?.delivery.target.bindingRevision).toBe(1);
    expect(record?.operationId).toBe(operationId);
  });

  it("refuses an ordinary publish that another operation prepared", async () => {
    const { stateHome, store, plan } = await seededState();

    await withLocalWriteLock(stateHome, async () => {
      await store.reserveOperation(plan);
    });

    const other = await buildTestPlan({
      store,
      namespace: NAMESPACE,
      key: KEY,
      content: CONTENT,
      provider: PROVIDER,
      targetId: TARGET_ID,
      connectionId: CONNECTION_ID,
      bindingRevision: 1,
    });

    const error = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => {
        await store.reserveOperation(other);
      }),
    );

    expect(error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("refuses a plan whose binding is no longer current", async () => {
    const { stateHome, store, plan } = await seededState();

    await withLocalWriteLock(stateHome, async () => {
      await store.putConnection(
        connectionRecord({
          provider: PROVIDER,
          targetId: "did:plc:someone-else",
          connectionId: `conn_${"b".repeat(32)}`,
          bindingRevision: 2,
        }),
        1,
      );
    });

    const error = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => {
        await store.reserveOperation(plan);
      }),
    );

    expect(error.code).toBe("BINDING_CHANGED");
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
  });

  it("treats an identical plan write as a no-op and refuses a different one", async () => {
    const { stateHome, store, plan } = await seededState();

    await withLocalWriteLock(stateHome, async () => {
      await store.putPlan(plan);
    });

    const other = await buildTestPlan({
      store,
      namespace: NAMESPACE,
      key: "t03-different-key",
      content: CONTENT,
      provider: PROVIDER,
      targetId: TARGET_ID,
      connectionId: CONNECTION_ID,
      bindingRevision: 1,
      planId: plan.planId,
    });

    const error = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => {
        await store.putPlan(other);
      }),
    );

    expect(error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await store.getPlan(plan.planId))?.items[0]?.delivery.key).toBe(KEY);
  });

  it("refuses an expired plan on first admission", async () => {
    const { stateHome, store } = await seededState();
    const expired = await buildTestPlan({
      store,
      namespace: NAMESPACE,
      key: "t03-expired",
      content: CONTENT,
      provider: PROVIDER,
      targetId: TARGET_ID,
      connectionId: CONNECTION_ID,
      bindingRevision: 1,
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    await withLocalWriteLock(stateHome, async () => {
      await store.putPlan(expired);
    });

    const error = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => {
        await store.reserveOperation(expired);
      }),
    );

    expect(error.code).toBe("PLAN_EXPIRED");
  });
});

describe("attempts and outcomes", () => {
  it("marks an operation as interrupted without touching deliveries", async () => {
    const { stateHome, store, plan, deliveryId } = await seededState();

    await withLocalWriteLock(stateHome, async () => {
      const operation = await store.reserveOperation(plan);

      expect(operation.interrupted).toBe(false);

      await store.markInterrupted(operation.operationId);

      expect(
        (await store.getOperation(operation.operationId))?.interrupted,
      ).toBe(true);
      expect((await store.getDelivery(deliveryId))?.status).toBe("not_started");
    });
  });

  it("persists the attempt before returning and refuses a late outcome", async () => {
    const { stateHome, store, plan, deliveryId } = await seededState();

    await withLocalWriteLock(stateHome, async () => {
      const operation = await store.reserveOperation(plan);
      const attempts = await store.beginAttempt(
        operation.operationId,
        deliveryId,
        plan.items[0]?.delivery.target as never,
      );

      expect(attempts).toBe(1);

      const inFlight = await store.getDelivery(deliveryId);

      expect(inFlight?.status).toBe("in_flight");
      expect(inFlight?.attempts).toBe(1);
      expect(inFlight?.outcome).toBeNull();

      await store.commitOutcome(operation.operationId, deliveryId, 1, {
        kind: "succeeded",
        remoteId: "at://did:plc:alice/app.bsky.feed.post/3",
        url: "https://bsky.app/profile/alice/post/3",
      });

      const succeeded = await store.getDelivery(deliveryId);

      expect(succeeded?.status).toBe("succeeded");
      expect(succeeded?.attempts).toBe(1);

      const late = await expectCliError(() =>
        store.commitOutcome(operation.operationId, deliveryId, 1, {
          kind: "failed",
          code: "NETWORK",
          writeDisposition: "not_applied",
          retryable: true,
          retryNotBefore: null,
        }),
      );

      expect(late.code).toBe("STATE_COMMIT_FAILED");
      expect(late.exitCode).toBe(EXIT_CODE.FAILURE);
      expect((await store.getDelivery(deliveryId))?.status).toBe("succeeded");
    });
  });

  it("exhausts the attempt limit across operations", async () => {
    const { stateHome, store, plan, deliveryId } = await seededState();
    let operationId!: string;

    await withLocalWriteLock(stateHome, async () => {
      const operation = await store.reserveOperation(plan);

      operationId = operation.operationId;
    });

    forgeRecord(stateHome, "deliveries", deliveryId, {
      schemaVersion: 1,
      delivery: plan.items[0]?.delivery,
      status: "failed",
      attempts: 3,
      operationId,
      outcome: {
        kind: "failed",
        code: "PROVIDER_UNAVAILABLE",
        writeDisposition: "not_applied",
        retryable: true,
        retryNotBefore: null,
      },
      updatedAt: "2026-09-24T00:00:00.000Z",
    });

    const retry = await buildTestPlan({
      store,
      namespace: NAMESPACE,
      key: KEY,
      content: CONTENT,
      provider: PROVIDER,
      targetId: TARGET_ID,
      connectionId: CONNECTION_ID,
      bindingRevision: 1,
      action: "retry",
      kind: "retry",
      parentOperationId: operationId,
    });

    const error = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => {
        await store.reserveOperation(retry);
      }),
    );

    expect(error.code).toBe("ATTEMPTS_EXHAUSTED");
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
  });

  it("refuses an attempt before its retry window opens", async () => {
    const { stateHome, store, plan, deliveryId } = await seededState();
    let operationId!: string;

    await withLocalWriteLock(stateHome, async () => {
      const operation = await store.reserveOperation(plan);

      operationId = operation.operationId;
    });

    forgeRecord(stateHome, "deliveries", deliveryId, {
      schemaVersion: 1,
      delivery: plan.items[0]?.delivery,
      status: "failed",
      attempts: 1,
      operationId,
      outcome: {
        kind: "failed",
        code: "RATE_LIMIT",
        writeDisposition: "not_applied",
        retryable: true,
        retryNotBefore: "2099-01-01T00:00:00.000Z",
      },
      updatedAt: "2026-09-24T00:00:00.000Z",
    });

    const retry = await buildTestPlan({
      store,
      namespace: NAMESPACE,
      key: KEY,
      content: CONTENT,
      provider: PROVIDER,
      targetId: TARGET_ID,
      connectionId: CONNECTION_ID,
      bindingRevision: 1,
      action: "retry",
      kind: "retry",
      parentOperationId: operationId,
    });

    const error = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => {
        await store.reserveOperation(retry);
      }),
    );

    expect(error.code).toBe("RETRY_NOT_READY");
  });
});

describe("connections", () => {
  it("enforces the revision compare-and-set and keeps tombstones", async () => {
    const stateHome = makeStateHome();
    const store = createLocalFileStore(stateHome);

    await initialize(store, stateHome);

    await withLocalWriteLock(stateHome, async () => {
      await seedConnection(store, {
        provider: PROVIDER,
        targetId: TARGET_ID,
        connectionId: CONNECTION_ID,
        bindingRevision: 1,
      });

      const stale = await expectCliError(() =>
        seedConnection(store, {
          provider: PROVIDER,
          targetId: TARGET_ID,
          connectionId: CONNECTION_ID,
          bindingRevision: 2,
        }),
      );

      expect(stale.code).toBe("BINDING_CHANGED");

      await seedConnection(store, {
        provider: PROVIDER,
        targetId: TARGET_ID,
        connectionId: CONNECTION_ID,
        bindingRevision: 2,
        expectedRevision: 1,
      });

      const frozen = await expectCliError(() =>
        seedConnection(store, {
          provider: PROVIDER,
          targetId: TARGET_ID,
          connectionId: CONNECTION_ID,
          bindingRevision: 2,
          expectedRevision: 2,
        }),
      );

      expect(frozen.code).toBe("BINDING_CHANGED");

      await seedConnection(store, {
        provider: PROVIDER,
        targetId: TARGET_ID,
        connectionId: CONNECTION_ID,
        bindingRevision: 3,
        removed: true,
        expectedRevision: 2,
      });

      const removed = await store.getConnection(PROVIDER);

      expect(removed?.removed).toBe(true);
      expect(removed?.target.bindingRevision).toBe(3);

      await seedConnection(store, {
        provider: PROVIDER,
        targetId: TARGET_ID,
        connectionId: CONNECTION_ID,
        bindingRevision: 4,
        expectedRevision: 3,
      });

      expect((await store.getConnection(PROVIDER))?.removed).toBe(false);
    });
  });
});

describe("operations listing", () => {
  it("filters by namespace before the limit and sorts newest first", async () => {
    const clock = { value: new Date("2026-09-24T00:00:00.000Z") };
    const stateHome = makeStateHome();
    const store = createLocalFileStore(stateHome, { now: () => clock.value });

    await initialize(store, stateHome);

    const ids: string[] = [];

    await withLocalWriteLock(stateHome, async () => {
      await seedConnection(store, {
        provider: PROVIDER,
        targetId: TARGET_ID,
        connectionId: CONNECTION_ID,
        bindingRevision: 1,
      });

      for (const [namespace, key] of [
        ["alpha", "list-1"],
        ["beta", "list-2"],
        ["alpha", "list-3"],
      ] as const) {
        const plan = await buildTestPlan({
          store,
          namespace,
          key,
          content: CONTENT,
          provider: PROVIDER,
          targetId: TARGET_ID,
          connectionId: CONNECTION_ID,
          bindingRevision: 1,
          createdAt: clock.value,
        });

        await store.putPlan(plan);
        ids.push((await store.reserveOperation(plan)).operationId);
        clock.value = new Date(clock.value.getTime() + 1000);
      }
    });

    const alpha = await store.listOperations(1, "alpha");

    expect(alpha).toHaveLength(1);
    expect(alpha[0]?.operationId).toBe(ids[2]);

    const all = await store.listOperations(10);

    expect(all.map(operation => operation.operationId)).toEqual([
      ids[2],
      ids[1],
      ids[0],
    ]);

    const bad = await expectCliError(() => store.listOperations(0));

    expect(bad.code).toBe("INVALID_DOCUMENT");
  });
});

describe("inspection", () => {
  it("reports a missing state without creating it", async () => {
    const stateHome = makeStateHome();
    const inspection = await inspectLocalState(stateHome);

    expect(inspection.exists).toBe(false);
    expect(inspection.safe).toBe(false);
    expect(inspection.corrupt).toEqual([]);
    expect(lstatSync(stateHome, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("is read-only on a healthy state", async () => {
    const { stateHome, store, plan } = await seededState();

    await withLocalWriteLock(stateHome, async () => {
      await store.reserveOperation(plan);
    });

    const before = snapshot(stateHome);
    const inspection = await inspectLocalState(stateHome);

    expect(inspection.exists).toBe(true);
    expect(inspection.safe).toBe(true);
    expect(inspection.corrupt).toEqual([]);
    expect(inspection.installationId).toMatch(/^inst_[0-9a-f]{32}$/);
    expect(snapshot(stateHome)).toEqual(before);
  });

  it("reports a missing required directory and an unsafe identity", async () => {
    const { stateHome } = await seededState();

    rmSync(path.join(stateHome, "deliveries"), { recursive: true });

    const inspection = await inspectLocalState(stateHome);

    expect(inspection.safe).toBe(false);
    expect(inspection.corrupt).toContainEqual({
      collection: "deliveries",
      id: "directory",
      code: "STATE_CORRUPT",
    });
  });

  it("reports a missing installation record as a defect", async () => {
    const { stateHome } = await seededState();

    rmSync(path.join(stateHome, "installation.json"));

    const inspection = await inspectLocalState(stateHome);

    expect(inspection.safe).toBe(false);
    expect(inspection.installationId).toBeNull();
    expect(inspection.corrupt).toContainEqual({
      collection: "installation",
      id: "installation",
      code: "STATE_CORRUPT",
    });
  });

  it("never echoes an unrecognized entry name", async () => {
    const { stateHome } = await seededState();
    const hostile = "secret\u0007name";

    writeFileSync(path.join(stateHome, "deliveries", hostile), "{}\n", {
      mode: 0o600,
    });

    const inspection = await inspectLocalState(stateHome);

    expect(inspection.safe).toBe(false);
    expect(inspection.corrupt).toContainEqual({
      collection: "deliveries",
      id: "unrecognized-entry",
      code: "STATE_CORRUPT",
    });
    expect(JSON.stringify(inspection)).not.toContain("secret");
  });

  it("reports orphan in-flight deliveries and preparing operations", async () => {
    const stateHome = makeStateHome();
    const run = await runWriter({
      entry: writerEntry,
      mode: "intent-then-die",
      stateHome,
    });

    expect(run.signal).toBe("SIGKILL");

    const inspection = await inspectLocalState(stateHome);

    expect(inspection.orphanInFlight).toHaveLength(1);
    expect(inspection.lock.held).toBe(true);
    expect(inspection.lock.owner?.pid).toBeGreaterThan(0);
  });

  it("reports a corrupt lock owner without leaking its token", async () => {
    const { stateHome } = await seededState();

    mkdirSync(path.join(stateHome, ".write-lock"), { mode: 0o700 });
    writeFileSync(path.join(stateHome, ".write-lock", "owner.json"), "{}\n", {
      mode: 0o600,
    });

    const inspection = await inspectLocalState(stateHome);

    expect(inspection.lock.held).toBe(true);
    expect(inspection.lock.owner).toBeNull();
    expect(inspection.corrupt).toContainEqual({
      collection: "lock",
      id: "owner",
      code: "STATE_CORRUPT",
    });
  });
});

describe("plan identity", () => {
  it("derives a deterministic operation id", async () => {
    const { store, plan } = await seededState();
    const installation = await store.getInstallation();
    const expected = `op_${sha256Hex(
      `[${JSON.stringify(installation.installationId)},${JSON.stringify(
        plan.planId,
      )}]`,
    )}`;

    expect(await store.operationIdFor(plan.planId)).toBe(expected);
    expect(await store.operationIdFor(plan.planId)).toBe(
      await store.operationIdFor(plan.planId),
    );
  });

  it("rejects a malformed identifier and accepts an unknown one", async () => {
    const { store } = await seededState();

    const error = await expectCliError(() => store.getPlan("not-a-plan-id"));

    expect(error.code).toBe("INVALID_DOCUMENT");
    expect(await store.getOperation(`op_${"9".repeat(64)}`)).toBeNull();
  });
});

function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};

  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = lstatSync(full);
      const key = path.relative(root, full);

      entries[key] = `${stat.mode}:${stat.size}:${stat.mtimeMs}`;

      if (stat.isDirectory()) {
        walk(full);
      }
    }
  };

  walk(root);

  return entries;
}

function existsSync(target: string): boolean {
  return lstatSync(target, { throwIfNoEntry: false }) !== undefined;
}
