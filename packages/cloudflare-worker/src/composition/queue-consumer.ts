/**
 * Native Queue/DLQ mapping (design §7 "Main queue and DLQ").
 *
 * The module is deliberately thin: it validates the copied physical queue
 * names and the batch's own `queue` before any domain work, then calls the
 * accepted portable use cases directly — `executePublication` for main
 * messages and `settleDeadLetterMessage` for dead-letter messages. It contains
 * no envelope decoding, no business retry policy, no provider call and no
 * queue producer: a DLQ message is never forwarded anywhere.
 *
 * Dispositions are ordered and attempted once. A settled main outcome
 * acknowledges; an infrastructure outcome or an unexpected use-case exception
 * requests one fixed sixty-second broker retry. A settled DLQ outcome
 * acknowledges only after authoritative metadata settlement. A quarantined
 * message requires the required fixed alert to *complete successfully* before
 * acknowledgement: the sink may be synchronous or return a promise, and its
 * completion is awaited, so a synchronous throw and a rejected promise behave
 * alike and both request a retry instead of an acknowledgement. If a native
 * disposition call itself throws, the consumer surfaces a fixed operational
 * error and never attempts a second disposition.
 *
 * Queue names, message ids, bodies and exception text never appear in an error
 * or an alert.
 */

import {
  executePublication,
  settleDeadLetterMessage,
  type DlqConsumerOutcome,
  type ExecutePublicationDependencies,
  type SettleDeadLetterDependencies,
} from "@syndroo/application";

/** Fixed bounded broker retry for infrastructure and quarantine retries. */
export const RETRY_DELAY_SECONDS = 60;

export type QueueConsumerErrorCode = "QUEUE_ROUTING_INVALID" | "QUEUE_DISPOSITION_FAILED";

const ERROR_MESSAGES: Readonly<Record<QueueConsumerErrorCode, string>> = Object.freeze({
  QUEUE_ROUTING_INVALID: "queue routing configuration is invalid",
  QUEUE_DISPOSITION_FAILED: "queue message disposition failed",
});

/** Fixed, value-free operational failure for this mapping. */
export class QueueConsumerError extends Error {
  public readonly code: QueueConsumerErrorCode;

  public constructor(code: QueueConsumerErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "QueueConsumerError";
    this.code = code;
  }
}

/** Exact physical queue names; both are required and must differ. */
export interface QueueConsumerNames {
  readonly main: string;
  readonly deadLetter: string;
}

/** Fixed quarantine alert code; never derived from the rejected message. */
export type QuarantineAlertCode = "MALFORMED_DLQ_MESSAGE";

export interface QuarantineAlertEvent {
  readonly code: QuarantineAlertCode;
}

/**
 * Required narrow alert sink. It may be synchronous or return a promise; the
 * consumer awaits its completion, so only a successfully completed alert lets
 * the message be acknowledged. A swallowed optional application log is not
 * proof that the quarantine alert succeeded, and a sink that throws or rejects
 * reports failure. Local tests prove alert-completion ordering, not production
 * log-export durability.
 */
export type QuarantineAlertSink = (event: QuarantineAlertEvent) => void | Promise<void>;

export interface QueueConsumerDependencies {
  readonly names: QueueConsumerNames;
  /** Accepted main-message consumer dependencies. */
  readonly execute: ExecutePublicationDependencies;
  /** Accepted DLQ settlement dependencies. */
  readonly settleDeadLetter: SettleDeadLetterDependencies;
  readonly alert: QuarantineAlertSink;
}

export type QueueConsumer = (batch: MessageBatch<unknown>) => Promise<void>;

const QUARANTINE_EVENT: QuarantineAlertEvent = Object.freeze({
  code: "MALFORMED_DLQ_MESSAGE" as const,
});

/**
 * Validate and copy the routing configuration once, then return the handler.
 *
 * Invalid, missing, equal or whitespace-only names — and a missing alert sink —
 * fail here, before any batch exists, with one fixed operational error.
 */
