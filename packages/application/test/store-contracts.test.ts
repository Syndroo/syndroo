import { describe, expect, it } from "vitest";

import {
  JobQueueError,
  envelopeForJob,
  type SlotMutation,
} from "../src/index.js";
import {
  FIXTURE_NOW,
  createSnapshotFake,
  createSnapshotFakeHarness,
  createTransaction,
  instant,
  runStoreContractScenarios,
  testEnvelope,
} from "../src/testing/index.js";

function claimInput() {
  return {
    jobId: "job_0001",
    publicationId: "pub_0001",
    attemptNo: 1,
    now: FIXTURE_NOW,
    credentialSlotRevision: 0,
    claimToken: "claim_0001",
    attemptId: "attempt_0001",
  } as const;
}

function slotSet(): SlotMutation {
  return {
    platform: "x",
    expectedRevision: 0,
    now: FIXTURE_NOW,
    change: {
      kind: "set",
      bindingId: "bind-1",
      envelope: testEnvelope("one"),
      payloadRevision: 1,
      payloadSchemaVersion: 1,
      expiresAt: null,
      target: null,
    },
  };
}

describe("portable store contract suite", () => {
  it("passes every scenario against the rollback-capable fake", async () => {
    const report = await runStoreContractScenarios(createSnapshotFakeHarness());
    const failures = report.scenarios
      .filter((scenario) => scenario.status === "fail")
      .map((scenario) => `${scenario.id}: ${scenario.detail}`);
    expect(failures).toEqual([]);
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThanOrEqual(20);
  });
});

