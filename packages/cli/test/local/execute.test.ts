import { rmSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CliError } from "../../src/cli-error.js";
import { EXIT_CODE } from "../../src/exit-codes.js";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  executeLocalPlan,
  type ExecuteLocalPlanOptions,
} from "../../src/local/execute.js";
import type {
  LocalPlan,
  LocalStore,
} from "../../src/local/ports/local-store.js";
import { exitCodeForResult } from "../../src/local/results.js";
import {
  notApplied,
  openExecution,
  scriptedProvider,
  succeeded,
  successWhenAborted,
  unknownOutcome,
  unknownWhenAborted,
  waitFor,
  type ExecutionFixture,
} from "./support/execute-fixture.js";
import { DAY_MS, connectionRecord } from "./support/plan-fixture.js";

/**
 * Execution behaviour against the real file store.
 *
 * Every case asserts what reached the store on disk and which exit code the
 * result maps to, not only the returned labels.
 */

const fixtures: ExecutionFixture[] = [];

async function fixture(
  options: Parameters<typeof openExecution>[0] = {},
): Promise<ExecutionFixture> {
  const state = await openExecution(options);
  fixtures.push(state);
  return state;
}

afterEach(() => {
  for (const state of fixtures.splice(0)) {
    state.cleanup();
  }
});

