import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CliError } from "../../src/cli-error.js";
import { EXIT_CODE } from "../../src/exit-codes.js";
import {
  LocalLockReleaseError,
  lockReleaseFailureOf,
  withLocalWriteLock,
} from "../../src/local/state/lock.js";
import { inspectLocalState } from "../../src/local/state/store.js";
import { compileWriter, runWriter } from "../fixtures/local-writer.js";

/**
 * LOCK-01..04: real OS writers compete for one lock, ownership is never stolen,
 * the recovery guard is checked on both sides of acquisition, and configuration
 * writes serialize with execution preparation.
 */

const TEMP_ROOTS: string[] = [];
const BUILD_ROOTS: string[] = [];
let writerEntry = "";

beforeAll(() => {
  const buildRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "syndroo-t03-lock-build-")),
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
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "syndroo-t03-lock-")));

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

async function expectThrown(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }

  throw new Error("expected a thrown error");
}

function lockDir(stateHome: string): string {
  return path.join(stateHome, ".write-lock");
}

function guardDir(stateHome: string): string {
  return path.join(stateHome, ".recovery-lock");
}

function exists(target: string): boolean {
  return lstatSync(target, { throwIfNoEntry: false }) !== undefined;
}

function writeOwner(stateHome: string, token: string, hostname: string, pid: number, createdAt: string): void {
  writeFileSync(
    path.join(lockDir(stateHome), "owner.json"),
    `${JSON.stringify({ schemaVersion: 1, token, hostname, pid, createdAt })}\n`,
    { mode: 0o600 },
  );
}

async function waitForLock(stateHome: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const inspection = await inspectLocalState(stateHome);

    if (inspection.lock.held && inspection.lock.owner !== null) {
      return inspection.lock.owner.pid;
    }

    await new Promise(resolve => {
      setTimeout(resolve, 25);
    });
  }

  throw new Error("the writer never took the lock");
}

describe("LOCK-01 two real writers", () => {
  it("grants exactly one owner and refuses the other", async () => {
    const stateHome = makeStateHome();
    const options = {
      entry: writerEntry,
      mode: "try-lock",
      stateHome,
      env: { SYNDROO_T03_HOLD_MS: "600" },
    };
    const [first, second] = await Promise.all([
      runWriter(options),
      runWriter(options),
    ]);
    const reports = [first.report, second.report] as {
      ok: boolean;
      code?: string;
    }[];

    expect(reports.filter(report => report.ok)).toHaveLength(1);
    expect(
      reports.filter(report => !report.ok).map(report => report.code),
    ).toEqual(["STATE_BUSY"]);
    expect(exists(path.join(lockDir(stateHome), "owner.json"))).toBe(false);
  });

  it("keeps a live writer's lock and never steals it after a kill", async () => {
    const stateHome = makeStateHome();
    const pending = runWriter({
      entry: writerEntry,
      mode: "hold-forever",
      stateHome,
    });
    const pid = await waitForLock(stateHome);
    const blocked = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => undefined),
    );

    expect(blocked.code).toBe("STATE_BUSY");
    expect(blocked.exitCode).toBe(EXIT_CODE.USAGE);

    process.kill(pid, "SIGKILL");
    await pending;

    const afterKill = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => undefined),
    );

    expect(afterKill.code).toBe("STATE_BUSY");
    expect(exists(path.join(lockDir(stateHome), "owner.json"))).toBe(true);
  });
});

