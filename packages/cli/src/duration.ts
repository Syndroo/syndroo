import { usageError } from "./cli-error.js";

const DURATION_PATTERN = /^(\d+)(ms|s|m|h)?$/u;

const MAX_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parses `500ms`, `60s`, `5m`, `2h`. A bare number is seconds, matching the
 * documented `--timeout 60s`; the unit is required in the documentation for a
 * reason, so it is accepted and encouraged.
 */
export function parseDuration(value: string, flag: string): number {
  const match = DURATION_PATTERN.exec(value.trim());

  if (match === null) {
    throw usageError(
      `${flag} must be a duration such as 500ms, 60s, 5m, or 2h; received "${value}".`,
    );
  }

  const amount = Number.parseInt(match[1] as string, 10);
  const unitMs = UNIT_MS[match[2] ?? "s"] as number;
  const total = amount * unitMs;

  if (total <= 0) {
    throw usageError(`${flag} must be greater than zero.`);
  }

  if (total > MAX_WAIT_TIMEOUT_MS) {
    throw usageError(`${flag} must not exceed 24h.`);
  }

  return total;
}
