/**
 * v0.2.0 section 0 orchestration gates. These tests drive the real Worker:
 * HTTP route, local D1, the local Queue binding, the `scheduled` handler, and
 * the native Threads adapter. Provider responses come from a fail-closed
 * global `fetch` stub, so no request can reach a real social network.
 *
 * D1 storage is not reset between tests in this file, so every assertion is
 * scoped to the ids created by the test that makes it.
 */
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Post, Publication, PublicationJob } from "@syndroo/core";

import worker from "../src/index.js";
import { D1Repository } from "../src/repository.js";

const origin = "https://syndroo.test";
const threadsOrigin = "https://graph.threads.net";
const createdAt = "2026-09-15T00:00:00.000Z";
const authHeaders = {
  authorization: "Bearer test-api-key",
  "content-type": "application/json",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Fail-closed provider double. Only the Threads API origin is reachable and
 * every response is supplied by the test; any other outbound request throws
 * before it can leave the Worker.
 */
function controlThreadsProvider(
  respond: (call: number) => Response | Promise<Response>,
) {
  let call = 0;

  return vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const url = requestUrl(input);

    if (new URL(url).origin !== threadsOrigin) {
      throw new Error("Blocked outbound request to " + url);
    }

    call += 1;
    return respond(call);
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  return input instanceof URL ? input.href : input.url;
}

async function createPostRequest(
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<Response> {
  return exports.default.fetch(origin + "/v1/posts", {
    method: "POST",
    headers: idempotencyKey
      ? { ...authHeaders, "idempotency-key": idempotencyKey }
      : authHeaders,
    body: JSON.stringify(body),
  });
}

async function readPostDetail(
  id: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await exports.default.fetch(origin + "/v1/posts/" + id, {
    headers: authHeaders,
  });

  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function publicationFor(postId: string): Promise<Publication> {
  const detail = await new D1Repository(env.DB).getPost(postId);
  const publication = detail?.publications[0];

  if (!publication) {
    throw new Error("Expected a publication for " + postId);
  }

  return publication;
}

/** Publication ids recorded by a spied `PUBLICATION_QUEUE.sendBatch`. */
function enqueuedIds(send: { mock: { calls: unknown[][] } }): string[] {
  return send.mock.calls.flatMap(call =>
    [...((call[0] ?? []) as Iterable<{ body: PublicationJob }>)].map(
      message => message.body.publicationId,
    ),
  );
}

function postIdOf(created: Record<string, unknown>): string {
  const id = created.id;

  if (typeof id !== "string") {
    throw new Error("Expected the create response to include a Post id");
  }

  return id;
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await condition()) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for " + description);
}

describe("concurrent idempotent creation", () => {
  it("creates one Post and one provider publish for identical concurrent requests", async () => {
    const fetchMock = controlThreadsProvider(() =>
      Response.json({ id: "remote-idempotent" }),
    );
    const request = () =>
      createPostRequest(
        { content: "Identical request", platforms: ["threads"] },
        "orchestration:identical",
      );

    const responses = await Promise.all([request(), request()]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 202]);

    const bodies = (await Promise.all(
      responses.map(response => response.json()),
    )) as Record<string, unknown>[];
    const postId = postIdOf(bodies[0] ?? {});
    expect(bodies.map(body => body.id)).toEqual([postId, postId]);
    expect(bodies.filter(body => body.replayed === true)).toHaveLength(1);

    const storedPosts = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM posts WHERE idempotency_key = ?",
    )
      .bind("orchestration:identical")
      .first<{ count: number }>();
    expect(storedPosts?.count).toBe(1);

    await waitForCondition(
      async () => (await publicationFor(postId)).status === "published",
      "the single provider publish",
    );

    // One Post, one publication, and exactly one provider request even though
    // two requests were accepted concurrently.
    const storedPublications = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM publications WHERE post_id = ?",
    )
      .bind(postId)
      .first<{ count: number }>();
    expect(storedPublications?.count).toBe(1);
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it("keeps the conflict response for concurrent requests with different content", async () => {
    const fetchMock = controlThreadsProvider(() =>
      Response.json({ id: "remote-conflict" }),
    );
    const request = (content: string) =>
      createPostRequest(
        { content, platforms: ["threads"] },
        "orchestration:conflict",
      );

    const responses = await Promise.all([
      request("First body"),
      request("Second body"),
    ]);
    const ordered = [...responses].sort(
      (left, right) => left.status - right.status,
    );
    expect(ordered.map(response => response.status)).toEqual([202, 409]);
    await expect(ordered[1]?.json()).resolves.toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });

    const stored = await env.DB.prepare(
      "SELECT id, content FROM posts WHERE idempotency_key = ?",
    )
      .bind("orchestration:conflict")
      .all<{ id: string; content: string }>();
    expect(stored.results).toHaveLength(1);
    const postId = stored.results[0]?.id;
    expect(["First body", "Second body"]).toContain(
      stored.results[0]?.content,
    );

    if (!postId) {
      throw new Error("Expected the stored Post id");
    }

    await waitForCondition(
      async () => (await publicationFor(postId)).status === "published",
      "the single provider publish",
    );
    expect(fetchMock.mock.calls).toHaveLength(1);
  });
});

