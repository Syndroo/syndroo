/**
 * Reusable Provider contract harness: `@syndroo/provider-sdk/testing`.
 *
 * `providerContractTests` replays caller-supplied freeze cases against a plugin
 * and checks the guarantees the architecture promises every provider, not the
 * guarantees one platform happens to need:
 *
 * - freeze is deterministic, mutates nothing it was given, and returns a deeply
 *   frozen, completely typed payload;
 * - the frozen payload stays free of auth material, and so does a publish
 *   outcome even when the harness hands the plugin a labelled test credential;
 * - an `unknown` outcome is never marked retryable, because an unknown write
 *   must not become a retry just because a provider has a dedupe feature;
 * - a malformed payload or outcome is a failure here, not something a caller
 *   has to discover later.
 *
 * The harness performs no I/O. Its transport refuses every request with a
 * deterministic `before_request` transport error, so nothing is ever sent and
 * no network, clock or random source is consulted. Providers whose publish path
 * needs a two-step flow may still call the transport more than once; only the
 * returned outcome is judged.
 *
 * This module is a test subpath. The production root export must not import it.
 */

import { isDeepStrictEqual } from "node:util";

import { ProviderDefinitionError, defineProvider } from "./define-provider.js";
import type {
  ContractCase,
  FrozenProviderPayload,
  Json,
  ProviderFailureReason,
  ProviderHttpRequest,
  ProviderHttpResult,
  ProviderPlugin,
  ProviderTransport,
  ProviderWriteOutcome,
} from "./types.js";

/** Budgets the harness itself enforces while scanning a payload. */
export const CONTRACT_LIMITS = Object.freeze({
  /** Longest path string quoted in a harness failure. */
  maxReportedPathLength: 200,
  /** Values one frozen payload or outcome may contain. */
  maxNodes: 4096,
  /** Nesting depth of one frozen payload or outcome. */
  maxDepth: 32,
});

/**
 * A labelled fake credential the harness passes to `publish`. A provider that
 * echoes credentials into an outcome fails the harness; nothing here is a real
 * secret and nothing is sent anywhere.
 */
export const CONTRACT_TEST_CREDENTIAL_CANARY = "syndroo-contract-canary-not-a-real-secret";

/** The credential bundle shape the harness supplies to `publish`. */
export const contractTestCredentials = (): Record<string, Json> => ({
  contractTestCanary: CONTRACT_TEST_CREDENTIAL_CANARY,
});

/** Key names that must never appear inside a frozen payload or an outcome. */
const AUTH_KEY_PATTERN =
  /^(access[_-]?token|refresh[_-]?token|api[_-]?key|password|client[_-]?secret|client[_-]?id|authorization|auth|code[_-]?verifier|code[_-]?challenge|token|secret|credentials|bearer)$/i;

const FAILURE_REASONS: ReadonlySet<string> = new Set<ProviderFailureReason>([
  "auth",
  "validation",
  "rate_limited",
  "provider_unavailable",
  "network",
  "permission",
  "unsupported",
  "unknown",
]);

/**
 * Keys each `ProviderWriteOutcome` variant may carry, and a static sentence
 * describing the variant. A variant that carries a field belonging to another
 * variant is malformed: `succeeded` cannot also claim a `disposition` or a
 * `retryable` flag, and `unknown` cannot carry a `retryAfter`.
 */
const OUTCOME_VARIANTS: Readonly<Record<string, { keys: readonly string[]; rule: string }>> = Object.freeze({
  succeeded: { keys: ["status", "remoteId", "url"], rule: "a succeeded outcome carries only remoteId and url" },
  failed: {
    keys: ["status", "disposition", "retryable", "reason", "retryAfter"],
    rule: "a failed outcome carries only disposition, retryable, reason and retryAfter",
  },
  unknown: { keys: ["status", "disposition", "reason"], rule: "an unknown outcome carries only disposition and reason" },
});