describe("rollback-capable fake", () => {
  it("rolls back a create that throws after staging", async () => {
    const fake = createSnapshotFake();
    const before = fake.snapshot();
    fake.faults.inject({ failNextCreateAfterStage: new Error("injected write failure") });
    await expect(fake.publishing.createPostWithDispatch(createTransaction())).rejects.toThrow(
      "injected write failure",
    );
    expect(fake.snapshot()).toEqual(before);
  });

  it("rolls back a commit that throws after staging", async () => {
    const fake = createSnapshotFake();
    await fake.publishing.createPostWithDispatch(createTransaction());
    await fake.publishing.claimExecution(claimInput());
    const before = fake.snapshot();
    fake.faults.inject({ failNextCommitAfterStage: new Error("injected commit failure") });
    await expect(
      fake.publishing.commitExecution({
        jobId: "job_0001",
        publicationId: "pub_0001",
        attemptId: "attempt_0001",
        claimToken: "claim_0001",
        now: FIXTURE_NOW,
        outcome: "published",
        externalId: "external-1",
        externalUrl: null,
        archive: null,
      }),
    ).rejects.toThrow("injected commit failure");
    expect(fake.snapshot()).toEqual(before);
  });

  it("rolls back activation across slot and operation together", async () => {
    const fake = createSnapshotFake();
    await fake.credentials.compareAndSetSlot(slotSet());
    await fake.credentials.createAuthOperation({
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
    await fake.credentials.claimOAuthCallback({
      platform: "x",
      oauthState: "state_0001",
      requestToken: null,
      now: FIXTURE_NOW,
      currentConfigBinding: "config-binding-1",
    });
    await fake.credentials.saveCandidate({
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
    const before = fake.snapshot();
    fake.faults.inject({ failNextActivationAfterStage: new Error("injected activation failure") });
    await expect(
      fake.credentials.activateCandidate({
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
    ).rejects.toThrow("injected activation failure");
    expect(fake.snapshot()).toEqual(before);
  });

  it("reports an unknown claim or lease result without writing", async () => {
    const fake = createSnapshotFake();
    await fake.publishing.createPostWithDispatch(createTransaction());
    const beforeClaim = fake.snapshot();
    fake.faults.inject({ claimResultUnknownOnce: true });
    const claim = await fake.publishing.claimExecution(claimInput());
    expect(claim.kind).toBe("unknown");
    expect(fake.snapshot()).toEqual(beforeClaim);

    await fake.credentials.compareAndSetSlot(slotSet());
    const beforeLease = fake.snapshot();
    fake.faults.inject({ refreshClaimResultUnknownOnce: true });
    const lease = await fake.credentials.acquireRefresh({
      platform: "x",
      expectedRevision: 1,
      leaseToken: "lease_0001",
      now: FIXTURE_NOW,
      leaseDurationMs: 60_000,
    });
    expect(lease.kind).toBe("unknown");
    expect(fake.snapshot()).toEqual(beforeLease);
  });

  it("distinguishes a claim that committed from one whose result was lost", async () => {
    const fake = createSnapshotFake();
    await fake.publishing.createPostWithDispatch(createTransaction());
    fake.faults.inject({ claimCommittedUnknownOnce: true });
    const claim = await fake.publishing.claimExecution(claimInput());
    expect(claim.kind).toBe("unknown");
    const execution = await fake.publishing.getExecution({
      jobId: "job_0001",
      publicationId: "pub_0001",
    });
    expect(execution?.publication.status).toBe("publishing");
    expect(execution?.publication.attempts).toBe(1);
    expect(execution?.publication.claimToken).toBe("claim_0001");
    const duplicate = await fake.publishing.claimExecution(claimInput());
    expect(duplicate.kind).toBe("not_claimed");
    expect((duplicate as { reason: string }).reason).toBe("already_claimed");
  });

  it("distinguishes committed-but-unknown OAuth and lease results", async () => {
    const fake = createSnapshotFake();
    await fake.credentials.compareAndSetSlot(slotSet());
    await fake.credentials.createAuthOperation({
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
    fake.faults.inject({ oauthClaimCommittedUnknownOnce: true });
    const claim = await fake.credentials.claimOAuthCallback({
      platform: "x",
      oauthState: "state_0001",
      requestToken: null,
      now: FIXTURE_NOW,
      currentConfigBinding: "config-binding-1",
    });
    expect(claim.kind).toBe("unknown");
    const stored = await fake.credentials.readAuthOperation({ operationId: "op_0001" });
    expect(stored?.phase).toBe("exchanging");
    const duplicate = await fake.credentials.claimOAuthCallback({
      platform: "x",
      oauthState: "state_0001",
      requestToken: null,
      now: FIXTURE_NOW,
      currentConfigBinding: "config-binding-1",
    });
    expect(duplicate.kind).toBe("conflict");
    expect((duplicate as { reason: string }).reason).toBe("phase_mismatch");

    fake.faults.inject({ refreshClaimCommittedUnknownOnce: true });
    const lease = await fake.credentials.acquireRefresh({
      platform: "x",
      expectedRevision: 1,
      leaseToken: "lease_0001",
      now: FIXTURE_NOW,
      leaseDurationMs: 60_000,
    });
    expect(lease.kind).toBe("unknown");
    const slot = await fake.credentials.readSlot({ platform: "x" });
    expect(slot.refreshLease?.token).toBe("lease_0001");
    const secondLease = await fake.credentials.acquireRefresh({
      platform: "x",
      expectedRevision: 1,
      leaseToken: "lease_0002",
      now: FIXTURE_NOW,
      leaseDurationMs: 60_000,
    });
    expect(secondLease.kind).toBe("conflict");
    expect((secondLease as { reason: string }).reason).toBe("lease_held");
  });

  it("keeps a job pending when a queue send does not confirm", async () => {
    const fake = createSnapshotFake();
    await fake.publishing.createPostWithDispatch(createTransaction());
    const before = fake.snapshot();
    fake.faults.inject({
      failNextQueueSend: new JobQueueError("broker timeout", "unknown", "SEND_UNKNOWN"),
    });
    await expect(
      fake.queue.send(envelopeForJob({ id: "job_0001", aggregateId: "pub_0001" }, FIXTURE_NOW)),
    ).rejects.toThrow("broker timeout");
    expect(fake.sentEnvelopes).toHaveLength(0);
    expect(fake.snapshot()).toEqual(before);
  });

  it("returns frozen snapshots that callers cannot mutate", async () => {
    const fake = createSnapshotFake();
    await fake.publishing.createPostWithDispatch(createTransaction());
    const snapshot = fake.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.posts)).toBe(true);
    expect(Object.isFrozen(snapshot.posts[0])).toBe(true);
    const execution = await fake.publishing.getExecution({
      jobId: "job_0001",
      publicationId: "pub_0001",
    });
    expect(execution).not.toBeNull();
    expect(Object.isFrozen(execution?.publication)).toBe(true);
  });

  it("reflects dispatch, diagnostics and archive expiry", async () => {
    const fake = createSnapshotFake();
    await fake.publishing.createPostWithDispatch(createTransaction());
    const diagnostics = await fake.diagnostics.readSnapshot();
    expect(diagnostics.pendingOutbox).toBe(1);
    expect(diagnostics.oldestDueAt).toBe(FIXTURE_NOW);
    expect(diagnostics.oldestAgeSeconds).toBe(0);
    expect(diagnostics.storage.approximateBytes).toBeNull();
    expect(diagnostics.storage.reason).toBe("size_unavailable");

    await fake.archive.put("archive/provider-responses/2026/09/pub_0001/attempt_0001.json", {
      schemaVersion: 1,
      category: "provider_response",
      redactionVersion: 1,
      platform: "x",
      stage: "response",
      outcome: "failed",
      httpStatus: 503,
      code: "PROVIDER_UNAVAILABLE",
      publicationId: "pub_0001",
      jobId: "job_0001",
      attemptId: "attempt_0001",
      createdAt: FIXTURE_NOW,
      expiresAt: instant(60_000),
    });
    expect(
      await fake.archive.get("archive/provider-responses/2026/09/pub_0001/attempt_0001.json"),
    ).not.toBeNull();
    fake.clock.set(instant(60_000));
    expect(
      await fake.archive.get("archive/provider-responses/2026/09/pub_0001/attempt_0001.json"),
    ).toBeNull();
  });

  it("stores blob bodies and hides the fake cipher from production wiring", async () => {
    const fake = createSnapshotFake();
    const stored = await fake.blobs.put(
      "media/posts/post_0001/object_0001",
      new Uint8Array([1, 2, 3]),
      { contentType: "image/png", byteLength: 3, checksum: null },
    );
    expect(stored.size).toBe(3);
    expect(await fake.blobs.exists("media/posts/post_0001/object_0001")).toBe(true);
    const read = await fake.blobs.get("media/posts/post_0001/object_0001");
    expect(Array.from(read?.body ?? [])).toEqual([1, 2, 3]);
    expect(fake.cipher.kind).toBe("test-double");
  });
});
