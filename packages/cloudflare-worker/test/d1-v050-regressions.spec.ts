import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { CorruptStoreRecordError, StoreUnavailable } from "@syndroo/application";
import {
  FIXTURE_NOW,
  createTransaction,
  instant,
  testEnvelope,
} from "@syndroo/application/testing";

import { D1Repository } from "../src/infrastructure/d1/repository.js";
import { createD1Harness } from "./support/d1-v050-support.js";

const SENTINEL = "sentinel-secret-value-abc123";

/** Every outward error must be fixed, cause-free and free of raw text. */
function assertSanitized(error: unknown): void {
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || depth > 5 || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (value instanceof Error) {
      expect(value).toBeInstanceOf(StoreUnavailable);
      expect(value.message).not.toContain(SENTINEL);
      expect(value.message).not.toMatch(/SELECT|UPDATE|INSERT|DELETE/i);
      expect((value as { cause?: unknown }).cause).toBeUndefined();
    }
  };
  walk(error, 0);
}

function throwingBatchDb(inner: D1Database): D1Database {
  return new Proxy(inner, {
    get(target, key) {
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await target.batch(statements);
          throw new Error(`injected failure ${SENTINEL} SELECT * FROM credentials`);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

function readFailDb(inner: D1Database): D1Database {
  return new Proxy(inner, {
    get(target, key) {
      if (key === "prepare") {
        return () => {
          throw new Error(`injected read failure ${SENTINEL} bound-param`);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

/** Runs the real batch, then lets the test install a concurrent replacement. */
function afterCommitDb(inner: D1Database, hook: () => Promise<void>): D1Database {
  return new Proxy(inner, {
    get(target, key) {
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          await hook();
          return results;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

/** Mutates state between a pre-read and the guarded batch. */
function beforeBatchDb(inner: D1Database, hook: () => Promise<void>): D1Database {
  return new Proxy(inner, {
    get(target, key) {
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await hook();
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

describe("D1 0.5.0 regressions", () => {
  beforeEach(async () => {
    await createD1Harness().reset();
  });

  it("never leaks raw D1 text, parameters or causes to callers", async () => {
    const harness = createD1Harness();
    await harness.publishing.createPostWithDispatch(createTransaction());

    const writeRepository = new D1Repository(throwingBatchDb(env.DB));
    await expect(
      writeRepository.claimExecution({
        jobId: "job_0001",
        publicationId: "pub_0001",
        attemptNo: 1,
        now: FIXTURE_NOW,
        credentialSlotRevision: 0,
        claimToken: "claim_0001",
        attemptId: "attempt_0001",
      }),
    ).resolves.toMatchObject({ kind: "unknown" });

    const readRepository = new D1Repository(readFailDb(env.DB));
    let readError: unknown;
    try {
      await readRepository.readSlot({ platform: "x" });
    } catch (error) {
      readError = error;
    }
    expect(readError).toBeInstanceOf(StoreUnavailable);
    assertSanitized(readError);

    let createResult: { readonly kind: string } | undefined;
    let createError: unknown;
    try {
      createResult = await writeRepository.createPostWithDispatch(
        createTransaction({
          key: "create-key-9999",
          postId: "post_9999",
          publicationIds: ["pub_9999"],
          jobIds: ["job_9999"],
        }),
      );
    } catch (error) {
      createError = error;
    }
    // The batch committed before the acknowledgement was lost, so the committed
    // write is discovered and reported as a replay: no raw error escapes and no
    // duplicate row appears.
    if (createError !== undefined) {
      expect(createError).toBeInstanceOf(StoreUnavailable);
      assertSanitized(createError);
    } else {
      expect(["created", "replayed"]).toContain(createResult?.kind);
    }
    const committed = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM posts WHERE id = 'post_9999'",
    ).first<{ count: number }>();
    expect(committed?.count).toBe(1);
  });

  it("treats a malformed active envelope as corruption, never an empty slot", async () => {
    const harness = createD1Harness();
    await env.DB.prepare(
      `INSERT INTO credentials (platform, data, created_at, updated_at, revision, tombstone, envelope)
       VALUES ('x', '{}', ?, ?, 1, 0, '{"version":1,')`,
    )
      .bind(FIXTURE_NOW, FIXTURE_NOW)
      .run();
    await expect(harness.credentials.readSlot({ platform: "x" })).rejects.toBeInstanceOf(
      CorruptStoreRecordError,
    );
  });

  it("refuses to treat unmigrated active plaintext as an absent slot", async () => {
    const harness = createD1Harness();
    await env.DB.prepare(
      `INSERT INTO credentials (platform, data, created_at, updated_at, revision, tombstone)
       VALUES ('x', ?, ?, ?, 1, 0)`,
    )
      .bind(`{"access_token":"${SENTINEL}"}`, FIXTURE_NOW, FIXTURE_NOW)
      .run();
    let error: unknown;
    try {
      await harness.credentials.readSlot({ platform: "x" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CorruptStoreRecordError);
    expect((error as Error).message).not.toContain(SENTINEL);
  });

  it("does not coerce an unsupported persisted job protocol", async () => {
    const harness = createD1Harness();
    await harness.publishing.createPostWithDispatch(createTransaction());
    await env.DB.prepare(
      `INSERT INTO outbox_jobs (id, kind, payload_version, aggregate_id, attempt_no, available_at, status, created_at, updated_at)
       VALUES ('job_future', 'delivery.other', 2, 'pub_0001', 1, ?, 'pending', ?, ?)`,
    )
      .bind(FIXTURE_NOW, FIXTURE_NOW, FIXTURE_NOW)
      .run();
    await expect(
      harness.publishing.getExecution({ jobId: "job_future", publicationId: "pub_0001" }),
    ).rejects.toBeInstanceOf(CorruptStoreRecordError);
    const ready = await harness.outbox.listReady({ now: FIXTURE_NOW, limit: 10 });
    expect(ready.map((job) => job.id)).not.toContain("job_future");
  });

  it("lets an old job's DLQ record metadata without terminating a newer attempt", async () => {
    const harness = createD1Harness();
    await harness.publishing.createPostWithDispatch(createTransaction());
    await harness.publishing.claimExecution({
      jobId: "job_0001",
      publicationId: "pub_0001",
      attemptNo: 1,
      now: FIXTURE_NOW,
      credentialSlotRevision: 0,
      claimToken: "claim_0001",
      attemptId: "attempt_0001",
    });
    const retryAt = instant(60_000);
    await harness.publishing.commitExecution({
      jobId: "job_0001",
      publicationId: "pub_0001",
      attemptId: "attempt_0001",
      claimToken: "claim_0001",
      now: FIXTURE_NOW,
      outcome: "safe_retry",
      errorCode: "PROVIDER_UNAVAILABLE",
      retryAt,
      nextJob: {
        id: "job_0002",
        kind: "delivery.execute",
        aggregateId: "pub_0001",
        attemptNo: 2,
        availableAt: retryAt,
      },
      archive: null,
    });
    await harness.publishing.claimExecution({
      jobId: "job_0002",
      publicationId: "pub_0001",
      attemptNo: 2,
      now: retryAt,
      credentialSlotRevision: 0,
      claimToken: "claim_0002",
      attemptId: "attempt_0002",
    });

    const lateDlq = await harness.publishing.settleDeadLetter({
      jobId: "job_0001",
      publicationId: "pub_0001",
      now: instant(16 * 60_000),
      transportReason: "queue_dlq",
    });
    expect(lateDlq.kind).toBe("recorded");
    const execution = await harness.publishing.getExecution({
      jobId: "job_0002",
      publicationId: "pub_0001",
    });
    expect(execution?.publication.status).toBe("publishing");
    expect(execution?.publication.claimToken).toBe("claim_0002");
    expect(execution?.publication.terminalReason).toBeNull();
  });

  it("applies the credential binding guard inside the create batch", async () => {
    const harness = createD1Harness();
    await harness.credentials.compareAndSetSlot({
      platform: "x",
      expectedRevision: 0,
      now: FIXTURE_NOW,
      change: {
        kind: "set",
        bindingId: "bind-real",
        envelope: testEnvelope("seed"),
        payloadRevision: 1,
        payloadSchemaVersion: 1,
        expiresAt: null,
        target: null,
      },
    });
    const mismatched = await harness.publishing.createPostWithDispatch(
      createTransaction({
        credentialRevision: 1,
        credentialGuards: [{ platform: "x", expectedRevision: 1, bindingId: "bind-other" }],
      }),
    );
    expect(mismatched).toMatchObject({ kind: "conflict", reason: "credential_revision_mismatch" });
    const rows = await env.DB.prepare("SELECT COUNT(*) AS count FROM posts").first<{
      count: number;
    }>();
    expect(rows?.count).toBe(0);

    const matching = await harness.publishing.createPostWithDispatch(
      createTransaction({
        credentialRevision: 1,
        credentialGuards: [{ platform: "x", expectedRevision: 1, bindingId: "bind-real" }],
      }),
    );
    expect(matching.kind).toBe("created");
  });

  it("reports a duplicate auth operation as a contract error, not infrastructure", async () => {
    const harness = createD1Harness();
    const start = {
      operationId: "op_0001",
      platform: "x" as const,
      now: FIXTURE_NOW,
      expectedRevision: 0,
      canonicalCallbackUrl: "https://syndroo.test/v1/auth/x/callback",
      startConfigBinding: "config-binding-1",
      oauthState: "state_0001",
      requestToken: null,
      requestSecret: null,
      requestSecretPurpose: null,
      requestSecretRevision: null,
      expiresAt: instant(30 * 60_000),
    };
    await harness.credentials.createAuthOperation(start);
    await expect(harness.credentials.createAuthOperation(start)).rejects.toThrow(
      "auth operation already exists",
    );
    const stored = await harness.credentials.readAuthOperation({ operationId: "op_0001" });
    expect(stored?.startConfigBinding).toBe("config-binding-1");
    expect(stored?.phase).toBe("pending_callback");
  });

  it("returns unknown on a lost acknowledgement and never another caller's lease", async () => {
    const harness = createD1Harness();
    await harness.credentials.compareAndSetSlot({
      platform: "x",
      expectedRevision: 0,
      now: FIXTURE_NOW,
      change: {
        kind: "set",
        bindingId: "bind-1",
        envelope: testEnvelope("seed"),
        payloadRevision: 1,
        payloadSchemaVersion: 1,
        expiresAt: null,
        target: null,
      },
    });

    const lostAck = new D1Repository(throwingBatchDb(env.DB));
    const lostLease = await lostAck.acquireRefresh({
      platform: "x",
      expectedRevision: 1,
      leaseToken: "lease-own",
      now: FIXTURE_NOW,
      leaseDurationMs: 60_000,
    });
    expect(lostLease.kind).toBe("unknown");
    const competing = await harness.credentials.acquireRefresh({
      platform: "x",
      expectedRevision: 1,
      leaseToken: "lease-other",
      now: FIXTURE_NOW,
      leaseDurationMs: 60_000,
    });
    expect(competing.kind).toBe("conflict");
    expect((competing as { reason: string }).reason).toBe("lease_held");

    await env.DB.prepare(
      `UPDATE credentials SET refresh_lease_token = NULL, refresh_lease_acquired_at = NULL,
         refresh_lease_expires_at = NULL, refresh_lease_revision = NULL WHERE platform = 'x'`,
    ).run();
    const racing = new D1Repository(
      afterCommitDb(env.DB, async () => {
        await env.DB.prepare(
          `UPDATE credentials SET refresh_lease_token = 'lease-injected' WHERE platform = 'x'`,
        ).run();
      }),
    );
    const raced = await racing.acquireRefresh({
      platform: "x",
      expectedRevision: 1,
      leaseToken: "lease-mine",
      now: FIXTURE_NOW,
      leaseDurationMs: 60_000,
    });
    expect(raced.kind).toBe("acquired");
    if (raced.kind === "acquired") {
      expect(raced.lease.token).toBe("lease-mine");
      expect(raced.snapshot.refreshLease?.token).toBe("lease-mine");
    }
  });

  it("keeps the winning claim snapshot across a concurrent recovery", async () => {
    const harness = createD1Harness();
    await harness.publishing.createPostWithDispatch(createTransaction());
    const racing = new D1Repository(
      afterCommitDb(env.DB, async () => {
        await env.DB.prepare(
          `UPDATE publications SET claim_token = 'claim-injected', attempt_id = 'attempt-injected' WHERE id = 'pub_0001'`,
        ).run();
      }),
    );
    const claimed = await racing.claimExecution({
      jobId: "job_0001",
      publicationId: "pub_0001",
      attemptNo: 1,
      now: FIXTURE_NOW,
      credentialSlotRevision: 0,
      claimToken: "claim-mine",
      attemptId: "attempt-mine",
    });
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind === "claimed") {
      expect(claimed.execution.publication.claimToken).toBe("claim-mine");
      expect(claimed.execution.publication.attemptId).toBe("attempt-mine");
      expect(claimed.execution.publication.attempts).toBe(1);
    }
  });

  it("swallows a throwing metrics observer on reads and writes", async () => {
    const harness = createD1Harness();
    const noisy = new D1Repository(env.DB, {
      metrics: {
        observe() {
          throw new Error(`observer failure ${SENTINEL} SELECT`);
        },
      },
    });
    await expect(noisy.readSlot({ platform: "x" })).resolves.toMatchObject({ status: "empty" });
    const created = await noisy.createPostWithDispatch(createTransaction());
    expect(created.kind).toBe("created");
    const claimed = await noisy.claimExecution({
      jobId: "job_0001",
      publicationId: "pub_0001",
      attemptNo: 1,
      now: FIXTURE_NOW,
      credentialSlotRevision: 0,
      claimToken: "claim_0001",
      attemptId: "attempt_0001",
    });
    expect(claimed.kind).toBe("claimed");
    void harness;
  });

  it("fences a job protocol change that lands after the pre-read", async () => {
    const harness = createD1Harness();
    await harness.publishing.createPostWithDispatch(createTransaction());
    const racing = new D1Repository(
      beforeBatchDb(env.DB, async () => {
        await env.DB.prepare(
          "UPDATE outbox_jobs SET payload_version = 2 WHERE id = 'job_0001'",
        ).run();
      }),
    );
    const claimed = await racing.claimExecution({
      jobId: "job_0001",
      publicationId: "pub_0001",
      attemptNo: 1,
      now: FIXTURE_NOW,
      credentialSlotRevision: 0,
      claimToken: "claim_0001",
      attemptId: "attempt_0001",
    });
    expect(claimed.kind).toBe("not_claimed");
    // The job row now carries an unsupported protocol, so assert through raw SQL
    // rather than the strict mapper.
    const row = await env.DB.prepare(
      "SELECT status, attempts FROM publications WHERE id = 'pub_0001'",
    ).first<{ status: string; attempts: number }>();
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
  });

  it("fences recovery eligibility that changes before the guarded batch", async () => {
    const harness = createD1Harness();
    await harness.publishing.createPostWithDispatch(createTransaction());
    await harness.outbox.recordDispatch({
      jobId: "job_0001",
      dispatchRevision: 0,
      now: FIXTURE_NOW,
      outcome: { kind: "dispatched" },
    });
    const racing = new D1Repository(
      beforeBatchDb(env.DB, async () => {
        await env.DB.prepare(
          "UPDATE outbox_jobs SET status = 'cancelled' WHERE id = 'job_0001'",
        ).run();
      }),
    );
    const recovery = await racing.recoverStaleClaims({
      now: instant(31 * 60_000),
      limit: 5,
    });
    expect(recovery.jobsRearmed).toBe(0);
    const execution = await harness.publishing.getExecution({
      jobId: "job_0001",
      publicationId: "pub_0001",
    });
    expect(execution?.job.status).toBe("cancelled");
  });
});
