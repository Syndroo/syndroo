import type { PublicationJob } from "@syndroo/core";

import { executePublication } from "./publishing.js";
import { D1Repository } from "./repository.js";

export async function consumePublications(
  batch: MessageBatch<PublicationJob>,
  env: Env,
): Promise<void> {
  const repository = new D1Repository(env.DB);

  for (const message of batch.messages) {
    if (!isPublicationJob(message.body)) {
      console.error(
        JSON.stringify({
          event: "invalid_publication_job",
          messageId: message.id,
        }),
      );
      message.ack();
      continue;
    }

    const decision = await executePublication(
      message.body.publicationId,
      repository,
      env,
    );

    if (decision.action === "retry") {
      message.retry({ delaySeconds: decision.delaySeconds });
    } else {
      message.ack();
    }
  }
}

function isPublicationJob(value: unknown): value is PublicationJob {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.ownKeys(value).length === 1 &&
    typeof Reflect.get(value, "publicationId") === "string"
  );
}
