import { createHmac } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  LocalProviderError,
  type LocalCredentials,
  type LocalProvider,
  type LocalProviderDescription,
  type LocalProviderId,
  type PreparedTarget,
  type TargetBinding,
} from "@syndroo/core";

import { CliError } from "../../src/cli-error.js";
import { EXIT_CODE } from "../../src/exit-codes.js";
import type {
  ConnectionRecord,
  LocalStore,
} from "../../src/local/ports/local-store.js";

/**
 * Obviously fake material: no real account, no real secret.
 *
 * Tests assert on these with `includes(...) === false` so a failing assertion
 * prints a boolean instead of the value.
 */
export const FAKE_BLUESKY_IDENTIFIER = "fake-handle.bsky.social";
export const FAKE_BLUESKY_PASSWORD = "fake-app-password-00000000";
export const FAKE_THREADS_TOKEN = "fake-threads-access-token-00000000";
export const FAKE_INSTALLATION_KEY = "fake-installation-key-for-tests";

/** A strict credential file body; only the named pieces are replaced. */
export function blueskyCredentialBody(
  credentials: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: "bluesky",
    credentials: {
      identifier: FAKE_BLUESKY_IDENTIFIER,
      password: FAKE_BLUESKY_PASSWORD,
      ...credentials,
    },
  };
}

export function threadsCredentialBody(
  credentials: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: "threads",
    credentials: { accessToken: FAKE_THREADS_TOKEN, ...credentials },
  };
}

/** Writes a credential file with an exact mode, bypassing umask. */
export async function writeCredentialFile(
  directory: string,
  name: string,
  text: string,
  mode = 0o600,
): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, text, { mode });
  await chmod(path, mode);
  return path;
}

/**
 * A local store stand-in for T04.
 *
 * Only the connection slot and `authenticate` are real: the rest of the port
 * throws, so a credential/auth path that starts touching plans, deliveries, or
 * operations fails loudly instead of silently passing.
 *
 * `auditDir` mirrors every persisted connection to disk, so a test can scan
 * the whole "state" for a secret that must never be stored.
 */
export class FakeLocalStore implements LocalStore {
  readonly connections = new Map<LocalProviderId, ConnectionRecord>();
  readonly putConnectionCalls: Array<{
    record: ConnectionRecord;
    expectedRevision: number | null;
  }> = [];
  readonly installationKey: string;
  readonly auditDir: string | null;
  /** Runs inside `putConnection` before the revision check (simulates a race). */
  beforePutConnection: (() => Promise<void> | void) | null = null;

  constructor(options: { auditDir?: string; installationKey?: string } = {}) {
    this.auditDir = options.auditDir ?? null;
    this.installationKey = options.installationKey ?? FAKE_INSTALLATION_KEY;
  }

  get writes(): number {
    return this.putConnectionCalls.length;
  }

  async authenticate(value: string): Promise<string> {
    return createHmac("sha256", this.installationKey)
      .update(value)
      .digest("hex");
  }

  async getConnection(
    provider: LocalProviderId,
  ): Promise<ConnectionRecord | null> {
    return this.connections.get(provider) ?? null;
  }

  async putConnection(
    record: ConnectionRecord,
    expectedRevision: number | null,
  ): Promise<void> {
    this.putConnectionCalls.push({ record, expectedRevision });

    if (this.beforePutConnection !== null) {
      await this.beforePutConnection();
    }

    const current = this.connections.get(record.target.provider) ?? null;
    const currentRevision =
      current === null ? null : current.target.bindingRevision;

    if (currentRevision !== expectedRevision) {
      throw new CliError(
        "STATE_BUSY: the local binding changed while this command was running",
        { code: "STATE_BUSY", exitCode: EXIT_CODE.USAGE },
      );
    }

    this.connections.set(record.target.provider, record);
    await this.persistAudit();
  }

  private async persistAudit(): Promise<void> {
    if (this.auditDir === null) {
      return;
    }

    await mkdir(this.auditDir, { recursive: true });
    await writeFile(
      join(this.auditDir, "connections.json"),
      JSON.stringify({ connections: [...this.connections.values()] }, null, 2),
      { mode: 0o600 },
    );
  }

  async initialize(): Promise<void> {
    throw new Error("FakeLocalStore.initialize is not used by T04");
  }

  async getInstallation(): Promise<{ schemaVersion: 1; installationId: string }> {
    throw new Error("FakeLocalStore.getInstallation is not used by T04");
  }

  async getPlan(): Promise<never> {
    throw new Error("FakeLocalStore.getPlan is not used by T04");
  }

  async putPlan(): Promise<never> {
    throw new Error("FakeLocalStore.putPlan is not used by T04");
  }

  async getDelivery(): Promise<never> {
    throw new Error("FakeLocalStore.getDelivery is not used by T04");
  }

  async getOperation(): Promise<never> {
    throw new Error("FakeLocalStore.getOperation is not used by T04");
  }

  async listOperations(): Promise<never> {
    throw new Error("FakeLocalStore.listOperations is not used by T04");
  }

  async operationIdFor(): Promise<never> {
    throw new Error("FakeLocalStore.operationIdFor is not used by T04");
  }

  async reserveOperation(): Promise<never> {
    throw new Error("FakeLocalStore.reserveOperation is not used by T04");
  }

  async beginAttempt(): Promise<never> {
    throw new Error("FakeLocalStore.beginAttempt is not used by T04");
  }

  async commitOutcome(): Promise<never> {
    throw new Error("FakeLocalStore.commitOutcome is not used by T04");
  }

  async markInterrupted(): Promise<never> {
    throw new Error("FakeLocalStore.markInterrupted is not used by T04");
  }
}

/** A provider whose identity lookup is scripted and recorded. */
export class FakeLocalProvider implements LocalProvider {
  readonly provider: LocalProviderId;
  targetId: string;
  failure: LocalProviderError | null = null;
  readonly verifyIdentityCalls: LocalCredentials[] = [];
  readonly prepareCalls: TargetBinding[] = [];

  constructor(provider: LocalProviderId, targetId: string) {
    this.provider = provider;
    this.targetId = targetId;
  }

  describe(): LocalProviderDescription {
    return {
      provider: this.provider,
      maturity: "fixture-tested",
      localPublish: true,
      unavailableReason: null,
    };
  }

  freeze(): {
    payloadVersion: number;
    payload: Readonly<Record<string, unknown>>;
  } {
    return { payloadVersion: 1, payload: { text: "not used by T04" } };
  }

  async verifyIdentity(
    credentials: LocalCredentials,
    _signal: AbortSignal,
  ): Promise<{ targetId: string }> {
    this.verifyIdentityCalls.push(credentials);

    if (this.failure !== null) {
      throw this.failure;
    }

    return { targetId: this.targetId };
  }

  async prepare(
    _credentials: LocalCredentials,
    target: TargetBinding,
  ): Promise<PreparedTarget> {
    this.prepareCalls.push(target);
    throw new Error("FakeLocalProvider.prepare is not used by T04");
  }
}
