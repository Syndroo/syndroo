/**
 * Framework-free assertions for the shared port contract suite.
 *
 * The suite runs inside Vitest for the in-memory fake and inside whichever
 * runner the D1 adapter uses, so it cannot import a test framework.
 */

export class ContractViolationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ContractViolationError";
  }
}

export function fail(message: string): never {
  throw new ContractViolationError(message);
}

export function assertTrue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) {
    fail(`${message} (expected ${render(expected)}, received ${render(actual)})`);
  }
}

export function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualText = stableRender(actual);
  const expectedText = stableRender(expected);
  if (actualText !== expectedText) {
    fail(`${message}\n  expected: ${expectedText}\n  received: ${actualText}`);
  }
}

export function assertKind<T extends { readonly kind: string }, K extends string>(
  value: T,
  kind: K,
  message: string,
): asserts value is Extract<T, { readonly kind: K }> {
  if (value.kind !== kind) {
    fail(`${message} (expected kind ${kind}, received ${value.kind})`);
  }
}

function render(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function stableRender(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const result: Record<string, unknown> = {};
    for (const [key, nested] of entries) {
      result[key] = sortKeys(nested);
    }
    return result;
  }
  return value;
}
