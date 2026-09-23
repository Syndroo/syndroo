import { describe, expect, it } from "vitest";

import {
  InvalidContractInputError,
  compareInstants,
  isDueAt,
  isIsoInstant,
  requireIsoInstant,
} from "../src/index.js";

describe("canonical UTC instants", () => {
  it("accepts exactly the canonical form D1 text ordering relies on", () => {
    expect(isIsoInstant("2026-09-23T00:00:00.000Z")).toBe(true);
    expect(isIsoInstant("2026-09-23T00:00:00.500Z")).toBe(true);
  });

  it("rejects missing milliseconds and non-UTC offsets", () => {
    expect(isIsoInstant("2026-09-23T00:00:00Z")).toBe(false);
    expect(isIsoInstant("2026-09-23T00:00:00+09:00")).toBe(false);
    expect(isIsoInstant("2026-09-23T00:00:00.000+09:00")).toBe(false);
  });

  it("rejects impossible calendar dates and malformed input", () => {
    expect(isIsoInstant("2026-02-30T00:00:00.000Z")).toBe(false);
    expect(isIsoInstant("2026-13-01T00:00:00.000Z")).toBe(false);
    expect(isIsoInstant("2026-09-23T25:00:00.000Z")).toBe(false);
    expect(isIsoInstant("not-an-instant")).toBe(false);
    expect(isIsoInstant(1_758_585_600_000)).toBe(false);
    expect(isIsoInstant(null)).toBe(false);
  });

  it("compares and orders instants safely", () => {
    expect(compareInstants("2026-09-23T00:00:00.000Z", "2026-09-23T00:00:00.000Z")).toBe(0);
    expect(compareInstants("2026-09-23T00:00:00.000Z", "2026-09-23T00:00:01.000Z")).toBe(-1);
    expect(isDueAt("2026-09-23T00:00:00.000Z", "2026-09-23T00:00:00.000Z")).toBe(true);
    expect(isDueAt("2026-09-23T00:00:01.000Z", "2026-09-23T00:00:00.000Z")).toBe(false);
  });

  it("rejects non-canonical values at the port boundary", () => {
    expect(() => requireIsoInstant("2026-09-23T00:00:00Z", "now")).toThrow(
      InvalidContractInputError,
    );
    expect(() => requireIsoInstant("2026-09-23T00:00:00+09:00", "now")).toThrow(
      InvalidContractInputError,
    );
  });
});