export function createQueueConsumer(dependencies: QueueConsumerDependencies): QueueConsumer {
  const mainName = readQueueName(dependencies, "names", "main");
  const deadLetterName = readQueueName(dependencies, "names", "deadLetter");
  if (mainName === deadLetterName) {
    throw new QueueConsumerError("QUEUE_ROUTING_INVALID");
  }
  const alert = readAlertSink(dependencies);
  const executeDependencies = dependencies.execute;
  const settleDependencies = dependencies.settleDeadLetter;

  return async (batch: MessageBatch<unknown>): Promise<void> => {
    const queueName = readBatchQueue(batch);
    // Route membership is decided before the batch's messages are inspected, so
    // an unknown queue can never touch message state.
    if (queueName === mainName) {
      await consumeSequentially(readBatchMessages(batch), (message) =>
        decideMainOutcome(message, executeDependencies),
      );
      return;
    }
    if (queueName === deadLetterName) {
      await consumeSequentially(readBatchMessages(batch), (message) =>
        decideDeadLetterOutcome(message, settleDependencies, alert),
      );
      return;
    }
    // Unknown or prefix-matching queue names perform no domain work.
    throw new QueueConsumerError("QUEUE_ROUTING_INVALID");
  };
}

type Disposition = "ack" | "retry";

async function consumeSequentially(
  messages: readonly Message<unknown>[],
  decide: (message: Message<unknown>) => Promise<Disposition>,
): Promise<void> {
  for (const message of messages) {
    const disposition = await decide(message);
    if (disposition === "ack") {
      acknowledge(message);
    } else {
      requestRetry(message);
    }
  }
}

async function decideMainOutcome(
  message: Message<unknown>,
  dependencies: ExecutePublicationDependencies,
): Promise<Disposition> {
  let outcome: Awaited<ReturnType<typeof executePublication>>;
  try {
    // No decoding or business logic here: the accepted use case owns both.
    outcome = await executePublication(message.body, dependencies);
  } catch {
    // Unexpected adapter or use-case exception: fixed infrastructure retry,
    // never the exception text and never a second side effect.
    return "retry";
  }
  return outcome.kind === "settled" ? "ack" : "retry";
}

async function decideDeadLetterOutcome(
  message: Message<unknown>,
  dependencies: SettleDeadLetterDependencies,
  alert: QuarantineAlertSink,
): Promise<Disposition> {
  let outcome: DlqConsumerOutcome;
  try {
    outcome = await settleDeadLetterMessage(message.body, dependencies);
  } catch {
    return "retry";
  }
  if (outcome.kind === "settled") {
    // Metadata settlement completed before this decision was returned.
    return "ack";
  }
  if (outcome.kind === "infrastructure_retry") {
    return "retry";
  }
  // Quarantine: the required alert must complete successfully before ack. The
  // awaited call covers both a synchronous throw and a rejected promise.
  try {
    await alert(QUARANTINE_EVENT);
  } catch {
    return "retry";
  }
  return "ack";
}

/** One attempt only: a throwing disposition becomes a fixed operational error. */
function acknowledge(message: Message<unknown>): void {
  try {
    message.ack();
  } catch {
    throw new QueueConsumerError("QUEUE_DISPOSITION_FAILED");
  }
}

function requestRetry(message: Message<unknown>): void {
  try {
    message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
  } catch {
    throw new QueueConsumerError("QUEUE_DISPOSITION_FAILED");
  }
}

function readQueueName(
  dependencies: QueueConsumerDependencies,
  group: "names",
  key: "main" | "deadLetter",
): string {
  let value: unknown;
  try {
    const names = dependencies[group];
    value = names === null || typeof names !== "object" ? undefined : names[key];
  } catch {
    throw new QueueConsumerError("QUEUE_ROUTING_INVALID");
  }
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new QueueConsumerError("QUEUE_ROUTING_INVALID");
  }
  return value;
}

function readAlertSink(dependencies: QueueConsumerDependencies): QuarantineAlertSink {
  let sink: unknown;
  try {
    sink = dependencies.alert;
  } catch {
    throw new QueueConsumerError("QUEUE_ROUTING_INVALID");
  }
  if (typeof sink !== "function") {
    throw new QueueConsumerError("QUEUE_ROUTING_INVALID");
  }
  return sink as QuarantineAlertSink;
}

function readBatchQueue(batch: unknown): string {
  try {
    if (typeof batch !== "object" || batch === null) {
      throw new Error("batch shape");
    }
    const queue = (batch as { readonly queue?: unknown }).queue;
    if (typeof queue !== "string" || queue.length === 0) {
      throw new Error("batch queue");
    }
    return queue;
  } catch {
    throw new QueueConsumerError("QUEUE_ROUTING_INVALID");
  }
}

function readBatchMessages(batch: unknown): readonly Message<unknown>[] {
  try {
    const messages = (batch as { readonly messages?: unknown }).messages;
    if (!Array.isArray(messages)) {
      throw new Error("batch messages");
    }
    return messages as readonly Message<unknown>[];
  } catch {
    // A hostile or malformed batch shape is one fixed routing failure.
    throw new QueueConsumerError("QUEUE_ROUTING_INVALID");
  }
}
