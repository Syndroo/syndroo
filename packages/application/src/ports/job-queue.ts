/**
 * Minimal queue port. The application only sends a versioned, ID-only
 * envelope; acknowledgement, redelivery delay and DLQ movement are runtime
 * concerns and are not part of this contract.
 */

import type { QueueEnvelopeV1 } from "../contracts/outbox.js";

export type QueueSendCertainty = "failed" | "unknown";

/**
 * Raised when a send did not confirm success. `certainty` distinguishes a
 * known rejection from an unknown broker outcome; in both cases the outbox job
 * stays pending and a later wake retries the same job.
 */
export class JobQueueError extends Error {
  public constructor(
    message: string,
    public readonly certainty: QueueSendCertainty,
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JobQueueError";
  }
}

export interface JobQueue {
  /** Resolves only when the broker confirmed acceptance; never retries internally. */
  send(message: QueueEnvelopeV1): Promise<void>;
}
