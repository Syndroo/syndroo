import type { PublicationJob } from "@syndroo/core";

import { D1Repository } from "./repository.js";

const SCHEDULER_BATCH_SIZE = 50;
const PUBLISHING_TIMEOUT_MS = 15 * 60 * 1000;

export async function schedulePublications(
  env: Env,
  scheduledTime: number,
): Promise<void> {
  const repository = new D1Repository(env.DB);
  const now = new Date(scheduledTime);
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - PUBLISHING_TIMEOUT_MS).toISOString();
  const recovered = await repository.recoverStalePublishing(cutoff, nowIso);
  const due = await repository.findDuePublications(
    nowIso,
    cutoff,
    SCHEDULER_BATCH_SIZE,
  );
  const ready: PublicationJob[] = [];
  const readyIds: string[] = [];

  for (const publication of due) {
    if (
      publication.status === "scheduled" &&
      !(await repository.activateScheduled(publication.id, nowIso))
    ) {
      continue;
    }

    ready.push({ publicationId: publication.id });
    readyIds.push(publication.id);
  }

  if (ready.length > 0) {
    await env.PUBLICATION_QUEUE.sendBatch(
      ready.map(body => ({ body, contentType: "json" })),
    );
    await repository.markEnqueued(readyIds, nowIso);
  }

  console.log(
    JSON.stringify({
      event: "scheduler_completed",
      due: due.length,
      enqueued: ready.length,
      recovered,
      scheduledTime: nowIso,
    }),
  );
}
