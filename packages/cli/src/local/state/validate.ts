import { stateFailure } from "./atomic.js";

/**
 * Shared shape readers for state records.
 *
 * Every message is static and carries only the label of the field, never a raw
 * value, path, key, or record body: these messages reach the operator.
 */

export type StateObject = Readonly<Record<string, unknown>>;

/** Canonical timestamp shape: exactly what `Date.prototype.toISOString` emits. */
export const ISO_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function corrupt(what: string, detail: string): never {
  throw stateFailure("STATE_CORRUPT", `${what} ${detail}`);
}

export function requireRecord(value: unknown, what: string): StateObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    corrupt(what, "is not a JSON object");
  }

  return value as StateObject;
}

/** Requires exactly these fields: no unknown field, no missing field. */
export function requireExactFields(
  record: StateObject,
  fields: readonly string[],
  what: string,
): void {
  for (const field of Object.keys(record)) {
    if (!fields.includes(field)) {
      corrupt(what, "has a field this version does not accept");
    }
  }

  for (const field of fields) {
    if (!Object.hasOwn(record, field)) {
      corrupt(what, "is missing a field this version requires");
    }
  }
}

export function requireString(
  value: unknown,
  what: string,
  options: { pattern?: RegExp; min?: number; max?: number } = {},
): string {
  if (typeof value !== "string") {
    corrupt(what, "is not a string");
  }

  const min = options.min ?? 1;
  const max = options.max ?? 1024;

  if (value.length < min || value.length > max) {
    corrupt(what, "is outside the accepted length");
  }

  if (options.pattern !== undefined && !options.pattern.test(value)) {
    corrupt(what, "is not in the accepted format");
  }

  return value;
}

export function requireInteger(
  value: unknown,
  what: string,
  options: { min?: number; max?: number } = {},
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    corrupt(what, "is not an integer");
  }

  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;

  if (value < min || value > max) {
    corrupt(what, "is outside the accepted range");
  }

  return value;
}

export function requireBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") {
    corrupt(what, "is not a boolean");
  }

  return value;
}

export function requireArray(
  value: unknown,
  what: string,
  options: { min?: number; max?: number } = {},
): readonly unknown[] {
  if (!Array.isArray(value)) {
    corrupt(what, "is not an array");
  }

  const min = options.min ?? 0;
  const max = options.max ?? 1024;

  if (value.length < min || value.length > max) {
    corrupt(what, "is outside the accepted length");
  }

  return value;
}

/**
 * Requires a finite canonical ISO timestamp.
 *
 * The round-trip check refuses dates that parse but do not exist, such as
 * `2026-02-31T00:00:00.000Z`, which `Date.parse` silently normalizes.
 */
export function requireIsoTime(value: unknown, what: string): string {
  if (typeof value !== "string" || !ISO_TIME_PATTERN.test(value)) {
    corrupt(what, "is not a canonical timestamp");
  }

  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    corrupt(what, "is not a canonical timestamp");
  }

  return value;
}

export function requireHex(
  value: unknown,
  what: string,
  length: number,
): string {
  if (
    typeof value !== "string" ||
    value.length !== length ||
    !/^[0-9a-f]+$/.test(value)
  ) {
    corrupt(what, "is not a lowercase hex digest");
  }

  return value;
}

export function requireVersion(value: unknown, what: string): 1 {
  if (value === 1) {
    return 1;
  }

  if (typeof value === "number" && Number.isInteger(value) && value > 1) {
    throw stateFailure(
      "STATE_VERSION_UNSUPPORTED",
      `${what} was written by a newer version`,
    );
  }

  corrupt(what, "has an unsupported schema version");
}
