import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PublishError,
  type Post,
  type Publication,
  type PublicationJob,
} from "@syndroo/core";

import worker from "../src/index.js";
import { D1Repository } from "../src/repository.js";

const createdAt = "2026-09-15T00:00:00.000Z";
const firstRetryDue = "2026-09-15T00:01:00.000Z";
const secondRetryDue = "2026-09-15T00:03:00.000Z";
const enqueuedCutoff = "2026-09-15T00:15:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function createPublication(
  id: string,
): Promise<{ repository: D1Repository; publicationId: string }> {
  const repository = new D1Repository(env.DB);
  const post: Post = {
    id: id + "-post",
    content: "Strict retry timing",
    platforms: ["threads"],
    status: "queued",
    createdAt,
  };
  const publication: Publication = {
    id,
    postId: post.id,
    platform: "threads",
    provider: "threads-native",
    content: post.content,
    status: "pending",
    attempts: 0,
    createdAt,
  };

  await repository.createPost(post, [publication]);
  return { repository, publicationId: publication.id };
}

function rateLimited(): PublishError {
  return new PublishError("Threads rate limited", "RATE_LIMIT");
}

async function enqueuedAt(id: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT enqueued_at FROM publications WHERE id = ?",
  )
    .bind(id)
    .first<{ enqueued_at: string | null }>();

  return row?.enqueued_at ?? null;
}

