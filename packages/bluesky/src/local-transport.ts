/**
 * Bounded HTTP transport for the local Bluesky provider.
 *
 * This module stays on the web platform: no Node imports, no CLI imports.
 * Every request goes to the one trusted origin, never follows a redirect, and
 * every response is read with a hard byte cap.
 */

export const MAX_RESPONSE_BYTES = 65_536;
export const DEFAULT_TIMEOUT_MS = 15_000;

const MAX_RETRY_AFTER_SECONDS = 604_800;
const MAX_HEADER_LENGTH = 64;

/** RFC 7231 delta-seconds: decimal digits only. */
const DELTA_SECONDS_PATTERN = /^[0-9]+$/;

/** The three HTTP-date grammars from RFC 7231, with bounded components. */
const IMF_FIXDATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12][0-9]|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} (?:[01][0-9]|2[0-3]):[0-5][0-9]:(?:[0-5][0-9]|60) GMT$/;
const RFC850_DATE_PATTERN =
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (?:0[1-9]|[12][0-9]|3[01])-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-[0-9]{2} (?:[01][0-9]|2[0-3]):[0-5][0-9]:(?:[0-5][0-9]|60) GMT$/;
const ASCTIME_DATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ 0-9][0-9]) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/;

const MONTH_INDEX: Readonly<Record<string, number>> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

export type TransportFailure =
  | "RESPONSE_TOO_LARGE"
  | "INVALID_UTF8"
  | "INVALID_JSON";

export class LocalTransportError extends Error {
  constructor(readonly reason: TransportFailure) {
    super(reason);
    this.name = "LocalTransportError";
  }
}

export interface Deadline {
  readonly signal: AbortSignal;
  /** True when the local deadline fired rather than the caller's signal. */
  timedOut(): boolean;
  cleanup(): void;
}

/**
 * Links the caller's signal with a local total deadline. Cleanup is explicit
 * so a finished call never leaves a pending timer or listener behind.
 */
export function createDeadline(
  external: AbortSignal,
  timeoutMs: number,
): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => {
    controller.abort();
  };

  if (external.aborted) {
    controller.abort();
  } else {
    external.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      external.removeEventListener("abort", onAbort);
    },
  };
}

export interface BoundedResponse {
  readonly status: number;
  readonly body: unknown;
  /** Raw Retry-After header, bounded and unparsed. */
  readonly retryAfter: string | null;
}

export async function requestBounded(
  transport: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<BoundedResponse> {
  const response = await transport(url, { ...init, redirect: "manual", signal });
  const body = await readBoundedJson(response);

  return {
    status: response.status,
    body,
    retryAfter: rawHeader(response, "retry-after"),
  };
}

/**
 * How long a rate-limited caller was told to wait.
 *
 * - `none`: no header. The platform still rejected us, so a retry stays allowed
 *   with no scheduled time.
 * - `at`: a representable future instant inside the bound.
 * - `unsafe`: a header was supplied but cannot be represented safely, so the
 *   caller must refuse to schedule an early retry instead of guessing.
 */
export type RetryHint =
  | { readonly kind: "none" }
  | { readonly kind: "at"; readonly retryNotBefore: string }
  | { readonly kind: "unsafe" };

export function readRetryHint(
  value: string | null,
  now: number = Date.now(),
): RetryHint {
  if (value === null) {
    return { kind: "none" };
  }

  if (value.length === 0 || value.length > MAX_HEADER_LENGTH) {
    return { kind: "unsafe" };
  }

  // `+1`, `0x10`, `1e2`, and `1.5` are not delta-seconds and must not be
  // rescued by a lenient date parser.
  if (DELTA_SECONDS_PATTERN.test(value)) {
    const seconds = Number(value);

    if (seconds > MAX_RETRY_AFTER_SECONDS) {
      return { kind: "unsafe" };
    }

    return {
      kind: "at",
      retryNotBefore: new Date(now + seconds * 1_000).toISOString(),
    };
  }

  const at = readHttpDate(value);

  if (
    at === null ||
    at < now ||
    at > now + MAX_RETRY_AFTER_SECONDS * 1_000
  ) {
    return { kind: "unsafe" };
  }

  return { kind: "at", retryNotBefore: new Date(at).toISOString() };
}

/**
 * Returns the instant an accepted HTTP-date describes, or null when the value
 * is not one of the three RFC 7231 grammars. Plain `Date.parse` is not used as
 * a grammar check because it also accepts values like `1.5`.
 */
function readHttpDate(value: string): number | null {
  if (IMF_FIXDATE_PATTERN.test(value) || RFC850_DATE_PATTERN.test(value)) {
    const at = Date.parse(value);

    return Number.isNaN(at) ? null : at;
  }

  const asctime = ASCTIME_DATE_PATTERN.exec(value);

  if (asctime === null) {
    return null;
  }

  const [, month, day, hour, minute, second, year] = asctime;

  if (
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    year === undefined
  ) {
    return null;
  }

  const monthIndex = MONTH_INDEX[month];
  const dayOfMonth = Number(day);
  const hours = Number(hour);
  const minutes = Number(minute);
  const seconds = Number(second);

  if (
    monthIndex === undefined ||
    dayOfMonth < 1 ||
    dayOfMonth > 31 ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 60
  ) {
    return null;
  }

  // asctime is GMT, and `Date.parse` would read it as local time.
  return Date.UTC(Number(year), monthIndex, dayOfMonth, hours, minutes, seconds);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? "");

  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await cancel(response);
    throw new LocalTransportError("RESPONSE_TOO_LARGE");
  }

  if (!response.body) {
    return undefined;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      length += value.byteLength;

      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new LocalTransportError("RESPONSE_TOO_LARGE");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (length === 0) {
    return undefined;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LocalTransportError("INVALID_UTF8");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LocalTransportError("INVALID_JSON");
  }
}

function rawHeader(response: Response, name: string): string | null {
  const value = response.headers.get(name);

  return value === null ? null : value.trim();
}

async function cancel(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; there is nothing left to clean up.
  }
}
