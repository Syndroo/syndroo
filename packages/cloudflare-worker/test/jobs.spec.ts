import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PublishError,
  type Post,
  type Publication,
  type PublicationJob,
} from "@syndroo/core";

import worker from "../src/index.js";
import { D1Repository } from "../src/repository.js";
import { shouldRetry } from "../src/retry.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const createdAt = "2026-09-15T00:00:00.000Z";
const firstRetryAt = "2026-09-15T00:01:00.000Z";
const secondRetryAt = "2026-09-15T00:03:00.000Z";

// `getQueueResult` resolves to `any`: the plugin's `FetcherQueueResult` type is
// an undeclared global, so its errors are suppressed by `skipLibCheck`.
interface DeliveryResult {
  explicitAcks: string[];
  retryMessages: { msgId: string }[];
}

function pendingPost(id: string): { post: Post; publication: Publication } {
  const post: Post = {
    id: id + "-post",
    content: "Queue delivery content",
    platforms: ["threads"],
    status: "queued",
    createdAt,
  };

  return {
    post,
    publication: {
      id,
      postId: post.id,
      platform: "threads",
      provider: "threads-native",
      content: post.content,
      status: "pending",
      attempts: 0,
      createdAt: post.createdAt,
    },
  };
}

async function deliver(
  publicationId: string,
  messageId: string,
): Promise<DeliveryResult> {
  const batch = createMessageBatch<PublicationJob>("syndroo-publications", [
    {
      id: messageId,
      timestamp: new Date(),
      attempts: 1,
      body: { publicationId },
    },
  ]);
  const context = createExecutionContext();
  await worker.queue(batch, env);

  return getQueueResult(batch, context);
}

