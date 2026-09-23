/** Largest wait a provider hint may request before the application's own policy applies. */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export interface RetryAfterOptions {
  readonly now: Date;
  /** Defaults to 24h; a trustworthy header beyond it is clamped to this bound. */
  readonly maxDelayMs?: number;
}

/** IMF-fixdate only: an arbitrary `Date.parse` input is not an HTTP date. */
const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Normalizes a `Retry-After` header into a UTC instant.
 *
 * Callers must only use the result for a response they proved had no remote
 * effect (an explicit 429 rejection). A missing, malformed, or already elapsed
 * value returns `undefined` so the caller falls back to its own policy; a value
 * further out than `maxDelayMs` is clamped rather than trusted verbatim.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  options: RetryAfterOptions,
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();

  if (trimmed === "") {
    return undefined;
  }

  const nowMs = options.now.getTime();

  if (!Number.isFinite(nowMs)) {
    return undefined;
  }

  const maxDelayMs = options.maxDelayMs ?? MAX_RETRY_AFTER_MS;

  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_RETRY_AFTER_MS) {
    throw new TypeError(
      `maxDelayMs must be a finite positive number no greater than ${MAX_RETRY_AFTER_MS}`,
    );
  }

  let requestedMs: number;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    requestedMs = Number.isFinite(seconds) ? nowMs + seconds * 1000 : Number.NaN;
  } else if (HTTP_DATE.test(trimmed)) {
    requestedMs = Date.parse(trimmed);
  } else {
    return undefined;
  }

  if (!Number.isFinite(requestedMs) || requestedMs <= nowMs) {
    return undefined;
  }

  return new Date(Math.min(requestedMs, nowMs + maxDelayMs)).toISOString();
}