function optionsOf(
  state: ExecutionFixture,
  overrides: Partial<ExecuteLocalPlanOptions> = {},
): ExecuteLocalPlanOptions {
  return {
    store: state.instrumented,
    providers: state.providers,
    resolveCredentials: state.resolveCredentials,
    signal: new AbortController().signal,
    kind: "publish",
    now: state.clock.now,
    ...overrides,
  };
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

function deliveryIdOf(plan: LocalPlan, index: number): string {
  const item = plan.items[index];

  if (item === undefined) {
    throw new Error("the fixture plan has no such item");
  }

  return item.delivery.deliveryId;
}

describe("executeLocalPlan", () => {
  it("exposes the documented command budget", () => {
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBe(120_000);
    expect(MAX_COMMAND_TIMEOUT_MS).toBe(600_000);
  });

  it("admits the operation and persists the intent before the first content request", async () => {
    const state = await fixture();
    state.bluesky.queue(succeeded());
    state.threads.queue(succeeded());
    const plan = await state.publishPlan({ platforms: ["bluesky", "threads"] });

    await executeLocalPlan(plan.planId, optionsOf(state));

    const admission = state.events.indexOf("admission:ready");
    const firstIntent = state.events.indexOf(`intent:${deliveryIdOf(plan, 0)}`);
    const firstContent = state.events.indexOf("content:bluesky");
    const secondIntent = state.events.indexOf(`intent:${deliveryIdOf(plan, 1)}`);
    const secondContent = state.events.indexOf("content:threads");

    expect(admission).toBeGreaterThanOrEqual(0);
    expect(admission).toBeLessThan(firstIntent);
    expect(firstIntent).toBeLessThan(firstContent);
    // Targets are serial: the second intent lands after the first answer.
    expect(firstContent).toBeLessThan(secondIntent);
    expect(secondIntent).toBeLessThan(secondContent);
  });

  it("sends each target once, commits both records, and exits 0", async () => {
    const state = await fixture();
    state.bluesky.queue(succeeded("at://fixture/bluesky"));
    state.threads.queue(succeeded("at://fixture/threads"));
    const plan = await state.publishPlan({ platforms: ["bluesky", "threads"] });

    const result = await executeLocalPlan(plan.planId, optionsOf(state));

    expect(state.bluesky.calls.publish).toBe(1);
    expect(state.threads.calls.publish).toBe(1);
    expect(result.status).toBe("succeeded");
    expect(result.durability).toBe("committed");
    expect(exitCodeForResult(result)).toBe(EXIT_CODE.SUCCESS);
    expect(result.results.map(entry => entry.reused)).toEqual([false, false]);
    expect(result.results[0]?.remoteId).toBe("at://fixture/bluesky");
    expect(result.results[0]?.retry).toEqual({
      eligible: false,
      reason: "ALREADY_SUCCEEDED",
      notBefore: null,
    });

    const first = await state.store.getDelivery(deliveryIdOf(plan, 0));
    const second = await state.store.getDelivery(deliveryIdOf(plan, 1));

    expect(first?.status).toBe("succeeded");
    expect(first?.attempts).toBe(1);
    expect(first?.outcome).toEqual({
      kind: "succeeded",
      remoteId: "at://fixture/bluesky",
      url: null,
    });
    expect(second?.status).toBe("succeeded");
    expect(second?.attempts).toBe(1);
  });

  it("continues to the next target after a confirmed not-applied failure", async () => {
    const state = await fixture();
    state.bluesky.queue(notApplied());
    state.threads.queue(succeeded("at://fixture/threads"));
    const plan = await state.publishPlan({ platforms: ["bluesky", "threads"] });

    const result = await executeLocalPlan(plan.planId, optionsOf(state));

    expect(state.bluesky.calls.publish).toBe(1);
    expect(state.threads.calls.publish).toBe(1);
    expect(result.status).toBe("partial");
    expect(exitCodeForResult(result)).toBe(EXIT_CODE.NOT_DELIVERED);
    expect(result.results[0]).toMatchObject({
      provider: "bluesky",
      status: "failed",
      attempts: 1,
      remoteId: null,
      writeDisposition: "not_applied",
    });
    expect(result.results[0]?.retry).toEqual({
      eligible: true,
      reason: "CONFIRMED_NOT_SENT",
      notBefore: null,
    });
    expect(result.results[1]).toMatchObject({
      provider: "threads",
      status: "succeeded",
    });

    const failed = await state.store.getDelivery(deliveryIdOf(plan, 0));

    expect(failed?.status).toBe("failed");
    expect(failed?.attempts).toBe(1);
  });

  it("reports an unknown result as unknown without a blind resend", async () => {
    const state = await fixture();
    state.bluesky.queue(unknownOutcome());
    state.threads.queue(succeeded());
    const plan = await state.publishPlan({ platforms: ["bluesky", "threads"] });

    const result = await executeLocalPlan(plan.planId, optionsOf(state));

    expect(state.bluesky.calls.publish).toBe(1);
    expect(state.threads.calls.publish).toBe(1);
    expect(result.status).toBe("unknown");
    expect(exitCodeForResult(result)).toBe(EXIT_CODE.AMBIGUOUS);
    expect(result.results[0]).toMatchObject({
      status: "unknown",
      attempts: 1,
      writeDisposition: "unknown",
    });
    expect(result.results[0]?.retry).toEqual({
      eligible: false,
      reason: "OUTCOME_UNKNOWN",
      notBefore: null,
    });
    expect((await state.store.getDelivery(deliveryIdOf(plan, 0)))?.status).toBe(
      "unknown",
    );
  });

  it("keeps a trusted success in memory when its commit fails, and never resends", async () => {
    let fired = false;
    const state = await fixture({
      fault: point => {
        if (point === "before-outcome-commit" && !fired) {
          fired = true;
          throw new Error("the disk is full");
        }
      },
    });
    state.bluesky.queue(succeeded("at://fixture/kept"));
    state.threads.queue(succeeded());
    const plan = await state.publishPlan({ platforms: ["bluesky", "threads"] });

    const result = await executeLocalPlan(plan.planId, optionsOf(state));

    expect(state.bluesky.calls.publish).toBe(1);
    expect(state.threads.calls.publish).toBe(0);
    expect(result.durability).toBe("failed");
    expect(exitCodeForResult(result)).toBe(EXIT_CODE.FAILURE);
    expect(result.results[0]).toMatchObject({
      provider: "bluesky",
      status: "succeeded",
      remoteId: "at://fixture/kept",
      writeDisposition: "applied",
    });
    expect(result.results[1]).toMatchObject({
      provider: "threads",
      status: "not_started",
      attempts: 0,
    });

    // The durable record is still `in_flight`: the trusted success was never
    // written, so a later read can only report unknown.
    const record = await state.store.getDelivery(deliveryIdOf(plan, 0));

    expect(record?.status).toBe("in_flight");
    expect(record?.attempts).toBe(1);

    state.events.length = 0;
    const replay = await executeLocalPlan(plan.planId, optionsOf(state));

    expect(state.bluesky.calls.publish).toBe(1);
    expect(state.threads.calls.publish).toBe(0);
    expect(replay.results[0]).toMatchObject({
      status: "unknown",
      reused: true,
      writeDisposition: "unknown",
    });
    expect(replay.status).toBe("unknown");
    expect(exitCodeForResult(replay)).toBe(EXIT_CODE.AMBIGUOUS);
    expect(state.events).not.toContain("content:bluesky");
  });

  it("sends nothing when the frozen payload no longer matches the provider", async () => {
    const state = await fixture();
    const plan = await state.publishPlan();
    const bumped = scriptedProvider("bluesky", [], { payloadVersion: 2 });

    const error = await rejectionOf(() =>
      executeLocalPlan(plan.planId, optionsOf(state, {
        providers: { bluesky: bumped.provider, threads: state.threads.provider },
      })),
    );

    expect(error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(bumped.calls.prepare).toBe(0);
    expect(state.bluesky.calls.publish).toBe(0);
    expect(await state.store.listOperations(10)).toHaveLength(0);
  });

  it("prepares every target before admission, so a refusal sends nothing", async () => {
    const state = await fixture();
    const plan = await state.publishPlan({ platforms: ["bluesky", "threads"] });
    const refusing = scriptedProvider("threads", [], {
      prepareError: "PROVIDER_UNAVAILABLE",
    });

    const error = await rejectionOf(() =>
      executeLocalPlan(plan.planId, optionsOf(state, {
        providers: {
          bluesky: state.bluesky.provider,
          threads: refusing.provider,
        },
      })),
    );

    expect(error.code).toBe("PROVIDER_LOCAL_UNAVAILABLE");
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(state.bluesky.calls.prepare).toBe(1);
    expect(refusing.calls.prepare).toBe(1);
    expect(state.bluesky.calls.publish).toBe(0);
    expect(refusing.calls.publish).toBe(0);
    expect(await state.store.listOperations(10)).toHaveLength(0);
  });

  it("refuses an old plan whose account binding was replaced", async () => {
    const state = await fixture();
    const plan = await state.publishPlan();

    await state.store.putConnection(
      connectionRecord({
        provider: "bluesky",
        connectionId: `conn_${"c".repeat(32)}`,
        bindingRevision: 2,
      }),
      1,
    );

    const error = await rejectionOf(() =>
      executeLocalPlan(plan.planId, optionsOf(state)),
    );

    expect(error.code).toBe("BINDING_CHANGED");
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(state.bluesky.calls.prepare).toBe(0);
    expect(state.bluesky.calls.publish).toBe(0);
    expect(await state.store.listOperations(10)).toHaveLength(0);
  });

  it("stops starting new targets when the command budget ends", async () => {
    const state = await fixture();
    state.bluesky.queue(successWhenAborted());
    state.threads.queue(succeeded());
    const plan = await state.publishPlan({ platforms: ["bluesky", "threads"] });

    const result = await executeLocalPlan(
      plan.planId,
      optionsOf(state, { timeoutMs: 250 }),
    );

    expect(state.bluesky.calls.publish).toBe(1);
    expect(state.threads.calls.publish).toBe(0);
    expect(state.threads.calls.prepare).toBe(1);
    expect(result.interrupted).toBeUndefined();
    expect(result.status).toBe("partial");
    expect(exitCodeForResult(result)).toBe(EXIT_CODE.NOT_DELIVERED);
    expect(result.results[0]).toMatchObject({
      provider: "bluesky",
      status: "succeeded",
    });
    expect(result.results[1]).toMatchObject({
      provider: "threads",
      status: "not_started",
      attempts: 0,
      writeDisposition: "not_applied",
    });
    expect(result.results[1]?.retry).toEqual({
      eligible: true,
      reason: "NOT_STARTED",
      notBefore: null,
    });
  });

  it("records a signal, keeps every real status, and exits 130", async () => {
    const state = await fixture();
    state.bluesky.queue(unknownWhenAborted());
    state.threads.queue(succeeded());
    const plan = await state.publishPlan({ platforms: ["bluesky", "threads"] });
    const controller = new AbortController();

    const pending = executeLocalPlan(
      plan.planId,
      optionsOf(state, { signal: controller.signal }),
    );

    await waitFor(() => state.bluesky.calls.publish === 1, "the first request");
    controller.abort(new Error("SIGINT"));

    const result = await pending;

    expect(result.interrupted).toBe(true);
    expect(exitCodeForResult(result)).toBe(EXIT_CODE.INTERRUPTED);
    expect(state.bluesky.calls.publish).toBe(1);
    expect(state.threads.calls.publish).toBe(0);
    expect(result.results[0]).toMatchObject({ status: "unknown", attempts: 1 });
    expect(result.results[1]).toMatchObject({
      status: "not_started",
      attempts: 0,
    });
    expect(state.events).toContain("interrupted");

    const operation = await state.store.getOperation(result.operationId);

    expect(operation?.interrupted).toBe(true);
  });

  it("replays an admitted operation without touching a credential or a provider", async () => {
    const state = await fixture();
    state.bluesky.queue(succeeded("at://fixture/once"));
    const plan = await state.publishPlan();

    const first = await executeLocalPlan(plan.planId, optionsOf(state));

    // The plan stays usable after it expires because the operation is admitted.
    state.clock.advance(DAY_MS * 2);
    state.events.length = 0;

    const second = await executeLocalPlan(plan.planId, optionsOf(state));

    expect(second.operationId).toBe(first.operationId);
    expect(second.results[0]).toMatchObject({
      status: "succeeded",
      reused: true,
      attempts: 1,
      remoteId: "at://fixture/once",
    });
    expect(second.status).toBe("succeeded");
    expect(exitCodeForResult(second)).toBe(EXIT_CODE.SUCCESS);
    expect(state.bluesky.calls.publish).toBe(1);
    expect(state.resolved).toHaveLength(1);
    expect(state.events).toEqual([]);
  });

  it("refuses an expired plan that was never admitted", async () => {
    const state = await fixture();
    const plan = await state.publishPlan();

    state.clock.advance(DAY_MS + 1_000);

    const error = await rejectionOf(() =>
      executeLocalPlan(plan.planId, optionsOf(state)),
    );

    expect(error.code).toBe("PLAN_EXPIRED");
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(state.bluesky.calls.prepare).toBe(0);
    expect(state.bluesky.calls.publish).toBe(0);
  });

  it("refuses a plan of the other kind and an unknown plan id", async () => {
    const state = await fixture();
    const plan = await state.publishPlan();

    const wrongKind = await rejectionOf(() =>
      executeLocalPlan(plan.planId, optionsOf(state, { kind: "retry" })),
    );

    expect(wrongKind.code).toBe("PLAN_KIND_MISMATCH");
    expect(wrongKind.exitCode).toBe(EXIT_CODE.USAGE);

    const missing = await rejectionOf(() =>
      executeLocalPlan(`plan_${"0".repeat(32)}`, optionsOf(state)),
    );

    expect(missing.code).toBe("USAGE");
    expect(missing.exitCode).toBe(EXIT_CODE.USAGE);
  });

  it("refuses a command budget outside the documented range", async () => {
    const state = await fixture();
    const plan = await state.publishPlan();

    for (const timeoutMs of [0, -1, 1.5, MAX_COMMAND_TIMEOUT_MS + 1]) {
      const error = await rejectionOf(() =>
        executeLocalPlan(plan.planId, optionsOf(state, { timeoutMs })),
      );

      expect(error.code).toBe("CONFIG");
      expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    }

    expect(state.bluesky.calls.publish).toBe(0);
  });

  it("reads every authoritative record before the first content request", async () => {
    const state = await fixture();
    state.bluesky.queue(succeeded());
    state.threads.queue(succeeded());
    const plan = await state.publishPlan({ platforms: ["bluesky", "threads"] });
    const lost = deliveryIdOf(plan, 1);
    const store: LocalStore = {
      ...state.instrumented,
      reserveOperation: async candidate => {
        const operation = await state.instrumented.reserveOperation(candidate);
        // The second target's ledger entry disappears between admission and
        // the first content request.
        rmSync(path.join(state.stateHome, "deliveries", `${lost}.json`));
        return operation;
      },
    };

    const error = await rejectionOf(() =>
      executeLocalPlan(plan.planId, optionsOf(state, { store })),
    );

    expect(error.code).toBe("STATE_CORRUPT");
    expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
    expect(state.bluesky.calls.publish).toBe(0);
    expect(state.threads.calls.publish).toBe(0);
    expect(await state.store.listOperations(10)).toHaveLength(1);
  });

  it("never reports an indeterminate intent as retryable", async () => {
    const state = await fixture();
    state.bluesky.queue(succeeded());
    const plan = await state.publishPlan();
    const deliveryId = deliveryIdOf(plan, 0);
    const store: LocalStore = {
      ...state.instrumented,
      beginAttempt: async (operationId, id, target) => {
        // The intent may have landed; only the answer was lost.
        await state.instrumented.beginAttempt(operationId, id, target);
        throw new Error("the rename answer was lost");
      },
    };

    const result = await executeLocalPlan(plan.planId, optionsOf(state, { store }));

    expect(state.bluesky.calls.publish).toBe(0);
    expect(result.durability).toBe("failed");
    // An unknown write outranks a durability failure (exit 4 before exit 1).
    expect(exitCodeForResult(result)).toBe(EXIT_CODE.AMBIGUOUS);
    expect(result.results[0]).toMatchObject({
      status: "unknown",
      writeDisposition: "unknown",
    });
    expect(result.results[0]?.retry).toEqual({
      eligible: false,
      reason: "OUTCOME_UNKNOWN",
      notBefore: null,
    });
    expect((await state.store.getDelivery(deliveryId))?.status).toBe("in_flight");

    const replay = await executeLocalPlan(plan.planId, optionsOf(state));

    expect(replay.results[0]?.status).toBe("unknown");
    expect(state.bluesky.calls.publish).toBe(0);
  });

  it("refuses before admission when the caller stops during preparation", async () => {
    const state = await fixture();
    state.bluesky.queue(succeeded());
    state.threads.queue(succeeded());
    const plan = await state.publishPlan({ platforms: ["bluesky", "threads"] });
    const controller = new AbortController();

    const error = await rejectionOf(() =>
      executeLocalPlan(plan.planId, optionsOf(state, {
        signal: controller.signal,
        resolveCredentials: async connection => {
          const credentials = await state.resolveCredentials(connection);

          if (connection.target.provider === "threads") {
            controller.abort(new Error("SIGINT"));
          }

          return credentials;
        },
      })),
    );

    expect(error.code).toBe("INTERRUPTED");
    expect(error.exitCode).toBe(EXIT_CODE.INTERRUPTED);
    expect(state.bluesky.calls.publish).toBe(0);
    expect(state.threads.calls.publish).toBe(0);
    expect(await state.store.listOperations(10)).toHaveLength(0);
  });

  it("refuses before admission when the budget ends during preparation", async () => {
    const state = await fixture();
    const hanging = scriptedProvider("bluesky", [], { prepareHangs: true });
    const plan = await state.publishPlan();

    const error = await rejectionOf(() =>
      executeLocalPlan(plan.planId, optionsOf(state, {
        providers: {
          bluesky: hanging.provider,
          threads: state.threads.provider,
        },
        timeoutMs: 60,
      })),
    );

    expect(error.code).toBe("COMMAND_TIMEOUT");
    expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
    expect(hanging.calls.publish).toBe(0);
    expect(await state.store.listOperations(10)).toHaveLength(0);
  });

  it("refuses before admission when the caller signal is already over", async () => {
    const state = await fixture();
    state.bluesky.queue(succeeded());
    const plan = await state.publishPlan();
    const controller = new AbortController();

    controller.abort(new Error("SIGTERM"));

    const error = await rejectionOf(() =>
      executeLocalPlan(
        plan.planId,
        optionsOf(state, { signal: controller.signal }),
      ),
    );

    expect(error.code).toBe("INTERRUPTED");
    expect(error.exitCode).toBe(EXIT_CODE.INTERRUPTED);
    expect(state.bluesky.calls.prepare).toBe(0);
    expect(state.bluesky.calls.publish).toBe(0);
    expect(await state.store.listOperations(10)).toHaveLength(0);
  });

  it("refuses before admission when a provider answers after the signal", async () => {
    const state = await fixture();
    const plan = await state.publishPlan();
    const controller = new AbortController();
    const ignoring = scriptedProvider("bluesky", [], {
      prepareIgnoresSignal: true,
    });

    const error = await rejectionOf(() =>
      executeLocalPlan(plan.planId, optionsOf(state, {
        providers: {
          bluesky: ignoring.provider,
          threads: state.threads.provider,
        },
        signal: controller.signal,
        resolveCredentials: async connection => {
          const credentials = await state.resolveCredentials(connection);

          controller.abort(new Error("SIGINT"));

          return credentials;
        },
      })),
    );

    expect(error.code).toBe("INTERRUPTED");
    expect(error.exitCode).toBe(EXIT_CODE.INTERRUPTED);
    expect(ignoring.calls.prepare).toBe(1);
    expect(ignoring.calls.publish).toBe(0);
    expect(await state.store.listOperations(10)).toHaveLength(0);
  });

  it("reports an admitted run as blocked when the budget ends after preparation", async () => {
    const state = await fixture();
    state.bluesky.queue(succeeded());
    const plan = await state.publishPlan();
    const store: LocalStore = {
      ...state.instrumented,
      reserveOperation: async candidate => {
        const operation = await state.instrumented.reserveOperation(candidate);
        // Preparation succeeded; the budget ends while the manifest is being
        // made durable.
        await new Promise(resolve => setTimeout(resolve, 300));
        return operation;
      },
    };

    const result = await executeLocalPlan(
      plan.planId,
      optionsOf(state, { store, timeoutMs: 150 }),
    );

    expect(state.bluesky.calls.publish).toBe(0);
    expect(result.status).toBe("blocked");
    expect(result.durability).toBe("committed");
    expect(exitCodeForResult(result)).toBe(EXIT_CODE.NOT_DELIVERED);
    expect(result.results[0]).toMatchObject({
      status: "not_started",
      attempts: 0,
      writeDisposition: "not_applied",
    });
    expect(await state.store.listOperations(10)).toHaveLength(1);

    // The admitted operation is replayed, not resent.
    const replay = await executeLocalPlan(plan.planId, optionsOf(state));

    expect(replay.status).toBe("blocked");
    expect(state.bluesky.calls.publish).toBe(0);
  });
});