/**
 * A full ISO 8601 date-time: the shape `Date#toISOString` emits, with a `T`
 * separator, seconds and either `Z` or a numeric UTC offset. The shape gate
 * runs first so date-only, locale-ish and prose strings are rejected before the
 * calendar parse proves the fields are real. `retryAfter` is a time an operator
 * is told to wait until, so "nonsense" must never reach a caller.
 */
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isIsoTime(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIME_PATTERN.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

/** Stable failure codes raised by the harness. */
export type ProviderContractErrorCode =
  | "invalid_plugin"
  | "invalid_manifest"
  | "missing_operation"
  | "version_mismatch"
  | "no_cases"
  | "invalid_case"
  | "freeze_threw"
  | "malformed_payload"
  | "mutable_payload"
  | "nondeterministic_freeze"
  | "expected_mismatch"
  | "input_mutated"
  | "incomplete_preview"
  | "content_not_preserved"
  | "auth_material_in_payload"
  | "publish_threw"
  | "malformed_outcome"
  | "unknown_marked_retryable"
  | "credential_leaked"
  | "frozen_payload_mutated"
  | "payload_too_large";

/** Raised when a plugin breaks a contract guarantee. */
export class ProviderContractError extends Error {
  readonly code: ProviderContractErrorCode;
  readonly caseName?: string;

  constructor(code: ProviderContractErrorCode, message: string, caseName?: string) {
    super(caseName === undefined ? message : `[${caseName}] ${message}`);
    this.name = "ProviderContractError";
    this.code = code;
    if (caseName !== undefined) {
      this.caseName = caseName;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function reportPath(path: string): string {
  return path.length > CONTRACT_LIMITS.maxReportedPathLength
    ? `${path.slice(0, CONTRACT_LIMITS.maxReportedPathLength)}...`
    : path;
}

/**
 * Walk a value with a fixed node and depth budget and report every own key.
 * The walk never invokes a getter: own-property descriptors are read.
 */
function scan(
  value: unknown,
  path: string,
  onKey: (key: string, keyPath: string, owner: Record<string, unknown>) => void,
  state: { nodes: number; stack: Set<object> },
  depth = 0,
): void {
  state.nodes += 1;
  if (state.nodes > CONTRACT_LIMITS.maxNodes) {
    throw new ProviderContractError("payload_too_large", `exceeds the ${CONTRACT_LIMITS.maxNodes}-node budget`, path);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ProviderContractError("malformed_payload", "contains a non-finite number", path);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new ProviderContractError("malformed_payload", `contains a ${typeof value} value`, path);
  }
  if (depth > CONTRACT_LIMITS.maxDepth) {
    throw new ProviderContractError(
      "payload_too_large",
      `nested deeper than the ${CONTRACT_LIMITS.maxDepth}-level budget`,
      path,
    );
  }
  // A node that is still on the current path is a cycle. A node reached twice
  // on different paths is a shared reference, which JSON encoders accept.
  if (state.stack.has(value)) {
    throw new ProviderContractError("malformed_payload", "contains a cycle", path);
  }
  state.stack.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      scan(Object.getOwnPropertyDescriptor(value, String(index))?.value, `${path}[${index}]`, onKey, state, depth + 1);
    }
    state.stack.delete(value);
    return;
  }

  if (!isPlainObject(value)) {
    throw new ProviderContractError("malformed_payload", "contains a non-plain object", path);
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new ProviderContractError("malformed_payload", "contains an accessor property", path);
    }
    onKey(key, `${path}.${key}`, value);
    scan(descriptor.value, `${path}.${key}`, onKey, state, depth + 1);
  }
  state.stack.delete(value);
}

/** Recursively freeze a JSON value. Test scaffolding, not a Core facility. */
export function deepFreeze<T>(value: T): T {
  const seen = new Set<object>();
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) {
      return;
    }
    seen.add(node);
    for (const key of Object.getOwnPropertyNames(node)) {
      walk(Object.getOwnPropertyDescriptor(node, key)?.value);
    }
    Object.freeze(node);
  };
  walk(value);
  return value;
}

/** True when every object and array inside a value is frozen. */
export function isDeepFrozen(value: unknown): boolean {
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.pop();
    if (typeof node !== "object" || node === null || seen.has(node)) {
      continue;
    }
    visited += 1;
    if (visited > CONTRACT_LIMITS.maxNodes) {
      return false;
    }
    seen.add(node);
    if (!Object.isFrozen(node)) {
      return false;
    }
    for (const key of Object.getOwnPropertyNames(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (descriptor !== undefined && "value" in descriptor) {
        queue.push(descriptor.value);
      }
    }
  }
  return true;
}

