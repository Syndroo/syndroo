import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  LocalProviderError,
  type FrozenDelivery,
  type LocalProvider,
  type LocalProviderDescription,
  type LocalProviderId,
  type LocalProviderErrorCode,
  type ProviderOutcome,
  type TargetBinding,
} from "@syndroo/core";

import type { CredentialResolver } from "../../../src/local/execute.js";
import { planLocalPublish } from "../../../src/local/plan.js";
import type {
  LocalPlan,
  LocalStore,
} from "../../../src/local/ports/local-store.js";
import {
  createLocalFileStore,
  type FaultInjector,
} from "../../../src/local/state/store.js";
import {
  documentOf,
  seedConnection,
  testClock,
  type TestClock,
} from "./plan-fixture.js";

/**
 * Fixtures for the execution and retry tests.
 *
 * The store is the real file store on a disposable state home; only the
 * providers are doubles, because a plan must never reach a provider beyond the
 * one `publish` call per target that these tests count.
 */

export const NAMESPACE = "default";
export const BLUESKY_TARGET = "did:plc:fixturealice";
export const THREADS_TARGET = "threads-fixture";

export type ScriptedStep =
  | ProviderOutcome
  | Error
  | ((
      delivery: FrozenDelivery,
      signal: AbortSignal,
    ) => ProviderOutcome | Promise<ProviderOutcome>);

export interface ScriptedProvider {
  readonly provider: LocalProvider;
  readonly calls: {
    freeze: number;
    prepare: number;
    publish: number;
    verifyIdentity: number;
  };
  /** Delivery ids, in dispatch order. */
  readonly publishedIds: string[];
  /** Bindings handed to `prepare`, in call order. */
  readonly preparedTargets: TargetBinding[];
  queue(...steps: readonly ScriptedStep[]): void;
}

