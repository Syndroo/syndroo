import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { PublishError, type Post, type Publication } from "@syndroo/core";
import { D1Repository } from "../src/repository.js";

const createdAt = "2026-09-01T00:00:00.000Z";
const now = "2026-09-01T00:01:00.000Z";

async function createPendingPost(id: string, scheduledAt?: string): Promise<string> {
  const repository = new D1Repository(env.DB);
  const post: Post = {
    id, content: "Atomic publication", platforms: ["bluesky"],
    status: scheduledAt ? "scheduled" : "queued", createdAt,
    ...(scheduledAt ? { scheduledAt } : {}),
  };
  const publication: Publication = {
    id: id + "-publication", postId: id, platform: "bluesky",
    provider: "bluesky-native", content: post.content,
    status: scheduledAt ? "scheduled" : "pending", attempts: 0, createdAt,
  };
  await repository.createPost(post, [publication]);
  return publication.id;
}

describe("publication state consistency", () => {
  it("rolls back a claim if D1 cannot read the claimed publication", async () => {
    const id = await createPendingPost("post-claim-read-failure");
    // Inject a failing SELECT at the database seam; execute every statement on D1.
    const faultDb = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") {
          return (sql: string) => target.prepare(
            sql.startsWith("SELECT p.id")
              ? "SELECT injected_missing_column FROM publications WHERE id = ?"
              : sql,
          );
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(new D1Repository(faultDb).claimPublication(id, now)).rejects.toThrow();
    const repository = new D1Repository(env.DB);
    await expect(repository.getPublication(id)).resolves.toMatchObject({ status: "pending", attempts: 0 });
    await expect(repository.claimPublication(id, now)).resolves.toMatchObject({ status: "publishing", attempts: 1 });
  });

  it("grants one claim across concurrent consumers and returns the scheduled time", async () => {
    const id = await createPendingPost("post-concurrent-claim", now);
    const repository = new D1Repository(env.DB);
    await repository.activateScheduled(id, now);
    const claims = await Promise.all([
      repository.claimPublication(id, now),
      new D1Repository(env.DB).claimPublication(id, now),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({ id, attempts: 1, scheduledAt: now });
    await expect(repository.getPost("post-concurrent-claim")).resolves.toMatchObject({ status: "publishing" });
  });

  it.each([
    { results: ["published", "published"], expected: "published" },
    { results: ["published", "failed"], expected: "partial" },
    { results: ["failed", "failed"], expected: "failed" },
  ] as const)("aggregates concurrent platform completion as $expected", async ({ results, expected }) => {
    const repository = new D1Repository(env.DB);
    const post: Post = {
      id: "post-concurrent-" + expected, content: "Two platforms",
      platforms: ["bluesky", "threads"], status: "queued", createdAt,
    };
    const publications = post.platforms.map<Publication>(platform => ({
      id: post.id + "-" + platform, postId: post.id, platform,
      provider: platform + "-native", content: post.content,
      status: "pending", attempts: 0, createdAt,
    }));
    await repository.createPost(post, publications);
    await Promise.all(publications.map(publication => repository.claimPublication(publication.id, now)));
    await Promise.all(publications.map((publication, index) =>
      results[index] === "published"
        ? repository.markPublished(publication.id, "remote-" + index, undefined, now)
        : repository.markFailed(publication.id, new PublishError("Rejected", "INVALID_CONTENT"), false, now),
    ));
    await expect(repository.getPost(post.id)).resolves.toMatchObject({ status: expected });
    for (const [index, publication] of publications.entries()) {
      await expect(repository.getPublication(publication.id)).resolves.toMatchObject({ status: results[index] });
    }
  });

  it("rolls back stale recovery on Post failure and preserves ambiguous outcomes on retry", async () => {
    const repository = new D1Repository(env.DB);
    const id = await createPendingPost("post-recovery-rollback");
    await repository.claimPublication(id, createdAt);
    const cutoff = "2026-09-01T00:15:00.000Z";
    const recoveredAt = "2026-09-01T00:30:00.000Z";
    await env.DB.prepare(`CREATE TRIGGER fail_recovery_post_update
      BEFORE UPDATE ON posts WHEN OLD.id = 'post-recovery-rollback'
      BEGIN SELECT RAISE(ABORT, 'injected Post update failure'); END`).run();
    try {
      await expect(repository.recoverStalePublishing(cutoff, recoveredAt)).rejects.toThrow();
      await expect(repository.getPublication(id)).resolves.toMatchObject({ status: "publishing" });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_recovery_post_update").run();
    }
    await repository.recoverStalePublishing(cutoff, recoveredAt);
    await expect(repository.getPost("post-recovery-rollback")).resolves.toMatchObject({
      status: "failed",
      publications: [{ status: "failed", errorCode: "UNKNOWN", errorAmbiguous: true, attempts: 1 }],
    });
    await expect(repository.claimPublication(id, recoveredAt)).resolves.toBeNull();
    await expect(repository.recoverStalePublishing(cutoff, recoveredAt)).resolves.toBe(0);
  });

  it("keeps scheduled work recoverable if activation cannot update its Post", async () => {
    const repository = new D1Repository(env.DB);
    const id = await createPendingPost("post-activation-rollback", now);
    await env.DB.prepare(`CREATE TRIGGER fail_activation_post_update
      BEFORE UPDATE ON posts WHEN OLD.id = 'post-activation-rollback'
      BEGIN SELECT RAISE(ABORT, 'injected Post update failure'); END`).run();
    try {
      await expect(repository.activateScheduled(id, now)).rejects.toThrow();
      await expect(repository.getPublication(id)).resolves.toMatchObject({ status: "scheduled" });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_activation_post_update").run();
    }
    await expect(repository.activateScheduled(id, now)).resolves.toBe(true);
    await expect(repository.getPost("post-activation-rollback")).resolves.toMatchObject({
      status: "queued", publications: [{ status: "pending", scheduledAt: now }],
    });
  });

  it.each([false, true])("does not partially persist failure (retry=%s)", async retry => {
    const repository = new D1Repository(env.DB);
    const postId = "post-failure-rollback-" + retry;
    const id = await createPendingPost(postId);
    await repository.claimPublication(id, now);
    const error = new PublishError("Rate limited", "RATE_LIMIT");
    await env.DB.prepare(`CREATE TRIGGER fail_failure_post_update
      BEFORE UPDATE ON posts
      BEGIN SELECT RAISE(ABORT, 'injected Post update failure'); END`).run();
    try {
      await expect(repository.markFailed(id, error, retry, now)).rejects.toThrow();
      await expect(repository.getPublication(id)).resolves.toMatchObject({
        status: "publishing", attempts: 1,
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_failure_post_update").run();
    }
    await repository.markFailed(id, error, retry, now);
    await expect(repository.getPost(postId)).resolves.toMatchObject({
      status: retry ? "queued" : "failed",
      publications: [{ status: retry ? "pending" : "failed", errorCode: "RATE_LIMIT" }],
    });
  });

  it("does not partially persist a successful publication if its Post update fails", async () => {
    const repository = new D1Repository(env.DB);
    const id = await createPendingPost("post-success-rollback");
    await repository.claimPublication(id, now);
    await env.DB.prepare(`CREATE TRIGGER fail_success_post_update
      BEFORE UPDATE ON posts WHEN OLD.id = 'post-success-rollback'
      BEGIN SELECT RAISE(ABORT, 'injected Post update failure'); END`).run();
    try {
      await expect(repository.markPublished(id, "remote-id", undefined, now)).rejects.toThrow();
      await expect(repository.getPublication(id)).resolves.toMatchObject({
        status: "publishing", attempts: 1,
      });
      await expect(repository.getPost("post-success-rollback")).resolves.toMatchObject({
        status: "publishing",
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_success_post_update").run();
    }
    // A retry of persistence is safe; this is not another provider call.
    await repository.markPublished(id, "remote-id", undefined, now);
    await expect(repository.getPost("post-success-rollback")).resolves.toMatchObject({
      status: "published", publications: [{ status: "published", externalId: "remote-id" }],
    });
  });

  it("keeps an unsent publication claimable when the Post update fails", async () => {
    const repository = new D1Repository(env.DB);
    const id = await createPendingPost("post-claim-rollback");

    // Test-only database fault: exercise real D1 rollback, not repository mocks.
    await env.DB.prepare(`CREATE TRIGGER fail_claim_post_update
      BEFORE UPDATE ON posts WHEN OLD.id = 'post-claim-rollback'
      BEGIN SELECT RAISE(ABORT, 'injected Post update failure'); END`).run();
    try {
      await expect(repository.claimPublication(id, now)).rejects.toThrow();
      await expect(repository.getPublication(id)).resolves.toMatchObject({
        status: "pending", attempts: 0,
      });
      await expect(repository.getPost("post-claim-rollback")).resolves.toMatchObject({
        status: "queued",
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_claim_post_update").run();
    }

    await expect(repository.claimPublication(id, now)).resolves.toMatchObject({
      id, status: "publishing", attempts: 1, publishingAt: now,
    });
    await expect(repository.getPost("post-claim-rollback")).resolves.toMatchObject({
      status: "publishing",
    });
  });

  it("keeps the final Post status when the other publication completes mid-transaction", async () => {
    const repository = new D1Repository(env.DB);
    const postId = "post-interleaved-aggregate";
    const blueskyId = postId + "-bluesky";
    const threadsId = postId + "-threads";
    const post: Post = {
      id: postId, content: "Interleaved aggregate",
      platforms: ["bluesky", "threads"], status: "queued", createdAt,
    };
    const publications: Publication[] = [
      {
        id: blueskyId, postId, platform: "bluesky", provider: "bluesky-native",
        content: post.content, status: "pending", attempts: 0, createdAt,
      },
      {
        id: threadsId, postId, platform: "threads", provider: "threads-native",
        content: post.content, status: "pending", attempts: 0, createdAt,
      },
    ];
    await repository.createPost(post, publications);
    await repository.claimPublication(blueskyId, now);
    await repository.claimPublication(threadsId, now);

    // Deterministic interleaving seam. A paused database is handed to the
    // publication whose transition must not lose the concurrent completion:
    //
    // - current implementation: pause before the status transaction runs;
    // - previous read-then-write implementation: pause after its stale count
    //   read resolves and before it writes the derived status.
    const seam = createAggregateSeam();
    const older = new D1Repository(databasePausingAtAggregate(env.DB, seam));
    const completedAt = "2026-09-01T00:02:00.000Z";
    const olderCompletion = older.markPublished(
      blueskyId,
      "remote-bluesky",
      undefined,
      completedAt,
    );

    try {
      await seam.reached();

      // The other publication completes while the first aggregate is open.
      await repository.markPublished(
        threadsId,
        "remote-threads",
        undefined,
        completedAt,
      );
    } finally {
      seam.release();
      await olderCompletion.catch(() => undefined);
    }

    const detail = await repository.getPost(postId);
    const byId = new Map(
      (detail?.publications ?? []).map(publication => [publication.id, publication]),
    );
    expect(detail?.status).toBe("published");
    expect(byId.get(blueskyId)).toMatchObject({
      status: "published",
      externalId: "remote-bluesky",
    });
    expect(byId.get(threadsId)).toMatchObject({
      status: "published",
      externalId: "remote-threads",
    });
  });
});

interface AggregateSeam {
  /** Resolves once the paused statement reached the seam. */
  reached: () => Promise<void>;
  /** Lets the paused statement continue. Safe to call more than once. */
  release: () => void;
  /** Used by the database seam when it pauses. */
  pause: () => Promise<void>;
}

function createAggregateSeam(): AggregateSeam {
  let releaseGate = (): void => {};
  const gate = new Promise<void>(resolve => {
    releaseGate = resolve;
  });
  let markReached = (): void => {};
  const reached = new Promise<void>(resolve => {
    markReached = resolve;
  });
  let paused = false;

  return {
    reached: async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;

      try {
        const outcome = await Promise.race([
          reached.then(() => "reached" as const),
          new Promise<"timeout">(resolve => {
            timeout = setTimeout(() => resolve("timeout"), 2000);
          }),
        ]);

        if (outcome === "timeout") {
          throw new Error("The aggregate interleaving seam was never reached");
        }
      } finally {
        clearTimeout(timeout);
      }
    },
    release: () => {
      markReached();
      releaseGate();
    },
    pause: async () => {
      if (paused) {
        return;
      }

      paused = true;
      markReached();
      await gate;
    },
  };
}

// Matches the aggregate read of the previous read-then-write implementation.
const LEGACY_AGGREGATE_READ = /SELECT COUNT\(\*\) AS total/;

function databasePausingAtAggregate(
  db: D1Database,
  seam: AggregateSeam,
): D1Database {
  return new Proxy(db, {
    get(target, key) {
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await seam.pause();
          return target.batch(statements);
        };
      }

      if (key === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);

          if (!LEGACY_AGGREGATE_READ.test(sql)) {
            return statement;
          }

          return pauseOnAggregateRead(statement, seam);
        };
      }

      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

function pauseOnAggregateRead(
  statement: D1PreparedStatement,
  seam: AggregateSeam,
): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, key) {
      if (key === "first") {
        return async (...args: unknown[]) => {
          const row = await (
            target.first as (...inner: unknown[]) => Promise<unknown>
          )(...args);
          await seam.pause();
          return row;
        };
      }

      if (key === "bind") {
        // `prepare(...).bind(...)` returns a new statement: keep the proxy so
        // the paused `first()` survives the chained binding.
        return (...args: unknown[]) =>
          pauseOnAggregateRead(
            (target.bind as (...inner: unknown[]) => D1PreparedStatement)(...args),
            seam,
          );
      }

      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
