import type * as T from '@syndroo/core';
import { ProtocolError } from '@syndroo/core';

export type QueueBody = { scope: string; operationId: string; executionRevision: number };
export type QueueMessage = {
  body: unknown;
  ack(): void;
  retry(): void;
};
export type QueueSender = { send(body: QueueBody): Promise<void> };

function decode(value: unknown): QueueBody | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(',') !== 'executionRevision,operationId,scope'
    || typeof body.scope !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.scope)
    || typeof body.operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.operationId)
    || !Number.isSafeInteger(body.executionRevision) || (body.executionRevision as number) < 0)
    return null;
  return body as QueueBody;
}

/** Queue messages contain routing references only. State determines whether any work exists. */
export async function consumeMessages(options: {
  messages: readonly QueueMessage[];
  scope: string;
  state: T.StateStore;
  executor: T.Executor;
  now(): string;
  signal: AbortSignal;
  deadLetter?: boolean;
}): Promise<void> {
  for (const message of options.messages) {
    const body = decode(message.body);
    if (!body || body.scope !== options.scope || options.deadLetter) { message.ack(); continue; }
    const work: T.WorkRef = { operationId: body.operationId, executionRevision: body.executionRevision };
    try {
      const intent = await options.state.getExecutionIntent(work);
      if (!intent) { message.ack(); continue; }
      const operation = await options.state.getOperation(work.operationId, intent.principalId);
      if (!operation || operation.phase !== 'execution'
        || operation.executionRevision !== work.executionRevision) { message.ack(); continue; }
      const inFlight = operation.deliveries.find(delivery => delivery.state === 'in_flight');
      if (inFlight && inFlight.claim!.expiresAt > options.now()) { message.ack(); continue; }
      if (inFlight) {
        await options.state.recoverInterrupted({
          work, expectedVersion: operation.version, now: options.now(),
        });
        message.ack();
        continue;
      }
      if (!inFlight && !operation.deliveries.some(delivery => delivery.state === 'ready')) {
        message.ack(); continue;
      }
      await options.executor.run(work, options.signal);
      message.ack();
    } catch (error) {
      // Validation failures are non-retryable references. Persistence or runtime
      // failures are infrastructure retries; the Core claim still fences SNS.
      if (error instanceof ProtocolError && ['NOT_FOUND', 'STALE_INTENT'].includes(error.code))
        message.ack();
      else message.retry();
    }
  }
}

/** Cron performs bounded notification only. It never executes content writes. */
export async function scanPending(options: {
  scope: string;
  state: T.StateStore;
  sender: QueueSender;
  ownerId: string;
  now: string;
  limit?: number;
}): Promise<number> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProtocolError('INVALID_INPUT');
  const claims = await options.state.claimNotifications({
    ownerId: options.ownerId, now: options.now, limit,
  });
  for (const claim of claims) {
    let sent = false;
    try {
      await options.sender.send({ scope: options.scope, ...claim.work });
      sent = true;
    } catch { /* Keep the durable work pending for the next scan. */ }
    await options.state.recordNotification({ claim, sent, now: options.now });
  }
  return claims.length;
}