describe("strict earliest retry time", () => {
  it("persists eligibility with the failure and blocks claim and Cron until due", async () => {
    const { repository, publicationId } = await createPublication("pub-boundary");
    await repository.claimPublication(publicationId, createdAt);
    await repository.markFailed(publicationId, rateLimited(), true, createdAt);

    await expect(repository.getPublication(publicationId)).resolves.toMatchObject({
      status: "pending",
      attempts: 1,
      retryAt: firstRetryDue,
    });

    // One millisecond before the boundary: no claim, no attempt increase.
    await expect(
      repository.claimPublication(publicationId, "2026-09-15T00:00:59.999Z"),
    ).resolves.toBeNull();
    const premature = await repository.findDuePublications(
      "2026-09-15T00:00:59.999Z",
      enqueuedCutoff,
    );
    expect(premature.map(item => item.id)).not.toContain(publicationId);
    await expect(repository.getPublication(publicationId)).resolves.toMatchObject({
      status: "pending",
      attempts: 1,
    });

    // At the boundary both paths release the retry.
    const due = await repository.findDuePublications(firstRetryDue, enqueuedCutoff);
    expect(due.map(item => item.id)).toContain(publicationId);
    await expect(
      repository.claimPublication(publicationId, firstRetryDue),
    ).resolves.toMatchObject({ status: "publishing", attempts: 2 });
    const claimed = await repository.getPublication(publicationId);
    expect(claimed?.retryAt).toBeUndefined();

    // Second retry waits 120 seconds, not 60.
    await repository.markFailed(publicationId, rateLimited(), true, firstRetryDue);
    await expect(repository.getPublication(publicationId)).resolves.toMatchObject({
      status: "pending",
      attempts: 2,
      retryAt: secondRetryDue,
    });
  });

  it("keeps one claim across concurrent consumers at the boundary", async () => {
    const { repository, publicationId } = await createPublication("pub-concurrent");
    await repository.claimPublication(publicationId, createdAt);
    await repository.markFailed(publicationId, rateLimited(), true, createdAt);

    const claims = await Promise.all([
      repository.claimPublication(publicationId, firstRetryDue),
      new D1Repository(env.DB).claimPublication(publicationId, firstRetryDue),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({
      id: publicationId,
      status: "publishing",
      attempts: 2,
    });
    await expect(repository.getPublication(publicationId)).resolves.toMatchObject({
      attempts: 2,
    });
  });

  it("clears retry eligibility on success and on a terminal failure", async () => {
    const { repository, publicationId } = await createPublication("pub-clear");
    await repository.claimPublication(publicationId, createdAt);
    await repository.markFailed(publicationId, rateLimited(), true, createdAt);
    await repository.claimPublication(publicationId, firstRetryDue);
    await repository.markPublished(publicationId, "remote-id", undefined, firstRetryDue);

    await expect(repository.getPublication(publicationId)).resolves.toMatchObject({
      status: "published",
      attempts: 2,
    });
    expect((await repository.getPublication(publicationId))?.retryAt).toBeUndefined();

    const retried = await repository.claimPublication(publicationId, firstRetryDue);
    expect(retried).toBeNull();

    const terminal = await createPublication("pub-terminal");
    await terminal.repository.claimPublication(terminal.publicationId, createdAt);
    await terminal.repository.markFailed(
      terminal.publicationId,
      rateLimited(),
      true,
      createdAt,
    );
    const third = await terminal.repository.claimPublication(
      terminal.publicationId,
      firstRetryDue,
    );
    expect(third?.attempts).toBe(2);
    // A terminal decision clears eligibility; the attempt cap is covered by the
    // Queue test below, which reaches three attempts.
    await terminal.repository.markFailed(
      terminal.publicationId,
      rateLimited(),
      false,
      firstRetryDue,
    );
    await expect(
      terminal.repository.getPublication(terminal.publicationId),
    ).resolves.toMatchObject({ status: "failed", attempts: 2, errorCode: "RATE_LIMIT" });
    expect(
      (await terminal.repository.getPublication(terminal.publicationId))?.retryAt,
    ).toBeUndefined();
  });

  it("rolls back status, aggregate, and retry eligibility together on persistence failure", async () => {
    const { repository, publicationId } = await createPublication("pub-rollback");
    await repository.claimPublication(publicationId, createdAt);

    // Test-only database fault: exercise real D1 rollback, not repository mocks.
    await env.DB.prepare(
      "CREATE TRIGGER fail_retry_post_update BEFORE UPDATE ON posts " +
        "WHEN OLD.id = 'pub-rollback-post' " +
        "BEGIN SELECT RAISE(ABORT, 'injected Post update failure'); END",
    ).run();
    try {
      await expect(
        repository.markFailed(publicationId, rateLimited(), true, createdAt),
      ).rejects.toThrow();
      await expect(repository.getPublication(publicationId)).resolves.toMatchObject({
        status: "publishing",
        attempts: 1,
      });
      expect((await repository.getPublication(publicationId))?.retryAt).toBeUndefined();
      // The publication stays claimed, not resettled to a retryable state.
      await expect(
        repository.claimPublication(publicationId, createdAt),
      ).rejects.toThrow();
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_retry_post_update").run();
    }

    await repository.markFailed(publicationId, rateLimited(), true, createdAt);
    await expect(repository.getPublication(publicationId)).resolves.toMatchObject({
      status: "pending",
      retryAt: firstRetryDue,
    });
  });

  it("covers both scheduler branches before and after the retry time", async () => {
    const { repository, publicationId } = await createPublication("pub-cron");
    await repository.claimPublication(publicationId, createdAt);
    await repository.markFailed(publicationId, rateLimited(), true, createdAt);
    // Keep any Queue delivery of a Cron enqueue away from the real provider.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: { message: "Rate limited" } }, { status: 429 }),
    );

    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.parse("2026-09-15T00:00:59.999Z") }),
      env,
    );
    await expect(enqueuedAt(publicationId)).resolves.toBeNull();

    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.parse(firstRetryDue) }),
      env,
    );
    await expect(enqueuedAt(publicationId)).resolves.toBe(firstRetryDue);
  });

  it("treats pre-migration rows without a retry time as immediately eligible", async () => {
    const columns = await env.DB.prepare(
      "SELECT name FROM pragma_table_info('publications')",
    ).run<{ name: string }>();
    expect(columns.results.map(column => column.name)).toContain("retry_at");
    const applied = await env.DB.prepare(
      "SELECT name FROM d1_migrations WHERE name LIKE '0003%'",
    ).run<{ name: string }>();
    expect(applied.results).toHaveLength(1);

    // Insert a row shaped like an applied pre-0003 row: no retry_at value.
    await env.DB.prepare(
      "INSERT INTO posts (id, content, platforms, overrides, scheduled_at, " +
        "status, created_at, updated_at, idempotency_key) " +
        "VALUES (?, ?, ?, NULL, NULL, 'queued', ?, ?, NULL)",
    )
      .bind("post-legacy", "Legacy row", JSON.stringify(["threads"]), createdAt, createdAt)
      .run();
    await env.DB.prepare(
      "INSERT INTO publications (id, post_id, platform, provider, content, " +
        "status, attempts, external_id, external_url, error_code, error_message, " +
        "error_ambiguous, enqueued_at, publishing_at, created_at, updated_at, published_at) " +
        "VALUES (?, ?, 'threads', 'threads-native', ?, 'pending', 0, NULL, NULL, " +
        "NULL, NULL, 0, NULL, NULL, ?, ?, NULL)",
    )
      .bind("pub-legacy", "post-legacy", "Legacy row", createdAt, createdAt)
      .run();

    const repository = new D1Repository(env.DB);
    const legacy = await repository.getPublication("pub-legacy");
    expect(legacy?.retryAt).toBeUndefined();
    const stored = await env.DB.prepare(
      "SELECT retry_at FROM publications WHERE id = 'pub-legacy'",
    ).first<{ retry_at: string | null }>();
    expect(stored?.retry_at).toBeNull();
    const due = await repository.findDuePublications(createdAt, enqueuedCutoff);
    expect(due.map(item => item.id)).toContain("pub-legacy");
    await expect(
      repository.claimPublication("pub-legacy", createdAt),
    ).resolves.toMatchObject({ status: "publishing", attempts: 1 });
  });

  it("keeps retry eligibility out of the public post response", async () => {
    const { repository, publicationId } = await createPublication("pub-public-shape");
    await repository.claimPublication(publicationId, createdAt);
    await repository.markFailed(publicationId, rateLimited(), true, createdAt);

    const detail = await repository.getPost("pub-public-shape-post");
    expect(detail?.publications[0]).not.toHaveProperty("retryAt");

    const response = await exports.default.fetch(
      "https://syndroo.test/v1/posts/pub-public-shape-post",
      { headers: { authorization: "Bearer test-api-key" } },
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("retryAt");
    expect(body).not.toContain("retry_at");
  });
});