/** Throw unless the value is a well-formed `FrozenProviderPayload`. */
export function validateFrozenProviderPayload(
  payload: unknown,
  label = "frozen payload",
): asserts payload is FrozenProviderPayload {
  if (!isPlainObject(payload)) {
    throw new ProviderContractError("malformed_payload", "expected a plain object", label);
  }
  if (payload.payloadVersion !== 1) {
    throw new ProviderContractError("malformed_payload", "payloadVersion must be 1", label);
  }
  if (!isPlainObject(payload.payload)) {
    throw new ProviderContractError("malformed_payload", "payload must be a plain object", label);
  }
  if (!isPlainObject(payload.effectiveContent)) {
    throw new ProviderContractError("malformed_payload", "effectiveContent must be a plain object", label);
  }
  for (const key of Object.getOwnPropertyNames(payload.effectiveContent)) {
    if (key !== "text") {
      throw new ProviderContractError("malformed_payload", `effectiveContent carries unknown key "${key}"`, label);
    }
    if (typeof payload.effectiveContent.text !== "string") {
      throw new ProviderContractError("malformed_payload", "effectiveContent.text must be a string", label);
    }
  }
  if (!isPlainObject(payload.effectiveOptions)) {
    throw new ProviderContractError("malformed_payload", "effectiveOptions must be a plain object", label);
  }
  if (!isPlainObject(payload.preview)) {
    throw new ProviderContractError("malformed_payload", "preview must be a plain object", label);
  }
  if (!isPlainObject(payload.preview.content)) {
    throw new ProviderContractError("malformed_payload", "preview.content must be a plain object", label);
  }
  if (!Array.isArray(payload.preview.fields)) {
    throw new ProviderContractError("malformed_payload", "preview.fields must be an array", label);
  }

  // One bounded walk over the whole payload: it rejects cycles, accessors,
  // non-finite numbers and values JSON cannot carry, including every preview
  // field value.
  scan(payload, label, () => undefined, { nodes: 0, stack: new Set<object>() });

  const names = new Set<string>();
  for (const field of payload.preview.fields) {
    if (!isPlainObject(field) || typeof field.name !== "string" || field.name.length === 0) {
      throw new ProviderContractError("malformed_payload", "every preview field needs a name", label);
    }
    if (names.has(field.name)) {
      throw new ProviderContractError("malformed_payload", `duplicate preview field "${field.name}"`, label);
    }
    names.add(field.name);
  }
}

/** Throw unless the value is a well-formed `ProviderWriteOutcome`. */
export function validateProviderWriteOutcome(
  outcome: unknown,
  label = "write outcome",
): asserts outcome is ProviderWriteOutcome {
  if (!isPlainObject(outcome)) {
    throw new ProviderContractError("malformed_outcome", "expected a plain object", label);
  }
  const status = outcome.status;

  const variant = typeof status === "string" ? OUTCOME_VARIANTS[status] : undefined;
  if (variant === undefined) {
    throw new ProviderContractError("malformed_outcome", "status must be succeeded, failed or unknown", label);
  }

  // An outcome may carry only the fields its own variant declares. A field from
  // a sibling variant is a shape error, so a caller can never read a
  // `retryable` off `succeeded`, or a `retryAfter` off `unknown`.
  for (const key of Object.getOwnPropertyNames(outcome)) {
    if (!variant.keys.includes(key)) {
      // A retryable `unknown` keeps its dedicated code: it is the one shape the
      // architecture calls out by name, so callers can branch on it.
      if (status === "unknown" && key === "retryable") {
        throw new ProviderContractError(
          "unknown_marked_retryable",
          "an unknown outcome must not carry a retryable flag",
          label,
        );
      }
      throw new ProviderContractError("malformed_outcome", variant.rule, label);
    }
  }

  if (status === "succeeded") {
    if (outcome.remoteId !== undefined && typeof outcome.remoteId !== "string") {
      throw new ProviderContractError("malformed_outcome", "remoteId must be a string", label);
    }
    if (outcome.url !== undefined && typeof outcome.url !== "string") {
      throw new ProviderContractError("malformed_outcome", "url must be a string", label);
    }
    return;
  }

  if (status === "failed") {
    if (outcome.disposition !== "not_applied") {
      throw new ProviderContractError("malformed_outcome", 'failed requires disposition "not_applied"', label);
    }
    if (typeof outcome.retryable !== "boolean") {
      throw new ProviderContractError("malformed_outcome", "failed requires a boolean retryable", label);
    }
    if (typeof outcome.reason !== "string" || !FAILURE_REASONS.has(outcome.reason)) {
      throw new ProviderContractError("malformed_outcome", "failed requires a known failure reason", label);
    }
    if (outcome.retryAfter !== undefined && !isIsoTime(outcome.retryAfter)) {
      throw new ProviderContractError("malformed_outcome", "retryAfter must be an ISO 8601 date-time string", label);
    }
    return;
  }

  if (status === "unknown") {
    if (outcome.disposition !== "unknown") {
      throw new ProviderContractError("malformed_outcome", 'unknown requires disposition "unknown"', label);
    }
    if (typeof outcome.reason !== "string" || !FAILURE_REASONS.has(outcome.reason)) {
      throw new ProviderContractError("malformed_outcome", "unknown requires a known failure reason", label);
    }
    return;
  }

  throw new ProviderContractError("malformed_outcome", "status must be succeeded, failed or unknown", label);
}

