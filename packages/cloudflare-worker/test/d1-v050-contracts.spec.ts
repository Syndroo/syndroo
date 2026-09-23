import { describe, expect, it } from "vitest";

import { runStoreContractScenarios } from "@syndroo/application/testing";

import { createD1Harness } from "./support/d1-v050-support.js";

describe("portable store contract on real local D1", () => {
  it("passes every shared scenario", async () => {
    const harness = createD1Harness();
    const report = await runStoreContractScenarios(harness);
    const failures = report.scenarios
      .filter((scenario) => scenario.status === "fail")
      .map((scenario) => `${scenario.id}: ${scenario.detail}`);
    expect(failures).toEqual([]);
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThanOrEqual(49);
  }, 300_000);
});
