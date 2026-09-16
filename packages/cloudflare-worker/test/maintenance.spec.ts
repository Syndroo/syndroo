import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Post, Publication, PublicationJob } from "@syndroo/core";

import worker from "../src/index.js";
import { D1Repository } from "../src/repository.js";

const origin = "https://syndroo.test";
const scheduledAt = "2030-01-02T03:04:05.000Z";
const authHeaders = {
  authorization: "Bearer test-api-key",
  "content-type": "application/json",
};

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];

  if (typeof field !== "string") {
    throw new Error(`Expected ${key} to be a string`);
  }

  return field;
}

// `wrangler types` narrows the configured default to the literal "false", so
// widen the binding before overriding it. `undefined` models a deployment where
// the optional variable was never set.
function maintenanceEnv(value?: string): Env {
  const { SYNDROO_MAINTENANCE: _configured, ...rest } = env;
  const widened: Omit<Env, "SYNDROO_MAINTENANCE"> & {
    SYNDROO_MAINTENANCE?: string;
  } = value === undefined ? rest : { ...rest, SYNDROO_MAINTENANCE: value };

  return widened as Env;
}

function createRequest(
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${origin}/v1/posts`, {
    method: "POST",
    headers: { ...authHeaders, ...headers },
    body,
  });
}

function scheduledBody(content: string): string {
  return JSON.stringify({
    content,
    platforms: ["threads"],
    scheduledAt,
  });
}

describe("maintenance admission gate", () => {
  it("rejects an authenticated POST before body, idempotency, and database work", async () => {
    const guarded: Env = {
      ...maintenanceEnv("true"),
      DB: {
        prepare() {
          throw new Error("Unexpected database access");
        },
      } as unknown as D1Database,
      PUBLICATION_QUEUE: {
        sendBatch() {
          throw new Error("Unexpected queue access");
        },
      } as unknown as Env["PUBLICATION_QUEUE"],
    };
    const attempts: Array<{ headers: Record<string, string>; body: string }> = [
      {
        headers: { "idempotency-key": "maintenance-valid-key" },
        body: "not json",
      },
      {
        headers: { "idempotency-key": "not a valid key!" },
        body: "not json",
      },
      { headers: { "content-type": "text/plain" }, body: "{" },
    ];

    for (const attempt of attempts) {
      const response = await worker.fetch(
        createRequest(attempt.body, attempt.headers),
        guarded,
      );

      expect(response.status).toBe(503);
      await expect(json(response)).resolves.toEqual({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: expect.stringContaining("maintenance"),
        },
      });
    }

    await expect(
      new D1Repository(env.DB).getPostByIdempotencyKey("maintenance-valid-key"),
    ).resolves.toBeNull();
  });

  it("requires bearer authentication before the maintenance gate", async () => {
    const response = await worker.fetch(
      new Request(`${origin}/v1/posts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: scheduledBody("Unauthorized"),
      }),
      maintenanceEnv("true"),
    );

    expect(response.status).toBe(401);
    await expect(json(response)).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("keeps health checks and authenticated queries available", async () => {
    const created = await worker.fetch(
      createRequest(scheduledBody("Accepted before maintenance")),
      maintenanceEnv("false"),
    );
    expect(created.status).toBe(202);
    const id = stringField(await json(created), "id");
    const blocked = maintenanceEnv("true");

    const health = await worker.fetch(new Request(`${origin}/health`), blocked);
    expect(health.status).toBe(200);
    await expect(json(health)).resolves.toEqual({ status: "ok" });

    const list = await worker.fetch(
      new Request(`${origin}/v1/posts`, { headers: authHeaders }),
      blocked,
    );
    expect(list.status).toBe(200);
    await expect(json(list)).resolves.toMatchObject({ items: expect.any(Array) });

    const detail = await worker.fetch(
      new Request(`${origin}/v1/posts/${id}`, { headers: authHeaders }),
      blocked,
    );
    expect(detail.status).toBe(200);
    await expect(json(detail)).resolves.toMatchObject({
      id,
      status: "scheduled",
    });
  });

  it.each([undefined, "false", "FALSE", "1", " true", ""])(
    "keeps normal operation when SYNDROO_MAINTENANCE is %j",
    async value => {
      const response = await worker.fetch(
        createRequest(scheduledBody("Normal operation")),
        maintenanceEnv(value),
      );

      expect(response.status).toBe(202);
    },
  );

  it("rejects a replay while blocked and replays the stored post afterwards", async () => {
    const key = "maintenance-replay-key";
    const body = scheduledBody("Replay across maintenance");
    const first = await worker.fetch(
      createRequest(body, { "idempotency-key": key }),
      maintenanceEnv("false"),
    );
    expect(first.status).toBe(202);
    const firstId = stringField(await json(first), "id");

    const blocked = await worker.fetch(
      createRequest(body, { "idempotency-key": key }),
      maintenanceEnv("true"),
    );
    expect(blocked.status).toBe(503);
    await expect(json(blocked)).resolves.toMatchObject({
      error: { code: "SERVICE_UNAVAILABLE" },
    });

    const replay = await worker.fetch(
      createRequest(body, { "idempotency-key": key }),
      maintenanceEnv("false"),
    );
    expect(replay.status).toBe(200);
    await expect(json(replay)).resolves.toMatchObject({
      id: firstId,
      replayed: true,
    });

    const fresh = await worker.fetch(
      createRequest(body, { "idempotency-key": `${key}-2` }),
      maintenanceEnv("false"),
    );
    expect(fresh.status).toBe(202);
    expect(stringField(await json(fresh), "id")).not.toBe(firstId);
  });

  it("keeps Queue delivery running for work accepted before maintenance", async () => {
    const repository = new D1Repository(env.DB);
    const createdAt = "2026-09-15T00:00:00.000Z";
    const post: Post = {
      id: "post-maintenance-queue",
      content: "Accepted before maintenance",
      platforms: ["threads"],
      status: "queued",
      createdAt,
    };
    const publication: Publication = {
      id: "pub-maintenance-queue",
      postId: post.id,
      platform: "threads",
      provider: "threads-native",
      content: post.content,
      status: "pending",
      attempts: 0,
      createdAt,
    };
    await repository.createPost(post, [publication]);
    const providerRequest = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json({ id: "maintenance-remote-id" }, { status: 200 }),
      );
    const batch = createMessageBatch<PublicationJob>("syndroo-publications", [
      {
        id: "maintenance-queue-message",
        timestamp: new Date(),
        attempts: 1,
        body: { publicationId: publication.id },
      },
    ]);
    const context = createExecutionContext();

    await worker.queue(batch, maintenanceEnv("true"));

    expect((await getQueueResult(batch, context)).explicitAcks).toEqual([
      "maintenance-queue-message",
    ]);
    expect(providerRequest).toHaveBeenCalledTimes(1);
    await expect(repository.getPublication(publication.id)).resolves.toMatchObject({
      status: "published",
      externalId: "maintenance-remote-id",
    });
  });

  it("keeps Cron dispatch running while new posts are rejected", async () => {
    const repository = new D1Repository(env.DB);
    const createdAt = "2026-09-15T00:00:00.000Z";
    const dueAt = "2026-09-15T00:05:00.000Z";
    const post: Post = {
      id: "post-maintenance-cron",
      content: "Scheduled before maintenance",
      platforms: ["threads"],
      status: "scheduled",
      createdAt,
      scheduledAt: dueAt,
    };
    const publication: Publication = {
      id: "pub-maintenance-cron",
      postId: post.id,
      platform: "threads",
      provider: "threads-native",
      content: post.content,
      status: "scheduled",
      attempts: 0,
      createdAt,
      scheduledAt: dueAt,
    };
    await repository.createPost(post, [publication]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ id: "maintenance-cron-id" }, { status: 200 }),
    );

    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.parse(dueAt) }),
      maintenanceEnv("true"),
    );

    const row = await env.DB.prepare(
      "SELECT enqueued_at FROM publications WHERE id = ?",
    )
      .bind(publication.id)
      .first<{ enqueued_at: string | null }>();
    expect(row?.enqueued_at).toBe(dueAt);
  });
});
