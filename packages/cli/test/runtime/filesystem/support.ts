import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type * as T from "@syndroo/core";

import { FilesystemCredentials } from "../../../src/runtime/filesystem/credentials.js";
import type { FaultInjector } from "../../../src/runtime/filesystem/database.js";
import { FilesystemState } from "../../../src/runtime/filesystem/state.js";

/** Deterministic clock for fixtures, so journals and commits are stable. */
export const FIXED_NOW = "2026-10-08T00:00:00.000Z";

/**
 * A private temporary state root.
 *
 * `realpath` is applied so the macOS `/var` -> `/private/var` system alias does
 * not become part of the test's own expectations.
 */
export async function makeRoot(): Promise<string> {
  return await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "syndroo-fs-")),
  );
}

export type Fixture = {
  readonly state: FilesystemState;
  readonly credentials: FilesystemCredentials;
};

export function fixtureAt(root: string, fault?: FaultInjector): Fixture {
  const now = (): string => FIXED_NOW;

  return {
    state: new FilesystemState(
      fault ? { root, now, fault } : { root, now },
    ),
    credentials: new FilesystemCredentials(
      fault ? { root, now, fault } : { root, now },
    ),
  };
}

/** Returns the rejection so a test can inspect its code, message and stack. */
export async function rejectionOf(
  promise: Promise<unknown>,
): Promise<Error & { code?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: string };
  }

  throw new Error("expected the call to reject");
}

export const ACCOUNT: T.AccountIdentity = {
  provider: "fake",
  accountId: "alice",
  origin: "https://social.example",
};

export const IMPLEMENTATION: T.Implementation = {
  provider: "fake",
  packageName: "fake",
  version: "0.7.0-rc.1",
  apiVersion: 1,
  artifactFingerprint: "artifact",
  schemaFingerprint: "schema",
};

export type ConnectedFixture = {
  readonly connection: T.ConnectionRecord;
  readonly stage: T.SecretStage;
};

export type StartedConnect = {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly claim: T.StepClaim;
};

/** Reserves a connect session and claims its first step. */
export async function startConnect(
  fixture: Fixture,
  suffix = "one",
  now: string = FIXED_NOW,
): Promise<StartedConnect> {
  const sessionId = `cs_${suffix}`;
  const connectionId = `conn_${suffix}`;

  await fixture.state.reserveConnect({
    request: {
      principalId: "owner",
      family: "connect",
      key: `connect_${suffix}`,
      digest: `connect_${suffix}`,
    },
    session: {
      sessionId,
      principalId: "owner",
      provider: "fake",
      implementation: IMPLEMENTATION,
      stepRevision: 0,
      expiresAt: "2026-10-08T00:15:00.000Z",
      connectionId,
      baselineRevision: null,
      status: "awaiting",
    },
    now,
  });

  const claimed = await fixture.state.claimConnectStep({
    sessionId,
    principalId: "owner",
    stepRevision: 0,
    inputDigest: "input",
    claimId: `step_${suffix}`,
    now,
  });

  if (claimed.type !== "claimed") {
    throw new Error("expected the first connect step to be claimed");
  }

  return { sessionId, connectionId, claim: claimed.claim };
}

export function connectionRecord(
  connectionId: string,
  secretRef: T.SecretRef,
  suffix = "one",
): T.ConnectionRecord {
  return {
    connectionId,
    account: { ...ACCOUNT, accountId: suffix === "one" ? "alice" : "bob" },
    active: true,
    isDefault: suffix === "one",
    revision: 1,
    bindingRevision: 1,
    credentialRevision: 1,
    secretRef,
    observations: [],
  };
}

/**
 * Drives one connect session to a committed connection, mirroring the shared
 * contract fixture so adapter-specific tests exercise the same records.
 */
export async function connected(
  fixture: Fixture,
  suffix = "one",
  now: string = FIXED_NOW,
): Promise<ConnectedFixture> {
  const { connectionId, claim } = await startConnect(fixture, suffix, now);
  const stage = await fixture.credentials.put({
    creationId: `credential_${suffix}`,
    owner: { kind: "credential", ownerId: connectionId, version: 1 },
    value: { token: "fixture-only" },
  });
  const connection = connectionRecord(connectionId, stage.ref, suffix);
  const committed = await fixture.state.commitConnection({
    claim,
    expectedConnectionRevision: null,
    connection,
    stagedCredential: stage,
    now,
  });

  if (committed.type !== "applied") {
    throw new Error("expected the connection commit to apply");
  }

  return { connection, stage };
}

/** Every file below the state root, with its mode and bytes. */
export async function tree(
  directory: string,
): Promise<{ path: string; mode: number; text: string }[]> {
  const found: { path: string; mode: number; text: string }[] = [];

  async function walk(current: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await walk(next);

        continue;
      }

      const stat = await fs.lstat(next);

      found.push({
        path: next,
        mode: stat.mode & 0o777,
        text: await fs.readFile(next, "utf8"),
      });
    }
  }

  await walk(directory);

  return found.sort((left, right) => left.path.localeCompare(right.path));
}
