/**
 * Best-effort archive write that runs strictly after an authoritative outcome
 * commit.
 *
 * The archive is diagnostic only: a slow, rejecting or unavailable archive
 * must never change the publishing result, never enter the provider retry path
 * and never keep the consumer waiting past a small fixed budget. The planned
 * logical key and the allowlisted payload are built before the commit, so this
 * module only writes and reports.
 */

import type { IsoInstant } from "../contracts/primitives.js";
import type { Logger } from "../ports/logger.js";
import type { ArchiveStore } from "../ports/archive-store.js";
import type { PublishingStore } from "../ports/publishing-store.js";
import type { ArchivePlan } from "./execution-policy.js";

/** Default and maximum wall-clock budget for one archive attempt. */
export const DEFAULT_ARCHIVE_BUDGET_MS = 2000;
export const MAX_ARCHIVE_BUDGET_MS = 2000;

/**
 * Upper bound on the window reserved *inside* the requested total budget for
 * marking a timeout status. It is never added on top of the budget: when the
 * object write runs out of its own slice, only this reserved slice remains, and
 * the whole stage still finishes inside the budget the caller asked for.
 */
export const TIMEOUT_STATUS_MARK_MS = 250;

export type ArchiveWriteStatus = "available" | "failed" | "unavailable";

export interface ArchiveWriteInput {
  readonly archive: ArchiveStore;
  /** Only the archive-result guard is needed from the publishing store. */
  readonly publishing: Pick<PublishingStore, "recordArchiveResult">;
  readonly publicationId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly plan: ArchivePlan;
  readonly now: IsoInstant;
  /** Test-only lowering; values above the cap are clamped. */
  readonly budgetMs?: number;
  readonly logger?: Logger;
}

/**
 * Write one archive object and report its status, never throwing.
 *
 * The whole stage — object write plus status persistence — is bounded by one
 * total wall-clock budget, so a hanging `put` *or* a hanging
 * `recordArchiveResult` cannot hold the consumer, and nothing ever waits past
 * that budget. The budget is split, not extended: the object write gets
 * `budget - reserve`, and the reserve (at most `TIMEOUT_STATUS_MARK_MS`, or a
 * quarter of very small budgets) is the only window available to mark a
 * timeout status.
 *
 * The returned status describes the **object write**, not the status
 * persistence: if the object was written but the status write hung, `available`
 * is reported and the row is simply not updated. A timed-out object write is
 * reported as `unavailable`, a rejection as `failed`.
 *
 * Every losing promise carries a catch handler so a late settlement can never
 * become an unhandled rejection after the consumer has moved on.
 */
export async function writeArchiveBestEffort(
  input: ArchiveWriteInput,
): Promise<ArchiveWriteStatus> {
  const requested = input.budgetMs ?? DEFAULT_ARCHIVE_BUDGET_MS;
  const budgetMs =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_ARCHIVE_BUDGET_MS)
      : DEFAULT_ARCHIVE_BUDGET_MS;
  const startedAt = Date.now();
  const totalDeadlineAt = startedAt + budgetMs;
  // Never more than a quarter of a small budget, so both phases always exist.
  const reserveMs = Math.min(
    TIMEOUT_STATUS_MARK_MS,
    Math.max(1, Math.floor(budgetMs / 4)),
  );
  const putDeadlineAt = Math.max(startedAt, totalDeadlineAt - reserveMs);

  const put = Promise.resolve().then(() => input.archive.put(input.plan.key, input.plan.payload));
  const writeOutcome = await raceDeadline(
    put.then(
      () => "ok" as const,
      () => "failed" as const,
    ),
    putDeadlineAt,
  );
  // A late settle must not surface as an unhandled rejection.
  void put.catch(() => {});

  const status: ArchiveWriteStatus =
    writeOutcome === "ok" ? "available" : writeOutcome === "failed" ? "failed" : "unavailable";
  // Marking shares the same total deadline: it can use whatever is left of the
  // budget (including the reserved slice) but never extends it.
  await raceDeadline(markStatus(input, status), totalDeadlineAt);

  writeArchiveLog(input.logger, {
    level: status === "available" ? "info" : "warn",
    event: "execution_archive_result",
    fields: { code: status, jobId: input.jobId, attemptId: input.attemptId },
  });
  return status;
}

async function markStatus(
  input: ArchiveWriteInput,
  status: ArchiveWriteStatus,
): Promise<"marked"> {
  try {
    await input.publishing.recordArchiveResult({
      publicationId: input.publicationId,
      attemptId: input.attemptId,
      archiveKey: input.plan.key,
      status,
      now: input.now,
    });
  } catch {
    // The outcome commit is already authoritative; a lost archive status is a
    // diagnostic gap, never a publishing failure.
  }
  return "marked";
}

/**
 * Bound one step by an absolute deadline. The timer is always cleared and the
 * racing promise always keeps a catch handler attached by its caller.
 */
async function raceDeadline<T>(
  work: Promise<T>,
  deadlineAt: number,
): Promise<T | "timeout"> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    void work.catch(() => {});
    return "timeout";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), remainingMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function writeArchiveLog(logger: Logger | undefined, event: Parameters<Logger["write"]>[0]): void {
  if (logger === undefined) {
    return;
  }
  try {
    logger.write(event);
  } catch {
    // Observability must never change the publishing outcome.
  }
}