describe("LOCK-02 ownership", () => {
  it("never releases or removes another writer's lock", async () => {
    const stateHome = makeStateHome();

    await withLocalWriteLock(stateHome, async () => undefined);
    mkdirSync(lockDir(stateHome), { mode: 0o700 });
    writeOwner(
      stateHome,
      "f".repeat(64),
      "another-host",
      1,
      "2000-01-01T00:00:00.000Z",
    );

    const error = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => undefined),
    );

    expect(error.code).toBe("STATE_BUSY");

    const owner = JSON.parse(
      readFileSync(path.join(lockDir(stateHome), "owner.json"), "utf8"),
    ) as { token: string; hostname: string };

    expect(owner.token).toBe("f".repeat(64));
    expect(owner.hostname).toBe("another-host");
  });

  it("fails closed on a malformed owner record", async () => {
    const stateHome = makeStateHome();

    await withLocalWriteLock(stateHome, async () => undefined);
    mkdirSync(lockDir(stateHome), { mode: 0o700 });
    writeFileSync(path.join(lockDir(stateHome), "owner.json"), "{}\n", {
      mode: 0o600,
    });

    const error = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => undefined),
    );

    expect(error.code).toBe("STATE_BUSY");

    const inspection = await inspectLocalState(stateHome);

    expect(inspection.lock.held).toBe(true);
    expect(inspection.lock.owner).toBeNull();
  });

  it("keeps the callback error primary when the release succeeded", async () => {
    const stateHome = makeStateHome();
    const failure = new Error("callback failed");
    const thrown = await expectThrown(() =>
      withLocalWriteLock(stateHome, async () => {
        throw failure;
      }),
    );

    expect(thrown).toBe(failure);
    expect(lockReleaseFailureOf(thrown)).toBeNull();
    expect(exists(lockDir(stateHome))).toBe(false);
  });

  it("preserves a completed result when the release fails", async () => {
    const stateHome = makeStateHome();
    const error = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => {
        writeOwner(
          stateHome,
          "e".repeat(64),
          "another-host",
          1,
          "2026-09-24T00:00:00.000Z",
        );

        return "receipt";
      }),
    );

    expect(error).toBeInstanceOf(LocalLockReleaseError);
    expect((error as LocalLockReleaseError).result).toBe("receipt");
    expect(error.code).toBe("STATE_COMMIT_FAILED");
    expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
    expect(exists(lockDir(stateHome))).toBe(true);
  });

  it("attaches a secondary failure when the callback also failed", async () => {
    const stateHome = makeStateHome();
    const failure = new Error("callback failed");
    const thrown = await expectThrown(() =>
      withLocalWriteLock(stateHome, async () => {
        writeOwner(
          stateHome,
          "d".repeat(64),
          "another-host",
          1,
          "2026-09-24T00:00:00.000Z",
        );

        throw failure;
      }),
    );

    expect(thrown).toBe(failure);
    expect(lockReleaseFailureOf(thrown)?.code).toBe("STATE_COMMIT_FAILED");
    expect(exists(lockDir(stateHome))).toBe(true);
  });
});

describe("LOCK-03 recovery guard", () => {
  it("refuses a new writer while the guard exists", async () => {
    const stateHome = makeStateHome();

    await withLocalWriteLock(stateHome, async () => undefined);
    mkdirSync(guardDir(stateHome), { mode: 0o700 });

    const error = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => undefined),
    );

    expect(error.code).toBe("STATE_BUSY");
    expect(exists(guardDir(stateHome))).toBe(true);

    const child = await runWriter({
      entry: writerEntry,
      mode: "try-lock",
      stateHome,
    });

    expect((child.report as { ok: boolean }).ok).toBe(false);
    expect(exists(guardDir(stateHome))).toBe(true);
  });

  it("loses the guard race without leaving a lock behind", async () => {
    const stateHome = makeStateHome();

    await withLocalWriteLock(stateHome, async () => undefined);

    const pending = withLocalWriteLock(stateHome, async () => "ran");

    // The guard appears inside the acquisition window: either the check before
    // the lock or the one after it must refuse, and no lock may survive.
    mkdirSync(guardDir(stateHome), { mode: 0o700 });

    const error = await expectCliError(() => pending);

    expect(error.code).toBe("STATE_BUSY");
    expect(exists(lockDir(stateHome))).toBe(false);
    expect(exists(guardDir(stateHome))).toBe(true);
  });

  it("treats a corrupt guard as corruption, not as a busy state", async () => {
    const stateHome = makeStateHome();

    await withLocalWriteLock(stateHome, async () => undefined);
    writeFileSync(guardDir(stateHome), "not a directory\n", { mode: 0o600 });

    const error = await expectCliError(() =>
      withLocalWriteLock(stateHome, async () => undefined),
    );

    expect(error.code).toBe("STATE_CORRUPT");
    expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
  });
});

describe("LOCK-04 serialized writers", () => {
  it("serializes two real writers without interleaving", async () => {
    const stateHome = makeStateHome();
    const log = path.join(path.dirname(stateHome), "writers.log");
    const options = {
      entry: writerEntry,
      mode: "compete-retry",
      stateHome,
      env: {
        SYNDROO_T03_LOG: log,
        SYNDROO_T03_HOLD_MS: "120",
        SYNDROO_T03_ATTEMPTS: "120",
      },
    };
    const [first, second] = await Promise.all([
      runWriter(options),
      runWriter(options),
    ]);

    expect((first.report as { ok: boolean }).ok).toBe(true);
    expect((second.report as { ok: boolean }).ok).toBe(true);

    const lines = readFileSync(log, "utf8").trim().split("\n");

    expect(lines).toHaveLength(4);
    expect(lines.map(line => line.split(":")[0])).toEqual([
      "enter",
      "exit",
      "enter",
      "exit",
    ]);
    expect(exists(lockDir(stateHome))).toBe(false);
  });
});
