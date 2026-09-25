import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CliError } from "../../src/cli-error.js";
import { EXIT_CODE } from "../../src/exit-codes.js";
import {
  frozenBusinessTime,
  loadLocalPlan,
  planLocalPublish,
  previewForPlan,
  signLocalPlan,
  type LocalPlanBody,
} from "../../src/local/plan.js";
import type {
  LocalPlan,
  LocalStore,
  PlanItem,
} from "../../src/local/ports/local-store.js";
import {
  DAY_MS,
  START_TIME,
  deliverOutcome,
  documentOf,
  failedOutcome,
  openState,
  planFilePath,
  providerSet,
  seedConnection,
  stateSnapshot,
  staticProvider,
  succeededOutcome,
  testClock,
  unknownOutcome,
  type StateFixture,
} from "./support/plan-fixture.js";

const CONNECTION_ID = `conn_${"a".repeat(32)}`;

const fixtures: StateFixture[] = [];

async function fixture(): Promise<StateFixture> {
  const state = await openState(testClock());
  fixtures.push(state);
  return state;
}

afterEach(() => {
  for (const state of fixtures.splice(0)) {
    state.cleanup();
  }

  vi.unstubAllGlobals();
});

async function rejectionOf(run: () => Promise<unknown>): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }

  throw new Error("expected a CliError");
}

function onlyItem(plan: LocalPlan): PlanItem {
  const item = plan.items[0];

  if (item === undefined) {
    throw new Error("expected exactly one plan item");
  }

  return item;
}

