/**
 * Wire types and the runtime reader for `GET /v1/diagnostics` (0.5.0).
 *
 * The endpoint is read-only: counts describe current rows, an unknown storage
 * size or limit is `null` with a fixed reason, and utilization is a 0..1 ratio
 * only when both are known.
 */

import {
  invalid,
  requireInstant,
  requireNullableInstant,
  requireNonNegativeInteger,
  requireNullableNumber,
  requireNullableString,
  requireRecord,
  requireString,
  type ParseContext,
} from "./types.js";

export interface DiagnosticsStorage {
  approximateBytes: number | null;
  limitBytes: number | null;
  utilization: number | null;
  reason: string | null;
  observedAt: string;
}

export interface Diagnostics {
  observedAt: string;
  pendingOutbox: number;
  oldestDueAt: string | null;
  oldestAgeSeconds: number | null;
  retryScheduled: number;
  deadLettered: number;
  latestAttemptArchiveFailures: number;
  storage: DiagnosticsStorage;
}

export function parseDiagnostics(value: unknown, context: ParseContext): Diagnostics {
  const record = requireRecord(value, "diagnostics", context);
  const storage = requireRecord(record["storage"], "diagnostics storage", context);
  const approximateBytes = requireNullableBytes(
    storage["approximateBytes"],
    "diagnostics storage approximateBytes",
    context,
  );
  const limitBytes = requireNullableBytes(
    storage["limitBytes"],
    "diagnostics storage limitBytes",
    context,
  );
  const utilization = requireNullableRatio(
    storage["utilization"],
    "diagnostics storage utilization",
    context,
  );
  const reason = requireNullableReason(
    storage["reason"],
    "diagnostics storage reason",
    context,
  );

  // Utilization is a ratio only when both numbers are known.
  if (
    utilization !== null &&
    (approximateBytes === null || limitBytes === null)
  ) {
    throw invalid(
      "diagnostics storage utilization must be null when size or limit is unknown",
      context,
    );
  }

  // An unknown size or limit must say why, with the one code this deployment
  // documents; a known pair may leave the reason empty.
  if ((approximateBytes === null || limitBytes === null) && reason === null) {
    throw invalid(
      "diagnostics storage reason must be present when size or limit is unknown",
      context,
    );
  }

  return {
    observedAt: requireInstant(record["observedAt"], "diagnostics observedAt", context),
    pendingOutbox: requireNonNegativeInteger(
      record["pendingOutbox"],
      "diagnostics pendingOutbox",
      context,
    ),
    oldestDueAt: requireNullableInstant(
      record["oldestDueAt"],
      "diagnostics oldestDueAt",
      context,
    ),
    oldestAgeSeconds: requireNullableAge(
      record["oldestAgeSeconds"],
      "diagnostics oldestAgeSeconds",
      context,
    ),
    retryScheduled: requireNonNegativeInteger(
      record["retryScheduled"],
      "diagnostics retryScheduled",
      context,
    ),
    deadLettered: requireNonNegativeInteger(
      record["deadLettered"],
      "diagnostics deadLettered",
      context,
    ),
    latestAttemptArchiveFailures: requireNonNegativeInteger(
      record["latestAttemptArchiveFailures"],
      "diagnostics latestAttemptArchiveFailures",
      context,
    ),
    storage: {
      approximateBytes,
      limitBytes,
      utilization,
      reason,
      observedAt: requireInstant(
        storage["observedAt"],
        "diagnostics storage observedAt",
        context,
      ),
    },
  };
}

/**
 * The only storage reason this deployment documents. Anything else is server
 * text and must not reach a caller, so it is rejected instead of echoed.
 */
const STORAGE_REASONS: ReadonlySet<string> = new Set(["size_unavailable"]);

function requireNullableReason(
  value: unknown,
  label: string,
  context: ParseContext,
): string | null {
  const reason = requireNullableString(value, label, context);

  if (reason !== null && !STORAGE_REASONS.has(reason)) {
    throw invalid(`${label} is not one this SDK documents`, context);
  }

  return reason;
}

/** Byte totals are whole and nonnegative when they are known. */
function requireNullableBytes(
  value: unknown,
  label: string,
  context: ParseContext,
): number | null {
  if (value === null) {
    return null;
  }

  return requireNonNegativeInteger(value, label, context);
}

function requireNullableAge(
  value: unknown,
  label: string,
  context: ParseContext,
): number | null {
  const age = requireNullableNumber(value, label, context);

  if (age !== null && (age < 0 || !Number.isFinite(age))) {
    throw invalid(`${label} must be a nonnegative number of seconds`, context);
  }

  return age;
}

function requireNullableRatio(
  value: unknown,
  label: string,
  context: ParseContext,
): number | null {
  const ratio = requireNullableNumber(value, label, context);

  if (ratio !== null && (ratio < 0 || ratio > 1)) {
    throw invalid(`${label} must be a ratio between 0 and 1`, context);
  }

  return ratio;
}
