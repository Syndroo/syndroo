import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type {
  Post,
  Publication,
  PublicationJob,
} from "@syndroo/core";

import worker from "../src/index.js";
import { D1Repository } from "../src/repository.js";

describe("publication queue", () => {
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