describe("publication queue", () => {
  it.each([200, 429, 503])("does not republish after HTTP %s when result persistence fails", async status => {
    const repository = new D1Repository(env.DB);
    const post: Post = {
      id: "post-queue-persistence-" + status, content: "Persist safely",
      platforms: ["threads"], status: "queued", createdAt: new Date().toISOString(),
    };
    const publication: Publication = {
      id: post.id + "-publication", postId: post.id, platform: "threads",
      provider: "threads-native", content: post.content,
      status: "pending", attempts: 0, createdAt: post.createdAt,
    };
    await repository.createPost(post, [publication]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(status === 200 ? { id: "remote-post" } : { error: { message: "Test response" } }, { status }),
    );
    const deliver = async (suffix: string) => {
      const batch = createMessageBatch<PublicationJob>("syndroo-publications", [{
        id: post.id + suffix, timestamp: new Date(), attempts: 1,
        body: { publicationId: publication.id },
      }]);
      const context = createExecutionContext();
      await worker.queue(batch, env);
      return getQueueResult(batch, context);
    };

    // Claim may commit; the provider-result transaction must fail and roll back.
    await env.DB.prepare(`CREATE TRIGGER fail_queue_result_update
      BEFORE UPDATE ON posts WHEN NEW.status != 'publishing'
      BEGIN SELECT RAISE(ABORT, 'injected result persistence failure'); END`).run();
    try {
      const first = await deliver("-first");
      expect(first.explicitAcks).toEqual([]);
      await expect(repository.getPublication(publication.id)).resolves.toMatchObject({
        status: "publishing", attempts: 1,
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_queue_result_update").run();
    }

    await deliver("-duplicate");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const future = new Date(Date.now() + 31 * 60 * 1000).toISOString();
    const cutoff = new Date(Date.now() + 16 * 60 * 1000).toISOString();
    await repository.recoverStalePublishing(cutoff, future);
    await expect(repository.getPost(post.id)).resolves.toMatchObject({
      status: "failed", publications: [{ status: "failed", errorAmbiguous: true, attempts: 1 }],
    });
    const final = await deliver("-after-recovery");
    expect(final.explicitAcks).toEqual([post.id + "-after-recovery"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("acknowledges a job whose publication no longer exists", async () => {
    const batch = createMessageBatch<PublicationJob>("syndroo-publications", [
      {
        id: "message-1",
        timestamp: new Date("2026-09-01T00:00:00.000Z"),
        attempts: 1,
        body: { publicationId: "missing-publication" },
      },
    ]);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    await expect(getQueueResult(batch, context)).resolves.toMatchObject({
      outcome: "ok",
      explicitAcks: ["message-1"],
    });
  });

  it("recovers a pending publication after its Queue lease expires", async () => {
    const repository = new D1Repository(env.DB);
    const post: Post = {
      id: "post-stale-lease",
      content: "Recover me",
      platforms: ["bluesky"],
      status: "queued",
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    const publication: Publication = {
      id: "publication-stale-lease",
      postId: post.id,
      platform: "bluesky",
      provider: "bluesky-native",
      content: post.content,
      status: "pending",
      attempts: 0,
      createdAt: post.createdAt,
    };

    await repository.createPost(post, [publication]);
    await repository.markEnqueued(
      [publication.id],
      "2026-09-01T00:01:00.000Z",
    );

    const due = await repository.findDuePublications(
      "2026-09-01T00:30:00.000Z",
      "2026-09-01T00:15:00.000Z",
    );

    expect(due.map(item => item.id)).toContain(publication.id);
  });
});

describe("duplicate Queue delivery", () => {
  it("calls the provider once when a delivered message is delivered again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(createdAt));
    const repository = new D1Repository(env.DB);
    const { post, publication } = pendingPost("pub-duplicate-success");
    await repository.createPost(post, [publication]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ id: "remote-once" }));

    const first = await deliver(publication.id, "message-first");
    expect(first).toMatchObject({ outcome: "ok", explicitAcks: ["message-first"] });
    await expect(repository.getPublication(publication.id)).resolves.toMatchObject({
      status: "published",
      attempts: 1,
      externalId: "remote-once",
    });

    const duplicate = await deliver(publication.id, "message-duplicate");
    expect(duplicate).toMatchObject({
      outcome: "ok",
      explicitAcks: ["message-duplicate"],
      retryMessages: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(repository.getPublication(publication.id)).resolves.toMatchObject({
      status: "published",
      attempts: 1,
      externalId: "remote-once",
    });
  });

  it("calls the provider once when the same message is delivered concurrently", async () => {
    const repository = new D1Repository(env.DB);
    const { post, publication } = pendingPost("pub-duplicate-concurrent");
    await repository.createPost(post, [publication]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      // Hold the winning claim open so the duplicate observes `publishing`.
      await new Promise(resolve => setTimeout(resolve, 10));
      return Response.json({ id: "remote-concurrent" });
    });

    const results = await Promise.all([
      deliver(publication.id, "message-a"),
      deliver(publication.id, "message-b"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(repository.getPublication(publication.id)).resolves.toMatchObject({
      status: "published",
      attempts: 1,
      externalId: "remote-concurrent",
    });
    // The duplicate is either acknowledged after the publish or rescheduled
    // while the claim is in flight; it is never dropped or republished.
    const settled = results
      .flatMap(result => [
        ...result.explicitAcks,
        ...result.retryMessages.map(message => message.msgId),
      ])
      .sort();
    expect(settled).toEqual(["message-a", "message-b"]);
  });
});

describe("provider failure classification through the Queue", () => {
  it.each([
    {
      name: "authentication rejection",
      status: 401,
      expectedStatus: "failed",
      expectedCode: "AUTH",
      ambiguous: false,
      retried: false,
    },
    {
      name: "explicit content rejection",
      status: 400,
      expectedStatus: "failed",
      expectedCode: "INVALID_CONTENT",
      ambiguous: false,
      retried: false,
    },
    {
      name: "rate limit",
      status: 429,
      expectedStatus: "pending",
      expectedCode: "RATE_LIMIT",
      ambiguous: false,
      retried: true,
    },
    {
      name: "provider 5xx after submission",
      status: 503,
      expectedStatus: "failed",
      expectedCode: "PROVIDER_UNAVAILABLE",
      ambiguous: true,
      retried: false,
    },
    {
      name: "unreadable success response",
      status: 200,
      expectedStatus: "failed",
      expectedCode: "UNKNOWN",
      ambiguous: true,
      retried: false,
    },
  ] as const)(
    "stores $expectedCode for a $status response and retries=$retried",
    async ({ status, expectedStatus, expectedCode, ambiguous, retried }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(createdAt));
      const repository = new D1Repository(env.DB);
      const publicationId = "pub-classify-" + status;
      const { post, publication } = pendingPost(publicationId);
      await repository.createPost(post, [publication]);
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        Response.json(
          status === 200 ? { ok: true } : { error: { message: "Provider response" } },
          { status },
        ),
      );

      const result = await deliver(publicationId, "message-classify");
      const stored = await repository.getPublication(publicationId);

      expect(stored).toMatchObject({
        status: expectedStatus,
        attempts: 1,
        errorCode: expectedCode,
        errorAmbiguous: ambiguous,
      });
      expect(stored?.retryAt).toBe(retried ? firstRetryAt : undefined);

      if (retried) {
        expect(result.retryMessages).toEqual([{ msgId: "message-classify" }]);
        expect(result.explicitAcks).toEqual([]);
      } else {
        expect(result.retryMessages).toEqual([]);
        expect(result.explicitAcks).toEqual(["message-classify"]);
      }
    },
  );

  it("treats an interrupted provider request as ambiguous and never retries it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(createdAt));
    const repository = new D1Repository(env.DB);
    const { post, publication } = pendingPost("pub-classify-network");
    await repository.createPost(post, [publication]);
    // The Threads adapter cannot tell whether an interrupted POST was accepted,
    // so it reports NETWORK as ambiguous. No installed adapter produces an
    // unambiguous NETWORK error; that policy branch is covered below.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new TypeError("Network connection lost");
    });

    const result = await deliver(publication.id, "message-network");
    const stored = await repository.getPublication(publication.id);

    expect(stored).toMatchObject({
      status: "failed",
      attempts: 1,
      errorCode: "NETWORK",
      errorAmbiguous: true,
    });
    expect(stored?.retryAt).toBeUndefined();
    expect(result).toMatchObject({
      explicitAcks: ["message-network"],
      retryMessages: [],
    });
  });

  it("retries a rate-limited publish per backoff window and publishes on the third attempt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(createdAt));
    const repository = new D1Repository(env.DB);
    const publicationId = "pub-retry-until-success";
    const { post, publication } = pendingPost(publicationId);
    await repository.createPost(post, [publication]);
    let call = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call += 1;
      return call < 3
        ? Response.json({ error: { message: "Rate limited" } }, { status: 429 })
        : Response.json({ id: "remote-after-retry" });
    });

    const first = await deliver(publicationId, "message-attempt-1");
    expect(first.retryMessages).toEqual([{ msgId: "message-attempt-1" }]);
    await expect(repository.getPublication(publicationId)).resolves.toMatchObject({
      status: "pending",
      attempts: 1,
      retryAt: firstRetryAt,
    });

    // Before the persisted deadline a duplicate is rescheduled, not delivered.
    vi.setSystemTime(new Date("2026-09-15T00:00:30.000Z"));
    const early = await deliver(publicationId, "message-early");
    expect(early.retryMessages).toEqual([{ msgId: "message-early" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(repository.getPublication(publicationId)).resolves.toMatchObject({
      status: "pending",
      attempts: 1,
      retryAt: firstRetryAt,
    });

    // At the 60-second deadline the second attempt runs and is rate limited.
    vi.setSystemTime(new Date(firstRetryAt));
    const second = await deliver(publicationId, "message-attempt-2");
    expect(second.retryMessages).toEqual([{ msgId: "message-attempt-2" }]);
    await expect(repository.getPublication(publicationId)).resolves.toMatchObject({
      status: "pending",
      attempts: 2,
      retryAt: secondRetryAt,
    });

    // At the 120-second deadline the third attempt publishes within the cap.
    vi.setSystemTime(new Date(secondRetryAt));
    const third = await deliver(publicationId, "message-attempt-3");
    expect(third).toMatchObject({
      explicitAcks: ["message-attempt-3"],
      retryMessages: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expect(repository.getPublication(publicationId)).resolves.toMatchObject({
      status: "published",
      attempts: 3,
      externalId: "remote-after-retry",
    });

    // A late duplicate of a published publication is acknowledged.
    const late = await deliver(publicationId, "message-late");
    expect(late).toMatchObject({
      explicitAcks: ["message-late"],
      retryMessages: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("retry policy classification", () => {
  it.each([
    { code: "RATE_LIMIT", ambiguous: false, retries: true },
    { code: "PROVIDER_UNAVAILABLE", ambiguous: false, retries: true },
    { code: "NETWORK", ambiguous: false, retries: true },
    { code: "NETWORK", ambiguous: true, retries: false },
    { code: "PROVIDER_UNAVAILABLE", ambiguous: true, retries: false },
    { code: "AUTH", ambiguous: false, retries: false },
    { code: "INVALID_CONTENT", ambiguous: false, retries: false },
    { code: "UNKNOWN", ambiguous: true, retries: false },
  ] as const)(
    "$code with ambiguous=$ambiguous retries=$retries below the cap",
    ({ code, ambiguous, retries }) => {
      const error = () => new PublishError("Provider failure", code, ambiguous);

      expect(shouldRetry(error(), 1)).toBe(retries);
      expect(shouldRetry(error(), 2)).toBe(retries);
      expect(shouldRetry(error(), 3)).toBe(false);
    },
  );
});