export function scriptedProvider(
  providerId: LocalProviderId,
  events: string[] = [],
  options: {
    /** A provider whose payload shape moved on from the frozen plan. */
    readonly payloadVersion?: number;
    /** A provider that refuses to prepare a session at all. */
    readonly prepareError?: LocalProviderErrorCode;
    /** A provider whose session lookup only ends when the signal does. */
    readonly prepareHangs?: boolean;
    /** A provider that answers with a target even after the signal ended. */
    readonly prepareIgnoresSignal?: boolean;
  } = {},
): ScriptedProvider {
  const steps: ScriptedStep[] = [];
  const calls = { freeze: 0, prepare: 0, publish: 0, verifyIdentity: 0 };
  const publishedIds: string[] = [];
  const preparedTargets: TargetBinding[] = [];

  return {
    calls,
    publishedIds,
    preparedTargets,
    queue: (...items) => {
      steps.push(...items);
    },
    provider: {
      provider: providerId,
      describe: (): LocalProviderDescription => ({
        provider: providerId,
        maturity: "fixture-tested",
        localPublish: true,
        unavailableReason: null,
      }),
      freeze: (content, createdAt) => {
        calls.freeze++;

        return {
          payloadVersion: options.payloadVersion ?? 1,
          payload: { text: content, createdAt },
        };
      },
      verifyIdentity: async () => {
        calls.verifyIdentity++;
        throw new Error("execution must not verify an identity separately");
      },
      prepare: async (credentials, target, signal) => {
        calls.prepare++;
        events.push(`prepare:${providerId}`);

        if (options.prepareIgnoresSignal === true) {
          return {
            target: { ...target },
            publish: async () => {
              throw new Error("the signal-ignoring provider never publishes");
            },
          };
        }

        if (options.prepareHangs === true) {
          await new Promise<void>(resolve => {
            if (signal.aborted) {
              resolve();
              return;
            }

            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new LocalProviderError("ABORTED");
        }

        if (options.prepareError !== undefined) {
          throw new LocalProviderError(options.prepareError);
        }

        if (signal.aborted) {
          throw new LocalProviderError("ABORTED");
        }

        if (credentials.provider !== providerId) {
          throw new LocalProviderError("ACCOUNT_MISMATCH");
        }

        preparedTargets.push({ ...target });

        return {
          target: { ...target },
          publish: async (delivery, publishSignal) => {
            calls.publish++;
            publishedIds.push(delivery.deliveryId);
            events.push(`content:${providerId}`);

            const step = steps.shift();

            if (step === undefined) {
              throw new Error("no scripted publish step");
            }

            if (step instanceof Error) {
              throw step;
            }

            if (typeof step === "function") {
              return await step(delivery, publishSignal);
            }

            return step;
          },
        };
      },
    },
  };
}

export function succeeded(remoteId = "at://fixture/1"): ProviderOutcome {
  return { kind: "succeeded", remoteId, url: null };
}

export function notApplied(
  options: { readonly retryable?: boolean; readonly retryNotBefore?: string | null } = {},
): ProviderOutcome {
  return {
    kind: "failed",
    code: "RATE_LIMITED",
    writeDisposition: "not_applied",
    retryable: options.retryable ?? true,
    retryNotBefore: options.retryNotBefore ?? null,
  };
}

export function permanentFailure(): ProviderOutcome {
  return {
    kind: "failed",
    code: "INVALID_CONTENT",
    writeDisposition: "not_applied",
    retryable: false,
    retryNotBefore: null,
  };
}

export function unknownOutcome(): ProviderOutcome {
  return { kind: "unknown", code: "TIMEOUT", writeDisposition: "unknown" };
}

/** Reports an unknown outcome only once the signal ends. */
export function unknownWhenAborted(): ScriptedStep {
  return (_delivery, signal) =>
    new Promise(resolve => {
      const finish = (): void => {
        resolve({ kind: "unknown", code: "ABORTED", writeDisposition: "unknown" });
      };

      if (signal.aborted) {
        finish();
        return;
      }

      signal.addEventListener("abort", finish, { once: true });
    });
}

/** Reports success only once the signal ends; used to model a late answer. */
export function successWhenAborted(remoteId = "at://fixture/late"): ScriptedStep {
  return (_delivery, signal) =>
    new Promise(resolve => {
      const finish = (): void => {
        resolve(succeeded(remoteId));
      };

      if (signal.aborted) {
        finish();
        return;
      }

      signal.addEventListener("abort", finish, { once: true });
    });
}

export interface ExecutionFixture {
  readonly stateHome: string;
  readonly clock: TestClock;
  /** The raw store, for on-disk assertions and for building plans. */
  readonly store: LocalStore;
  /** The store handed to the use case, with every call recorded in `events`. */
  readonly instrumented: LocalStore;
  readonly events: string[];
  readonly bluesky: ScriptedProvider;
  readonly threads: ScriptedProvider;
  readonly providers: Readonly<Record<LocalProviderId, LocalProvider>>;
  readonly resolveCredentials: CredentialResolver;
  /** Providers whose credential source was resolved, in call order. */
  readonly resolved: string[];
  publishPlan(
    fields?: Parameters<typeof documentOf>[0],
  ): Promise<LocalPlan>;
  cleanup(): void;
}

export interface ExecutionFixtureOptions {
  readonly fault?: FaultInjector;
  readonly clock?: TestClock;
}

export async function openExecution(
  options: ExecutionFixtureOptions = {},
): Promise<ExecutionFixture> {
  const clock = options.clock ?? testClock();
  const stateHome = mkdtempSync(path.join(tmpdir(), "syndroo-exec-"));
  const store = createLocalFileStore(stateHome, {
    now: clock.now,
    ...(options.fault === undefined ? {} : { fault: options.fault }),
  });

  await store.initialize();
  await seedConnection(store, { provider: "bluesky", targetId: BLUESKY_TARGET });
  await seedConnection(store, { provider: "threads", targetId: THREADS_TARGET });

  const events: string[] = [];
  const bluesky = scriptedProvider("bluesky", events);
  const threads = scriptedProvider("threads", events);
  const providers = {
    bluesky: bluesky.provider,
    threads: threads.provider,
  };
  const resolved: string[] = [];
  const resolveCredentials: CredentialResolver = async connection => {
    const provider = connection.target.provider;
    resolved.push(provider);
    events.push(`credentials:${provider}`);

    return provider === "bluesky"
      ? {
          provider: "bluesky",
          identifier: "fixture-handle",
          password: "fixture-password",
          host: "bsky.social",
        }
      : { provider: "threads", accessToken: "fixture-token" };
  };

  return {
    stateHome,
    clock,
    store,
    instrumented: instrument(store, events),
    events,
    bluesky,
    threads,
    providers,
    resolveCredentials,
    resolved,
    publishPlan: fields =>
      planLocalPublish(documentOf(fields), {
        store,
        providers,
        namespace: NAMESPACE,
        now: clock.now,
      }),
    cleanup: () => {
      rmSync(stateHome, { recursive: true, force: true });
    },
  };
}

/**
 * Records the order of the durable steps around the provider call.
 *
 * `admission` is pushed after `reserveOperation` resolves `ready`, `intent`
 * after `beginAttempt` persists the in-flight record, and `content` from the
 * provider itself, so the three can be compared directly.
 */
export function instrument(store: LocalStore, events: string[]): LocalStore {
  return {
    ...store,
    getConnection: async provider => {
      events.push(`connection:${provider}`);
      return store.getConnection(provider);
    },
    reserveOperation: async plan => {
      const operation = await store.reserveOperation(plan);
      events.push(`admission:${operation.admissionState}`);
      return operation;
    },
    beginAttempt: async (operationId, deliveryId, target) => {
      const attempt = await store.beginAttempt(operationId, deliveryId, target);
      events.push(`intent:${deliveryId}`);
      return attempt;
    },
    commitOutcome: async (operationId, deliveryId, attempt, outcome) => {
      await store.commitOutcome(operationId, deliveryId, attempt, outcome);
      events.push(`outcome:${deliveryId}`);
    },
    markInterrupted: async operationId => {
      await store.markInterrupted(operationId);
      events.push("interrupted");
    },
  };
}

/** Polls a synchronous predicate until it holds, or fails the test. */
export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }

    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
