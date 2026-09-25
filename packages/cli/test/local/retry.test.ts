import type { LocalProviderId, ProviderOutcome } from "@syndroo/core";
import { afterEach, describe, expect, it } from "vitest";

import { CliError } from "../../src/cli-error.js";
import { EXIT_CODE } from "../../src/exit-codes.js";
import { executeLocalPlan } from "../../src/local/execute.js";
import { loadLocalPlan } from "../../src/local/plan.js";
import type {
  LocalPlan,
  LocalStore,
  OperationRecord,
} from "../../src/local/ports/local-store.js";
import { planLocalRetry } from "../../src/local/retry.js";
import { exitCodeForResult } from "../../src/local/results.js";
import {
  BLUESKY_TARGET,
  NAMESPACE,
  notApplied,
  openExecution,
  permanentFailure,
  succeeded,
  unknownOutcome,
  type ExecutionFixture,
} from "./support/execute-fixture.js";
import { connectionRecord } from "./support/plan-fixture.js";

/**
 * Retry preview behaviour against the real file store.
 *
 * A retry plan is built from the parent operation's authoritative records, so
 * every case here checks the records and the resulting actions rather than only
 * the returned shape.
 */

const fixtures: ExecutionFixture[] = [];

async function fixture(): Promise<ExecutionFixture> {
  const state = await openExecution();
  fixtures.push(state);
  return state;
}

afterEach(() => {
  for (const state of fixtures.splice(0)) {
    state.cleanup();
  }
});

function retryOptions(
  state: ExecutionFixture,
  overrides: Partial<Parameters<typeof planLocalRetry>[2]> = {},
): Parameters<typeof planLocalRetry>[2] {
  return {
    store: state.store,
    providers: state.providers,
    namespace: NAMESPACE,
    now: state.clock.now,
    ...overrides,
  };
}