describe("outbox recovery through the scheduled handler", () => {
  it("recovers a Post whose Queue enqueue failed on the next Cron run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(createdAt));
    const repository = new D1Repository(env.DB);
    const fetchMock = controlThreadsProvider(() =>
      Response.json({ id: "remote-recovered" }),
    );
    const send = vi.spyOn(
      env.PUBLICATION_QUEUE as Queue<PublicationJob>,
      "sendBatch",
    );
    send.mockRejectedValueOnce(new Error("Queue unavailable"));

    const response = await createPostRequest({
      content: "Recover me",
      platforms: ["threads"],
    });
    expect(response.status).toBe(202);
    const created = (await response.json()) as Record<string, unknown>;
    const postId = postIdOf(created);
    expect(created).toMatchObject({ status: "queued", enqueueDeferred: true });

    const publication = await publicationFor(postId);
    expect(publication).toMatchObject({ status: "pending", attempts: 0 });
    expect(publication.enqueuedAt).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(enqueuedIds(send)).toEqual([publication.id]);

    // The next Cron pass finds the un-enqueued row and publishes it through the
    // real Queue binding and the real Threads adapter.
    vi.setSystemTime(new Date("2026-09-15T00:15:00.000Z"));
    await worker.scheduled(
      createScheduledController({
        scheduledTime: Date.parse("2026-09-15T00:15:00.000Z"),
      }),
      env,
    );
    await waitForCondition(
      async () =>
        (await repository.getPublication(publication.id))?.status ===
        "published",
      "the Cron recovery to publish the pending publication",
    );

    expect(enqueuedIds(send)).toEqual([publication.id, publication.id]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(repository.getPublication(publication.id)).resolves.toMatchObject({
      status: "published",
      attempts: 1,
      externalId: "remote-recovered",
      enqueuedAt: "2026-09-15T00:15:00.000Z",
    });
    await expect(readPostDetail(postId)).resolves.toMatchObject({
      status: 200,
      body: { status: "published" },
    });
  });

  it("re-enqueues a pending publication only after its enqueue lease expires", async () => {
    const repository = new D1Repository(env.DB);
    const post: Post = {
      id: "post-enqueue-lease",
      content: "Lease boundary",
      platforms: ["threads"],
      status: "queued",
      createdAt,
    };
    const publication: Publication = {
      id: "pub-enqueue-lease",
      postId: post.id,
      platform: "threads",
      provider: "threads-native",
      content: post.content,
      status: "pending",
      attempts: 0,
      createdAt: post.createdAt,
    };
    await repository.createPost(post, [publication]);
    await repository.markEnqueued([publication.id], createdAt);
    const send = vi
      .spyOn(env.PUBLICATION_QUEUE as Queue<PublicationJob>, "sendBatch")
      .mockResolvedValue({} as QueueSendBatchResponse);

    // Exactly one lease later the row still counts as enqueued: the selection
    // predicate uses `enqueued_at < cutoff`, not `<=`.
    await worker.scheduled(
      createScheduledController({
        scheduledTime: Date.parse("2026-09-15T00:15:00.000Z"),
      }),
      env,
    );
    expect(enqueuedIds(send)).toEqual([]);
    await expect(repository.getPublication(publication.id)).resolves.toMatchObject({
      status: "pending",
      attempts: 0,
      enqueuedAt: createdAt,
    });

    // One millisecond past the lease the publication is selected again.
    await worker.scheduled(
      createScheduledController({
        scheduledTime: Date.parse("2026-09-15T00:15:00.001Z"),
      }),
      env,
    );
    expect(enqueuedIds(send)).toEqual([publication.id]);
    await expect(repository.getPublication(publication.id)).resolves.toMatchObject({
      status: "pending",
      attempts: 0,
      enqueuedAt: "2026-09-15T00:15:00.001Z",
    });

    // D1 storage is shared between tests in this file, so leave the row
    // terminal: a later test's Cron pass would otherwise re-enqueue it.
    await repository.markPublished(
      publication.id,
      "remote-lease",
      undefined,
      "2026-09-15T00:15:00.001Z",
    );
  });
});

