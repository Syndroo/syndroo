import {
  PublishError,
  type Publication,
  type PublicationJob,
} from "@syndroo/core";

import { publisherFor } from "./publishers.js";
import { D1Repository } from "./repository.js";

const MAX_ATTEMPTS = 3;

export async function consumePublications(
  batch: MessageBatch<PublicationJob>,
  env: Env,
): Promise<void> {
  const repository = new D1Repository(env.DB);

  for (const message of batch.messages) {
    await consumeOne(message, repository, env);
  }
}

async function consumeOne(
  message: Message<PublicationJob>,
  repository: D1Repository,
  env: Env,
): Promise<void> {
  if (!isPublicationJob(message.body)) {
    console.error(
      JSON.stringify({
        event: "invalid_publication_job",
        messageId: message.id,
      }),
    );
    message.ack();
    return;
  }

  const now = new Date().toISOString();
  let publication: Publication | null;

  try {
    publication = await repository.claimPublication(
      message.body.publicationId,
      now,
    );
  } catch (error) {
    retryInfrastructure(message, "publication_claim_failed", error);
    return;
  }

  if (!publication) {
    const current = await repository.getPublication(message.body.publicationId);

    if (current?.status === "publishing") {
      message.retry({ delaySeconds: 15 * 60 });
    } else {
      message.ack();
    }

    return;
  }

  let result: Awaited<ReturnType<ReturnType<typeof publisherFor>["publish"]>>;

  try {
    result = await publisherFor(publication.platform, env).publish({
      publicationId: publication.id,
      platform: publication.platform,
      content: publication.content,
    });
  } catch (error) {
    const publishError = normalizePublishError(error);
    const retry = shouldRetry(publishError, publication.attempts);

    try {
      await repository.markFailed(
        publication.id,
        publishError,
        retry,
        new Date().toISOString(),
      );
    } catch (persistError) {
      retryInfrastructure(message, "publish_failure_persist_failed", persistError);
      return;
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

    if (retry) {
      message.retry({ delaySeconds: retryDelay(publication.attempts) });
    } else {
      message.ack();
    }

    return;
  }

  try {
    await repository.markPublished(
      publication.id,
      result.externalId,
      result.externalUrl,
      new Date().toISOString(),
    );
  } catch (error) {
    retryInfrastructure(message, "publish_success_persist_failed", error);
    return;
  }

  console.log(
    JSON.stringify({
      event: "publication_published",
      publicationId: publication.id,
      platform: publication.platform,
      attempts: publication.attempts,
    }),
  );
  message.ack();
}

function shouldRetry(error: PublishError, attempts: number): boolean {
  if (error.ambiguous || attempts >= MAX_ATTEMPTS) {
    return false;
  }

  return (
    error.code === "RATE_LIMIT" ||
    error.code === "PROVIDER_UNAVAILABLE" ||
    error.code === "NETWORK"
  );
}

function retryDelay(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 15 * 60);
}

function retryInfrastructure(
  message: Message<PublicationJob>,
  event: string,
  error: unknown,
): void {
  console.error(
    JSON.stringify({
      event,
      publicationId: isPublicationJob(message.body)
        ? message.body.publicationId
        : undefined,
      error: error instanceof Error ? error.message : "Unknown error",
    }),
  );
  message.retry({ delaySeconds: 60 });
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

function isPublicationJob(value: unknown): value is PublicationJob {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.ownKeys(value).length === 1 &&
    typeof Reflect.get(value, "publicationId") === "string"
  );
}