/** Admits a plan and records one outcome per target, in order. */
async function deliver(
  state: ExecutionFixture,
  plan: LocalPlan,
  outcomes: readonly ProviderOutcome[],
): Promise<OperationRecord> {
  const operation = await state.store.reserveOperation(plan);

  for (const [index, outcome] of outcomes.entries()) {
    const item = plan.items[index];

    if (item === undefined) {
      throw new Error("the fixture plan has no such item");
    }

    const attempt = await state.store.beginAttempt(
      operation.operationId,
      item.delivery.deliveryId,
      item.delivery.target,
    );

    await state.store.commitOutcome(
      operation.operationId,
      item.delivery.deliveryId,
      attempt,
      outcome,
    );
  }

  return operation;
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

describe("planLocalRetry", () => {
  it("freezes a signed retry plan from the authoritative failure", async () => {
    const state = await fixture();
    const plan = await state.publishPlan();
    const operation = await deliver(state, plan, [notApplied()]);
    const parent = plan.items[0];

    const retry = await planLocalRetry(
      operation.operationId,
      ["bluesky"],
      retryOptions(state),
    );

    expect(retry.kind).toBe("retry");
    expect(retry.parentOperationId).toBe(operation.operationId);
    expect(retry.namespace).toBe(NAMESPACE);
    expect(retry.installationId).toBe(plan.installationId);
    expect(Date.parse(retry.expiresAt) - Date.parse(retry.createdAt)).toBe(
      24 * 60 * 60 * 1_000,
    );
    expect(retry.items).toHaveLength(1);

    const item = retry.items[0];

    expect(item?.action).toBe("retry");
    expect(item?.previousBinding).toBeNull();
    expect(item?.delivery.deliveryId).toBe(parent?.delivery.deliveryId);
    expect(item?.delivery.payload).toEqual(parent?.delivery.payload);
    expect(item?.delivery.payloadHash).toBe(parent?.delivery.payloadHash);
    expect(item?.delivery.content).toBe(parent?.delivery.content);

    // The signature and MAC verify end to end through the store.
    const loaded = await loadLocalPlan(retry.planId, {
      store: state.store,
      kind: "retry",
      now: state.clock.now,
    });

    expect(loaded.digest).toBe(retry.digest);
    expect((await state.store.getPlan(retry.planId))?.planId).toBe(retry.planId);
  });

  it("skips a recorded success and retries a target that never started", async () => {
    const state = await fixture();
    const plan = await state.publishPlan({ platforms: ["bluesky", "threads"] });
    const operation = await state.store.reserveOperation(plan);
    const first = plan.items[0];
    const second = plan.items[1];

    if (first === undefined || second === undefined) {
      throw new Error("the fixture plan is incomplete");
    }

    const attempt = await state.store.beginAttempt(
      operation.operationId,
      first.delivery.deliveryId,
      first.delivery.target,
    );

    await state.store.commitOutcome(
      operation.operationId,
      first.delivery.deliveryId,
      attempt,
      succeeded("at://fixture/first"),
    );

    const retry = await planLocalRetry(
      operation.operationId,
      ["bluesky", "threads"],
      retryOptions(state),
    );

    expect(retry.items.map(item => item.action)).toEqual(["skip", "retry"]);
    expect(retry.items[0]?.delivery.deliveryId).toBe(first.delivery.deliveryId);
    expect(retry.items[1]?.delivery.deliveryId).toBe(
      second.delivery.deliveryId,
    );
  });

  it("refuses a selection that contains an unknown result, and allows the safe subset", async () => {
    const state = await fixture();
    const plan = await state.publishPlan({ platforms: ["bluesky", "threads"] });
    const operation = await deliver(state, plan, [unknownOutcome(), notApplied()]);

    const error = await rejectionOf(() =>
      planLocalRetry(
        operation.operationId,
        ["bluesky", "threads"],
        retryOptions(state),
      ),
    );

    expect(error.code).toBe("OUTCOME_UNKNOWN");
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(await state.store.listOperations(10)).toHaveLength(1);

    const safe = await planLocalRetry(
      operation.operationId,
      ["threads"],
      retryOptions(state),
    );

    expect(safe.items.map(item => item.action)).toEqual(["retry"]);
  });

  it("refuses a permanent failure and a window that has not opened", async () => {
    const state = await fixture();
    const permanentPlan = await state.publishPlan({
      key: "syndroo-retry-permanent-001",
    });
    const permanentOperation = await deliver(state, permanentPlan, [
      permanentFailure(),
    ]);

    const permanent = await rejectionOf(() =>
      planLocalRetry(
        permanentOperation.operationId,
        ["bluesky"],
        retryOptions(state),
      ),
    );

    expect(permanent.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(permanent.exitCode).toBe(EXIT_CODE.USAGE);

    const waitingPlan = await state.publishPlan({
      key: "syndroo-retry-window-001",
    });
    const waitingOperation = await deliver(state, waitingPlan, [
      notApplied({ retryNotBefore: "2026-09-24T01:00:00.000Z" }),
    ]);

    const waiting = await rejectionOf(() =>
      planLocalRetry(
        waitingOperation.operationId,
        ["bluesky"],
        retryOptions(state),
      ),
    );

    expect(waiting.code).toBe("RETRY_NOT_READY");
    expect(waiting.exitCode).toBe(EXIT_CODE.USAGE);

    // Once the window opens, the same selection is admitted.
    state.clock.set("2026-09-24T01:00:01.000Z");

    const opened = await planLocalRetry(
      waitingOperation.operationId,
      ["bluesky"],
      retryOptions(state),
    );

    expect(opened.items[0]?.action).toBe("retry");
  });

  it("shows a rotated revision of the same account as previousBinding", async () => {
    const state = await fixture();
    const plan = await state.publishPlan();
    const operation = await deliver(state, plan, [notApplied()]);

    await state.store.putConnection(
      connectionRecord({
        provider: "bluesky",
        connectionId: `conn_${"c".repeat(32)}`,
        bindingRevision: 2,
      }),
      1,
    );

    const retry = await planLocalRetry(
      operation.operationId,
      ["bluesky"],
      retryOptions(state),
    );
    const item = retry.items[0];

    expect(item?.previousBinding).toEqual({
      provider: "bluesky",
      targetId: BLUESKY_TARGET,
      connectionId: `conn_${"a".repeat(32)}`,
      bindingRevision: 1,
    });
    expect(item?.delivery.target).toEqual({
      provider: "bluesky",
      targetId: BLUESKY_TARGET,
      connectionId: `conn_${"c".repeat(32)}`,
      bindingRevision: 2,
    });
    expect(item?.delivery.payloadHash).toBe(
      plan.items[0]?.delivery.payloadHash,
    );
  });

  it("refuses to follow a replacement account", async () => {
    const state = await fixture();
    const plan = await state.publishPlan();
    const operation = await deliver(state, plan, [notApplied()]);

    await state.store.putConnection(
      connectionRecord({
        provider: "bluesky",
        targetId: "did:plc:someoneelse",
        connectionId: `conn_${"d".repeat(32)}`,
        bindingRevision: 2,
      }),
      1,
    );

    const error = await rejectionOf(() =>
      planLocalRetry(
        operation.operationId,
        ["bluesky"],
        retryOptions(state),
      ),
    );

    expect(error.code).toBe("BINDING_CHANGED");
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
  });

  it("resolves no credential and opens no session during a dry run", async () => {
    const state = await fixture();
    const plan = await state.publishPlan();
    const operation = await deliver(state, plan, [notApplied()]);

    await planLocalRetry(
      operation.operationId,
      ["bluesky"],
      retryOptions(state),
    );

    expect(state.resolved).toEqual([]);
    expect(state.bluesky.calls.prepare).toBe(0);
    expect(state.bluesky.calls.verifyIdentity).toBe(0);
    expect(state.bluesky.calls.publish).toBe(0);
    // Only the pure payload check runs.
    expect(state.bluesky.calls.freeze).toBeGreaterThan(0);
  });

  it("sends only the selected target when the retry plan is executed", async () => {
    const state = await fixture();
    const plan = await state.publishPlan({ platforms: ["bluesky", "threads"] });
    const operation = await deliver(state, plan, [
      notApplied(),
      succeeded("at://fixture/threads"),
    ]);
    const retry = await planLocalRetry(
      operation.operationId,
      ["bluesky", "threads"],
      retryOptions(state),
    );

    state.bluesky.queue(succeeded("at://fixture/bluesky-retry"));

    const result = await executeLocalPlan(retry.planId, {
      store: state.instrumented,
      providers: state.providers,
      resolveCredentials: state.resolveCredentials,
      signal: new AbortController().signal,
      kind: "retry",
      now: state.clock.now,
    });

    expect(state.bluesky.calls.publish).toBe(1);
    expect(state.threads.calls.publish).toBe(0);
    expect(result.status).toBe("succeeded");
    expect(exitCodeForResult(result)).toBe(EXIT_CODE.SUCCESS);
    expect(result.results[0]).toMatchObject({
      provider: "bluesky",
      status: "succeeded",
      attempts: 2,
      reused: false,
      remoteId: "at://fixture/bluesky-retry",
    });
    expect(result.results[1]).toMatchObject({
      provider: "threads",
      status: "succeeded",
      attempts: 1,
      reused: true,
    });
  });

  it("counts attempts across plans and stops at three", async () => {
    const state = await fixture();
    const plan = await state.publishPlan();
    const first = await deliver(state, plan, [notApplied()]);

    const retryOne = await planLocalRetry(
      first.operationId,
      ["bluesky"],
      retryOptions(state),
    );

    state.bluesky.queue(notApplied());

    const second = await executeLocalPlan(retryOne.planId, {
      store: state.instrumented,
      providers: state.providers,
      resolveCredentials: state.resolveCredentials,
      signal: new AbortController().signal,
      kind: "retry",
      now: state.clock.now,
    });

    expect(second.results[0]?.attempts).toBe(2);

    const retryTwo = await planLocalRetry(
      second.operationId,
      ["bluesky"],
      retryOptions(state),
    );

    state.bluesky.queue(notApplied());

    const third = await executeLocalPlan(retryTwo.planId, {
      store: state.instrumented,
      providers: state.providers,
      resolveCredentials: state.resolveCredentials,
      signal: new AbortController().signal,
      kind: "retry",
      now: state.clock.now,
    });

    expect(third.results[0]?.attempts).toBe(3);
    expect(third.results[0]?.retry).toEqual({
      eligible: false,
      reason: "ATTEMPTS_EXHAUSTED",
      notBefore: null,
    });

    const exhausted = await rejectionOf(() =>
      planLocalRetry(third.operationId, ["bluesky"], retryOptions(state)),
    );

    expect(exhausted.code).toBe("ATTEMPTS_EXHAUSTED");
    expect(exhausted.exitCode).toBe(EXIT_CODE.USAGE);
    // The first attempt was recorded by the store before this test's provider
    // ran, so only two content requests exist, and no fourth was made: a new
    // plan and a new operation never reset the count.
    expect(state.bluesky.calls.publish).toBe(2);
  });

  it("fails with exit 1 when the local clock is not usable", async () => {
    const state = await fixture();
    const plan = await state.publishPlan();
    const operation = await deliver(state, plan, [notApplied()]);

    const error = await rejectionOf(() =>
      planLocalRetry(
        operation.operationId,
        ["bluesky"],
        retryOptions(state, { now: () => new Date(Number.NaN) }),
      ),
    );

    expect(error.code).toBe("LOCAL_RUNTIME_UNSUPPORTED");
    expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
  });

  it("keeps the trusted attempt count when an indeterminate record cannot be read", async () => {
    const state = await fixture();
    const plan = await state.publishPlan();
    const first = await deliver(state, plan, [notApplied()]);
    const retry = await planLocalRetry(
      first.operationId,
      ["bluesky"],
      retryOptions(state),
    );
    const deliveryId = retry.items[0]?.delivery.deliveryId ?? "";
    let reads = 0;
    const store: LocalStore = {
      ...state.instrumented,
      getDelivery: async id => {
        if (id === deliveryId) {
          reads++;

          if (reads > 1) {
            // The ledger entry became unreadable after the intent write.
            throw new CliError("STATE_CORRUPT: the record is unreadable", {
              code: "STATE_CORRUPT",
              exitCode: EXIT_CODE.FAILURE,
            });
          }
        }

        return state.instrumented.getDelivery(id);
      },
      beginAttempt: async (operationId, id, target) => {
        await state.instrumented.beginAttempt(operationId, id, target);
        throw new Error("the rename answer was lost");
      },
    };

    // The queued success would be consumed if anything were dispatched.
    state.bluesky.queue(succeeded("at://fixture/should-not-send"));

    const result = await executeLocalPlan(retry.planId, {
      store,
      providers: state.providers,
      resolveCredentials: state.resolveCredentials,
      signal: new AbortController().signal,
      kind: "retry",
      now: state.clock.now,
    });

    expect(state.bluesky.calls.publish).toBe(0);
    expect(result.durability).toBe("failed");
    expect(result.results[0]).toMatchObject({
      provider: "bluesky",
      status: "unknown",
      // The last trusted count is the baseline the intent was built from.
      attempts: 1,
      reused: false,
      writeDisposition: "unknown",
    });
    expect(result.results[0]?.retry).toEqual({
      eligible: false,
      reason: "OUTCOME_UNKNOWN",
      notBefore: null,
    });
  });

  it("refuses an unusable selection or an unknown operation", async () => {
    const state = await fixture();
    const plan = await state.publishPlan();
    const operation = await deliver(state, plan, [notApplied()]);
    const unknownProvider = "mastodon" as LocalProviderId;

    const cases: readonly (() => Promise<unknown>)[] = [
      () => planLocalRetry(operation.operationId, [], retryOptions(state)),
      () =>
        planLocalRetry(
          operation.operationId,
          ["bluesky", "bluesky"],
          retryOptions(state),
        ),
      () =>
        planLocalRetry(
          operation.operationId,
          [unknownProvider],
          retryOptions(state),
        ),
      () =>
        planLocalRetry(operation.operationId, ["threads"], retryOptions(state)),
      () =>
        planLocalRetry(
          `op_${"0".repeat(64)}`,
          ["bluesky"],
          retryOptions(state),
        ),
    ];

    for (const run of cases) {
      const error = await rejectionOf(run);

      expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    }

    const wrongNamespace = await rejectionOf(() =>
      planLocalRetry(
        operation.operationId,
        ["bluesky"],
        retryOptions(state, { namespace: "other" }),
      ),
    );

    expect(wrongNamespace.code).toBe("CONFIG");
    expect(wrongNamespace.exitCode).toBe(EXIT_CODE.USAGE);
  });
});
