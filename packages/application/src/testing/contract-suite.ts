/**
 * Portable behaviour contract for `PublishingStore`, `OutboxStore` and
 * `CredentialStore`.
 *
 * Scenarios use ports only, so the identical set runs against the
 * rollback-capable fake and against the real local-D1 adapter. Results are
 * returned as data rather than thrown assertions from a test framework, which
 * keeps this module free of runner dependencies.
 */

import type { Platform } from "@syndroo/core";

import type {
  ActivationCommit,
  AuthOperationStart,
  CandidateCommit,
  RefreshClaim,
  RefreshCommit,
  SlotMutation,
} from "../contracts/credentials.js";
import type { ClaimCondition, ExecutionCommit } from "../contracts/execution.js";
import {
  FIXTURE_NOW,
  createTransaction,
  instant,
  testEnvelope,
} from "./fixtures.js";
import { assertDeepEqual, assertEqual, assertKind, assertTrue } from "./assertions.js";
import type { StoreHarness } from "./snapshot-fake.js";

export interface ContractScenario {
  readonly id: string;
  readonly description: string;
  run(harness: StoreHarness): Promise<void>;
}

export interface ContractScenarioResult {
  readonly id: string;
  readonly status: "pass" | "fail";
  readonly detail: string | null;
}

export interface ContractReport {
  readonly passed: number;
  readonly failed: number;
  readonly scenarios: readonly ContractScenarioResult[];
}

function claimInput(overrides: Partial<ClaimCondition> = {}): ClaimCondition {
  return {
    jobId: "job_0001",
    publicationId: "pub_0001",
    attemptNo: 1,
    now: FIXTURE_NOW,
    credentialSlotRevision: 1,
    claimToken: "claim_0001",
    attemptId: "attempt_0001",
    ...overrides,
  };
}

/** Env-only preparation path: no D1 slot, so the observed revision is 0. */
function keylessClaimInput(overrides: Partial<ClaimCondition> = {}): ClaimCondition {
  return claimInput({ credentialSlotRevision: 0, ...overrides });
}

function publishedCommit(): ExecutionCommit {
  return {
    jobId: "job_0001",
    publicationId: "pub_0001",
    attemptId: "attempt_0001",
    claimToken: "claim_0001",
    now: FIXTURE_NOW,
    outcome: "published",
    externalId: "external-1",
    externalUrl: "https://example.test/1",
    archive: null,
  };
}

function startOperation(overrides: Partial<AuthOperationStart> = {}): AuthOperationStart {
  return {
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
    ...overrides,
  };
}

function candidateCommit(overrides: Partial<CandidateCommit> = {}): CandidateCommit {
  return {
    operationId: "op_0001",
    platform: "x",
    now: FIXTURE_NOW,
    outcome: {
      kind: "candidate",
      phase: "awaiting_confirmation",
      candidateEnvelope: testEnvelope("candidate"),
      candidatePayloadRevision: 1,
      candidatePayloadSchemaVersion: 1,
      candidateTarget: { label: "alice", source: "provider" },
      missingFields: [],
    },
    ...overrides,
  };
}

function activationCommit(overrides: Partial<ActivationCommit> = {}): ActivationCommit {
  return {
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
    target: { label: "alice", source: "provider" },
    receipt: {
      platform: "x",
      operationId: "op_0001",
      stored: true,
      revision: 2,
      configured: true,
      readiness: "ready",
    },
    ...overrides,
  };
}

function refreshClaim(overrides: Partial<RefreshClaim> = {}): RefreshClaim {
  return {
    platform: "x",
    expectedRevision: 1,
    leaseToken: "lease_0001",
    now: FIXTURE_NOW,
    leaseDurationMs: 60_000,
    ...overrides,
  };
}

function refreshCommit(overrides: Partial<RefreshCommit> = {}): RefreshCommit {
  return {
    platform: "x",
    leaseToken: "lease_0001",
    expectedRevision: 1,
    now: instant(1_000),
    envelope: testEnvelope("refreshed"),
    payloadRevision: 2,
    payloadSchemaVersion: 1,
    expiresAt: instant(3_600_000),
    target: null,
    ...overrides,
  };
}

function slotMutation(overrides: Partial<SlotMutation> = {}): SlotMutation {
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
    ...overrides,
  };
}

async function seedSlot(
  harness: StoreHarness,
  platform: Platform = "x",
  seed = "one",
): Promise<void> {
  const result = await harness.credentials.compareAndSetSlot({
    platform,
    expectedRevision: 0,
    now: FIXTURE_NOW,
    change: {
      kind: "set",
      bindingId: `bind-${seed}`,
      envelope: testEnvelope(seed),
      payloadRevision: 1,
      payloadSchemaVersion: 1,
      expiresAt: null,
      target: null,
    },
  });
  assertKind(result, "applied", "seeding a credential slot must apply");
}

