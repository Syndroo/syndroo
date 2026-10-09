import { describe, expect, it } from "vitest";

import type * as T from "@syndroo/core";

import * as coreRules from "../../../../core/src/domain/rules.js";
import * as localRules from "../../../src/runtime/filesystem/rules.js";

/**
 * The adapter duplicates five pure rules because Core does not publish
 * `domain/rules.ts`. These tests compare the copies with Core's implementation
 * on the same inputs, so drift is a failing test instead of a silent change in
 * adapter semantics.
 */

const delivery = (
  overrides: Partial<T.DeliveryRecord> = {},
): T.DeliveryRecord => ({
  deliveryId: "delivery_one",
  connectionId: "conn_one",
  account: {
    provider: "fake",
    accountId: "alice",
    origin: "https://social.example",
  },
  attempts: 0,
  outcome: null,
  state: "ready",
  history: [],
  ...overrides,
});

const succeeded: T.ProviderWriteOutcome = {
  status: "succeeded",
  remoteId: "remote",
};
const failedNotApplied: T.ProviderWriteOutcome = {
  status: "failed",
  disposition: "not_applied",
  retryable: true,
  reason: "rate_limited",
};
const unknown: T.ProviderWriteOutcome = {
  status: "unknown",
  disposition: "unknown",
  reason: "unknown",
};
const notStarted: T.NotStarted = {
  status: "not_started",
  disposition: "not_applied",
  reason: "execution_interrupted",
};

const aggregates: T.DeliveryRecord[][] = [
  [],
  [delivery()],
  [delivery({ state: "in_flight" })],
  [delivery({ state: "settled", outcome: succeeded })],
  [
    delivery({ state: "settled", outcome: succeeded }),
    delivery({ deliveryId: "delivery_two", state: "settled", outcome: succeeded }),
  ],
  [
    delivery({ state: "settled", outcome: succeeded }),
    delivery({ deliveryId: "delivery_two", state: "settled", outcome: unknown }),
  ],
  [
    delivery({ state: "in_flight" }),
    delivery({ deliveryId: "delivery_two", state: "settled", outcome: succeeded }),
  ],
  [
    delivery(),
    delivery({ deliveryId: "delivery_two", state: "settled", outcome: succeeded }),
  ],
  [
    delivery({ state: "settled", outcome: succeeded }),
    delivery({
      deliveryId: "delivery_two",
      state: "settled",
      outcome: {
        status: "failed",
        disposition: "not_applied",
        retryable: false,
        reason: "validation",
      },
    }),
  ],
  [delivery({ state: "settled", outcome: notStarted })],
];

const retryCases: [T.DeliveryRecord, string][] = [
  [delivery(), "2026-10-08T00:00:00.000Z"],
  [delivery({ state: "in_flight" }), "2026-10-08T00:00:00.000Z"],
  [delivery({ state: "settled", outcome: null }), "2026-10-08T00:00:00.000Z"],
  [delivery({ state: "settled", outcome: succeeded }), "2026-10-08T00:00:00.000Z"],
  [
    delivery({ state: "settled", outcome: failedNotApplied }),
    "2026-10-08T00:00:00.000Z",
  ],
  [
    delivery({
      state: "settled",
      outcome: { ...failedNotApplied, retryAfter: "2026-10-08T01:00:00.000Z" },
    }),
    "2026-10-08T00:00:00.000Z",
  ],
  [
    delivery({
      state: "settled",
      outcome: { ...failedNotApplied, retryAfter: "2026-10-07T00:00:00.000Z" },
    }),
    "2026-10-08T00:00:00.000Z",
  ],
  [
    delivery({
      state: "settled",
      attempts: 3,
      outcome: failedNotApplied,
    }),
    "2026-10-08T00:00:00.000Z",
  ],
  [delivery({ state: "settled", outcome: notStarted }), "2026-10-08T00:00:00.000Z"],
  [
    delivery({
      state: "settled",
      outcome: { ...notStarted, reason: "stale_binding" },
    }),
    "2026-10-08T00:00:00.000Z",
  ],
  [delivery({ state: "settled", outcome: unknown }), "2026-10-08T00:00:00.000Z"],
  [
    delivery({
      state: "settled",
      outcome: { ...failedNotApplied, retryAfter: "" },
    }),
    "2026-10-08T00:00:00.000Z",
  ],
];

describe("adapter rules match Core", () => {
  it("aggregates identically", () => {
    for (const deliveries of aggregates) {
      expect(localRules.aggregate(deliveries)).toBe(
        coreRules.aggregate(deliveries),
      );
    }
  });

  it("decides retry eligibility identically", () => {
    for (const [record, now] of retryCases) {
      expect(localRules.retryEligible(record, now)).toBe(
        coreRules.retryEligible(record, now),
      );
    }
  });

  it("derives the same identity key, deadline and unknown outcome", () => {
    const account: T.AccountIdentity = {
      provider: "fake",
      accountId: "alice",
      origin: "https://social.example",
    };

    expect(localRules.accountKey(account)).toBe(coreRules.accountKey(account));
    expect(localRules.later("2026-10-08T00:00:00.000Z", 900_000)).toBe(
      coreRules.later("2026-10-08T00:00:00.000Z", 900_000),
    );
    expect(localRules.unknownOutcome()).toEqual(coreRules.unknownOutcome());
  });
});
