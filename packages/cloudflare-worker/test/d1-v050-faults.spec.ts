import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import {
  FIXTURE_NOW,
  createTransaction,
  instant,
  testEnvelope,
} from "@syndroo/application/testing";

import { createD1Harness } from "./support/d1-v050-support.js";

async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    count: number;
  }>();
  return row?.count ?? 0;
}

async function plan(sql: string, ...params: unknown[]): Promise<string> {
  const result = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return (result.results ?? []).map((row) => row.detail).join(" | ");
}

describe("D1 0.5.0 execution semantics", () => {
  beforeEach(async () => {
    await createD1Harness().reset();
  });

  it("cannot authorise child rows when the create guard matches zero rows", async () => {
    const harness = createD1Harness();
    const seeded = await harness.credentials.compareAndSetSlot({
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
    expect(seeded.kind).toBe("applied");

    const result = await harness.publishing.createPostWithDispatch(
      createTransaction({
        credentialGuards: [{ platform: "x", expectedRevision: 0, bindingId: null }],
      }),
    );
    expect(result).toMatchObject({ kind: "conflict", reason: "credential_revision_mismatch" });
    expect(await countRows("posts")).toBe(0);
    expect(await countRows("publications")).toBe(0);
    expect(await countRows("outbox_jobs")).toBe(0);
  });

  it("rolls the whole batch back when SQL aborts mid-transaction", async () => {
    const harness = createD1Harness();
    await env.DB.prepare(
      "CREATE TRIGGER d1_v050_abort_jobs BEFORE INSERT ON outbox_jobs BEGIN SELECT RAISE(ABORT, 'injected'); END",
    ).run();
    try {
      await expect(
        harness.publishing.createPostWithDispatch(createTransaction()),
      ).rejects.toThrow();
    } finally {
      await env.DB.prepare("DROP TRIGGER d1_v050_abort_jobs").run();
    }
    expect(await countRows("posts")).toBe(0);
    expect(await countRows("publications")).toBe(0);
    expect(await countRows("outbox_jobs")).toBe(0);
    const retry = await harness.publishing.createPostWithDispatch(createTransaction());
    expect(retry.kind).toBe("created");
  });

  it("grants one claim across concurrent consumers and leaves loser state untouched", async () => {
    const harness = createD1Harness();
    await harness.publishing.createPostWithDispatch(createTransaction());
    const claims = await Promise.all([
      harness.publishing.claimExecution({
        jobId: "job_0001",
        publicationId: "pub_0001",
        attemptNo: 1,
        now: FIXTURE_NOW,
        credentialSlotRevision: 0,
        claimToken: "claim_A",
        attemptId: "attempt_A",
      }),
      harness.publishing.claimExecution({
        jobId: "job_0001",
        publicationId: "pub_0001",
        attemptNo: 1,
        now: FIXTURE_NOW,
        credentialSlotRevision: 0,
        claimToken: "claim_B",
        attemptId: "attempt_B",
      }),
    ]);
    const claimed = claims.filter((claim) => claim.kind === "claimed");
    const blocked = claims.filter((claim) => claim.kind === "not_claimed");
    expect(claimed).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect((blocked[0] as { reason: string }).reason).toBe("already_claimed");
    const execution = await harness.publishing.getExecution({
      jobId: "job_0001",
      publicationId: "pub_0001",
    });
    expect(execution?.publication.attempts).toBe(1);
    expect(execution?.publication.status).toBe("publishing");
  });

  it("keeps activation and a concurrent direct set from both winning", async () => {
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
    await harness.credentials.createAuthOperation({
      operationId: "op_0001",
      platform: "x",
      now: FIXTURE_NOW,
      expectedRevision: 1,
      canonicalCallbackUrl: "https://syndroo.test/v1/auth/x/callback",
      startConfigBinding: "config-binding-1",
      oauthState: "state_0001",
      requestToken: null,
      requestSecret: null,
      requestSecretPurpose: null,
      requestSecretRevision: null,
      expiresAt: instant(30 * 60_000),
    });
    await harness.credentials.claimOAuthCallback({
      platform: "x",
      oauthState: "state_0001",
      requestToken: null,
      now: FIXTURE_NOW,
      currentConfigBinding: "config-binding-1",
    });
    await harness.credentials.saveCandidate({
      operationId: "op_0001",
      platform: "x",
      now: FIXTURE_NOW,
      outcome: {
        kind: "candidate",
        phase: "awaiting_confirmation",
        candidateEnvelope: testEnvelope("candidate"),
        candidatePayloadRevision: 1,
        candidatePayloadSchemaVersion: 1,
        candidateTarget: null,
        missingFields: [],
      },
    });

    const [activation, directSet] = await Promise.all([
      harness.credentials.activateCandidate({
        operationId: "op_0001",
        platform: "x",
        now: FIXTURE_NOW,
        expectedRevision: 1,
        bindingId: "bind-activated",
        currentConfigBinding: "config-binding-1",
        envelope: testEnvelope("active"),
        payloadRevision: 1,
        payloadSchemaVersion: 1,
        expiresAt: null,
        target: null,
        receipt: {
          platform: "x",
          operationId: "op_0001",
          stored: true,
          revision: 2,
          configured: true,
          readiness: "ready",
        },
      }),
      harness.credentials.compareAndSetSlot({
        platform: "x",
        expectedRevision: 1,
        now: FIXTURE_NOW,
        change: {
          kind: "set",
          bindingId: "bind-direct",
          envelope: testEnvelope("direct"),
          payloadRevision: 1,
          payloadSchemaVersion: 1,
          expiresAt: null,
          target: null,
        },
      }),
    ]);
    const winners = [activation.kind, directSet.kind].filter(
      (kind) => kind === "activated" || kind === "applied",
    );
    expect(winners).toHaveLength(1);
    const slot = await harness.credentials.readSlot({ platform: "x" });
    expect(slot.revision).toBe(2);
  });

  it("reports an uncertain claim as unknown and lets a later claim succeed", async () => {
    const harness = createD1Harness();
    await harness.publishing.createPostWithDispatch(createTransaction());
    await env.DB.prepare(
      "CREATE TRIGGER d1_v050_abort_posts BEFORE UPDATE ON posts BEGIN SELECT RAISE(ABORT, 'injected'); END",
    ).run();
    let claim;
    try {
      claim = await harness.publishing.claimExecution({
        jobId: "job_0001",
        publicationId: "pub_0001",
        attemptNo: 1,
        now: FIXTURE_NOW,
        credentialSlotRevision: 0,
        claimToken: "claim_0001",
        attemptId: "attempt_0001",
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER d1_v050_abort_posts").run();
    }
    expect(claim.kind).toBe("unknown");
    const afterFailure = await harness.publishing.getExecution({
      jobId: "job_0001",
      publicationId: "pub_0001",
    });
    expect(afterFailure?.publication.status).toBe("pending");
    expect(afterFailure?.publication.attempts).toBe(0);

    const retry = await harness.publishing.claimExecution({
      jobId: "job_0001",
      publicationId: "pub_0001",
      attemptNo: 1,
      now: FIXTURE_NOW,
      credentialSlotRevision: 0,
      claimToken: "claim_0002",
      attemptId: "attempt_0002",
    });
    expect(retry.kind).toBe("claimed");
  });

  it("records batch metrics and uses indexes for the hot selectors", async () => {
    const harness = createD1Harness();
    for (let index = 0; index < 120; index += 1) {
      const id = `seed-${index}`;
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO posts (id, content, platforms, status, created_at, updated_at) VALUES (?, ?, '[\"x\"]', 'published', ?, ?)",
        ).bind(id, "seed", FIXTURE_NOW, FIXTURE_NOW),
        env.DB.prepare(
          `INSERT INTO publications (id, post_id, platform, provider, content, status, attempts, created_at, updated_at, archive_status)
           VALUES (?, ?, 'x', 'x', 'seed', 'published', 1, ?, ?, 'not_requested')`,
        ).bind(`${id}-pub`, id, FIXTURE_NOW, FIXTURE_NOW),
        env.DB.prepare(
          `INSERT INTO outbox_jobs (id, kind, payload_version, aggregate_id, attempt_no, available_at, status, created_at, updated_at)
           VALUES (?, 'delivery.execute', 1, ?, 1, ?, 'cancelled', ?, ?)`,
        ).bind(`${id}-job`, `${id}-pub`, FIXTURE_NOW, FIXTURE_NOW, FIXTURE_NOW),
      ]);
    }
    await harness.publishing.createPostWithDispatch(createTransaction());
    harness.metrics.length = 0;
    await harness.publishing.claimExecution({
      jobId: "job_0001",
      publicationId: "pub_0001",
      attemptNo: 1,
      now: FIXTURE_NOW,
      credentialSlotRevision: 0,
      claimToken: "claim_0001",
      attemptId: "attempt_0001",
    });
    const claimMetrics = harness.metrics.find((event) => event.op === "claimExecution");
    expect(claimMetrics?.statements).toBeGreaterThanOrEqual(2);
    expect(claimMetrics?.changes).toBeGreaterThan(0);

    const readyPlan = await plan(
      "SELECT id FROM outbox_jobs WHERE status = 'pending' AND dlq_seen_at IS NULL AND available_at <= ? ORDER BY available_at, id LIMIT 20",
      FIXTURE_NOW,
    );
    expect(readyPlan).toContain("idx_outbox_ready");
    const recoveryPlan = await plan(
      "SELECT id FROM outbox_jobs WHERE status = 'dispatched' AND recovery_after IS NOT NULL AND recovery_after <= ? ORDER BY recovery_after, id LIMIT 20",
      FIXTURE_NOW,
    );
    expect(recoveryPlan).toContain("idx_outbox_recovery");

    const collected = await harness.outbox.collectFinished({
      now: instant(31 * 24 * 60 * 60_000),
      limit: 5,
    });
    expect(collected.removed).toBe(5);
  });
});
