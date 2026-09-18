import { PublishError, type Publisher } from "@syndroo/core";

import { publisherFor } from "./publishers.js";
import { D1Repository, type StoredPublication } from "./repository.js";
import {
  retryAtFor,
  secondsUntilRetry,
  shouldRetry,
} from "./retry.js";

/**
 * What the caller must do with the delivery that triggered this execution.
 * The executor never touches a Queue message; Cloudflare Queues map this to
 * `ack()` or `retry({ delaySeconds })`, and tests or another caller can apply
 * the same decision without constructing a `MessageBatch`.
 */
export type PublicationDecision =
  | { action: "ack" }
  | { action: "retry"; delaySeconds: number };

/** Keep a live claim delivery parked until stale-claim recovery can run. */
const ACTIVE_CLAIM_RETRY_SECONDS = 15 * 60;

/** Transport or persistence failure: retry the delivery, not the provider. */
const INFRASTRUCTURE_RETRY_SECONDS = 60;

/**
 * Claim and publish one Publication, returning the delivery decision instead of
 * applying it.
 *
 * `repository` is the concrete D1 implementation, so the atomic claim, the
 * attempt count, and the durable retry time keep their existing SQL guarantees.
 * Cloudflare Queue acknowledgment and retry mechanics stay in `jobs.ts`.
 */
export async function executePublication(
  publicationId: string,
  repository: D1Repository,
  env: Env,
): Promise<PublicationDecision> {
  const now = new Date().toISOString();
  let publication: StoredPublication | null;

  try {
    publication = await repository.claimPublication(publicationId, now);
  } catch (error) {
    return infrastructureFailure("publication_claim_failed", publicationId, error);
  }

  if (!publication) {
    return decideUnclaimed(publicationId, repository);
  }

  let result: Awaited<ReturnType<Publisher["publish"]>>;

  try {
    result = await publisherFor(publication.platform, env).publish({
      publicationId: publication.id,
      platform: publication.platform,
      content: publication.content,
    });
  } catch (error) {
    const publishError = normalizePublishError(error);
    const retry = shouldRetry(publishError, publication.attempts);
    const failedAt = new Date().toISOString();
    const retryAt = retry ? retryAtFor(failedAt, publication.attempts) : undefined;

    try {
      await repository.markFailed(
        publication.id,
        publishError,
        retry,
        failedAt,
        retryAt,
      );
    } catch (persistError) {
      return infrastructureFailure(
        "publish_failure_persist_failed",
        publication.id,
        persistError,
      );
    }

    console.error(
      JSON.stringify({
        event: "publication_failed",
        publicationId: publication.id,
        platform: publication.platform,
        code: publishError.code,
        ambiguous: publishError.ambiguous,
        retry,
        attempts: publication.attempts,
      }),
    );

    if (retry && retryAt !== undefined) {
      // Wait at least until the persisted earliest retry time.
      return {
        action: "retry",
        delaySeconds: secondsUntilRetry(retryAt, Date.now()),
      };
    }

    return { action: "ack" };
  }

  try {
    await repository.markPublished(
      publication.id,
      result.externalId,
      result.externalUrl,
      new Date().toISOString(),
    );
  } catch (error) {
    return infrastructureFailure(
      "publish_success_persist_failed",
      publication.id,
      error,
    );
  }

  console.log(
    JSON.stringify({
      event: "publication_published",
      publicationId: publication.id,
      platform: publication.platform,
      attempts: publication.attempts,
    }),
  );
  return { action: "ack" };
}

/**
 * The claim was rejected, so this delivery is a duplicate. Read the stored
 * state to keep the delivery instead of dropping it, without calling the
 * provider or increasing attempts.
 */
async function decideUnclaimed(
  publicationId: string,
  repository: D1Repository,
): Promise<PublicationDecision> {
  let current: StoredPublication | null;

  try {
    current = await repository.getPublication(publicationId);
  } catch (error) {
    return infrastructureFailure("publication_read_failed", publicationId, error);
  }

  if (current?.status === "publishing") {
    return { action: "retry", delaySeconds: ACTIVE_CLAIM_RETRY_SECONDS };
  }

  if (current?.status === "pending" && current.retryAt !== undefined) {
    // Duplicate delivery before the persisted retry time. Keep the retry
    // delivery instead of acking it; the stored time gates the next claim.
    return {
      action: "retry",
      delaySeconds: secondsUntilRetry(current.retryAt, Date.now()),
    };
  }

  return { action: "ack" };
}

function infrastructureFailure(
  event: string,
  publicationId: string,
  error: unknown,
): PublicationDecision {
  console.error(
    JSON.stringify({
      event,
      publicationId,
      error: error instanceof Error ? error.message : "Unknown error",
    }),
  );
  return { action: "retry", delaySeconds: INFRASTRUCTURE_RETRY_SECONDS };
}

function normalizePublishError(error: unknown): PublishError {
  if (error instanceof PublishError) {
    return error;
  }

  return new PublishError(
    error instanceof Error ? error.message : "Unknown publishing failure",
    "UNKNOWN",
    true,
    error instanceof Error ? { cause: error } : undefined,
  );
}