/** Every auth-shaped key name found in a value, in scan order. */
export function findAuthKeys(value: unknown): string[] {
  const found: string[] = [];
  scan(
    value,
    "payload",
    (key) => {
      if (AUTH_KEY_PATTERN.test(key)) {
        found.push(key);
      }
    },
    { nodes: 0, stack: new Set<object>() },
  );
  return found;
}

/** A deterministic transport that refuses to send anything. */
export function createRefusingTransport(): ProviderTransport {
  return {
    request(input: ProviderHttpRequest): Promise<ProviderHttpResult> {
      if (input.url.length === 0) {
        throw new ProviderContractError("publish_threw", "a transport request needs a URL");
      }
      return Promise.resolve({ type: "transport_error", stage: "before_request", code: "contract_harness" });
    },
  };
}

type Harness = {
  checks: number;
  fail: (code: ProviderContractErrorCode, message: string, caseName?: string) => never;
  pass: () => void;
};

async function freezeOrFail(
  plugin: ProviderPlugin,
  input: ContractCase["input"],
  harness: Harness,
  caseName: string,
): Promise<FrozenProviderPayload> {
  try {
    return await plugin.freeze(input);
  } catch (error) {
    harness.fail("freeze_threw", `freeze threw: ${(error as Error)?.name ?? "Error"}`, caseName);
  }
}

async function publishOrFail(
  plugin: ProviderPlugin,
  payload: FrozenProviderPayload,
  testCase: ContractCase,
  harness: Harness,
  caseName: string,
): Promise<ProviderWriteOutcome> {
  try {
    return await plugin.publish({
      frozen: payload,
      account: testCase.input.account,
      credentials: contractTestCredentials(),
      submissionId: testCase.input.seed,
      context: {
        now: testCase.input.now,
        signal: new AbortController().signal,
        transport: createRefusingTransport(),
      },
    });
  } catch (error) {
    harness.fail("publish_threw", `publish threw: ${(error as Error)?.name ?? "Error"}`, caseName);
  }
}

function checkPreviewCompleteness(payload: FrozenProviderPayload, testCase: ContractCase, harness: Harness): void {
  const caseName = testCase.name;
  const fieldNames = new Set(payload.preview.fields.map((field) => field.name));

  if (!isDeepStrictEqual(payload.preview.content, payload.effectiveContent)) {
    harness.fail("incomplete_preview", "preview.content must equal effectiveContent", caseName);
  }

  for (const key of Object.getOwnPropertyNames(testCase.input.content)) {
    const value = (testCase.input.content as Record<string, unknown>)[key];
    if (value === undefined) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(payload.effectiveContent, key)) {
      harness.fail("content_not_preserved", `effectiveContent dropped the supplied key "${key}"`, caseName);
    }
  }

  for (const key of Object.getOwnPropertyNames(payload.effectiveOptions)) {
    if (!fieldNames.has(key)) {
      harness.fail("incomplete_preview", `preview does not expose effective option "${key}"`, caseName);
    }
  }

  for (const key of Object.getOwnPropertyNames(testCase.input.options)) {
    if (!Object.prototype.hasOwnProperty.call(payload.effectiveOptions, key)) {
      harness.fail("content_not_preserved", `effectiveOptions dropped the supplied option "${key}"`, caseName);
    }
  }

  // Truncation is judged by coverage, never by the shape of a string: legitimate
  // text may contain an ellipsis, control characters, Unicode or words that look
  // like credentials. `expected` above and the per-option coverage here are the
  // comparison.
}