describe("planLocalPublish", () => {
  it("freezes a new delivery with no network and no credential read", async () => {
    const state = await fixture();
    const set = providerSet();
    const fetched: string[] = [];

    vi.stubGlobal("fetch", (input: unknown) => {
      fetched.push(String(input));
      throw new Error("a preview must not use the network");
    });

    await seedConnection(state.store, { provider: "bluesky" });

    const before = stateSnapshot(state.stateHome);
    const document = documentOf();
    const plan = await planLocalPublish(document, {
      store: state.store,
      providers: set.providers,
      namespace: "default",
      now: state.clock.now,
    });

    expect(plan.kind).toBe("publish");
    expect(plan.planId).toMatch(/^plan_[0-9a-f]{32}$/);
    expect(plan.namespace).toBe("default");
    expect(plan.createdAt).toBe(START_TIME);
    expect(plan.expiresAt).toBe(
      new Date(Date.parse(START_TIME) + DAY_MS).toISOString(),
    );
    expect(plan.parentOperationId).toBeNull();
    expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.mac).toMatch(/^[0-9a-f]{64}$/);

    const item = onlyItem(plan);

    expect(item.action).toBe("publish");
    expect(item.previousBinding).toBeNull();
    expect(item.delivery.deliveryId).toMatch(/^[0-9a-f]{64}$/);
    expect(item.delivery.key).toBe(document.key);
    expect(item.delivery.content).toBe(document.content);
    expect(item.delivery.payloadVersion).toBe(1);
    expect(item.delivery.payload["text"]).toBe(document.content);
    expect(item.delivery.target.targetId).toBe("did:plc:fixturealice");
    expect(item.delivery.target.bindingRevision).toBe(1);
    expect(frozenBusinessTime(item.delivery)).toBe(START_TIME);

    expect(set.calls.bluesky.freeze).toBe(1);
    expect(set.calls.bluesky.prepare).toBe(0);
    expect(set.calls.bluesky.verifyIdentity).toBe(0);
    expect(set.calls.threads.freeze).toBe(0);
    expect(fetched).toEqual([]);

    const added = stateSnapshot(state.stateHome).filter(
      line => !before.includes(line),
    );

    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(
      new RegExp(`^plans/${plan.planId}\\.json:`),
    );
    expect(await state.store.getDelivery(item.delivery.deliveryId)).toBeNull();

    const loaded = await loadLocalPlan(plan.planId, {
      store: state.store,
      kind: "publish",
      now: state.clock.now,
    });

    expect(loaded).toEqual(plan);
    expect(previewForPlan(loaded)).toEqual({
      planId: plan.planId,
      expiresAt: plan.expiresAt,
      digest: plan.digest,
      items: [
        {
          key: document.key,
          provider: "bluesky",
          targetId: "did:plc:fixturealice",
          action: "publish",
          content: document.content,
          binding: { connectionId: CONNECTION_ID, bindingRevision: 1 },
          previousBinding: null,
        },
      ],
    });
  });

  it("refuses an unusable namespace without writing state", async () => {
    const state = await fixture();
    const set = providerSet();

    await seedConnection(state.store, { provider: "bluesky" });

    const before = stateSnapshot(state.stateHome);
    const error = await rejectionOf(() =>
      planLocalPublish(documentOf(), {
        store: state.store,
        providers: set.providers,
        namespace: "bad namespace",
        now: state.clock.now,
      }),
    );

    expect(error.code).toBe("CONFIG");
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(set.calls.bluesky.freeze).toBe(0);
    expect(stateSnapshot(state.stateHome)).toEqual(before);
  });

  it("refuses a provider without an active binding", async () => {
    const state = await fixture();
    const set = providerSet();
    const before = stateSnapshot(state.stateHome);

    const error = await rejectionOf(() =>
      planLocalPublish(documentOf(), {
        store: state.store,
        providers: set.providers,
        namespace: "default",
        now: state.clock.now,
      }),
    );

    expect(error.code).toBe("AUTH_SOURCE_UNAVAILABLE");
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(set.calls.bluesky.freeze).toBe(0);
    expect(stateSnapshot(state.stateHome)).toEqual(before);
  });

  it("refuses a tombstoned binding", async () => {
    const state = await fixture();
    const set = providerSet();

    await seedConnection(state.store, { provider: "bluesky" });
    await seedConnection(state.store, {
      provider: "bluesky",
      removed: true,
      bindingRevision: 2,
      expectedRevision: 1,
    });

    const error = await rejectionOf(() =>
      planLocalPublish(documentOf(), {
        store: state.store,
        providers: set.providers,
        namespace: "default",
        now: state.clock.now,
      }),
    );

    expect(error.code).toBe("AUTH_SOURCE_UNAVAILABLE");
  });

  it("uses the selected override and never touches an unselected provider", async () => {
    const state = await fixture();
    const set = providerSet();

    await seedConnection(state.store, { provider: "bluesky" });
    await seedConnection(state.store, { provider: "threads" });

    const plan = await planLocalPublish(
      documentOf({
        platforms: ["threads"],
        overrides: { threads: { content: "threads only text" } },
      }),
      {
        store: state.store,
        providers: set.providers,
        namespace: "default",
        now: state.clock.now,
      },
    );

    const item = onlyItem(plan);

    expect(plan.items).toHaveLength(1);
    expect(item.delivery.content).toBe("threads only text");
    expect(item.delivery.payload["text"]).toBe("threads only text");
    expect(set.calls.bluesky.freeze).toBe(0);
    expect(set.calls.bluesky.prepare).toBe(0);
  });

  it("fails closed when the clock is unusable", async () => {
    const state = await fixture();
    const set = providerSet();

    await seedConnection(state.store, { provider: "bluesky" });

    const error = await rejectionOf(() =>
      planLocalPublish(documentOf(), {
        store: state.store,
        providers: set.providers,
        namespace: "default",
        now: () => new Date(Number.NaN),
      }),
    );

    expect(error.code).toBe("LOCAL_RUNTIME_UNSUPPORTED");
    expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
  });

  it("signs the same plan body to the same digest and MAC", async () => {
    const state = await fixture();
    const installation = await state.store.getInstallation();
    const body: LocalPlanBody = {
      schemaVersion: 1,
      installationId: installation.installationId,
      planId: `plan_${"d".repeat(32)}`,
      kind: "publish",
      namespace: "default",
      createdAt: START_TIME,
      expiresAt: new Date(Date.parse(START_TIME) + DAY_MS).toISOString(),
      items: [],
      parentOperationId: null,
    };

    const first = await signLocalPlan(body, state.store);
    const second = await signLocalPlan(body, state.store);

    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.mac).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("loadLocalPlan", () => {
  it("keeps the 24 hour lifetime and expires inclusively", async () => {
    const state = await fixture();
    const set = providerSet();

    await seedConnection(state.store, { provider: "bluesky" });

    const plan = await planLocalPublish(documentOf(), {
      store: state.store,
      providers: set.providers,
      namespace: "default",
      now: state.clock.now,
    });

    expect(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt)).toBe(DAY_MS);

    state.clock.set(new Date(Date.parse(plan.expiresAt) - 1).toISOString());
    await expect(
      loadLocalPlan(plan.planId, {
        store: state.store,
        kind: "publish",
        now: state.clock.now,
      }),
    ).resolves.toEqual(plan);

    state.clock.set(plan.expiresAt);
    const error = await rejectionOf(() =>
      loadLocalPlan(plan.planId, {
        store: state.store,
        kind: "publish",
        now: state.clock.now,
      }),
    );

    expect(error.code).toBe("PLAN_EXPIRED");
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
  });

  it("returns an admitted plan after expiry instead of publishing again", async () => {
    const state = await fixture();
    const set = providerSet();

    await seedConnection(state.store, { provider: "bluesky" });

    const plan = await planLocalPublish(documentOf(), {
      store: state.store,
      providers: set.providers,
      namespace: "default",
      now: state.clock.now,
    });

    const operation = await state.store.reserveOperation(plan);

    expect(operation.admissionState).toBe("ready");

    state.clock.advance(DAY_MS * 2);

    await expect(
      loadLocalPlan(plan.planId, {
        store: state.store,
        kind: "publish",
        now: state.clock.now,
      }),
    ).resolves.toEqual(plan);
  });

  it("keeps the frozen plan immune to later document edits", async () => {
    const state = await fixture();
    const set = providerSet();

    await seedConnection(state.store, { provider: "bluesky" });

    const options = {
      store: state.store,
      providers: set.providers,
      namespace: "default",
      now: state.clock.now,
    };
    const plan = await planLocalPublish(
      documentOf({ content: "original text" }),
      options,
    );

    await planLocalPublish(documentOf({ content: "edited text" }), options);

    const loaded = await loadLocalPlan(plan.planId, {
      store: state.store,
      kind: "publish",
      now: state.clock.now,
    });

    expect(onlyItem(loaded).delivery.content).toBe("original text");
    expect(onlyItem(loaded).delivery.deliveryId).toBe(
      onlyItem(plan).delivery.deliveryId,
    );
  });

  it("rejects a tampered plan file", async () => {
    const state = await fixture();
    const set = providerSet();

    await seedConnection(state.store, { provider: "bluesky" });

    const document = documentOf();
    const plan = await planLocalPublish(document, {
      store: state.store,
      providers: set.providers,
      namespace: "default",
      now: state.clock.now,
    });
    const file = planFilePath(state.stateHome, plan.planId);
    const original = readFileSync(file, "utf8");
    const tampered = original.replace(
      document.content,
      "tampered content here",
    );

    expect(tampered).not.toBe(original);
    writeFileSync(file, tampered, { mode: 0o600 });

    const error = await rejectionOf(() =>
      loadLocalPlan(plan.planId, {
        store: state.store,
        kind: "publish",
        now: state.clock.now,
      }),
    );

    expect(error.code).toBe("PLAN_TAMPERED");
  });

  it("rejects a plan copied from another state", async () => {
    const source = await fixture();
    const target = await fixture();
    const set = providerSet();

    await seedConnection(source.store, { provider: "bluesky" });
    await seedConnection(target.store, { provider: "bluesky" });

    const plan = await planLocalPublish(documentOf(), {
      store: source.store,
      providers: set.providers,
      namespace: "default",
      now: source.clock.now,
    });

    // Give the target state its own plan, so the plans directory exists.
    await planLocalPublish(documentOf({ key: "other-key" }), {
      store: target.store,
      providers: set.providers,
      namespace: "default",
      now: target.clock.now,
    });

    copyFileSync(
      planFilePath(source.stateHome, plan.planId),
      planFilePath(target.stateHome, plan.planId),
    );

    const error = await rejectionOf(() =>
      loadLocalPlan(plan.planId, {
        store: target.store,
        kind: "publish",
        now: target.clock.now,
      }),
    );

    expect(error.code).toBe("PLAN_TAMPERED");
  });

  it("rejects a plan id that is not a local plan id", async () => {
    const state = await fixture();
    const before = stateSnapshot(state.stateHome);

    for (const planId of [
      `plan_${"a".repeat(32)}/../../installation.json`,
      `https://example.test/plan_${"a".repeat(32)}`,
      `plan_${"A".repeat(32)}`,
      `plan_${"a".repeat(31)}`,
      `plan_${"a".repeat(32)}.json`,
    ]) {
      const error = await rejectionOf(() =>
        loadLocalPlan(planId, {
          store: state.store,
          kind: "publish",
          now: state.clock.now,
        }),
      );

      expect([planId, error.code, error.exitCode]).toEqual([
        planId,
        "PLAN_TAMPERED",
        EXIT_CODE.USAGE,
      ]);
    }

    expect(stateSnapshot(state.stateHome)).toEqual(before);
  });

  it("rejects a plan id this state does not have", async () => {
    const state = await fixture();
    const set = providerSet();

    await seedConnection(state.store, { provider: "bluesky" });
    await planLocalPublish(documentOf(), {
      store: state.store,
      providers: set.providers,
      namespace: "default",
      now: state.clock.now,
    });

    const before = stateSnapshot(state.stateHome);
    const error = await rejectionOf(() =>
      loadLocalPlan(`plan_${"c".repeat(32)}`, {
        store: state.store,
        kind: "publish",
        now: state.clock.now,
      }),
    );

    expect(error.code).toBe("USAGE");
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(stateSnapshot(state.stateHome)).toEqual(before);
  });

  it("rejects a plan loaded for the wrong command", async () => {
    const state = await fixture();
    const set = providerSet();

    await seedConnection(state.store, { provider: "bluesky" });

    const plan = await planLocalPublish(documentOf(), {
      store: state.store,
      providers: set.providers,
      namespace: "default",
      now: state.clock.now,
    });
    const error = await rejectionOf(() =>
      loadLocalPlan(plan.planId, {
        store: state.store,
        kind: "retry",
        now: state.clock.now,
      }),
    );

    expect(error.code).toBe("PLAN_KIND_MISMATCH");
  });
});

describe("planLocalPublish against an existing delivery", () => {
  it("skips a succeeded delivery and reuses its frozen business time", async () => {
    const state = await fixture();
    const set = providerSet();

    await seedConnection(state.store, { provider: "bluesky" });

    const first = await planLocalPublish(documentOf(), {
      store: state.store,
      providers: set.providers,
      namespace: "default",
      now: state.clock.now,
    });

    await deliverOutcome(state.store, first, succeededOutcome());

    // The same stable account, now at a new binding revision.
    await seedConnection(state.store, {
      provider: "bluesky",
      bindingRevision: 2,
      expectedRevision: 1,
    });
    state.clock.advance(60 * 60 * 1_000);

    const second = await planLocalPublish(documentOf(), {
      store: state.store,
      providers: set.providers,
      namespace: "default",
      now: state.clock.now,
    });
    const item = onlyItem(second);

    expect(item.action).toBe("skip");
    expect(item.delivery.target.bindingRevision).toBe(2);
    expect(item.delivery.payload).toEqual(onlyItem(first).delivery.payload);
    expect(item.delivery.payloadHash).toBe(onlyItem(first).delivery.payloadHash);
    expect(frozenBusinessTime(item.delivery)).toBe(START_TIME);
    expect(previewForPlan(second).items[0]?.binding).toEqual({
      connectionId: CONNECTION_ID,
      bindingRevision: 2,
    });

    // A skip only reads the recorded success, so the plan is admissible even
    // though the record still holds the older binding revision.
    const operation = await state.store.reserveOperation(second);

    expect(operation.admissionState).toBe("ready");
  });

  it("blocks a repeated preview whose content changed", async () => {
    const state = await fixture();
    const set = providerSet();

    await seedConnection(state.store, { provider: "bluesky" });

    const options = {
      store: state.store,
      providers: set.providers,
      namespace: "default",
      now: state.clock.now,
    };
    const first = await planLocalPublish(
      documentOf({ content: "first text" }),
      options,
    );

    await deliverOutcome(state.store, first, succeededOutcome());

    const second = await planLocalPublish(
      documentOf({ content: "second text" }),
      options,
    );
    const item = onlyItem(second);

    expect(item.action).toBe("blocked");
    expect(item.delivery.content).toBe("first text");
    expect(item.delivery.payloadHash).toBe(onlyItem(first).delivery.payloadHash);

    // A blocked item makes the plan unexecutable.
    const admission = await rejectionOf(() =>
      state.store.reserveOperation(second),
    );

    expect(admission.code).toBe("INVALID_DOCUMENT");

    await expect(
      loadLocalPlan(second.planId, {
        store: state.store,
        kind: "publish",
        now: state.clock.now,
      }),
    ).resolves.toEqual(second);
  });

  it("keeps failed, unknown, and not_started deliveries blocked", async () => {
    const cases: readonly {
      readonly name: string;
      readonly settle: (store: LocalStore, plan: LocalPlan) => Promise<void>;
    }[] = [
      {
        name: "failed",
        settle: (store, plan) => deliverOutcome(store, plan, failedOutcome()),
      },
      {
        name: "unknown",
        settle: (store, plan) => deliverOutcome(store, plan, unknownOutcome()),
      },
      {
        name: "not_started",
        settle: async (store, plan) => {
          await store.reserveOperation(plan);
        },
      },
    ];

    for (const testCase of cases) {
      const state = await fixture();
      const set = providerSet();

      await seedConnection(state.store, { provider: "bluesky" });

      const first = await planLocalPublish(documentOf(), {
        store: state.store,
        providers: set.providers,
        namespace: "default",
        now: state.clock.now,
      });

      await testCase.settle(state.store, first);

      const second = await planLocalPublish(documentOf(), {
        store: state.store,
        providers: set.providers,
        namespace: "default",
        now: state.clock.now,
      });

      expect([testCase.name, onlyItem(second).action]).toEqual([
        testCase.name,
        "blocked",
      ]);
    }
  });

  it("blocks reuse when the provider payload version or shape changed", async () => {
    const versionState = await fixture();
    const shapeState = await fixture();

    await seedConnection(versionState.store, { provider: "bluesky" });
    await seedConnection(shapeState.store, { provider: "bluesky" });

    const firstSet = providerSet({
      bluesky: staticProvider("bluesky", { extraPayload: { lang: "en" } }),
    });
    const versionSet = providerSet({
      bluesky: staticProvider("bluesky", { payloadVersion: 2 }),
    });
    const shapeSet = providerSet({
      bluesky: staticProvider("bluesky", { extraPayload: { lang: "fr" } }),
    });

    const versionFirst = await planLocalPublish(documentOf(), {
      store: versionState.store,
      providers: firstSet.providers,
      namespace: "default",
      now: versionState.clock.now,
    });

    await deliverOutcome(versionState.store, versionFirst, succeededOutcome());

    const versionSecond = await planLocalPublish(documentOf(), {
      store: versionState.store,
      providers: versionSet.providers,
      namespace: "default",
      now: versionState.clock.now,
    });

    expect(["version", onlyItem(versionSecond).action]).toEqual([
      "version",
      "blocked",
    ]);

    const shapeFirst = await planLocalPublish(documentOf(), {
      store: shapeState.store,
      providers: firstSet.providers,
      namespace: "default",
      now: shapeState.clock.now,
    });

    await deliverOutcome(shapeState.store, shapeFirst, succeededOutcome());

    const shapeSecond = await planLocalPublish(documentOf(), {
      store: shapeState.store,
      providers: shapeSet.providers,
      namespace: "default",
      now: shapeState.clock.now,
    });

    expect(["shape", onlyItem(shapeSecond).action]).toEqual([
      "shape",
      "blocked",
    ]);
  });

  it("needs a new plan for a different account", async () => {
    const state = await fixture();
    const set = providerSet();

    await seedConnection(state.store, { provider: "bluesky" });

    const first = await planLocalPublish(
      documentOf({ platforms: ["bluesky"] }),
      {
        store: state.store,
        providers: set.providers,
        namespace: "default",
        now: state.clock.now,
      },
    );

    await deliverOutcome(state.store, first, succeededOutcome());

    await seedConnection(state.store, {
      provider: "bluesky",
      targetId: "did:plc:fixturebob",
      connectionId: `conn_${"c".repeat(32)}`,
      bindingRevision: 2,
      expectedRevision: 1,
    });

    const second = await planLocalPublish(
      documentOf({ platforms: ["bluesky"] }),
      {
        store: state.store,
        providers: set.providers,
        namespace: "default",
        now: state.clock.now,
      },
    );
    const item = onlyItem(second);

    expect(second.items).toHaveLength(1);
    expect(item.action).toBe("publish");
    expect(item.delivery.target.targetId).toBe("did:plc:fixturebob");
    expect(item.delivery.deliveryId).not.toBe(
      onlyItem(first).delivery.deliveryId,
    );
    expect(set.calls.threads.freeze).toBe(0);
    expect(set.calls.threads.prepare).toBe(0);
  });
});