describe("ambiguous provider outcome", () => {
  it("does not republish after a provider timeout, duplicate delivery, or Cron", async () => {
    const repository = new D1Repository(env.DB);
    const fetchMock = controlThreadsProvider(() => {
      throw new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      );
    });

    const response = await createPostRequest({
      content: "Times out",
      platforms: ["threads"],
    });
    expect(response.status).toBe(202);
    const postId = postIdOf((await response.json()) as Record<string, unknown>);

    await waitForCondition(
      async () => (await publicationFor(postId)).status === "failed",
      "the ambiguous failure to persist",
    );
    const publication = await publicationFor(postId);
    await expect(repository.getPublication(publication.id)).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      errorCode: "NETWORK",
      errorAmbiguous: true,
    });
    expect(
      (await repository.getPublication(publication.id))?.retryAt,
    ).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A duplicate Queue delivery of the ambiguous failure is acknowledged
    // without another provider call.
    const batch = createMessageBatch<PublicationJob>("syndroo-publications", [
      {
        id: "message-ambiguous-duplicate",
        timestamp: new Date(),
        attempts: 1,
        body: { publicationId: publication.id },
      },
    ]);
    const context = createExecutionContext();
    await worker.queue(batch, env);
    await expect(getQueueResult(batch, context)).resolves.toMatchObject({
      explicitAcks: ["message-ambiguous-duplicate"],
      retryMessages: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Cron neither selects a failed publication nor recovers it: the remote
    // platform may already hold the post.
    await worker.scheduled(
      createScheduledController({
        scheduledTime: Date.parse("2026-09-15T00:16:00.000Z"),
      }),
      env,
    );
    await worker.scheduled(
      createScheduledController({
        scheduledTime: Date.parse("2026-09-15T00:31:00.000Z"),
      }),
      env,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(repository.getPublication(publication.id)).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      errorAmbiguous: true,
    });

    await expect(readPostDetail(postId)).resolves.toMatchObject({
      status: 200,
      body: {
        status: "failed",
        publications: [
          {
            status: "failed",
            errorCode: "NETWORK",
            errorAmbiguous: true,
            attempts: 1,
          },
        ],
      },
    });
  });
});

describe("stale publishing recovery through the scheduled handler", () => {
  it("marks a stale publishing publication ambiguous and aggregates its Post", async () => {
    const repository = new D1Repository(env.DB);
    const fetchMock = controlThreadsProvider(() => {
      throw new Error("The provider must not be called by stale recovery");
    });
    const post: Post = {
      id: "post-stale-publishing",
      content: "Recover me",
      platforms: ["threads"],
      status: "queued",
      createdAt,
    };
    const publication: Publication = {
      id: "pub-stale-publishing",
      postId: post.id,
      platform: "threads",
      provider: "threads-native",
      content: post.content,
      status: "pending",
      attempts: 0,
      createdAt: post.createdAt,
    };
    await repository.createPost(post, [publication]);
    await repository.claimPublication(publication.id, createdAt);
    await repository.markEnqueued([publication.id], createdAt);

    // Exactly at the 15-minute publishing timeout the claim is still live.
    await worker.scheduled(
      createScheduledController({
        scheduledTime: Date.parse("2026-09-15T00:15:00.000Z"),
      }),
      env,
    );
    await expect(repository.getPublication(publication.id)).resolves.toMatchObject({
      status: "publishing",
      attempts: 1,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // One second later recovery preserves ambiguity, clears retry eligibility,
    // and refreshes the Post aggregate in the same transaction.
    await worker.scheduled(
      createScheduledController({
        scheduledTime: Date.parse("2026-09-15T00:15:01.000Z"),
      }),
      env,
    );
    await expect(repository.getPublication(publication.id)).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      errorCode: "UNKNOWN",
      errorAmbiguous: true,
    });
    expect(
      (await repository.getPublication(publication.id))?.retryAt,
    ).toBeUndefined();
    await expect(readPostDetail(post.id)).resolves.toMatchObject({
      status: 200,
      body: {
        status: "failed",
        publications: [
          {
            status: "failed",
            errorCode: "UNKNOWN",
            errorAmbiguous: true,
          },
        ],
      },
    });

    // A later Cron pass does not re-enqueue or replay the ambiguous outcome.
    await worker.scheduled(
      createScheduledController({
        scheduledTime: Date.parse("2026-09-15T00:30:01.000Z"),
      }),
      env,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
