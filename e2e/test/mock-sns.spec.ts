/**
 * v0.2.0 section 0.1 end-to-end gate.
 *
 * Each test runs the real bundled production Worker in an isolated local
 * Miniflare instance with local D1, the local Queue, and the Cron handler. The
 * only replacement is the network boundary: the production Threads adapter and
 * the official Bluesky SDK reach a loopback Mock SNS HTTP server through the
 * outbound policy, which allows only the three exact SNS endpoints.
 *
 * Nothing is mocked inside Syndroo: no repository double, no publisher double,
 * and no state-transition double. No real SNS endpoint is ever contacted.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SyndrooApi, type CreatePostBody } from "../src/client.js";
import {
  assertBundleReady,
  startHarness,
  type Harness,
} from "../src/harness.js";
import {
  MOCK_BLUESKY_CID,
  MOCK_BLUESKY_DID,
  type SnsRequestRecord,
} from "../src/mock-sns-server.js";
import {
  parseCreatePostResponse,
  publicationFor,
  type CreatePostResponse,
} from "../src/api-types.js";
import { MOCK_CREDENTIALS, redact } from "../src/redact.js";

const THREADS_PATH = "/me/threads";
const BLUESKY_SESSION_PATH = "/xrpc/com.atproto.server.createSession";
const BLUESKY_RECORD_PATH = "/xrpc/com.atproto.repo.createRecord";
const HOUR_MS = 60 * 60 * 1000;

let harness: Harness;
let api: SyndrooApi;
let started = false;

beforeAll(async () => {
  // Fail once, with remediation, when the packaged Worker bundle is missing or
  // stale rather than silently testing the wrong artifact.
  await assertBundleReady();
});

beforeEach(async () => {
  // Do not dispose an instance from an earlier test when startup fails: the
  // new harness only becomes visible here once it is running.
  started = false;
  const instance = await startHarness();
  harness = instance;
  api = new SyndrooApi(instance);
  started = true;
});

afterEach(async () => {
  if (!started) {
    return;
  }

  started = false;
  await harness.dispose();
});

describe("Mock SNS end-to-end gate", () => {
  it("publishes through the real Threads adapter over the full local path", async () => {
    const content = `Threads e2e content ${Date.now()}`;
    const created = await createPostOk({ content, platforms: ["threads"] });

    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ status: "queued" });
    expect(created.body.replayed).toBeUndefined();
    expect(created.body.enqueueDeferred).toBeUndefined();

    const post = await api.waitForPost(
      created.body.id,
      candidate => candidate.status === "published",
      { description: "the Threads publication to finish" },
    );
    const publication = publicationFor(post, "threads");

    expect(publication).toMatchObject({
      provider: "threads-native",
      status: "published",
      attempts: 1,
      externalId: "threads-e2e-1",
      content,
      errorAmbiguous: false,
    });
    expect(publication.externalUrl).toBeUndefined();

    // A separate HTTP status query reports the same persisted state.
    const fetched = await api.getPost(created.body.id);
    expect(fetched.status).toBe(200);
    expect(publicationFor(fetched.body, "threads").externalId).toBe(
      "threads-e2e-1",
    );

    const request = onlyRequest(
      harness.mockSns.requestsFor(THREADS_PATH),
      "Threads",
    );
    expect(request.method).toBe("POST");
    expect(request.sourceOrigin).toBe("https://graph.threads.net");
    expect(request.search).toBe("");
    expect(request.headers.authorization).toBe(
      `Bearer ${MOCK_CREDENTIALS.threadsAccessToken}`,
    );

    const form = new URLSearchParams(request.body);
    expect(form.get("text")).toBe(content);
    expect(form.get("media_type")).toBe("TEXT");
    expect(form.get("auto_publish_text")).toBe("true");

    // The public status response never exposes a configured credential.
    expect(redact(JSON.stringify(post))).toBe(JSON.stringify(post));
  });

  it("publishes through the real Bluesky SDK with overrides and reports partial on explicit Threads rejection", async () => {
    const sharedContent = `Shared e2e content ${Date.now()}`;
    const threadsContent = `${sharedContent} threads override`;
    const blueskyContent = `${sharedContent} bluesky override see https://example.test/page`;

    harness.mockSns.enqueuePlan("POST", THREADS_PATH, {
      kind: "json",
      status: 400,
      body: {
        error: { message: "Mock Threads rejected the post" },
      },
      label: "threads-rejected",
    });

    const created = await createPostOk({
      content: sharedContent,
      platforms: ["threads", "bluesky"],
      overrides: {
        threads: { content: threadsContent },
        bluesky: { content: blueskyContent },
      },
    });

    expect(created.status).toBe(202);

    const post = await api.waitForPost(
      created.body.id,
      candidate => candidate.status === "partial",
      { description: "the mixed Bluesky success and Threads rejection" },
    );
    const threadsPublication = publicationFor(post, "threads");
    const blueskyPublication = publicationFor(post, "bluesky");

    expect(threadsPublication).toMatchObject({
      status: "failed",
      attempts: 1,
      content: threadsContent,
      errorCode: "INVALID_CONTENT",
      errorAmbiguous: false,
    });
    expect(threadsPublication.externalId).toBeUndefined();
    expect(blueskyPublication).toMatchObject({
      status: "published",
      attempts: 1,
      content: blueskyContent,
      externalId: MOCK_BLUESKY_CID,
      externalUrl: `https://bsky.app/profile/${encodeURIComponent(
        MOCK_BLUESKY_DID,
      )}/post/e2emock1`,
    });

    // Independent content overrides reached the two providers.
    const threadsRequest = onlyRequest(
      harness.mockSns.requestsFor(THREADS_PATH),
      "Threads",
    );
    expect(new URLSearchParams(threadsRequest.body).get("text")).toBe(
      threadsContent,
    );

    const sessionRequest = onlyRequest(
      harness.mockSns.requestsFor(BLUESKY_SESSION_PATH),
      "Bluesky session",
    );
    expect(JSON.parse(sessionRequest.body)).toMatchObject({
      identifier: MOCK_CREDENTIALS.blueskyIdentifier,
      password: MOCK_CREDENTIALS.blueskyPassword,
    });

    const recordRequest = onlyRequest(
      harness.mockSns.requestsFor(BLUESKY_RECORD_PATH),
      "Bluesky record",
    );
    expect(recordRequest.headers.authorization).toBe(
      "Bearer e2e-access-jwt-not-a-real-secret",
    );
    expect(JSON.parse(recordRequest.body)).toMatchObject({
      repo: MOCK_BLUESKY_DID,
      collection: "app.bsky.feed.post",
      record: {
        text: blueskyContent,
        facets: [
          {
            features: [
              {
                $type: "app.bsky.richtext.facet#link",
                uri: "https://example.test/page",
              },
            ],
          },
        ],
      },
    });
  });

  it("keeps one logical Post and one remote write across HTTP replay and duplicate Queue delivery", async () => {
    const content = `Idempotent e2e content ${Date.now()}`;
    const idempotencyKey = `e2e-idempotency-${Date.now()}`;
    const body = { content, platforms: ["threads"] };
    const first = await createPostOk(body, { idempotencyKey });

    expect(first.status).toBe(202);

    const post = await api.waitForPost(
      first.body.id,
      candidate => candidate.status === "published",
      { description: "the first Threads publication" },
    );
    const publication = publicationFor(post, "threads");
    expect(harness.mockSns.countFor(THREADS_PATH)).toBe(1);

    // Same key, same request: the stored result is replayed.
    const replay = await api.createPost(body, { idempotencyKey });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      id: first.body.id,
      status: "published",
      replayed: true,
    });

    // Same key, different request: a conflict, not a second publication.
    const conflict = await api.createPost(
      { content: `${content} changed`, platforms: ["threads"] },
      { idempotencyKey },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });

    // Controlled duplicate Queue delivery of the same job.
    const firstDuplicate = await harness.deliverQueueMessage({
      publicationId: publication.id,
    });
    const secondDuplicate = await harness.deliverQueueMessage({
      publicationId: publication.id,
    });

    expect(firstDuplicate.explicitAcks).toHaveLength(1);
    expect(secondDuplicate.explicitAcks).toHaveLength(1);

    const after = await api.getPost(first.body.id);
    const finalPublication = publicationFor(after.body, "threads");

    expect(finalPublication).toMatchObject({
      status: "published",
      attempts: 1,
      externalId: "threads-e2e-1",
    });
    expect(harness.mockSns.countFor(THREADS_PATH)).toBe(1);

    const posts = await api.listPosts();
    expect(posts.filter(candidate => candidate.content === content)).toHaveLength(1);
  });

  it("exposes an ambiguous outcome and never republishes after redelivery or Cron", async () => {
    const content = `Ambiguous e2e content ${Date.now()}`;
    // The Mock SNS records the request and then drops the connection without a
    // response: the Worker cannot know whether the remote side accepted it.
    harness.mockSns.setResponder(record =>
      record.path === THREADS_PATH
        ? { kind: "destroy", label: "ambiguous-destroy" }
        : {
            kind: "json",
            status: 404,
            body: { error: "MOCK_SNS_UNROUTED" },
            label: "unrouted",
          },
    );

    const created = await createPostOk({ content, platforms: ["threads"] });
    const post = await api.waitForPost(
      created.body.id,
      candidate =>
        candidate.publications.every(
          publication =>
            publication.status !== "pending" &&
            publication.status !== "publishing",
        ),
      { description: "the ambiguous Threads outcome to be recorded" },
    );
    const publication = publicationFor(post, "threads");
    const receipts = harness.mockSns.countFor(THREADS_PATH);

    expect(publication.status).toBe("failed");
    expect(publication.errorAmbiguous).toBe(true);
    expect(publication.attempts).toBe(1);
    // A transport failure injected through the harness surfaces inside workerd
    // as an opaque HTTP 500, so Syndroo records the conservative ambiguous
    // classification rather than claiming a definite rejection. The contract
    // asserted here is ambiguity plus exactly one remote receipt, not the code.
    expect(["UNKNOWN", "NETWORK", "PROVIDER_UNAVAILABLE"]).toContain(
      publication.errorCode,
    );
    expect(publication.errorMessage).toBeTruthy();
    // Exactly one remote receipt: the adapter performs one publish call, so a
    // second receipt would itself be a duplicate-write bug.
    expect(receipts).toBe(1);
    expect(harness.mockSns.requestsFor(THREADS_PATH)[0]?.plan).toBe(
      "ambiguous-destroy",
    );

    // Controlled redelivery of the Queue message: no second provider call.
    const redelivery = await harness.deliverQueueMessage({
      publicationId: publication.id,
    });
    expect(redelivery.explicitAcks).toHaveLength(1);

    // Cron recovery far past the 15 minute staleness cutoff: still no retry,
    // because an ambiguous result is never republished automatically.
    await harness.runScheduled(Date.now() + HOUR_MS);

    const after = await api.getPost(created.body.id);
    expect(publicationFor(after.body, "threads")).toMatchObject({
      status: "failed",
      errorAmbiguous: true,
      attempts: 1,
    });
    expect(await api.listPosts()).toHaveLength(1);
    expect(harness.mockSns.countFor(THREADS_PATH)).toBe(receipts);

    // Redacted diagnostics: the failure never echoes a configured credential.
    expect(redact(JSON.stringify(after.body))).toBe(JSON.stringify(after.body));
  });

  it("delivers a scheduled publication at the controlled due time without a 15 minute wait", async () => {
    const content = `Scheduled e2e content ${Date.now()}`;
    const dueAt = Date.now() + 60_000;
    const created = await createPostOk({
      content,
      platforms: ["threads"],
      scheduledAt: new Date(dueAt).toISOString(),
    });

    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({
      status: "scheduled",
      scheduledAt: new Date(dueAt).toISOString(),
    });

    // Cron one second before the due time: nothing is published.
    await harness.runScheduled(dueAt - 1_000);
    const early = await api.getPost(created.body.id);

    expect(early.body.status).toBe("scheduled");
    expect(publicationFor(early.body, "threads").status).toBe("scheduled");
    expect(harness.mockSns.requests).toHaveLength(0);

    // Cron exactly at the due time: the real Queue delivers to the real adapter.
    await harness.runScheduled(dueAt);
    const post = await api.waitForPost(
      created.body.id,
      candidate => candidate.status === "published",
      { description: "the scheduled Threads publication" },
    );

    expect(publicationFor(post, "threads")).toMatchObject({
      status: "published",
      attempts: 1,
      externalId: "threads-e2e-1",
    });
    expect(harness.mockSns.countFor(THREADS_PATH)).toBe(1);
  });
});

function onlyRequest(
  records: readonly SnsRequestRecord[],
  label: string,
): SnsRequestRecord {
  const [record] = records;

  if (!record || records.length !== 1) {
    throw new Error(
      `Expected exactly one ${label} request, found ${records.length}.\n` +
        harness.diagnostics(),
    );
  }

  return record;
}

/**
 * Create a post and require the documented success contract: HTTP 202 for a
 * new post or HTTP 200 for an idempotent replay.
 */
async function createPostOk(
  body: CreatePostBody,
  options: { idempotencyKey?: string } = {},
): Promise<{ status: number; body: CreatePostResponse }> {
  const result = await api.createPost(body, options);

  if (result.status !== 202 && result.status !== 200) {
    throw new Error(
      `Expected post creation to succeed, received HTTP ${result.status}: ` +
        `${JSON.stringify(result.body)}\n${harness.diagnostics()}`,
    );
  }

  return { status: result.status, body: parseCreatePostResponse(result.body) };
}
