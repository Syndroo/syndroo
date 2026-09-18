/**
 * Direct publishing-execution coverage. These tests call `executePublication`
 * with the concrete D1 repository and a fail-closed `fetch` stub, so publishing
 * behavior is exercised without constructing a Cloudflare Queue `MessageBatch`.
 * Queue validation and ack/retry mapping stay covered by `jobs.spec.ts`.
 */
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PublishError, type Post, type Publication } from "@syndroo/core";

import { executePublication } from "../src/publishing.js";
import { D1Repository, type StoredPublication } from "../src/repository.js";

const createdAt = "2026-09-15T00:00:00.000Z";
const firstRetryAt = "2026-09-15T00:01:00.000Z";
const secondRetryAt = "2026-09-15T00:03:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function createPublication(
  id: string,
): Promise<{ repository: D1Repository; postId: string }> {
  const repository = new D1Repository(env.DB);
  const post: Post = {
    id: id + "-post",
    content: "Direct execution content",
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
  return { repository, postId: post.id };
}

async function run(
  id: string,
  repository: D1Repository,
): Promise<Awaited<ReturnType<typeof executePublication>>> {
  return executePublication(id, repository, env);
}

/** Real D1 for the claim, fault injected only on the duplicate-state read. */
class FailingReadRepository extends D1Repository {
  override async getPublication(): Promise<StoredPublication | null> {
    throw new Error("injected publication read failure");
  }
}

describe("direct publication execution", () => {
  it("publishes a claimable publication and returns ack without a Queue batch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(createdAt));
    const { repository } = await createPublication("pub-direct-success");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ id: "remote-direct" }));

    await expect(run("pub-direct-success", repository)).resolves.toEqual({
      action: "ack",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(
      repository.getPublication("pub-direct-success"),
    ).resolves.toMatchObject({
      status: "published",
      attempts: 1,
      externalId: "remote-direct",
    });
  });

  it("returns the delay for the persisted earliest retry time and keeps it internal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(createdAt));
    const { repository, postId } = await createPublication("pub-direct-retry");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: { message: "Rate limited" } }, { status: 429 }),
    );

    await expect(run("pub-direct-retry", repository)).resolves.toEqual({
      action: "retry",
      delaySeconds: 60,
    });

    const stored = await repository.getPublication("pub-direct-retry");
    expect(stored).toMatchObject({
      status: "pending",
      attempts: 1,
      errorCode: "RATE_LIMIT",
      retryAt: firstRetryAt,
    });
    // The retry time gates the next claim but is not part of the public shape.
    expect((await repository.getPost(postId))?.publications[0]).not.toHaveProperty(
      "retryAt",
    );
  });

  it("keeps an ambiguous provider outcome failed and acked for manual checking", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(createdAt));
    const { repository } = await createPublication("pub-direct-ambiguous");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json({ error: { message: "Unavailable" } }, { status: 503 }),
      );

    await expect(run("pub-direct-ambiguous", repository)).resolves.toEqual({
      action: "ack",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = await repository.getPublication("pub-direct-ambiguous");
    expect(stored).toMatchObject({
      status: "failed",
      attempts: 1,
      errorCode: "PROVIDER_UNAVAILABLE",
      errorAmbiguous: true,
    });
    expect(stored?.retryAt).toBeUndefined();
  });

  it("parks a duplicate delivery on a live claim for the stale-claim window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(createdAt));
    const { repository } = await createPublication("pub-direct-live-claim");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    // Another consumer won the claim and is still inside the provider call.
    await repository.claimPublication("pub-direct-live-claim", createdAt);

    await expect(run("pub-direct-live-claim", repository)).resolves.toEqual({
      action: "retry",
      delaySeconds: 900,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      repository.getPublication("pub-direct-live-claim"),
    ).resolves.toMatchObject({ status: "publishing", attempts: 1 });
  });

  it("returns the remaining wait for a duplicate before the persisted retry time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(createdAt));
    const { repository } = await createPublication("pub-direct-early");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await repository.claimPublication("pub-direct-early", createdAt);
    await repository.markFailed(
      "pub-direct-early",
      new PublishError("Threads rate limited", "RATE_LIMIT"),
      true,
      createdAt,
    );

    vi.setSystemTime(new Date("2026-09-15T00:00:30.000Z"));

    await expect(run("pub-direct-early", repository)).resolves.toEqual({
      action: "retry",
      delaySeconds: 30,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      repository.getPublication("pub-direct-early"),
    ).resolves.toMatchObject({
      status: "pending",
      attempts: 1,
      retryAt: firstRetryAt,
    });
  });

  it("reaches the attempt cap and acknowledges the terminal failure", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(createdAt));
    const { repository } = await createPublication("pub-direct-cap");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: { message: "Rate limited" } }, { status: 429 }),
    );

    await expect(run("pub-direct-cap", repository)).resolves.toEqual({
      action: "retry",
      delaySeconds: 60,
    });

    vi.setSystemTime(new Date(firstRetryAt));
    await expect(run("pub-direct-cap", repository)).resolves.toEqual({
      action: "retry",
      delaySeconds: 120,
    });

    vi.setSystemTime(new Date(secondRetryAt));
    await expect(run("pub-direct-cap", repository)).resolves.toEqual({
      action: "ack",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const stored = await repository.getPublication("pub-direct-cap");
    expect(stored).toMatchObject({
      status: "failed",
      attempts: 3,
      errorCode: "RATE_LIMIT",
    });
    expect(stored?.retryAt).toBeUndefined();
  });

  it("acknowledges a delivery whose publication no longer exists", async () => {
    const repository = new D1Repository(env.DB);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(run("pub-direct-missing", repository)).resolves.toEqual({
      action: "ack",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries the delivery when the atomic claim fails", async () => {
    const { repository } = await createPublication("pub-direct-claim-fault");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await env.DB.prepare(
      "CREATE TRIGGER fail_direct_claim BEFORE UPDATE ON publications " +
        "WHEN NEW.id = 'pub-direct-claim-fault' " +
        "BEGIN SELECT RAISE(ABORT, 'injected claim failure'); END",
    ).run();

    try {
      await expect(run("pub-direct-claim-fault", repository)).resolves.toEqual({
        action: "retry",
        delaySeconds: 60,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(
        repository.getPublication("pub-direct-claim-fault"),
      ).resolves.toMatchObject({ status: "pending", attempts: 0 });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_direct_claim").run();
    }
  });

  it("retries the delivery when the duplicate-state read fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(createdAt));
    const { repository } = await createPublication("pub-direct-read-fault");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    // The claim is already taken, so the executor has to read the stored state;
    // that read is the fault under test.
    await repository.claimPublication("pub-direct-read-fault", createdAt);

    await expect(
      run("pub-direct-read-fault", new FailingReadRepository(env.DB)),
    ).resolves.toEqual({ action: "retry", delaySeconds: 60 });

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      repository.getPublication("pub-direct-read-fault"),
    ).resolves.toMatchObject({ status: "publishing", attempts: 1 });
  });

  it.each([
    {
      name: "provider success result",
      suffix: "success",
      respond: async () => Response.json({ id: "remote-faulted" }),
      aggregateChange: "NEW.status = 'published'",
    },
    {
      name: "provider failure result",
      suffix: "failure",
      respond: async () =>
        Response.json({ error: { message: "Rate limited" } }, { status: 429 }),
      aggregateChange: "NEW.status != 'publishing'",
    },
  ] as const)(
    "retries the delivery when the $name cannot be persisted",
    async ({ suffix, respond, aggregateChange }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(createdAt));
      const publicationId = "pub-direct-persist-fault-" + suffix;
      const { repository, postId } = await createPublication(publicationId);
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(respond);
      const trigger = "fail_direct_persist_" + suffix;
      await env.DB.prepare(
        "CREATE TRIGGER " + trigger + " BEFORE UPDATE ON posts " +
          "WHEN OLD.id = '" + postId + "' AND " + aggregateChange + " " +
          "BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END",
      ).run();

      try {
        await expect(run(publicationId, repository)).resolves.toEqual({
          action: "retry",
          delaySeconds: 60,
        });
        // The claim committed before the provider call; only the result
        // transaction rolls back, so the publication stays claimed with no
        // stored retry time instead of being re-sent to the provider.
        const stored = await repository.getPublication(publicationId);
        expect(stored).toMatchObject({ status: "publishing", attempts: 1 });
        expect(stored?.retryAt).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        await env.DB.prepare("DROP TRIGGER " + trigger).run();
      }

      // The failed transaction leaves the claim owned, so a later delivery is
      // parked instead of resending content. Only stale-claim recovery settles
      // it; that path is covered by `orchestration.spec.ts`.
      await expect(run(publicationId, repository)).resolves.toEqual({
        action: "retry",
        delaySeconds: 900,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(repository.getPublication(publicationId)).resolves.toMatchObject({
        status: "publishing",
        attempts: 1,
      });
    },
  );
});