export function storeContractScenarios(): readonly ContractScenario[] {
  return [
    {
      id: "create_commits_atomically",
      description: "Post, publications and initial jobs commit together",
      async run(harness) {
        const result = await harness.publishing.createPostWithDispatch(createTransaction());
        assertKind(result, "created", "create must be created");
        assertEqual(result.record.post.id, "post_0001", "created post id");
        assertEqual(result.record.publications.length, 1, "one publication");
        assertEqual(result.record.jobIds.length, 1, "one job");
        const execution = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertTrue(execution !== null, "execution must be readable after create");
        assertEqual(execution.job.status, "pending", "initial job status");
        assertEqual(execution.job.attemptNo, 1, "initial job attempt");
        assertEqual(execution.publication.currentJobId, "job_0001", "initial current job linked");
        assertEqual(execution.publication.attempts, 0, "no attempt yet");
        assertEqual(
          execution.publication.credentialBinding,
          "binding-hmac-0001",
          "publication keeps the connection binding HMAC",
        );
        assertEqual(
          execution.publication.credentialRevisionAtCreate,
          0,
          "creation revision is recorded as metadata",
        );
        assertDeepEqual(
          execution.post.platforms,
          ["x"],
          "post snapshot keeps canonical platform intent",
        );
        assertDeepEqual(
          execution.post.overrides,
          {},
          "post snapshot keeps canonical override intent",
        );
      },
    },
    {
      id: "create_replay_returns_original_record",
      description: "Same key returns the original record without a second write",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        const replay = await harness.publishing.createPostWithDispatch(
          createTransaction({ fingerprint: "different-fingerprint" }),
        );
        assertKind(replay, "replayed", "same key must replay");
        assertEqual(
          replay.record.requestFingerprint,
          "fingerprint-0001",
          "replay exposes the stored request fingerprint for comparison",
        );
        assertEqual(replay.record.post.id, "post_0001", "replay returns the original post");
        assertEqual(replay.record.publications.length, 1, "replay returns the original rows");
        const lookup = await harness.publishing.findIdempotentPost({
          scope: "posts.create.v1",
          key: "create-key-0001",
        });
        assertTrue(lookup !== null, "idempotency lookup finds the record");
        assertEqual(lookup.post.id, "post_0001", "lookup returns the stored post");
      },
    },
    {
      id: "create_preserves_canonical_intent",
      description: "Post snapshots keep platforms and per-platform overrides",
      async run(harness) {
        const overrides = {
          x: { content: "x only" },
          bluesky: { content: "bluesky only" },
        } as const;
        const created = await harness.publishing.createPostWithDispatch(
          createTransaction({
            platforms: ["bluesky", "x"],
            publicationIds: ["pub_0001", "pub_0002"],
            jobIds: ["job_0001", "job_0002"],
            overrides,
          }),
        );
        assertKind(created, "created", "multi-platform create");
        const execution = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertTrue(execution !== null, "execution readable");
        assertDeepEqual(
          execution.post.platforms,
          ["bluesky", "x"],
          "platform intent preserved in input order",
        );
        assertDeepEqual(execution.post.overrides, overrides, "override intent preserved");
        assertEqual(created.record.publications.length, 2, "both publications stored");
        const lookup = await harness.publishing.findIdempotentPost({
          scope: "posts.create.v1",
          key: "create-key-0001",
        });
        assertTrue(lookup !== null, "lookup finds the record");
        assertDeepEqual(lookup.post.overrides, overrides, "lookup keeps override intent");
      },
    },
    {
      id: "create_without_key_never_dedupes",
      description: "A missing idempotency key always creates a new post",
      async run(harness) {
        const first = await harness.publishing.createPostWithDispatch(
          createTransaction({ key: null }),
        );
        const second = await harness.publishing.createPostWithDispatch(
          createTransaction({
            key: null,
            postId: "post_0002",
            publicationIds: ["pub_0002"],
            jobIds: ["job_0002"],
          }),
        );
        assertKind(first, "created", "first keyless create");
        assertKind(second, "created", "second keyless create must also be created");
        const lookup = await harness.publishing.findIdempotentPost({
          scope: "posts.create.v1",
          key: null,
        });
        assertEqual(lookup, null, "a null key has nothing to look up");
      },
    },
    {
      id: "create_conflicts_on_stale_credential_revision",
      description: "A stale credential guard leaves every row unchanged",
      async run(harness) {
        await seedSlot(harness);
        const result = await harness.publishing.createPostWithDispatch(
          createTransaction({
            credentialGuards: [{ platform: "x", expectedRevision: 0, bindingId: null }],
          }),
        );
        assertKind(result, "conflict", "stale guard must conflict");
        assertEqual(result.reason, "credential_revision_mismatch", "conflict reason");
        const execution = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertEqual(execution, null, "no partial post was written");
        const slot = await harness.credentials.readSlot({ platform: "x" });
        assertEqual(slot.revision, 1, "slot untouched");
      },
    },
    {
      id: "create_conflicts_on_existing_job_id",
      description: "A job id collision leaves state unchanged",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        const result = await harness.publishing.createPostWithDispatch(
          createTransaction({
            key: "create-key-0002",
            postId: "post_0002",
            publicationIds: ["pub_0002"],
            jobIds: ["job_0001"],
          }),
        );
        assertKind(result, "conflict", "job collision must conflict");
        assertEqual(result.reason, "duplicate_job", "conflict reason");
        const second = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0002",
        });
        assertEqual(second, null, "the second post was not created");
        const original = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertTrue(original !== null, "the original post survives");
      },
    },
    {
      id: "claim_has_a_single_winner",
      description: "Concurrent claims of the same job produce one winner",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        const results = await Promise.all([
          harness.publishing.claimExecution(keylessClaimInput()),
          harness.publishing.claimExecution(keylessClaimInput()),
        ]);
        const claimed = results.filter((result) => result.kind === "claimed");
        const blocked = results.filter((result) => result.kind === "not_claimed");
        assertEqual(claimed.length, 1, "exactly one claim winner");
        assertEqual(blocked.length, 1, "exactly one claim loser");
        assertEqual(
          (blocked[0] as { reason: string }).reason,
          "already_claimed",
          "loser observes a live claim",
        );
        const execution = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertTrue(execution !== null, "execution readable");
        assertEqual(execution.publication.attempts, 1, "exactly one attempt charged");
      },
    },
    {
      id: "claim_guards_preparation_slot_revision",
      description: "Claim fences the preparation-time slot revision",
      async run(harness) {
        await seedSlot(harness);
        const created = await harness.publishing.createPostWithDispatch(
          createTransaction({
            credentialRevision: 1,
            credentialGuards: [{ platform: "x", expectedRevision: 1, bindingId: null }],
          }),
        );
        assertKind(created, "created", "create against the seeded slot");
        const stale = await harness.publishing.claimExecution(
          claimInput({ credentialSlotRevision: 7 }),
        );
        assertKind(stale, "not_claimed", "stale prepared revision must not claim");
        assertEqual(stale.reason, "credential_revision_mismatch", "reason");
        const fresh = await harness.publishing.claimExecution(claimInput());
        assertKind(fresh, "claimed", "matching revision claims");
      },
    },
    {
      id: "claim_respects_due_time",
      description: "A future job cannot be claimed early",
      async run(harness) {
        const scheduledAt = instant(5 * 60_000);
        await harness.publishing.createPostWithDispatch(createTransaction({ scheduledAt }));
        const early = await harness.publishing.claimExecution(
          keylessClaimInput({ now: FIXTURE_NOW }),
        );
        assertKind(early, "not_claimed", "early claim is refused");
        assertEqual(early.reason, "not_due", "reason");
        const due = await harness.publishing.claimExecution(
          keylessClaimInput({ now: scheduledAt }),
        );
        assertKind(due, "claimed", "due claim succeeds");
        assertEqual(due.execution.job.availableAt, scheduledAt, "availableAt unchanged");
      },
    },
    {
      id: "commit_is_idempotent_and_fenced",
      description: "Same commit replays; a conflicting result is refused",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        await harness.publishing.claimExecution(keylessClaimInput());
        const commit = publishedCommit();
        const applied = await harness.publishing.commitExecution(commit);
        assertKind(applied, "applied", "first commit applies");
        const replay = await harness.publishing.commitExecution(commit);
        assertKind(replay, "already_applied", "identical commit replays");
        const conflicting = await harness.publishing.commitExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
          attemptId: "attempt_0001",
          claimToken: "claim_0001",
          now: FIXTURE_NOW,
          outcome: "published",
          externalId: "external-2",
          externalUrl: null,
          archive: null,
        });
        assertKind(conflicting, "conflict", "a different result conflicts");
        const execution = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertTrue(execution !== null, "execution readable");
        assertEqual(execution.publication.externalId, "external-1", "first result wins");
        assertEqual(execution.publication.status, "published", "publication published");
        assertEqual(execution.job.status, "cancelled", "transport intent cancelled");
      },
    },
    {
      id: "commit_rejects_wrong_claim_token",
      description: "A forged or late claim token cannot write an outcome",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        await harness.publishing.claimExecution(keylessClaimInput());
        const before = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        const result = await harness.publishing.commitExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
          attemptId: "attempt_0001",
          claimToken: "claim_9999",
          now: FIXTURE_NOW,
          outcome: "published",
          externalId: "external-1",
          externalUrl: null,
          archive: null,
        });
        assertKind(result, "conflict", "wrong claim token conflicts");
        const after = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertDeepEqual(after, before, "fenced commit must not write");
      },
    },
    {
      id: "safe_retry_commits_future_job_atomically",
      description: "Business retry persists the successor job with the publication",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        await harness.publishing.claimExecution(keylessClaimInput());
        const retryAt = instant(60_000);
        const commit = await harness.publishing.commitExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
          attemptId: "attempt_0001",
          claimToken: "claim_0001",
          now: FIXTURE_NOW,
          outcome: "safe_retry",
          errorCode: "RATE_LIMIT",
          retryAt,
          nextJob: {
            id: "job_0002",
            kind: "delivery.execute",
            aggregateId: "pub_0001",
            attemptNo: 2,
            availableAt: retryAt,
          },
          archive: null,
        });
        assertKind(commit, "applied", "safe retry applies");
        const execution = await harness.publishing.getExecution({
          jobId: "job_0002",
          publicationId: "pub_0001",
        });
        assertTrue(execution !== null, "future job exists");
        assertEqual(execution.publication.status, "pending", "publication pends");
        assertEqual(execution.publication.retryAt, retryAt, "retryAt persisted");
        assertEqual(execution.publication.currentJobId, "job_0002", "current job switched");
        assertEqual(execution.publication.attempts, 1, "attempt charged at claim only");
        const ready = await harness.outbox.listReady({ now: retryAt, limit: 10 });
        assertEqual(ready.length, 1, "only the future job is due");
        assertEqual(ready[0]?.id, "job_0002", "future job is the ready one");
      },
    },
    {
      id: "safe_retry_respects_attempt_budget",
      description: "A retry after the third attempt is refused",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        let jobId = "job_0001";
        for (const attempt of [1, 2, 3]) {
          const claimed = await harness.publishing.claimExecution(
            keylessClaimInput({
              jobId,
              attemptNo: attempt,
              now: instant((attempt - 1) * 60_000),
              claimToken: `claim_000${attempt}`,
              attemptId: `attempt_000${attempt}`,
            }),
          );
          assertKind(claimed, "claimed", `attempt ${attempt} claims`);
          const retryAt = instant(attempt * 60_000);
          const nextJobId = `job_000${attempt + 1}`;
          const commit = await harness.publishing.commitExecution({
            jobId,
            publicationId: "pub_0001",
            attemptId: `attempt_000${attempt}`,
            claimToken: `claim_000${attempt}`,
            now: retryAt,
            outcome: "safe_retry",
            errorCode: "RATE_LIMIT",
            retryAt,
            nextJob: {
              id: nextJobId,
              kind: "delivery.execute",
              aggregateId: "pub_0001",
              attemptNo: attempt + 1,
              availableAt: retryAt,
            },
            archive: null,
          });
          if (attempt < 3) {
            assertKind(commit, "applied", `retry after attempt ${attempt} applies`);
            jobId = nextJobId;
          } else {
            assertKind(commit, "conflict", "a fourth attempt is refused");
            assertEqual(commit.reason, "attempt_budget_exhausted", "budget reason");
          }
        }
      },
    },
    {
      id: "pre_execution_rejection_is_terminal_and_cancels",
      description: "Permanent configuration failure never charges an attempt",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        const rejection = {
          jobId: "job_0001",
          publicationId: "pub_0001",
          now: FIXTURE_NOW,
          terminalReason: "binding_mismatch" as const,
          errorCode: "AUTH" as const,
        };
        const applied = await harness.publishing.rejectBeforeExecution(rejection);
        assertKind(applied, "applied", "rejection applies");
        const replay = await harness.publishing.rejectBeforeExecution(rejection);
        assertKind(replay, "already_applied", "identical rejection replays");
        const execution = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertTrue(execution !== null, "execution readable");
        assertEqual(execution.publication.status, "failed", "publication failed");
        assertEqual(execution.publication.errorAmbiguous, false, "not ambiguous");
        assertEqual(execution.publication.attempts, 0, "no attempt charged");
        assertEqual(execution.job.status, "cancelled", "job cancelled");
      },
    },
    {
      id: "dlq_settles_due_current_job_only",
      description: "A due unclaimed current job becomes dead_lettered",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        const result = await harness.publishing.settleDeadLetter({
          jobId: "job_0001",
          publicationId: "pub_0001",
          now: FIXTURE_NOW,
          transportReason: "queue_dlq",
        });
        assertKind(result, "dead_lettered", "due job is dead-lettered");
        assertEqual(result.attempts, 0, "attempts unchanged");
        const execution = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertTrue(execution !== null, "execution readable");
        assertEqual(execution.publication.terminalReason, "dead_lettered", "terminal reason");
        assertEqual(execution.publication.errorAmbiguous, false, "not ambiguous");
        assertEqual(execution.job.transportReason, "queue_dlq", "transport reason recorded");
      },
    },
    {
      id: "dlq_future_job_preserves_schedule",
      description: "A future job records transport failure without losing its due time",
      async run(harness) {
        const scheduledAt = instant(30 * 60_000);
        await harness.publishing.createPostWithDispatch(createTransaction({ scheduledAt }));
        const result = await harness.publishing.settleDeadLetter({
          jobId: "job_0001",
          publicationId: "pub_0001",
          now: FIXTURE_NOW,
          transportReason: "future_dlq",
        });
        assertKind(result, "recorded", "future DLQ is recorded only");
        assertEqual(result.reason, "not_due", "reason is not_due");
        const execution = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertTrue(execution !== null, "execution readable");
        assertEqual(execution.job.status, "pending", "job stays pending");
        assertEqual(execution.job.availableAt, scheduledAt, "availableAt preserved");
        assertEqual(execution.job.dlqSeenAt, FIXTURE_NOW, "dlqSeenAt recorded");
        assertEqual(execution.publication.terminalReason, null, "not terminated early");
        const ready = await harness.outbox.listReady({ now: scheduledAt, limit: 10 });
        assertEqual(ready.length, 0, "a DLQ-seen job is never redispatched");
        const recovery = await harness.publishing.recoverStaleClaims({
          now: scheduledAt,
          limit: 10,
        });
        assertEqual(recovery.jobsDeadLettered, 1, "maintenance settles it at due time");
      },
    },
    {
      id: "dlq_never_overrides_a_result",
      description: "Terminal jobs keep their business outcome",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        await harness.publishing.claimExecution(keylessClaimInput());
        await harness.publishing.commitExecution(publishedCommit());
        const result = await harness.publishing.settleDeadLetter({
          jobId: "job_0001",
          publicationId: "pub_0001",
          now: instant(1_000),
          transportReason: "queue_dlq",
        });
        assertKind(result, "recorded", "terminal DLQ is recorded only");
        assertEqual(result.reason, "terminal", "reason is terminal");
        const execution = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertTrue(execution !== null, "execution readable");
        assertEqual(execution.publication.status, "published", "published kept");
        assertEqual(execution.publication.externalId, "external-1", "external id kept");
      },
    },
    {
      id: "recover_stale_claim_marks_unknown",
      description: "A claim older than the window becomes unknown, never a resend",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        await harness.publishing.claimExecution(keylessClaimInput());
        const result = await harness.publishing.recoverStaleClaims({
          now: instant(16 * 60_000),
          limit: 10,
        });
        assertEqual(result.staleClaimsMarkedUnknown, 1, "stale claim recovered");
        const execution = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertTrue(execution !== null, "execution readable");
        assertEqual(execution.publication.status, "failed", "publication failed");
        assertEqual(execution.publication.errorAmbiguous, true, "ambiguous");
        assertEqual(execution.publication.terminalReason, "unknown", "reason unknown");
        assertEqual(execution.publication.attempts, 1, "no new attempt");
        assertEqual(execution.job.status, "cancelled", "no resend intent");
      },
    },
    {
      id: "rearm_preserves_due_time_and_fences_late_marks",
      description: "Early-message rearm keeps availableAt and bumps the CAS revision",
      async run(harness) {
        const scheduledAt = instant(5 * 60_000);
        await harness.publishing.createPostWithDispatch(createTransaction({ scheduledAt }));
        const dispatched = await harness.outbox.recordDispatch({
          jobId: "job_0001",
          dispatchRevision: 0,
          now: FIXTURE_NOW,
          outcome: { kind: "dispatched" },
        });
        assertKind(dispatched, "applied", "dispatch recorded");
        const rearm = await harness.outbox.rearmCurrentJob({
          jobId: "job_0001",
          publicationId: "pub_0001",
          now: FIXTURE_NOW,
          reason: "early_message",
        });
        assertKind(rearm, "rearmed", "rearm applies");
        assertEqual(rearm.recoveryCount, 0, "early message does not consume recovery budget");
        const late = await harness.outbox.recordDispatch({
          jobId: "job_0001",
          dispatchRevision: 0,
          now: FIXTURE_NOW,
          outcome: { kind: "dispatched" },
        });
        assertKind(late, "conflict", "late producer mark loses");
        assertEqual(late.reason, "revision_mismatch", "late mark reason");
        const execution = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertTrue(execution !== null, "execution readable");
        assertEqual(execution.job.availableAt, scheduledAt, "availableAt preserved");
        assertEqual(execution.job.status, "pending", "job is pending again");
      },
    },
    {
      id: "stalled_recovery_is_bounded",
      description: "Stalled dispatch recovery stops at the cap",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        const dispatched = await harness.outbox.recordDispatch({
          jobId: "job_0001",
          dispatchRevision: 0,
          now: FIXTURE_NOW,
          outcome: { kind: "dispatched" },
        });
        assertKind(dispatched, "applied", "dispatch recorded");
        let offsetMs = 31 * 60_000;
        for (const round of [1, 2, 3]) {
          const recovery = await harness.publishing.recoverStaleClaims({
            now: instant(offsetMs),
            limit: 10,
          });
          assertEqual(recovery.jobsRearmed, 1, `round ${round} rearmed`);
          const execution = await harness.publishing.getExecution({
            jobId: "job_0001",
            publicationId: "pub_0001",
          });
          assertTrue(execution !== null, "execution readable");
          assertEqual(execution.job.recoveryCount, round, "recovery count");
          const redispatch = await harness.outbox.recordDispatch({
            jobId: "job_0001",
            dispatchRevision: execution.job.dispatchRevision,
            now: instant(offsetMs),
            outcome: { kind: "dispatched" },
          });
          assertKind(redispatch, "applied", `round ${round} redispatch`);
          offsetMs += 31 * 60_000;
        }
        const exhausted = await harness.publishing.recoverStaleClaims({
          now: instant(offsetMs),
          limit: 10,
        });
        assertEqual(exhausted.jobsDeadLettered, 1, "cap reached becomes dead_lettered");
        const execution = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertTrue(execution !== null, "execution readable");
        assertEqual(execution.publication.terminalReason, "dead_lettered", "terminal reason");
        assertEqual(
          execution.job.transportReason,
          "stalled_recovery_exhausted",
          "transport reason",
        );
      },
    },
    {
      id: "slot_cas_and_replay",
      description: "Slot CAS has no implicit replay; every success bumps the revision",
      async run(harness) {
        const applied = await harness.credentials.compareAndSetSlot(slotMutation());
        assertKind(applied, "applied", "first set applies");
        assertEqual(applied.revision, 1, "revision advanced");
        const stale = await harness.credentials.compareAndSetSlot(slotMutation());
        assertKind(stale, "conflict", "a stale CAS conflicts");
        assertEqual(stale.reason, "revision_mismatch", "conflict reason");
        const rebound = await harness.credentials.compareAndSetSlot(
          slotMutation({
            expectedRevision: 1,
            change: {
              kind: "set",
              bindingId: "bind-2",
              envelope: testEnvelope("one"),
              payloadRevision: 1,
              payloadSchemaVersion: 1,
              expiresAt: null,
              target: { label: "alice", source: "provider" },
            },
          }),
        );
        assertKind(rebound, "applied", "identical ciphertext with a new binding still applies");
        assertEqual(rebound.revision, 2, "direct set is always a new connection");
        const afterRebind = await harness.credentials.readSlot({ platform: "x" });
        assertEqual(afterRebind.bindingId, "bind-2", "new binding stored");
        assertEqual(afterRebind.target?.label, "alice", "new target stored");
        const removed = await harness.credentials.compareAndSetSlot({
          platform: "x",
          expectedRevision: 2,
          now: FIXTURE_NOW,
          change: { kind: "remove" },
        });
        assertKind(removed, "applied", "removal applies");
        const slot = await harness.credentials.readSlot({ platform: "x" });
        assertEqual(slot.status, "tombstone", "tombstone kept");
        assertEqual(slot.revision, 3, "tombstone revision");
        assertEqual(slot.envelope, null, "ciphertext cleared");
        const removeAgain = await harness.credentials.compareAndSetSlot({
          platform: "x",
          expectedRevision: 3,
          now: FIXTURE_NOW,
          change: { kind: "remove" },
        });
        assertKind(removeAgain, "applied", "removing an existing tombstone still applies");
        assertEqual(removeAgain.revision, 4, "every satisfied remove bumps the revision");
      },
    },
    {
      id: "tombstone_delete_defeats_old_operation",
      description: "An authorization created at a tombstone revision cannot survive a delete",
      async run(harness) {
        const seeded = await harness.credentials.compareAndSetSlot(slotMutation());
        assertKind(seeded, "applied", "slot set");
        const removed = await harness.credentials.compareAndSetSlot({
          platform: "x",
          expectedRevision: 1,
          now: FIXTURE_NOW,
          change: { kind: "remove" },
        });
        assertKind(removed, "applied", "tombstone established");
        assertEqual(removed.revision, 2, "tombstone revision");

        await harness.credentials.createAuthOperation(
          startOperation({ expectedRevision: 2 }),
        );

        const secondRemove = await harness.credentials.compareAndSetSlot({
          platform: "x",
          expectedRevision: 2,
          now: instant(1_000),
          change: { kind: "remove" },
        });
        assertKind(secondRemove, "applied", "a later explicit delete always advances");
        assertEqual(secondRemove.revision, 3, "delete is not a no-op");

        const claimed = await harness.credentials.claimOAuthCallback({
          platform: "x",
          oauthState: "state_0001",
          requestToken: null,
          now: instant(2_000),
          currentConfigBinding: "config-binding-1",
        });
        assertKind(claimed, "claimed", "callback claim still proceeds");
        await harness.credentials.saveCandidate(candidateCommit({ now: instant(3_000) }));
        const activated = await harness.credentials.activateCandidate(
          activationCommit({ now: instant(4_000), expectedRevision: 2 }),
        );
        assertKind(activated, "conflict", "the old operation can no longer activate");
        assertEqual(activated.reason, "revision_mismatch", "reason");
        const slot = await harness.credentials.readSlot({ platform: "x" });
        assertEqual(slot.status, "tombstone", "slot stays a tombstone");
        assertEqual(slot.revision, 3, "slot untouched by the failed activation");
      },
    },
    {
      id: "activation_is_atomic_and_replays_receipt",
      description: "Activation writes slot and receipt together and replays safely",
      async run(harness) {
        await seedSlot(harness);
        await harness.credentials.createAuthOperation(startOperation());
        const claimed = await harness.credentials.claimOAuthCallback({
          platform: "x",
          oauthState: "state_0001",
          requestToken: null,
          now: FIXTURE_NOW,
          currentConfigBinding: "config-binding-1",
        });
        assertKind(claimed, "claimed", "callback claim wins");
        const saved = await harness.credentials.saveCandidate(candidateCommit());
        assertKind(saved, "applied", "candidate saved");
        const activated = await harness.credentials.activateCandidate(activationCommit());
        assertKind(activated, "activated", "activation applies");
        assertEqual(activated.revision, 2, "slot revision advanced");

        // A later direct set changes the slot; a repeated complete must still
        // return the original receipt and must not write the slot again.
        const laterSet = await harness.credentials.compareAndSetSlot({
          platform: "x",
          expectedRevision: 2,
          now: instant(1_000),
          change: {
            kind: "set",
            bindingId: "bind-later",
            envelope: testEnvelope("later"),
            payloadRevision: 2,
            payloadSchemaVersion: 1,
            expiresAt: null,
            target: null,
          },
        });
        assertKind(laterSet, "applied", "later direct set applies");
        const slotAfterSet = await harness.credentials.readSlot({ platform: "x" });
        const replay = await harness.credentials.activateCandidate(activationCommit());
        assertKind(replay, "replayed", "completed operation replays");
        assertEqual(replay.receipt.revision, 2, "original receipt revision");
        assertEqual(replay.receipt.replayed, true, "replay flagged");
        const slotAfterReplay = await harness.credentials.readSlot({ platform: "x" });
        assertDeepEqual(slotAfterReplay, slotAfterSet, "replay must not write the slot");
      },
    },
    {
      id: "activation_requires_observed_revision_and_config",
      description: "Stale or reconfigured completions cannot activate",
      async run(harness) {
        await seedSlot(harness);
        await harness.credentials.createAuthOperation(startOperation());
        const claimed = await harness.credentials.claimOAuthCallback({
          platform: "x",
          oauthState: "state_0001",
          requestToken: null,
          now: FIXTURE_NOW,
          currentConfigBinding: "config-binding-1",
        });
        assertKind(claimed, "claimed", "callback claim wins");
        await harness.credentials.saveCandidate(candidateCommit());
        const staleRevision = await harness.credentials.activateCandidate(
          activationCommit({ expectedRevision: 5 }),
        );
        assertKind(staleRevision, "conflict", "stale revision conflicts");
        assertEqual(staleRevision.reason, "revision_mismatch", "revision reason");
        const changedConfig = await harness.credentials.activateCandidate(
          activationCommit({ currentConfigBinding: "config-binding-2" }),
        );
        assertKind(changedConfig, "conflict", "changed config conflicts");
        assertEqual(changedConfig.reason, "start_config_changed", "config reason");
        const slot = await harness.credentials.readSlot({ platform: "x" });
        assertEqual(slot.revision, 1, "slot untouched");
      },
    },
    {
      id: "oauth_callback_rejects_wrong_state_and_config",
      description: "Callback claim is state-scoped and config-fenced",
      async run(harness) {
        await seedSlot(harness);
        await harness.credentials.createAuthOperation(startOperation());
        const wrongState = await harness.credentials.claimOAuthCallback({
          platform: "x",
          oauthState: "state_9999",
          requestToken: null,
          now: FIXTURE_NOW,
          currentConfigBinding: "config-binding-1",
        });
        assertKind(wrongState, "conflict", "unknown state conflicts");
        const changedConfig = await harness.credentials.claimOAuthCallback({
          platform: "x",
          oauthState: "state_0001",
          requestToken: null,
          now: FIXTURE_NOW,
          currentConfigBinding: "config-binding-2",
        });
        assertKind(changedConfig, "conflict", "changed config conflicts");
        assertEqual(changedConfig.reason, "start_config_changed", "config reason");
        const lookup = await harness.credentials.findAuthOperationByState({
          platform: "x",
          oauthState: "state_0001",
        });
        assertTrue(lookup !== null, "state lookup resolves the operation");
        assertEqual(lookup.operationId, "op_0001", "operation id resolved");
      },
    },
    {
      id: "refresh_lease_fences_late_result",
      description: "Only the lease holder may commit, and replays stay safe",
      async run(harness) {
        await seedSlot(harness);
        const acquired = await harness.credentials.acquireRefresh(refreshClaim());
        assertKind(acquired, "acquired", "lease acquired");
        const committed = await harness.credentials.completeRefresh(refreshCommit());
        assertKind(committed, "applied", "refresh commit applies");
        const replay = await harness.credentials.completeRefresh(refreshCommit());
        assertKind(replay, "already_applied", "identical refresh replays");
        // A late result that presents the current revision but an old lease is
        // rejected by the lease fence instead of overwriting the slot.
        const stale = await harness.credentials.completeRefresh(
          refreshCommit({
            expectedRevision: 2,
            now: instant(2_000),
            envelope: testEnvelope("other"),
            payloadRevision: 3,
          }),
        );
        assertKind(stale, "conflict", "a different late result conflicts");
        assertEqual(stale.reason, "lease_mismatch", "late result reason");
        const slot = await harness.credentials.readSlot({ platform: "x" });
        assertEqual(slot.revision, 2, "one revision for the applied refresh");
        assertEqual(slot.refreshLease, null, "lease cleared");
        assertEqual(slot.refreshState, "ready", "state stays ready");
      },
    },
    {
      id: "unknown_refresh_requires_reconnect",
      description: "An unknown exchange result blocks further automatic refreshes",
      async run(harness) {
        await seedSlot(harness);
        const acquired = await harness.credentials.acquireRefresh(refreshClaim());
        assertKind(acquired, "acquired", "lease acquired");
        const marked = await harness.credentials.markReconnectRequired({
          platform: "x",
          leaseToken: "lease_0001",
          expectedRevision: 1,
          now: instant(1_000),
          reason: "unknown_result",
        });
        assertKind(marked, "applied", "reconnect_required recorded");
        const slot = await harness.credentials.readSlot({ platform: "x" });
        assertEqual(slot.refreshState, "reconnect_required", "state is sticky");
        assertEqual(slot.refreshLease, null, "lease released");

        // Even once the safety window has elapsed, the uncertain token is never
        // reused: an explicit replacement connection is required.
        const retry = await harness.credentials.acquireRefresh(
          refreshClaim({ leaseToken: "lease_0002", now: instant(120_000) }),
        );
        assertKind(retry, "conflict", "reacquire is refused");
        assertEqual(retry.reason, "reconnect_required", "reacquire reason");
        const replaced = await harness.credentials.compareAndSetSlot({
          platform: "x",
          expectedRevision: 1,
          now: instant(120_000),
          change: {
            kind: "set",
            bindingId: "bind-new",
            envelope: testEnvelope("new"),
            payloadRevision: 2,
            payloadSchemaVersion: 1,
            expiresAt: null,
            target: null,
          },
        });
        assertKind(replaced, "applied", "explicit replacement is allowed");
        const after = await harness.credentials.readSlot({ platform: "x" });
        assertEqual(after.refreshState, "ready", "replacement resets refresh state");
      },
    },
    {
      id: "expired_operation_is_cleaned",
      description: "Expired operations lose their candidate secrets",
      async run(harness) {
        await seedSlot(harness);
        await harness.credentials.createAuthOperation(
          startOperation({ expiresAt: instant(60_000) }),
        );
        const claimed = await harness.credentials.claimOAuthCallback({
          platform: "x",
          oauthState: "state_0001",
          requestToken: null,
          now: FIXTURE_NOW,
          currentConfigBinding: "config-binding-1",
        });
        assertKind(claimed, "claimed", "callback claim wins");
        await harness.credentials.saveCandidate(candidateCommit());
        const cleaned = await harness.credentials.cleanupExpired({
          now: instant(120_000),
          limit: 10,
        });
        assertEqual(cleaned.removed, 1, "one operation expired");
        const operation = await harness.credentials.readAuthOperation({
          operationId: "op_0001",
        });
        assertTrue(operation !== null, "operation still readable as expired");
        assertEqual(operation.phase, "expired", "phase expired");
        assertEqual(operation.candidateEnvelope, null, "candidate secret cleared");
      },
    },
    {
      id: "gc_keeps_unfinished_intents",
      description: "Only finished jobs past retention are collected",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        await harness.publishing.claimExecution(keylessClaimInput());
        await harness.publishing.commitExecution(publishedCommit());
        const early = await harness.outbox.collectFinished({ now: FIXTURE_NOW, limit: 10 });
        assertEqual(early.removed, 0, "retention not reached");
        const late = await harness.outbox.collectFinished({
          now: instant(31 * 24 * 60 * 60_000),
          limit: 10,
        });
        assertEqual(late.removed, 1, "finished job collected");
      },
    },
    {
      id: "diagnostics_report_due_dead_letter",
      description: "A due job terminated by DLQ is immediately visible",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        const settled = await harness.publishing.settleDeadLetter({
          jobId: "job_0001",
          publicationId: "pub_0001",
          now: FIXTURE_NOW,
          transportReason: "queue_dlq",
        });
        assertKind(settled, "dead_lettered", "due job dead-lettered");
        const diagnostics = await harness.diagnostics.readSnapshot();
        assertEqual(diagnostics.deadLettered, 1, "dead-lettered publication counted");
      },
    },
    {
      id: "diagnostics_show_future_dlq_before_due",
      description: "A future DLQ failure is visible while its transition is preserved",
      async run(harness) {
        const scheduledAt = instant(30 * 60_000);
        await harness.publishing.createPostWithDispatch(createTransaction({ scheduledAt }));
        const recorded = await harness.publishing.settleDeadLetter({
          jobId: "job_0001",
          publicationId: "pub_0001",
          now: FIXTURE_NOW,
          transportReason: "future_dlq",
        });
        assertKind(recorded, "recorded", "future DLQ recorded only");
        const beforeDue = await harness.diagnostics.readSnapshot();
        assertEqual(beforeDue.deadLettered, 1, "waiting failure is visible before due");

        const recovery = await harness.publishing.recoverStaleClaims({
          now: scheduledAt,
          limit: 10,
        });
        assertEqual(recovery.jobsDeadLettered, 1, "settled at due time");
        const afterDue = await harness.diagnostics.readSnapshot();
        assertEqual(afterDue.deadLettered, 1, "still counted after termination");
        const execution = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertTrue(execution !== null, "execution readable");
        assertEqual(execution.publication.terminalReason, "dead_lettered", "terminal reason");
      },
    },
    {
      id: "diagnostics_ignore_late_dlq_on_result",
      description: "A late DLQ over a completed result is not a live failure",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        await harness.publishing.claimExecution(keylessClaimInput());
        await harness.publishing.commitExecution(publishedCommit());
        const settled = await harness.publishing.settleDeadLetter({
          jobId: "job_0001",
          publicationId: "pub_0001",
          now: instant(1_000),
          transportReason: "queue_dlq",
        });
        assertKind(settled, "recorded", "late DLQ recorded only");
        const diagnostics = await harness.diagnostics.readSnapshot();
        assertEqual(diagnostics.deadLettered, 0, "published result is not a live failure");
      },
    },
    {
      id: "refresh_expired_lease_blocks_new_exchange",
      description: "An expired unfinished lease never authorises another exchange",
      async run(harness) {
        await seedSlot(harness);
        const acquired = await harness.credentials.acquireRefresh(refreshClaim());
        assertKind(acquired, "acquired", "first lease acquired");
        const lateAcquire = await harness.credentials.acquireRefresh(
          refreshClaim({ leaseToken: "lease_0002", now: instant(120_000) }),
        );
        assertKind(lateAcquire, "conflict", "expired lease must not hand out a new one");
        assertEqual(lateAcquire.reason, "reconnect_required", "reason");
        const lateComplete = await harness.credentials.completeRefresh(
          refreshCommit({ now: instant(120_000) }),
        );
        assertKind(lateComplete, "conflict", "expired lease cannot complete");
        assertEqual(lateComplete.reason, "reconnect_required", "reason");
        const slot = await harness.credentials.readSlot({ platform: "x" });
        assertEqual(slot.revision, 1, "no revision change");
        assertEqual(slot.refreshLease?.token, "lease_0001", "original lease untouched");
        assertEqual(slot.refreshState, "ready", "state only changes through explicit marking");
      },
    },
    {
      id: "mark_reconnect_requires_matching_lease",
      description: "A stale failure token cannot poison a replacement connection",
      async run(harness) {
        await seedSlot(harness);
        const acquired = await harness.credentials.acquireRefresh(refreshClaim());
        assertKind(acquired, "acquired", "lease acquired");
        const replaced = await harness.credentials.compareAndSetSlot({
          platform: "x",
          expectedRevision: 1,
          now: instant(1_000),
          change: {
            kind: "set",
            bindingId: "bind-new",
            envelope: testEnvelope("new"),
            payloadRevision: 2,
            payloadSchemaVersion: 1,
            expiresAt: null,
            target: null,
          },
        });
        assertKind(replaced, "applied", "direct set replaces the connection");
        const late = await harness.credentials.markReconnectRequired({
          platform: "x",
          leaseToken: "lease_0001",
          expectedRevision: 1,
          now: instant(2_000),
          reason: "unknown_result",
        });
        assertKind(late, "conflict", "stale failure is refused");
        assertEqual(late.reason, "lease_mismatch", "reason");
        const slot = await harness.credentials.readSlot({ platform: "x" });
        assertEqual(slot.revision, 2, "new connection untouched");
        assertEqual(slot.refreshState, "ready", "new connection stays ready");
        assertEqual(slot.bindingId, "bind-new", "binding preserved");
      },
    },
    {
      id: "all_refresh_failures_require_reconnect",
      description: "Every failed exchange conservatively blocks automatic refresh",
      async run(harness) {
        const plan = [
          { platform: "x" as Platform, reason: "unknown_result" as const },
          { platform: "bluesky" as Platform, reason: "provider_rejected" as const },
          { platform: "linkedin" as Platform, reason: "invalid_response" as const },
        ];
        for (const entry of plan) {
          await seedSlot(harness, entry.platform, `${entry.platform}-seed`);
          const acquired = await harness.credentials.acquireRefresh(
            refreshClaim({ platform: entry.platform, leaseToken: `lease-${entry.platform}` }),
          );
          assertKind(acquired, "acquired", `${entry.platform} lease acquired`);
          const marked = await harness.credentials.markReconnectRequired({
            platform: entry.platform,
            leaseToken: `lease-${entry.platform}`,
            expectedRevision: 1,
            now: instant(1_000),
            reason: entry.reason,
          });
          assertKind(marked, "applied", `${entry.reason} marks reconnect`);
          const slot = await harness.credentials.readSlot({ platform: entry.platform });
          assertEqual(slot.refreshState, "reconnect_required", `${entry.reason} state`);
          assertEqual(slot.refreshLease, null, `${entry.reason} lease cleared`);
          const retry = await harness.credentials.acquireRefresh(
            refreshClaim({
              platform: entry.platform,
              leaseToken: `lease2-${entry.platform}`,
              now: instant(120_000),
            }),
          );
          assertKind(retry, "conflict", `${entry.reason} blocks reacquisition`);
          assertEqual(retry.reason, "reconnect_required", `${entry.reason} reason`);
        }
      },
    },
    {
      id: "refresh_preserves_target_and_binding",
      description: "A refresh cannot retarget or rebind a connection",
      async run(harness) {
        const seeded = await harness.credentials.compareAndSetSlot({
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
            target: { label: "alice", source: "provider" },
          },
        });
        assertKind(seeded, "applied", "slot seeded with a target");
        const acquired = await harness.credentials.acquireRefresh(refreshClaim());
        assertKind(acquired, "acquired", "lease acquired");
        const retarget = await harness.credentials.completeRefresh(
          refreshCommit({ target: { label: "bob", source: "provider" } }),
        );
        assertKind(retarget, "conflict", "a retarget must conflict");
        assertEqual(retarget.reason, "guard_mismatch", "reason");
        const afterConflict = await harness.credentials.readSlot({ platform: "x" });
        assertEqual(afterConflict.revision, 1, "no mutation on conflict");
        assertEqual(afterConflict.target?.label, "alice", "target untouched");
        const applied = await harness.credentials.completeRefresh(refreshCommit());
        assertKind(applied, "applied", "refresh without a target change applies");
        const slot = await harness.credentials.readSlot({ platform: "x" });
        assertEqual(slot.target?.label, "alice", "target preserved");
        assertEqual(slot.bindingId, "bind-1", "binding preserved");
      },
    },
    {
      id: "refresh_replay_requires_exact_identity",
      description: "Only an exact refresh replay is already_applied",
      async run(harness) {
        await seedSlot(harness);
        const acquired = await harness.credentials.acquireRefresh(refreshClaim());
        assertKind(acquired, "acquired", "lease acquired");
        const commit = refreshCommit();
        const applied = await harness.credentials.completeRefresh(commit);
        assertKind(applied, "applied", "refresh applies");
        const replay = await harness.credentials.completeRefresh({
          ...commit,
          now: instant(5_000),
        });
        assertKind(replay, "already_applied", "exact replay is idempotent");
        const altered = await harness.credentials.completeRefresh({
          ...commit,
          expiresAt: instant(9_000_000),
          now: instant(5_000),
        });
        assertKind(altered, "conflict", "semantically different input is not a replay");
        assertEqual(altered.reason, "revision_mismatch", "reason");
      },
    },
    {
      id: "oauth_conflicts_do_not_mutate",
      description: "Callback and activation conflicts leave records untouched",
      async run(harness) {
        await seedSlot(harness);
        await harness.credentials.createAuthOperation(startOperation());
        const claimed = await harness.credentials.claimOAuthCallback({
          platform: "x",
          oauthState: "state_0001",
          requestToken: null,
          now: FIXTURE_NOW,
          currentConfigBinding: "config-binding-1",
        });
        assertKind(claimed, "claimed", "callback claim");
        await harness.credentials.saveCandidate(candidateCommit());
        const activated = await harness.credentials.activateCandidate(activationCommit());
        assertKind(activated, "activated", "activation applies");
        const completed = await harness.credentials.readAuthOperation({ operationId: "op_0001" });
        assertTrue(completed !== null, "completed operation readable");

        // A late callback for an operation that already completed must not
        // damage the stored receipt.
        const lateCallback = await harness.credentials.claimOAuthCallback({
          platform: "x",
          oauthState: "state_0001",
          requestToken: null,
          now: instant(1_000),
          currentConfigBinding: "config-binding-1",
        });
        assertKind(lateCallback, "conflict", "completed operation refuses a callback");
        assertEqual(lateCallback.reason, "phase_mismatch", "phase checked first");
        const afterCallback = await harness.credentials.readAuthOperation({ operationId: "op_0001" });
        assertDeepEqual(afterCallback, completed, "completed operation unchanged");

        // Expired and config-changed conflicts are read-only.
        await harness.credentials.createAuthOperation(
          startOperation({
            operationId: "op_0002",
            oauthState: "state_0002",
            expiresAt: instant(60_000),
          }),
        );
        const expiredBefore = await harness.credentials.readAuthOperation({
          operationId: "op_0002",
        });
        const expiredClaim = await harness.credentials.claimOAuthCallback({
          platform: "x",
          oauthState: "state_0002",
          requestToken: null,
          now: instant(120_000),
          currentConfigBinding: "config-binding-1",
        });
        assertKind(expiredClaim, "conflict", "expired operation refuses a callback");
        assertEqual(expiredClaim.reason, "expired", "reason");
        assertDeepEqual(
          await harness.credentials.readAuthOperation({ operationId: "op_0002" }),
          expiredBefore,
          "expired conflict leaves the record for cleanup",
        );

        await harness.credentials.createAuthOperation(
          startOperation({ operationId: "op_0003", oauthState: "state_0003" }),
        );
        const configBefore = await harness.credentials.readAuthOperation({
          operationId: "op_0003",
        });
        const changedConfig = await harness.credentials.claimOAuthCallback({
          platform: "x",
          oauthState: "state_0003",
          requestToken: null,
          now: FIXTURE_NOW,
          currentConfigBinding: "config-binding-2",
        });
        assertKind(changedConfig, "conflict", "changed config refuses a callback");
        assertEqual(changedConfig.reason, "start_config_changed", "reason");
        assertDeepEqual(
          await harness.credentials.readAuthOperation({ operationId: "op_0003" }),
          configBefore,
          "config conflict leaves the record untouched",
        );
      },
    },
    {
      id: "candidate_after_ttl_is_not_usable",
      description: "A late candidate cannot leave a usable secret behind",
      async run(harness) {
        await seedSlot(harness);
        await harness.credentials.createAuthOperation(
          startOperation({ expiresAt: instant(60_000) }),
        );
        const claimed = await harness.credentials.claimOAuthCallback({
          platform: "x",
          oauthState: "state_0001",
          requestToken: null,
          now: FIXTURE_NOW,
          currentConfigBinding: "config-binding-1",
        });
        assertKind(claimed, "claimed", "callback claim");
        const saved = await harness.credentials.saveCandidate(
          candidateCommit({ now: instant(120_000) }),
        );
        assertKind(saved, "conflict", "a late candidate is refused");
        const beforeCleanup = await harness.credentials.readAuthOperation({
          operationId: "op_0001",
        });
        assertTrue(beforeCleanup !== null, "operation readable");
        assertEqual(beforeCleanup.candidateEnvelope, null, "no usable candidate secret");
        const cleaned = await harness.credentials.cleanupExpired({
          now: instant(120_000),
          limit: 10,
        });
        assertEqual(cleaned.removed, 1, "cleanup expires the operation");
        const afterCleanup = await harness.credentials.readAuthOperation({
          operationId: "op_0001",
        });
        assertTrue(afterCleanup !== null, "operation still readable");
        assertEqual(afterCleanup.phase, "expired", "phase expired");
        assertEqual(afterCleanup.candidateEnvelope, null, "candidate cleared");
      },
    },
    {
      id: "claim_validates_job_and_publication_state",
      description: "Claim refuses cancelled jobs, wrong attempts and settled rows",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        const wrongAttempt = await harness.publishing.claimExecution(
          keylessClaimInput({ attemptNo: 2 }),
        );
        assertKind(wrongAttempt, "not_claimed", "attempt 2 cannot claim before attempt 1");
        assertEqual(wrongAttempt.reason, "attempt_mismatch", "reason");

        const claimed = await harness.publishing.claimExecution(keylessClaimInput());
        assertKind(claimed, "claimed", "first attempt claims");
        const duplicate = await harness.publishing.claimExecution(
          keylessClaimInput({ claimToken: "claim_0002", attemptId: "attempt_0002" }),
        );
        assertKind(duplicate, "not_claimed", "live claim refuses a duplicate");
        assertEqual(duplicate.reason, "already_claimed", "reason");

        const retryAt = instant(60_000);
        const committed = await harness.publishing.commitExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
          attemptId: "attempt_0001",
          claimToken: "claim_0001",
          now: FIXTURE_NOW,
          outcome: "safe_retry",
          errorCode: "RATE_LIMIT",
          retryAt,
          nextJob: {
            id: "job_0002",
            kind: "delivery.execute",
            aggregateId: "pub_0001",
            attemptNo: 2,
            availableAt: retryAt,
          },
          archive: null,
        });
        assertKind(committed, "applied", "safe retry applies");
        const cancelled = await harness.publishing.claimExecution(
          keylessClaimInput({ now: retryAt, claimToken: "claim_0003", attemptId: "attempt_0003" }),
        );
        assertKind(cancelled, "not_claimed", "the superseded job cannot execute");
        assertEqual(cancelled.reason, "cancelled_job", "reason");
      },
    },
    {
      id: "archive_result_guard",
      description: "Archive results only update their own attempt",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        await harness.publishing.claimExecution(keylessClaimInput());
        const retryAt = instant(60_000);
        const keyOne = "archive/provider-responses/2026/09/pub_0001/attempt_0001.json";
        const retried = await harness.publishing.commitExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
          attemptId: "attempt_0001",
          claimToken: "claim_0001",
          now: FIXTURE_NOW,
          outcome: "safe_retry",
          errorCode: "PROVIDER_UNAVAILABLE",
          retryAt,
          nextJob: {
            id: "job_0002",
            kind: "delivery.execute",
            aggregateId: "pub_0001",
            attemptNo: 2,
            availableAt: retryAt,
          },
          archive: { key: keyOne },
        });
        assertKind(retried, "applied", "retry with a planned archive applies");
        const secondClaim = await harness.publishing.claimExecution(
          keylessClaimInput({
            jobId: "job_0002",
            attemptNo: 2,
            now: retryAt,
            claimToken: "claim_0002",
            attemptId: "attempt_0002",
          }),
        );
        assertKind(secondClaim, "claimed", "second attempt claims");

        const late = await harness.publishing.recordArchiveResult({
          publicationId: "pub_0001",
          attemptId: "attempt_0001",
          archiveKey: keyOne,
          status: "available",
          now: instant(61_000),
        });
        assertKind(late, "conflict", "an old attempt's archive result is refused");
        assertEqual(late.reason, "guard_mismatch", "reason");

        const keyTwo = "archive/provider-responses/2026/09/pub_0001/attempt_0002.json";
        const published = await harness.publishing.commitExecution({
          jobId: "job_0002",
          publicationId: "pub_0001",
          attemptId: "attempt_0002",
          claimToken: "claim_0002",
          now: instant(62_000),
          outcome: "published",
          externalId: "external-2",
          externalUrl: null,
          archive: { key: keyTwo },
        });
        assertKind(published, "applied", "second attempt publishes");
        const wrongKey = await harness.publishing.recordArchiveResult({
          publicationId: "pub_0001",
          attemptId: "attempt_0002",
          archiveKey: keyOne,
          status: "available",
          now: instant(63_000),
        });
        assertKind(wrongKey, "conflict", "a different key is refused");
        const applied = await harness.publishing.recordArchiveResult({
          publicationId: "pub_0001",
          attemptId: "attempt_0002",
          archiveKey: keyTwo,
          status: "failed",
          now: instant(64_000),
        });
        assertKind(applied, "applied", "the planned key accepts a result");
        const replay = await harness.publishing.recordArchiveResult({
          publicationId: "pub_0001",
          attemptId: "attempt_0002",
          archiveKey: keyTwo,
          status: "failed",
          now: instant(65_000),
        });
        assertKind(replay, "already_applied", "identical archive result replays");
        const diagnostics = await harness.diagnostics.readSnapshot();
        assertEqual(diagnostics.latestAttemptArchiveFailures, 1, "archive failure visible");
      },
    },
    {
      id: "archive_after_safe_retry",
      description: "The completed attempt can record its archive before the next claim",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(createTransaction());
        await harness.publishing.claimExecution(keylessClaimInput());
        const keyOne = "archive/provider-responses/2026/09/pub_0001/attempt_0001.json";
        const retryAt = instant(60_000);
        const retried = await harness.publishing.commitExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
          attemptId: "attempt_0001",
          claimToken: "claim_0001",
          now: FIXTURE_NOW,
          outcome: "safe_retry",
          errorCode: "PROVIDER_UNAVAILABLE",
          retryAt,
          nextJob: {
            id: "job_0002",
            kind: "delivery.execute",
            aggregateId: "pub_0001",
            attemptNo: 2,
            availableAt: retryAt,
          },
          archive: { key: keyOne },
        });
        assertKind(retried, "applied", "safe retry applies");

        // Before the next claim the publication has no current attempt id, but
        // the completed attempt identity is still known: its archive must land.
        const failed = await harness.publishing.recordArchiveResult({
          publicationId: "pub_0001",
          attemptId: "attempt_0001",
          archiveKey: keyOne,
          status: "failed",
          now: instant(1_000),
        });
        assertKind(failed, "applied", "archive result for the completed attempt applies");
        const afterFailure = await harness.diagnostics.readSnapshot();
        assertEqual(afterFailure.latestAttemptArchiveFailures, 1, "failure counted once");

        const secondClaim = await harness.publishing.claimExecution(
          keylessClaimInput({
            jobId: "job_0002",
            attemptNo: 2,
            now: retryAt,
            claimToken: "claim_0002",
            attemptId: "attempt_0002",
          }),
        );
        assertKind(secondClaim, "claimed", "next attempt claims");
        const claimedExecution = await harness.publishing.getExecution({
          jobId: "job_0002",
          publicationId: "pub_0001",
        });
        assertTrue(claimedExecution !== null, "execution readable");
        assertEqual(claimedExecution.publication.archiveKey, null, "old planned key cleared");
        assertEqual(
          claimedExecution.publication.archiveStatus,
          "not_requested",
          "old archive status cleared",
        );
        const afterClaim = await harness.diagnostics.readSnapshot();
        assertEqual(
          afterClaim.latestAttemptArchiveFailures,
          0,
          "previous attempt's failure is not attributed to the new attempt",
        );

        const stale = await harness.publishing.recordArchiveResult({
          publicationId: "pub_0001",
          attemptId: "attempt_0001",
          archiveKey: keyOne,
          status: "available",
          now: instant(2_000),
        });
        assertKind(stale, "conflict", "the superseded attempt cannot write after a claim");

        const keyTwo = "archive/provider-responses/2026/09/pub_0001/attempt_0002.json";
        const published = await harness.publishing.commitExecution({
          jobId: "job_0002",
          publicationId: "pub_0001",
          attemptId: "attempt_0002",
          claimToken: "claim_0002",
          now: instant(3_000),
          outcome: "published",
          externalId: "external-2",
          externalUrl: null,
          archive: { key: keyTwo },
        });
        assertKind(published, "applied", "second attempt publishes");
        const available = await harness.publishing.recordArchiveResult({
          publicationId: "pub_0001",
          attemptId: "attempt_0002",
          archiveKey: keyTwo,
          status: "available",
          now: instant(4_000),
        });
        assertKind(available, "applied", "success result for the current attempt applies");
        const afterSuccess = await harness.diagnostics.readSnapshot();
        assertEqual(afterSuccess.latestAttemptArchiveFailures, 0, "success is not a failure");
      },
    },
    {
      id: "cleanup_expired_budget_is_bounded",
      description: "Cleanup spends at most `limit` row mutations per call",
      async run(harness) {
        await seedSlot(harness);
        const expiresAt = instant(60_000);

        // Operation 1: completed, then given residual secrets (legacy residue).
        await harness.credentials.createAuthOperation(startOperation({ expiresAt }));
        await harness.credentials.claimOAuthCallback({
          platform: "x",
          oauthState: "state_0001",
          requestToken: null,
          now: FIXTURE_NOW,
          currentConfigBinding: "config-binding-1",
        });
        await harness.credentials.saveCandidate(candidateCommit());
        const activated = await harness.credentials.activateCandidate(activationCommit());
        assertKind(activated, "activated", "operation 1 completes");

        // Operation 2: still pending when the TTL passes.
        await harness.credentials.createAuthOperation(
          startOperation({ operationId: "op_0002", oauthState: "state_0002", expiresAt }),
        );

        assertTrue(
          typeof harness.placeResidualSecrets === "function",
          "harness must expose the residual-secret fixture",
        );
        await harness.placeResidualSecrets?.({
          operationId: "op_0001",
          requestSecret: testEnvelope("residual-request"),
          candidateSecret: testEnvelope("residual-candidate"),
          now: FIXTURE_NOW,
        });

        const first = await harness.credentials.cleanupExpired({
          now: instant(120_000),
          limit: 1,
        });
        assertEqual(first.removed, 1, "first call changes exactly one row");
        const opOne = await harness.credentials.readAuthOperation({ operationId: "op_0001" });
        const opTwo = await harness.credentials.readAuthOperation({ operationId: "op_0002" });
        assertTrue(opOne !== null && opTwo !== null, "operations readable");
        assertEqual(opOne.phase, "completed", "completed phase and receipt retained");
        assertTrue(opOne.receipt !== null, "receipt retained");
        assertEqual(opOne.requestSecret, null, "residual request secret cleared");
        assertEqual(opOne.candidateEnvelope, null, "residual candidate secret cleared");
        assertEqual(opTwo.phase, "pending_callback", "second row untouched by the first call");

        const second = await harness.credentials.cleanupExpired({
          now: instant(120_000),
          limit: 1,
        });
        assertEqual(second.removed, 1, "second call changes the next row");
        const opTwoAfter = await harness.credentials.readAuthOperation({ operationId: "op_0002" });
        assertTrue(opTwoAfter !== null, "operation 2 readable");
        assertEqual(opTwoAfter.phase, "expired", "non-terminal row expires");
        assertEqual(opTwoAfter.requestSecret, null, "request secret cleared");

        const third = await harness.credentials.cleanupExpired({
          now: instant(120_000),
          limit: 1,
        });
        assertEqual(third.removed, 0, "third call changes nothing");
      },
    },
    {
      id: "diagnostics_oldest_due_matches_list_ready",
      description: "Oldest due time uses the dispatchable predicate",
      async run(harness) {
        const scheduledAt = instant(30 * 60_000);
        await harness.publishing.createPostWithDispatch(createTransaction({ scheduledAt }));
        const beforeDue = await harness.diagnostics.readSnapshot();
        assertEqual(beforeDue.oldestDueAt, null, "not due yet");
        const atDue = { now: scheduledAt, limit: 10 };
        const readyBefore = await harness.outbox.listReady(atDue);
        assertEqual(readyBefore.length, 1, "job is dispatchable at due time");

        const recorded = await harness.publishing.settleDeadLetter({
          jobId: "job_0001",
          publicationId: "pub_0001",
          now: FIXTURE_NOW,
          transportReason: "future_dlq",
        });
        assertKind(recorded, "recorded", "future DLQ recorded");
        const readyAfter = await harness.outbox.listReady(atDue);
        assertEqual(readyAfter.length, 0, "DLQ-seen job is not dispatchable");
        const afterDlq = await harness.diagnostics.readSnapshot();
        assertEqual(afterDlq.oldestDueAt, null, "oldest due follows the same predicate");
      },
    },
    {
      id: "dispatched_future_dlq_settles_at_due",
      description: "A dispatched future job that saw a DLQ still settles at due time",
      async run(harness) {
        const scheduledAt = instant(30 * 60_000);
        await harness.publishing.createPostWithDispatch(createTransaction({ scheduledAt }));
        const dispatched = await harness.outbox.recordDispatch({
          jobId: "job_0001",
          dispatchRevision: 0,
          now: FIXTURE_NOW,
          outcome: { kind: "dispatched" },
        });
        assertKind(dispatched, "applied", "job dispatched early");
        const recorded = await harness.publishing.settleDeadLetter({
          jobId: "job_0001",
          publicationId: "pub_0001",
          now: FIXTURE_NOW,
          transportReason: "future_dlq",
        });
        assertKind(recorded, "recorded", "future DLQ recorded on a dispatched job");
        assertEqual(recorded.reason, "not_due", "reason");

        const lateMark = await harness.outbox.recordDispatch({
          jobId: "job_0001",
          dispatchRevision: 1,
          now: instant(1_000),
          outcome: { kind: "dispatched" },
        });
        assertKind(lateMark, "conflict", "a dispatch mark after DLQ conflicts");
        assertEqual(lateMark.reason, "guard_mismatch", "reason");

        const rearm = await harness.outbox.rearmCurrentJob({
          jobId: "job_0001",
          publicationId: "pub_0001",
          now: scheduledAt,
          reason: "early_message",
        });
        assertKind(rearm, "conflict", "a DLQ-seen job is never rearmed");
        assertEqual(rearm.reason, "dlq_seen", "reason");

        const recovery = await harness.publishing.recoverStaleClaims({
          now: scheduledAt,
          limit: 10,
        });
        assertEqual(recovery.jobsDeadLettered, 1, "settled at due time");
        const execution = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertTrue(execution !== null, "execution readable");
        assertEqual(execution.publication.terminalReason, "dead_lettered", "terminal reason");
        assertEqual(execution.job.status, "cancelled", "transport intent cancelled");
      },
    },
    {
      id: "dlq_requires_matching_entity",
      description: "A cross-entity DLQ message never writes metadata",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(
          createTransaction({
            platforms: ["bluesky", "x"],
            publicationIds: ["pub_0001", "pub_0002"],
            jobIds: ["job_0001", "job_0002"],
          }),
        );
        const mismatched = await harness.publishing.settleDeadLetter({
          jobId: "job_0001",
          publicationId: "pub_0002",
          now: FIXTURE_NOW,
          transportReason: "queue_dlq",
        });
        assertKind(mismatched, "recorded", "mismatched pair is recorded only");
        const first = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertTrue(first !== null, "first execution readable");
        assertEqual(first.job.dlqSeenAt, null, "the other publication's job was not touched");
        const second = await harness.publishing.getExecution({
          jobId: "job_0002",
          publicationId: "pub_0002",
        });
        assertTrue(second !== null, "second execution readable");
        assertEqual(second.job.dlqSeenAt, null, "target job untouched");
      },
    },
    {
      id: "gc_keeps_unknown_failures",
      description: "Ambiguous results keep their transport record",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(
          createTransaction({
            platforms: ["bluesky", "x"],
            publicationIds: ["pub_0001", "pub_0002"],
            jobIds: ["job_0001", "job_0002"],
          }),
        );
        // x (job_0001) publishes; bluesky (job_0002) ends unknown.
        const xClaim = await harness.publishing.claimExecution(
          keylessClaimInput({ jobId: "job_0001", publicationId: "pub_0001" }),
        );
        assertKind(xClaim, "claimed", "x claims");
        const published = await harness.publishing.commitExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
          attemptId: "attempt_0001",
          claimToken: "claim_0001",
          now: FIXTURE_NOW,
          outcome: "published",
          externalId: "external-1",
          externalUrl: null,
          archive: null,
        });
        assertKind(published, "applied", "x publishes");
        const blueskyClaim = await harness.publishing.claimExecution(
          keylessClaimInput({
            jobId: "job_0002",
            publicationId: "pub_0002",
            claimToken: "claim_0002",
            attemptId: "attempt_0002",
          }),
        );
        assertKind(blueskyClaim, "claimed", "bluesky claims");
        const unknown = await harness.publishing.commitExecution({
          jobId: "job_0002",
          publicationId: "pub_0002",
          attemptId: "attempt_0002",
          claimToken: "claim_0002",
          now: FIXTURE_NOW,
          outcome: "failed",
          terminalReason: "unknown",
          errorCode: "NETWORK",
          errorAmbiguous: true,
          archive: null,
        });
        assertKind(unknown, "applied", "bluesky ends unknown");

        const collected = await harness.outbox.collectFinished({
          now: instant(31 * 24 * 60 * 60_000),
          limit: 10,
        });
        assertEqual(collected.removed, 1, "only the published job is collected");
        const retained = await harness.publishing.getExecution({
          jobId: "job_0002",
          publicationId: "pub_0002",
        });
        assertTrue(retained !== null, "unknown result keeps its transport record");
        assertEqual(retained.publication.errorAmbiguous, true, "ambiguity preserved");
      },
    },
    {
      id: "gc_selects_eligible_rows_before_the_budget",
      description: "Ineligible low-id rows cannot starve collectable work",
      async run(harness) {
        await harness.publishing.createPostWithDispatch(
          createTransaction({
            platforms: ["bluesky", "x"],
            publicationIds: ["pub_0001", "pub_0002"],
            jobIds: ["job_0001", "job_0002"],
          }),
        );
        // job_0001 stays active; job_0002 is finished long ago.
        const claim = await harness.publishing.claimExecution(
          keylessClaimInput({ jobId: "job_0002", publicationId: "pub_0002" }),
        );
        assertKind(claim, "claimed", "second job claims");
        const published = await harness.publishing.commitExecution({
          jobId: "job_0002",
          publicationId: "pub_0002",
          attemptId: "attempt_0001",
          claimToken: "claim_0001",
          now: FIXTURE_NOW,
          outcome: "published",
          externalId: "external-2",
          externalUrl: null,
          archive: null,
        });
        assertKind(published, "applied", "second job publishes");
        const collected = await harness.outbox.collectFinished({
          now: instant(31 * 24 * 60 * 60_000),
          limit: 1,
        });
        assertEqual(collected.removed, 1, "the eligible row is collected despite a lower id");
        const active = await harness.publishing.getExecution({
          jobId: "job_0001",
          publicationId: "pub_0001",
        });
        assertTrue(active !== null, "active job kept");
        const finished = await harness.publishing.getExecution({
          jobId: "job_0002",
          publicationId: "pub_0002",
        });
        assertEqual(finished, null, "finished job collected");
      },
    },
    {
      id: "cleanup_retains_receipt_and_clears_secrets",
      description: "Expired receipts stay readable without usable secrets",
      async run(harness) {
        await seedSlot(harness);
        await harness.credentials.createAuthOperation(
          startOperation({
            requestSecret: testEnvelope("request-secret"),
            requestSecretPurpose: "oauth_request_secret",
            requestSecretRevision: 1,
            expiresAt: instant(60_000),
          }),
        );
        const claimed = await harness.credentials.claimOAuthCallback({
          platform: "x",
          oauthState: "state_0001",
          requestToken: null,
          now: FIXTURE_NOW,
          currentConfigBinding: "config-binding-1",
        });
        assertKind(claimed, "claimed", "callback claim");
        await harness.credentials.saveCandidate(candidateCommit());
        const activated = await harness.credentials.activateCandidate(activationCommit());
        assertKind(activated, "activated", "activation applies");

        const cleaned = await harness.credentials.cleanupExpired({
          now: instant(120_000),
          limit: 10,
        });
        assertEqual(cleaned.removed, 0, "a completed operation is not deleted");
        const operation = await harness.credentials.readAuthOperation({
          operationId: "op_0001",
        });
        assertTrue(operation !== null, "receipt retained");
        assertEqual(operation.phase, "completed", "phase preserved");
        assertTrue(operation.receipt !== null, "receipt preserved");
        assertEqual(operation.requestSecret, null, "request secret cleared");
        assertEqual(operation.candidateEnvelope, null, "candidate secret cleared");
      },
    },
  ];
}

export async function runStoreContractScenarios(harness: StoreHarness): Promise<ContractReport> {
  const results: ContractScenarioResult[] = [];
  for (const scenario of storeContractScenarios()) {
    await harness.reset();
    try {
      await scenario.run(harness);
      results.push({ id: scenario.id, status: "pass", detail: null });
    } catch (error) {
      results.push({
        id: scenario.id,
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const failed = results.filter((result) => result.status === "fail").length;
  return {
    passed: results.length - failed,
    failed,
    scenarios: results,
  };
}