describe("strict retry timing through the Queue", () => {
  it("reschedules duplicate deliveries without early provider calls and recovers at the boundary", async () => {
    const { repository, publicationId } = await createPublication("pub-duplicate");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: { message: "Rate limited" } }, { status: 429 }),
    );
    // Control the clock the Worker reads, without faking timers or RPC.
    vi.useFakeTimers({ toFake: ["Date"] });
    const deliver = async (suffix: string) => {
      const batch = createMessageBatch<PublicationJob>("syndroo-publications", [
        {
          id: publicationId + suffix,
          timestamp: new Date(),
          attempts: 1,
          body: { publicationId },
        },
      ]);
      const context = createExecutionContext();
      await worker.queue(batch, env);
      return getQueueResult(batch, context);
    };

    vi.setSystemTime(new Date(createdAt));
    const first = await deliver("-first");
    expect(first.explicitAcks).toEqual([]);
    expect(first).toMatchObject({
      retryMessages: [{ msgId: publicationId + "-first" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(repository.getPublication(publicationId)).resolves.toMatchObject({
      status: "pending",
      attempts: 1,
      retryAt: firstRetryDue,
    });

    // Just before the boundary: rescheduled, no provider call, no attempt increase.
    vi.setSystemTime(new Date("2026-09-15T00:00:59.999Z"));
    const duplicate = await deliver("-duplicate");
    expect(duplicate.explicitAcks).toEqual([]);
    expect(duplicate).toMatchObject({
      retryMessages: [{ msgId: publicationId + "-duplicate" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(repository.getPublication(publicationId)).resolves.toMatchObject({
      status: "pending",
      attempts: 1,
      retryAt: firstRetryDue,
    });

    // Exactly at the boundary: claimable again, one provider call, second delay.
    vi.setSystemTime(new Date(firstRetryDue));
    const due = await deliver("-due");
    expect(due.explicitAcks).toEqual([]);
    expect(due).toMatchObject({
      retryMessages: [{ msgId: publicationId + "-due" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(repository.getPublication(publicationId)).resolves.toMatchObject({
      status: "pending",
      attempts: 2,
      retryAt: secondRetryDue,
    });

    // Third attempt hits the cap: terminal failure, acked, eligibility cleared.
    vi.setSystemTime(new Date(secondRetryDue));
    const capped = await deliver("-capped");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(capped.explicitAcks).toEqual([publicationId + "-capped"]);
    const terminal = await repository.getPublication(publicationId);
    expect(terminal).toMatchObject({ status: "failed", attempts: 3, errorCode: "RATE_LIMIT" });
    expect(terminal?.retryAt).toBeUndefined();
  });
});
