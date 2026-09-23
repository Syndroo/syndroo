/**
 * Narrow Cloudflare Queues producer adapter for the frozen `JobQueue` port.
 *
 * Only one queue operation exists: send one versioned, identity-only envelope.
 * The adapter validates and encodes the envelope before touching the binding,
 * performs exactly one `send` with the JSON content type, and never uses a
 * broker delay - long-term scheduling belongs to D1 `availableAt`, not to the
 * broker.
 *
 * Failures are conservative and cause-free: the binding's own error may carry
 * transport or credential text, and a throw does not prove the broker refused
 * the message, so every binding failure becomes the same fixed `unknown`
 * `JobQueueError`. The consumer's execution CAS de-duplicates a duplicate
 * delivery, which is the documented at-least-once design.
 */

import {
  JobQueueError,
  decodeQueueEnvelopeV1,
  encodeQueueEnvelopeV1,
  type JobQueue,
  type QueueEnvelopeV1,
} from "@syndroo/application";

/**
 * Structural subset of the Cloudflare queue producer binding this adapter uses.
 *
 * Deliberately narrower than the platform binding: no batch send, no delay
 * option and no message handle. A real binding satisfies it as-is.
 */
export interface QueueProducerBinding {
  send(body: unknown, options?: { readonly contentType?: "json" }): Promise<void>;
}

export interface CloudflareJobQueueOptions {
  readonly binding: QueueProducerBinding;
}

const ENVELOPE_CONTENT_TYPE = "json" as const;

export function createCloudflareJobQueue(options: CloudflareJobQueueOptions): JobQueue {
  const { binding } = options;

  return {
    async send(message: QueueEnvelopeV1): Promise<void> {
      const body = requireSendableEnvelope(message);
      try {
        await binding.send(body, { contentType: ENVELOPE_CONTENT_TYPE });
      } catch {
        throw new JobQueueError(
          "queue send did not confirm acceptance",
          "unknown",
          "QUEUE_SEND_UNKNOWN",
        );
      }
    },
  };
}

/**
 * Validate and encode before the binding is touched.
 *
 * The frozen decoder rejects non-objects, unknown fields, unsupported
 * version/kind, malformed ids and instants, and anything above the project's
 * 2KiB bound; re-encoding proves the exact bytes the runtime will deliver. A
 * rejected envelope never reaches the broker and never echoes its content.
 *
 * The whole validation runs inside one local guard: a hostile input - a
 * throwing getter or a proxy trap that only misbehaves on `Object.keys` or a
 * later property read - can throw *after* the decoder's own serialisation
 * check, and it must still become the same fixed, cause-free failure with zero
 * binding calls.
 */
function requireSendableEnvelope(message: QueueEnvelopeV1): QueueEnvelopeV1 {
  let body: QueueEnvelopeV1 | null = null;
  try {
    const decoded = decodeQueueEnvelopeV1(message);
    if (decoded.kind === "ok") {
      encodeQueueEnvelopeV1(decoded.envelope);
      body = decoded.envelope;
    }
  } catch {
    body = null;
  }
  if (body === null) {
    throw new JobQueueError("queue envelope is not sendable", "failed", "INVALID_ENVELOPE");
  }
  return body;
}
