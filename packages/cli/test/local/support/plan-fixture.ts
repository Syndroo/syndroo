import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  LocalProvider,
  LocalProviderDescription,
  LocalProviderId,
  ProviderOutcome,
} from "@syndroo/core";

import {
  parseLocalPublishDocument,
  type LocalPublishDocument,
} from "../../../src/local/document.js";
import type {
  ConnectionRecord,
  LocalPlan,
  LocalStore,
} from "../../../src/local/ports/local-store.js";
import { createLocalFileStore } from "../../../src/local/state/store.js";

/**
 * Fixtures for the offline plan tests.
 *
 * The store is the real file store; only the providers are doubles, because a
 * plan must never reach a provider beyond pure `freeze` validation.
 */

export const START_TIME = "2026-09-24T00:00:00.000Z";

export const DAY_MS = 24 * 60 * 60 * 1_000;

export interface TestClock {
  readonly now: () => Date;
  set(iso: string): void;
  advance(ms: number): void;
}

export function testClock(startIso: string = START_TIME): TestClock {
  let current = startIso;

  return {
    now: () => new Date(current),
    set: iso => {
      current = iso;
    },
    advance: ms => {
      current = new Date(Date.parse(current) + ms).toISOString();
    },
  };
}

export interface StateFixture {
  readonly stateHome: string;
  readonly store: LocalStore;
  readonly clock: TestClock;
  cleanup(): void;
}

/** One initialized state home, on a clock both the store and the plan share. */
export async function openState(
  clock: TestClock = testClock(),
): Promise<StateFixture> {
  const stateHome = mkdtempSync(path.join(tmpdir(), "syndroo-plan-"));
  const store = createLocalFileStore(stateHome, { now: clock.now });

  await store.initialize();

  return {
    stateHome,
    store,
    clock,
    cleanup: () => {
      rmSync(stateHome, { recursive: true, force: true });
    },
  };
}

export function documentOf(
  fields: {
    readonly key?: string;
    readonly content?: string;
    readonly platforms?: readonly LocalProviderId[];
    readonly overrides?: Readonly<Record<string, { content: string }>>;
  } = {},
): LocalPublishDocument {
  return parseLocalPublishDocument(
    JSON.stringify({
      schemaVersion: 1,
      key: fields.key ?? "syndroo-t05-001",
      content: fields.content ?? "hello from the local plan",
      platforms: fields.platforms ?? ["bluesky"],
      ...(fields.overrides === undefined ? {} : { overrides: fields.overrides }),
    }),
  );
}

export interface ConnectionSeed {
  readonly provider: LocalProviderId;
  readonly targetId?: string;
  readonly connectionId?: string;
  readonly bindingRevision?: number;
  readonly removed?: boolean;
  readonly expectedRevision?: number | null;
}

/**
 * A registered account whose credential source is a file that does not exist.
 * A preview that read a credential source would fail loudly here.
 */
export function connectionRecord(seed: ConnectionSeed): ConnectionRecord {
  const provider = seed.provider;

  return {
    schemaVersion: 1,
    target: {
      provider,
      targetId:
        seed.targetId ??
        (provider === "bluesky" ? "did:plc:fixturealice" : "threads-fixture"),
      connectionId: seed.connectionId ?? `conn_${"a".repeat(32)}`,
      bindingRevision: seed.bindingRevision ?? 1,
    },
    source: {
      kind: "file",
      provider,
      path: "/nonexistent/credential-source.json",
    },
    fingerprint: "b".repeat(64),
    removed: seed.removed ?? false,
  };
}

export async function seedConnection(
  store: LocalStore,
  seed: ConnectionSeed,
): Promise<void> {
  await store.putConnection(connectionRecord(seed), seed.expectedRevision ?? null);
}

export interface StaticProviderOptions {
  /** `false` models a provider whose payload carries no business timestamp. */
  readonly withBusinessTime?: boolean;
  readonly payloadVersion?: number;
  readonly extraPayload?: Readonly<Record<string, unknown>>;
}

export interface StaticProvider {
  readonly provider: LocalProvider;
  readonly calls: {
    freeze: number;
    prepare: number;
    verifyIdentity: number;
  };
}

export function staticProvider(
  provider: LocalProviderId,
  options: StaticProviderOptions = {},
): StaticProvider {
  const calls = { freeze: 0, prepare: 0, verifyIdentity: 0 };

  return {
    calls,
    provider: {
      provider,
      describe: (): LocalProviderDescription => ({
        provider,
        maturity: "fixture-tested",
        localPublish: true,
        unavailableReason: null,
      }),
      freeze: (content, createdAt) => {
        calls.freeze++;

        return {
          payloadVersion: options.payloadVersion ?? 1,
          payload: {
            text: content,
            ...(options.withBusinessTime === false ? {} : { createdAt }),
            ...options.extraPayload,
          },
        };
      },
      verifyIdentity: async () => {
        calls.verifyIdentity++;
        throw new Error("a preview must not verify an identity");
      },
      prepare: async () => {
        calls.prepare++;
        throw new Error("a preview must not prepare a session");
      },
    },
  };
}

export interface ProviderSet {
  readonly providers: Readonly<Record<LocalProviderId, LocalProvider>>;
  readonly calls: Readonly<
    Record<
      LocalProviderId,
      { readonly freeze: number; readonly prepare: number; readonly verifyIdentity: number }
    >
  >;
}

export function providerSet(
  overrides: Partial<Record<LocalProviderId, StaticProvider>> = {},
): ProviderSet {
  const bluesky = overrides.bluesky ?? staticProvider("bluesky");
  const threads = overrides.threads ?? staticProvider("threads");

  return {
    providers: { bluesky: bluesky.provider, threads: threads.provider },
    calls: { bluesky: bluesky.calls, threads: threads.calls },
  };
}

/** Admits the plan, takes one attempt, and commits the outcome. */
export async function deliverOutcome(
  store: LocalStore,
  plan: LocalPlan,
  outcome: ProviderOutcome,
): Promise<void> {
  const item = plan.items[0];

  if (item === undefined) {
    throw new Error("the fixture plan has no items");
  }

  const operation = await store.reserveOperation(plan);
  const attempt = await store.beginAttempt(
    operation.operationId,
    item.delivery.deliveryId,
    item.delivery.target,
  );

  await store.commitOutcome(
    operation.operationId,
    item.delivery.deliveryId,
    attempt,
    outcome,
  );
}

export function succeededOutcome(remoteId = "at://did:plc:fixturealice/1"): ProviderOutcome {
  return { kind: "succeeded", remoteId, url: null };
}

export function failedOutcome(): ProviderOutcome {
  return {
    kind: "failed",
    code: "INVALID_CONTENT",
    writeDisposition: "not_applied",
    retryable: false,
    retryNotBefore: null,
  };
}

export function unknownOutcome(): ProviderOutcome {
  return { kind: "unknown", code: "OUTCOME_UNKNOWN", writeDisposition: "unknown" };
}

export function planFilePath(stateHome: string, planId: string): string {
  return path.join(stateHome, "plans", `${planId}.json`);
}

/**
 * Every file under the state root, with its size and content hash, so a test
 * can prove that a refused preview wrote nothing at all.
 */
export function stateSnapshot(stateHome: string): readonly string[] {
  const lines: string[] = [];

  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        lines.push(`${relative}/`);
        walk(absolute, relative);
        continue;
      }

      const bytes = readFileSync(absolute);

      lines.push(
        `${relative}:${bytes.byteLength}:${createHash("sha256").update(bytes).digest("hex")}`,
      );
    }
  };

  walk(stateHome, "");

  return lines.sort();
}
