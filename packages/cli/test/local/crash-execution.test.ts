import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { EXIT_CODE } from "../../src/exit-codes.js";
import { executeLocalPlan } from "../../src/local/execute.js";
import { exitCodeForResult } from "../../src/local/results.js";
import { recoverLocalState } from "../../src/local/state/store.js";
import {
  compileExecutionChild,
  killChild,
  readEvidence,
  spawnExecutionChild,
  waitForExit,
  waitForFile,
  type SpawnedChild,
} from "../fixtures/local-execute-child.js";
import {
  openExecution,
  succeeded,
  type ExecutionFixture,
} from "./support/execute-fixture.js";

/**
 * Execution across real OS processes.
 *
 * The children run the compiled fixture, hold the real cooperative write lock,
 * and are stopped with real signals, so the statuses on disk are evidence of
 * what the process actually did rather than what one event loop promised.
 */

let buildRoot = "";
let childEntry = "";
const directories: string[] = [];
const fixtures: ExecutionFixture[] = [];
const children: SpawnedChild[] = [];

beforeAll(() => {
  buildRoot = mkdtempSync(path.join(tmpdir(), "syndroo-child-"));
  childEntry = compileExecutionChild(path.join(buildRoot, "build"));
});

afterAll(() => {
  rmSync(buildRoot, { recursive: true, force: true });
});

afterEach(() => {
  // A failed assertion must not leave a worker holding the state lock.
  for (const child of children.splice(0)) {
    killChild(child);
  }

  for (const state of fixtures.splice(0)) {
    state.cleanup();
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture(): Promise<ExecutionFixture> {
  const state = await openExecution();
  fixtures.push(state);
  return state;
}

function controlDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "syndroo-control-"));
  directories.push(directory);
  return directory;
}

function started(child: SpawnedChild, file: string): Promise<void> {
  return waitForFile(file).catch(error => {
    killChild(child);
    throw new Error(`${String(error)}: ${child.stderr()}`);
  });
}

function spawn(
  mode: Parameters<typeof spawnExecutionChild>[1],
  stateHome: string,
  planId: string,
  controlDir: string,
): SpawnedChild {
  const child = spawnExecutionChild(childEntry, mode, stateHome, planId, controlDir);
  children.push(child);
  return child;
}

describe("execution processes", () => {
  it("stops on SIGINT with exit 130 and real per-target statuses", async () => {
    const state = await fixture();
    const plan = await state.publishPlan();
    const control = controlDir();
    const child = spawn("abort", state.stateHome, plan.planId, control);

    await started(child, path.join(control, "abort.started"));
    child.child.kill("SIGINT");

    const code = await waitForExit(child);

    expect(code).toBe(EXIT_CODE.INTERRUPTED);

    const evidence = readEvidence(path.join(control, "abort.json"));

    expect(evidence.interrupted).toBe(true);
    expect(evidence.status).toBe("unknown");
    expect(evidence.publishCalls).toBe(1);
    expect(evidence.results?.[0]).toMatchObject({
      provider: "bluesky",
      status: "unknown",
      attempts: 1,
    });

    const deliveryId = plan.items[0]?.delivery.deliveryId ?? "";
    const record = await state.store.getDelivery(deliveryId);
    const operation = await state.store.getOperation(
      await state.store.operationIdFor(plan.planId),
    );

    expect(record?.status).toBe("unknown");
    expect(record?.attempts).toBe(1);
    expect(operation?.interrupted).toBe(true);
  });

  it("reports a killed writer's intent as unknown and never sends it again", async () => {
    const state = await fixture();
    const plan = await state.publishPlan();
    const control = controlDir();
    const child = spawn("silent", state.stateHome, plan.planId, control);

    await started(child, path.join(control, "silent.started"));
    child.child.kill("SIGKILL");
    await waitForExit(child);

    const deliveryId = plan.items[0]?.delivery.deliveryId ?? "";

    // The intent is durable and the writer is gone: the record is in flight.
    expect((await state.store.getDelivery(deliveryId))?.status).toBe("in_flight");

    const report = await recoverLocalState(state.stateHome, {
      confirmNoWriters: true,
      yes: true,
    });

    expect(report.orphanInFlight.length).toBeGreaterThan(0);
    expect((await state.store.getDelivery(deliveryId))?.status).toBe("unknown");
    expect((await state.store.getDelivery(deliveryId))?.attempts).toBe(1);

    // A later run must not repeat the write, and it must not be able to: the
    // queued success would be consumed if anything were dispatched.
    state.bluesky.queue(succeeded("at://fixture/duplicate"));

    const rerun = await executeLocalPlan(plan.planId, {
      store: state.instrumented,
      providers: state.providers,
      resolveCredentials: state.resolveCredentials,
      signal: new AbortController().signal,
      kind: "publish",
      now: state.clock.now,
    });

    expect(state.bluesky.calls.publish).toBe(0);
    expect(rerun.results[0]).toMatchObject({
      status: "unknown",
      reused: true,
      attempts: 1,
    });
    expect(rerun.status).toBe("unknown");
    expect(exitCodeForResult(rerun)).toBe(EXIT_CODE.AMBIGUOUS);
  });

  it("lets only one of two competing writers send the first request", async () => {
    const state = await fixture();
    const plan = await state.publishPlan();
    const control = controlDir();
    const holder = spawn("hold", state.stateHome, plan.planId, control);

    await started(holder, path.join(control, "hold.started"));

    const second = spawn("steady", state.stateHome, plan.planId, control);
    const secondCode = await waitForExit(second);
    const secondEvidence = readEvidence(path.join(control, "steady.json"));

    expect(secondCode).toBe(EXIT_CODE.USAGE);
    expect(secondEvidence.lockError).toBe("STATE_BUSY");
    expect(secondEvidence.publishCalls).toBe(0);

    writeFileSync(path.join(control, "release"), "go");

    const holderCode = await waitForExit(holder);
    const holderEvidence = readEvidence(path.join(control, "hold.json"));

    expect(holderCode).toBe(EXIT_CODE.SUCCESS);
    expect(holderEvidence.status).toBe("succeeded");
    expect(holderEvidence.publishCalls).toBe(1);

    const deliveryId = plan.items[0]?.delivery.deliveryId ?? "";
    const record = await state.store.getDelivery(deliveryId);

    expect(record?.status).toBe("succeeded");
    expect(record?.attempts).toBe(1);
  });
});