/**
 * Replay freeze cases and publish shape checks against a plugin.
 *
 * Resolves with the number of checks that ran. Rejects with
 * `ProviderContractError` on the first broken guarantee.
 */
export async function providerContractTests(input: {
  plugin: ProviderPlugin;
  packageVersion: string;
  cases: readonly ContractCase[];
}): Promise<{ checks: number }> {
  const harness: Harness = {
    checks: 0,
    pass() {
      this.checks += 1;
    },
    fail(code, message, caseName) {
      throw new ProviderContractError(code, message, caseName);
    },
  };

  const { plugin, packageVersion, cases } = input;

  if (!isPlainObject(plugin)) {
    harness.fail("invalid_plugin", "expected a plain object");
  }
  try {
    defineProvider(plugin);
  } catch (error) {
    if (error instanceof ProviderDefinitionError) {
      harness.fail(
        error.code === "missing_operation" ? "missing_operation" : "invalid_manifest",
        `${reportPath(error.path)}: ${error.rule}`,
      );
    }
    throw error;
  }
  harness.pass();

  if (plugin.manifest.version !== packageVersion) {
    harness.fail("version_mismatch", "manifest.version must equal the package version under test");
  }
  harness.pass();

  if (cases.length === 0) {
    harness.fail("no_cases", "at least one contract case is required");
  }

  for (const testCase of cases) {
    const caseName = typeof testCase.name === "string" && testCase.name.length > 0 ? testCase.name : "unnamed case";
    if (typeof testCase.name !== "string" || testCase.name.length === 0) {
      harness.fail("invalid_case", "every case needs a name", caseName);
    }
    for (const key of Object.getOwnPropertyNames(testCase.input.content)) {
      if (key !== "text") {
        harness.fail("invalid_case", `case content carries unsupported key "${key}"`, caseName);
      }
    }

    let snapshot: ContractCase["input"];
    try {
      snapshot = structuredClone(testCase.input);
    } catch (error) {
      harness.fail("invalid_case", `case input is not cloneable: ${(error as Error)?.name ?? "Error"}`, caseName);
    }

    const payload = await freezeOrFail(plugin, testCase.input, harness, caseName);

    validateFrozenProviderPayload(payload, caseName);
    harness.pass();

    if (!isDeepFrozen(payload)) {
      harness.fail("mutable_payload", "freeze output must be deeply frozen", caseName);
    }
    harness.pass();

    if (findAuthKeys(payload).length > 0) {
      harness.fail("auth_material_in_payload", "a frozen payload must not carry auth-shaped keys", caseName);
    }
    harness.pass();

    // Structural guarantees are checked before the fixture expectation, so a
    // provider that mutates its input or hides an option is reported as such
    // rather than as a mismatch against a recorded snapshot.
    if (!isDeepStrictEqual(snapshot, testCase.input)) {
      harness.fail("input_mutated", "freeze must not change the input it was given", caseName);
    }
    harness.pass();

    checkPreviewCompleteness(payload, testCase, harness);
    harness.pass();

    const replay = await freezeOrFail(plugin, testCase.input, harness, caseName);
    if (!isDeepStrictEqual(payload, replay)) {
      harness.fail("nondeterministic_freeze", "two freeze calls with the same input must be deeply equal", caseName);
    }
    harness.pass();

    if (!isDeepStrictEqual(payload, testCase.expected)) {
      harness.fail("expected_mismatch", "frozen payload differs from the case expectation", caseName);
    }
    harness.pass();

    const frozenSnapshot = structuredClone(payload);
    const outcome = await publishOrFail(plugin, payload, testCase, harness, caseName);

    validateProviderWriteOutcome(outcome, caseName);
    harness.pass();

    if (JSON.stringify(outcome).includes(CONTRACT_TEST_CREDENTIAL_CANARY)) {
      harness.fail("credential_leaked", "a publish outcome must not echo credentials", caseName);
    }
    harness.pass();

    if (!isDeepStrictEqual(frozenSnapshot, payload)) {
      harness.fail("frozen_payload_mutated", "publish must not change the frozen payload", caseName);
    }
    harness.pass();
  }

  return { checks: harness.checks };
}
