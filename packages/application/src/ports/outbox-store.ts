/**
 * Transport-intent port for the transactional outbox.
 *
 * `cancelled` means the delivery intent is no longer needed; the Publication
 * remains the outcome authority. A cancelled job never becomes pending again.
 */

import type {
  DispatchObservation,
  OutboxJob,
  ReadyQuery,
  RearmCondition,
  RearmResult,
} from "../contracts/outbox.js";
import type { CleanupResult, CommitResult, MaintenanceBudget } from "../contracts/primitives.js";

export interface OutboxStore {
  /**
   * Pending jobs whose `availableAt` is due, ordered by `(availableAt, id)` and
   * capped by the run budget. Jobs that already saw a DLQ are never returned:
   * after a DLQ arrival the transport intent is settled by maintenance, not by
   * another provider call.
   */
  listReady(input: ReadyQuery): Promise<readonly OutboxJob[]>;

  /**
   * Record one dispatch observation guarded by `dispatchRevision`, so a late
   * producer mark cannot overwrite newer rearm/cancel intent.
   */
  recordDispatch(input: DispatchObservation): Promise<CommitResult>;

  /**
   * Restore dispatch intent for the current job while preserving `availableAt`.
   * `stalled_transport` consumes the bounded recovery budget and reports
   * `exhausted` at the cap; `early_message` does not.
   */
  rearmCurrentJob(input: RearmCondition): Promise<RearmResult>;

  /**
   * Collect finished transport intents past the retention window. Active,
   * unresolved, unknown-associated, idempotency and domain rows are never
   * removed.
   */
  collectFinished(input: MaintenanceBudget): Promise<CleanupResult>;
}
