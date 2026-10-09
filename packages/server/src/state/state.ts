import { canonicalJson } from "@syndroo/core";
import type * as T from "@syndroo/core";

import {
  Database,
  type Data,
  type RequestEntry,
  type StepEntry,
} from "./database.js";
import { type FailureCode, fail } from "./errors.js";
import { cursorSignature } from "./database.js";
import { timingSafeEqual } from "node:crypto";
import { parseStrictResponseJson } from "@syndroo/core";
import {
  accountKey,
  aggregate,
  clone,
  later,
  retryEligible,
  unknownOutcome,
} from "./rules.js";

/** SQLite implementation of the frozen business StateStore ports. */
export type StateOptions = {
  readonly databasePath: string;
  readonly scope: string;
  readonly busyTimeoutMs?: number;
};

const TRANSACTION_MS = 60_000;
const CLAIM_MS = 900_000;
const NOTIFY_LEASE_MS = 30_000;
const NOTIFY_RETRY_MS = 30_000;
const NOTIFY_SUCCESS_MS = 60_000;
const MAX_OPERATIONS = 100;
const MAX_CONNECTIONS = 100;
const MAX_CURSOR_LENGTH = 1024;

export class SQLiteState implements T.StateStore {
  readonly database: Database;
  readonly #scope: string;

  constructor(options: StateOptions) {
    this.database = new Database(options.databasePath, options.scope, options.busyTimeoutMs);
    this.#scope = options.scope;
  }

  close(): void { this.database.close(); }

  verifyRetirement(stage: T.SecretStage, proof: string): boolean {
    return this.database.verifyRetirement(stage, proof);
  }

  isRetired(ref: string): boolean { return this.database.isRetired(ref); }

  #key(identity: T.RequestIdentity): string {
    return canonicalJson([
      this.#scope,
      identity.principalId,
      identity.family,
      identity.key,
    ]);
  }

  #entry(data: Data, identity: T.RequestIdentity): RequestEntry | undefined {
    const entry = data.requests.get(this.#key(identity));

    if (entry && entry.digest !== identity.digest) {
      fail("IDEMPOTENCY_CONFLICT");
    }

    if (entry?.error) {
      fail(entry.error.code as FailureCode);
    }

    return entry;
  }

  #operation(data: Data, operationId: string): T.OperationRecord {
    const operation = data.operations.get(operationId);

    if (!operation) {
      fail("NOT_FOUND");
    }

    return operation;
  }

  #intent(data: Data, work: T.WorkRef): T.FrozenIntent {
    const intent = data.intents.get(
      `${work.operationId}:${work.executionRevision}`,
    );

    if (!intent) {
      fail("STALE_INTENT");
    }

    return intent;
  }

  #ticket(
    data: Data,
    operation: T.OperationRecord,
    request: T.RequestIdentity,
    ownerId: string,
    now: string,
    revision: number,
  ): T.PreparationTicket {
    const ticket: T.PreparationTicket = {
      operationId: operation.operationId,
      executionRevision: revision,
      ownerId,
      fence: ++data.meta.fence,
      expectedVersion: operation.version + 1,
      request: clone(request),
      expiresAt: later(now, TRANSACTION_MS),
    };

    operation.version++;
    operation.pendingPreparation = ticket;

    return clone(ticket);
  }

  async reservePreparation(
    input: Parameters<T.OperationStore["reservePreparation"]>[0],
  ): Promise<T.Reservation> {
    return this.database.write("reservePreparation", session => {
      const data = session.data;
      const entry = this.#entry(data, input.request);

      if (entry?.operationId !== undefined) {
        const operation = this.#operation(data, entry.operationId);

        if (operation.phase !== "preparing") {
          return {
            type: "replay",
            operation: clone(operation),
            intent: clone(
              this.#intent(data, {
                operationId: operation.operationId,
                executionRevision: operation.executionRevision,
              }),
            ),
          } satisfies T.Reservation;
        }

        if (
          operation.pendingPreparation &&
          operation.pendingPreparation.expiresAt > input.now
        ) {
          return {
            type: "busy",
            retryAt: operation.pendingPreparation.expiresAt,
          } satisfies T.Reservation;
        }

        return {
          type: "owned",
          ticket: this.#ticket(
            data,
            operation,
            input.request,
            input.ownerId,
            input.now,
            0,
          ),
        } satisfies T.Reservation;
      }

      const created: T.OperationRecord = {
        operationId: input.operationId,
        principalId: input.request.principalId,
        version: 0,
        createdAt: input.now,
        canonicalOriginal: clone(input.canonical),
        executionRevision: 0,
        phase: "preparing",
        deliveries: [],
        work: { pending: false, nextWakeAt: input.now },
      };

      if (data.operations.has(created.operationId)) fail("IDEMPOTENCY_CONFLICT");
      data.operations.set(created.operationId, created);
      data.meta.sequence++;
      data.creation.set(created.operationId, data.meta.sequence);
      data.requests.set(this.#key(input.request), {
        digest: input.request.digest,
        operationId: created.operationId,
      });

      return {
        type: "owned",
        ticket: this.#ticket(
          data,
          created,
          input.request,
          input.ownerId,
          input.now,
          0,
        ),
      } satisfies T.Reservation;
    });
  }

  async savePreparedIntent(
    input: Parameters<T.OperationStore["savePreparedIntent"]>[0],
  ): Promise<T.CasResult<T.FrozenIntent>> {
    return this.database.write("savePreparedIntent", session => {
      const data = session.data;
      const operation = this.#operation(data, input.ticket.operationId);

      if (
        operation.pendingPreparation?.fence !== input.ticket.fence ||
        operation.version !== input.ticket.expectedVersion ||
        input.ticket.expiresAt <= input.now
      ) {
        return { type: "conflict" } satisfies T.CasResult<T.FrozenIntent>;
      }

      if (canonicalJson(operation.pendingPreparation.request) !== canonicalJson(input.ticket.request)
        || input.intent.operationId !== operation.operationId
        || input.intent.executionRevision !== input.ticket.executionRevision
        || input.intent.principalId !== operation.principalId
        || canonicalJson(input.intent.request) !== canonicalJson(input.ticket.request)
        || data.intents.has(`${operation.operationId}:${input.ticket.executionRevision}`)
        || data.approvals.has(input.intent.approvalDigest)) fail("STALE_INTENT");

      session.assertNotRetired(input.intent.approvalSecretRef);

      data.intents.set(
        `${operation.operationId}:${input.ticket.executionRevision}`,
        clone(input.intent),
      );
      data.approvals.set(input.intent.approvalDigest, {
        work: {
          operationId: operation.operationId,
          executionRevision: input.ticket.executionRevision,
        },
        admitted: false,
        principalId: operation.principalId,
      });
      delete operation.pendingPreparation;
      operation.version++;

      if (operation.phase === "preparing") {
        operation.phase = "prepared";
        operation.intentDigest = input.intent.intentDigest;
        operation.deliveries = input.intent.targets.map(target => ({
          deliveryId: target.deliveryId,
          connectionId: target.binding.connectionId,
          account: clone(target.binding.account),
          attempts: 0,
          outcome: null,
          state: "ready",
          history: [],
        }));
      } else {
        operation.preparedRetry = {
          executionRevision: input.ticket.executionRevision,
          intentDigest: input.intent.intentDigest,
        };
      }

      return {
        type: "applied",
        value: clone(input.intent),
      } satisfies T.CasResult<T.FrozenIntent>;
    });
  }

  async failPreparation(
    input: Parameters<T.OperationStore["failPreparation"]>[0],
  ): Promise<void> {
    await this.database.write("failPreparation", session => {
      const data = session.data;
      const operation = this.#operation(data, input.ticket.operationId);

      if (operation.pendingPreparation?.fence !== input.ticket.fence) {
        return;
      }

      const entry = this.#entry(data, input.ticket.request);

      if (entry) {
        entry.error = clone(input.error);
      }

      delete operation.pendingPreparation;
      operation.version++;
    });
  }

  async prepareRetry(
    input: Parameters<T.OperationStore["prepareRetry"]>[0],
  ): Promise<T.Reservation> {
    return this.database.write("prepareRetry", session => {
      const data = session.data;
      const entry = this.#entry(data, input.request);

      if (entry?.operationId !== undefined) {
        const operation = this.#operation(data, entry.operationId);
        const intent = data.intents.select(
          "json_extract(r.value,'$.operationId') = ?", [entry.operationId],
          "CAST(json_extract(r.value,'$.executionRevision') AS INTEGER) DESC", 128,
        ).find(
          candidate =>
            this.#key(candidate.request) === this.#key(input.request),
        );

        if (intent) {
          return {
            type: "replay",
            operation: clone(operation),
            intent: clone(intent),
          } satisfies T.Reservation;
        }

        if (
          operation.pendingPreparation?.request.key === input.request.key &&
          operation.pendingPreparation.expiresAt <= input.now
        ) {
          return {
            type: "owned",
            ticket: this.#ticket(
              data,
              operation,
              input.request,
              input.ownerId,
              input.now,
              operation.executionRevision + 1,
            ),
          } satisfies T.Reservation;
        }

        return {
          type: "busy",
          retryAt: operation.pendingPreparation?.expiresAt ?? input.now,
        } satisfies T.Reservation;
      }

      const operation = this.#operation(data, input.operationId);

      if (operation.principalId !== input.request.principalId) {
        fail("NOT_FOUND");
      }

      if (
        operation.version !== input.expectedVersion ||
        operation.phase !== "execution" ||
        operation.deliveries.some(delivery => delivery.state !== "settled")
      ) {
        fail("RETRY_INELIGIBLE");
      }

      if (
        operation.pendingPreparation &&
        operation.pendingPreparation.expiresAt > input.now
      ) {
        fail("REQUEST_IN_PROGRESS");
      }

      if (operation.preparedRetry) {
        const previous = this.#intent(data, {
          operationId: operation.operationId,
          executionRevision: operation.preparedRetry.executionRevision,
        });

        if (previous.expiresAt > input.now) {
          fail("REQUEST_IN_PROGRESS");
        }

        delete operation.preparedRetry;
      }

      if (
        input.deliveryIds.length === 0 ||
        new Set(input.deliveryIds).size !== input.deliveryIds.length ||
        input.deliveryIds.some(
          deliveryId =>
            !operation.deliveries.some(
              delivery =>
                delivery.deliveryId === deliveryId &&
                retryEligible(delivery, input.now),
            ),
        )
      ) {
        fail("RETRY_INELIGIBLE");
      }

      data.requests.set(this.#key(input.request), {
        digest: input.request.digest,
        operationId: operation.operationId,
      });

      const revisions = data.intents.select(
        "json_extract(r.value,'$.operationId') = ?", [operation.operationId],
        "CAST(json_extract(r.value,'$.executionRevision') AS INTEGER) DESC", 128,
      )
        .map(intent => intent.executionRevision);

      return {
        type: "owned",
        ticket: this.#ticket(
          data,
          operation,
          input.request,
          input.ownerId,
          input.now,
          Math.max(operation.executionRevision, ...revisions) + 1,
        ),
      } satisfies T.Reservation;
    });
  }

  async readApproval(
    input: Parameters<T.OperationStore["readApproval"]>[0],
  ): Promise<{
    intent: T.FrozenIntent;
    admitted: boolean;
    operation: T.OperationRecord;
  } | null> {
    return this.database.read(data => {
      const approval = data.approvals.get(input.approvalDigest);

      if (!approval || approval.principalId !== input.principalId) {
        return null;
      }

      return {
        intent: clone(this.#intent(data, approval.work)),
        admitted: approval.admitted,
        operation: clone(this.#operation(data, approval.work.operationId)),
      };
    });
  }

  async admitExecution(
    input: Parameters<T.OperationStore["admitExecution"]>[0],
  ): Promise<T.CasResult<T.OperationRecord>> {
    return this.database.write("admitExecution", session => {
      const data = session.data;
      const approval = data.approvals.get(input.approvalDigest);

      if (!approval || approval.principalId !== input.principalId) {
        fail("APPROVAL_INVALID");
      }

      const operation = this.#operation(data, approval.work.operationId);

      if (approval.admitted) {
        return {
          type: "replay",
          value: clone(operation),
        } satisfies T.CasResult<T.OperationRecord>;
      }

      const intent = this.#intent(data, approval.work);

      if (input.approvalDigest !== intent.approvalDigest
        || canonicalJson(input.bindings) !== canonicalJson(intent.targets.map(target => target.binding))) {
        fail("APPROVAL_INVALID");
      }

      if (intent.expiresAt <= input.now) {
        fail("APPROVAL_EXPIRED");
      }

      if (
        operation.version !== input.expectedVersion ||
        intent.intentDigest !== input.intentDigest
      ) {
        return { type: "conflict" } satisfies T.CasResult<T.OperationRecord>;
      }

      if (
        approval.work.executionRevision !== 0 &&
        operation.preparedRetry?.executionRevision !==
          approval.work.executionRevision
      ) {
        fail("STALE_INTENT");
      }

      for (const binding of intent.targets.map(target => target.binding)) {
        const connection = data.connections.get(binding.connectionId);

        if (
          !connection?.active ||
          connection.bindingRevision !== binding.bindingRevision ||
          accountKey(connection.account) !== accountKey(binding.account)
        ) {
          fail("STALE_BINDING");
        }
      }

      approval.admitted = true;
      operation.phase = "execution";
      operation.executionRevision = intent.executionRevision;
      operation.intentDigest = intent.intentDigest;
      delete operation.preparedRetry;
      operation.version++;

      const admitted = new Set(
        intent.targets.map(target => target.deliveryId),
      );

      for (const delivery of operation.deliveries) {
        if (!admitted.has(delivery.deliveryId)) {
          continue;
        }

        delivery.state = "ready";
        delivery.outcome = null;
        delete delivery.claim;
      }

      operation.status = aggregate(operation.deliveries);
      operation.work = { pending: true, nextWakeAt: input.now };

      return {
        type: "applied",
        value: clone(operation),
      } satisfies T.CasResult<T.OperationRecord>;
    });
  }

  async claimDelivery(
    input: Parameters<T.OperationStore["claimDelivery"]>[0],
  ): Promise<T.Claim | null> {
    return this.database.write("claimDelivery", session => {
      const data = session.data;
      const operation = this.#operation(data, input.work.operationId);

      if (
        operation.phase !== "execution" ||
        operation.executionRevision !== input.work.executionRevision ||
        operation.version !== input.expectedVersion ||
        operation.deliveries.some(delivery => delivery.state === "in_flight")
      ) {
        return null;
      }

      const delivery = operation.deliveries.find(
        candidate => candidate.state === "ready",
      );

      if (
        !delivery ||
        delivery.deliveryId !== input.deliveryId ||
        delivery.attempts >= 3
      ) {
        return null;
      }

      const intent = this.#intent(data, input.work);
      const target = intent.targets.find(
        candidate => candidate.deliveryId === delivery.deliveryId,
      );
      const connection =
        target === undefined
          ? undefined
          : data.connections.get(target.binding.connectionId);

      if (
        !target ||
        !connection?.active ||
        connection.bindingRevision !== target.binding.bindingRevision ||
        accountKey(connection.account) !== accountKey(target.binding.account)
      ) {
        fail("STALE_BINDING");
      }

      const claim: T.Claim = {
        ...input.work,
        deliveryId: input.deliveryId,
        claimId: input.claimId,
        ownerId: input.ownerId,
        submissionId: input.submissionId,
        attempt: delivery.attempts + 1,
        claimedAt: input.now,
        expiresAt: later(input.now, CLAIM_MS),
      };

      delivery.attempts++;
      delivery.state = "in_flight";
      delivery.claim = claim;
      operation.version++;
      operation.status = aggregate(operation.deliveries);

      return clone(claim);
    });
  }

  async recordOutcome(
    input: Parameters<T.OperationStore["recordOutcome"]>[0],
  ): Promise<T.CasResult<T.OperationRecord>> {
    return this.database.write("recordOutcome", session => {
      const data = session.data;
      const operation = this.#operation(data, input.claim.operationId);
      const delivery = operation.deliveries.find(
        candidate => candidate.deliveryId === input.claim.deliveryId,
      );

      if (
        !delivery ||
        operation.executionRevision !== input.claim.executionRevision
      ) {
        return { type: "conflict" } satisfies T.CasResult<T.OperationRecord>;
      }

      if (delivery.state === "settled") {
        const previous = delivery.history.find(
          item => item.claim.claimId === input.claim.claimId,
        );

        return previous &&
          canonicalJson(previous.outcome) === canonicalJson(input.outcome)
          ? ({
              type: "replay",
              value: clone(operation),
            } satisfies T.CasResult<T.OperationRecord>)
          : ({ type: "conflict" } satisfies T.CasResult<T.OperationRecord>);
      }

      if (
        delivery.state !== "in_flight" ||
        !delivery.claim || canonicalJson(delivery.claim) !== canonicalJson(input.claim) ||
        delivery.claim.expiresAt <= input.now
      ) {
        return { type: "conflict" } satisfies T.CasResult<T.OperationRecord>;
      }

      delivery.outcome = clone(input.outcome);
      delivery.history = [
        ...delivery.history,
        { claim: clone(input.claim), outcome: clone(input.outcome) },
      ];
      delivery.state = "settled";
      delete delivery.claim;
      operation.version++;
      operation.status = aggregate(operation.deliveries);
      operation.work.pending = operation.deliveries.some(
        candidate => candidate.state !== "settled",
      );

      return {
        type: "applied",
        value: clone(operation),
      } satisfies T.CasResult<T.OperationRecord>;
    });
  }

  async stopUnstarted(
    input: Parameters<T.OperationStore["stopUnstarted"]>[0],
  ): Promise<T.CasResult<T.OperationRecord>> {
    return this.database.write("stopUnstarted", session => {
      const data = session.data;
      const operation = this.#operation(data, input.work.operationId);

      if (
        operation.executionRevision !== input.work.executionRevision ||
        operation.version !== input.expectedVersion
      ) {
        return { type: "conflict" } satisfies T.CasResult<T.OperationRecord>;
      }

      for (const delivery of operation.deliveries) {
        if (delivery.state === "ready") {
          delivery.state = "settled";
          delivery.outcome = clone(input.outcome);
        }
      }

      operation.version++;
      operation.status = aggregate(operation.deliveries);
      operation.work.pending = operation.deliveries.some(
        candidate => candidate.state === "in_flight",
      );

      return {
        type: "applied",
        value: clone(operation),
      } satisfies T.CasResult<T.OperationRecord>;
    });
  }

  async recoverInterrupted(
    input: Parameters<T.OperationStore["recoverInterrupted"]>[0],
  ): Promise<T.CasResult<T.OperationRecord>> {
    return this.database.write("recoverInterrupted", session => {
      const data = session.data;
      const operation = this.#operation(data, input.work.operationId);

      if (
        operation.version !== input.expectedVersion ||
        operation.executionRevision !== input.work.executionRevision
      ) {
        return { type: "conflict" } satisfies T.CasResult<T.OperationRecord>;
      }

      const expired = operation.deliveries.find(
        delivery =>
          delivery.state === "in_flight" &&
          (delivery.claim?.expiresAt ?? input.now) <= input.now,
      );

      if (!expired?.claim) {
        return { type: "conflict" } satisfies T.CasResult<T.OperationRecord>;
      }

      expired.outcome = unknownOutcome();
      expired.history = [
        ...expired.history,
        { claim: clone(expired.claim), outcome: clone(expired.outcome) },
      ];
      expired.state = "settled";
      delete expired.claim;

      for (const delivery of operation.deliveries) {
        if (delivery.state === "ready") {
          delivery.state = "settled";
          delivery.outcome = {
            status: "not_started",
            disposition: "not_applied",
            reason: "execution_interrupted",
          };
        }
      }

      operation.version++;
      operation.status = "unknown";
      operation.work.pending = false;

      return {
        type: "applied",
        value: clone(operation),
      } satisfies T.CasResult<T.OperationRecord>;
    });
  }

  async getExecutionIntent(work: T.WorkRef): Promise<T.FrozenIntent | null> {
    return this.database.read(
      data =>
        clone(
          data.intents.get(`${work.operationId}:${work.executionRevision}`) ??
            null,
        ),
    );
  }

  async getOperation(
    operationId: T.OperationId,
    principalId: string,
  ): Promise<T.OperationRecord | null> {
    return this.database.read(data => {
      const operation = data.operations.get(operationId);

      return operation?.principalId === principalId ? clone(operation) : null;
    });
  }

  async getIntent(
    work: T.WorkRef,
    principalId: string,
  ): Promise<T.FrozenIntent | null> {
    return this.database.read(data => {
      const operation = data.operations.get(work.operationId);

      if (operation?.principalId !== principalId) {
        return null;
      }

      return clone(
        data.intents.get(`${work.operationId}:${work.executionRevision}`) ??
          null,
      );
    });
  }

  async listOperations(
    input: Parameters<T.OperationStore["listOperations"]>[0],
  ): Promise<{
    operations: readonly T.OperationRecord[];
    nextCursor?: string;
  }> {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_OPERATIONS
    ) {
      fail("INVALID_INPUT");
    }

    return this.database.read(data => {
      let max = data.meta.sequence;
      let after = "";
      const encode = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

      if (input.cursor !== undefined) {
        try {
          if (input.cursor.length > MAX_CURSOR_LENGTH) fail("INVALID_INPUT");
          const parts = input.cursor.split(".");
          if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) fail("INVALID_INPUT");
          const payload = Buffer.from(parts[0]!, "base64url");
          const actual = Buffer.from(parts[1]!, "base64url");
          const expected = cursorSignature(data.meta.cursorKey, payload);
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail("INVALID_INPUT");
          const parsed = parseStrictResponseJson(payload);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("INVALID_INPUT");
          const cursor = parsed as Record<string, unknown>;
          if (cursor["scope"] !== this.#scope || cursor["principal"] !== input.principalId
              || !Number.isSafeInteger(cursor["max"]) || typeof cursor["after"] !== "string"
              || (cursor["max"] as number) > data.meta.sequence || (cursor["max"] as number) < 0) fail("INVALID_INPUT");
          max = cursor["max"] as number;
          after = cursor["after"] as string;
        } catch { fail("INVALID_INPUT"); }
      }

      // Creation sequence fixes the first-page snapshot even if wall time moves backward.
      const all = data.operations.select(
        `json_extract(r.value,'$.principalId') = ?
         AND json_extract(r.value,'$.phase') != 'preparing'
         AND CAST((SELECT c.value FROM records c WHERE c.scope=r.scope
           AND c.kind='creation' AND c.id=r.id) AS INTEGER) <= ?
         AND (? = '' OR (json_extract(r.value,'$.createdAt') || char(0) || r.id) < ?)`,
        [input.principalId, max, after, after],
        "json_extract(r.value,'$.createdAt') DESC, r.id DESC", input.limit + 1,
      );
      const page = all.slice(0, input.limit);
      if (all.length <= input.limit) return { operations: clone(page) };
      const payload = new TextEncoder().encode(JSON.stringify({
        scope: this.#scope, principal: input.principalId, max, after: lastSortKey(page),
      }));
      const signature = cursorSignature(data.meta.cursorKey, payload);
      return { operations: clone(page), nextCursor: `${encode(payload)}.${encode(signature)}` };
    });
  }

  async claimNotifications(
    input: Parameters<T.OperationStore["claimNotifications"]>[0],
  ): Promise<readonly T.NotifyClaim[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_OPERATIONS) fail("INVALID_INPUT");
    return this.database.write("claimNotifications", session => {
      const data = session.data;
      const claims: T.NotifyClaim[] = [];
      const ordered = data.operations.select(
        `json_extract(r.value,'$.work.pending') = 1
         AND json_extract(r.value,'$.work.nextWakeAt') <= ?
         AND (json_extract(r.value,'$.work.notifyClaimUntil') IS NULL
           OR json_extract(r.value,'$.work.notifyClaimUntil') <= ?)`,
        [input.now, input.now],
        `CAST((SELECT c.value FROM records c WHERE c.scope=r.scope
          AND c.kind='creation' AND c.id=r.id) AS INTEGER) ASC`, input.limit,
      );

      for (const operation of ordered) {
        if (claims.length >= input.limit) {
          break;
        }

        if (
          !operation.work.pending ||
          operation.work.nextWakeAt > input.now ||
          (operation.work.notifyClaimUntil !== undefined &&
            operation.work.notifyClaimUntil > input.now)
        ) {
          continue;
        }

        const claimId = `notify_${++data.meta.fence}`;

        operation.work.notifyClaim = claimId;
        operation.work.notifyClaimUntil = later(input.now, NOTIFY_LEASE_MS);
        claims.push({
          claimId,
          work: {
            operationId: operation.operationId,
            executionRevision: operation.executionRevision,
          },
        });
      }

      return claims;
    });
  }

  async recordNotification(
    input: Parameters<T.OperationStore["recordNotification"]>[0],
  ): Promise<void> {
    await this.database.write("recordNotification", session => {
      const data = session.data;
      const operation = this.#operation(data, input.claim.work.operationId);

      if (operation.work.notifyClaim !== input.claim.claimId ||
          operation.executionRevision !== input.claim.work.executionRevision) {
        return;
      }

      operation.work.nextWakeAt = later(
        input.now,
        input.sent ? NOTIFY_SUCCESS_MS : NOTIFY_RETRY_MS,
      );
      delete operation.work.notifyClaim;
      delete operation.work.notifyClaimUntil;
    });
  }

  async readConnectRequest(
    request: T.RequestIdentity,
  ): Promise<T.ConnectResult | null> {
    return this.database.read(data => {
      const entry = this.#entry(data, request);

      if (entry?.result) {
        return clone(entry.result);
      }

      if (entry?.sessionId !== undefined) {
        const step = data.steps.get(`${entry.sessionId}:0`);

        if (step?.result) {
          return clone(step.result);
        }
      }

      return null;
    });
  }

  async replayConnectStep(input: {
    sessionId: T.SessionId;
    principalId: string;
    stepRevision: T.Revision;
    inputDigest: T.Digest;
  }): Promise<T.ConnectResult | null> {
    return this.database.read(data => {
      const session = data.sessions.get(input.sessionId);

      if (!session || session.principalId !== input.principalId) {
        fail("NOT_FOUND");
      }

      const entry = data.steps.get(
        `${input.sessionId}:${input.stepRevision}`,
      );

      if (!entry) {
        return null;
      }

      if (entry.digest !== input.inputDigest) {
        fail("CONNECT_STEP_CONFLICT");
      }

      if (entry.error) {
        fail(entry.error.code as FailureCode);
      }

      return clone(entry.result ?? null);
    });
  }

  async listConnections(
    provider?: T.ProviderId,
  ): Promise<readonly T.ConnectionRecord[]> {
    return this.database.read(data =>
      clone(
        [...data.connections.values()].filter(
          connection =>
            provider === undefined || connection.account.provider === provider,
        ),
      ),
    );
  }

  async getConnection(
    connectionId: T.ConnectionId,
  ): Promise<T.ConnectionRecord | null> {
    return this.database.read(data =>
      clone(data.connections.get(connectionId) ?? null),
    );
  }

  async reserveConnect(
    input: Parameters<T.ConnectionStore["reserveConnect"]>[0],
  ): Promise<T.CasResult<T.ConnectSession>> {
    return this.database.write("reserveConnect", session => {
      const data = session.data;
      const entry = this.#entry(data, input.request);

      if (entry?.sessionId !== undefined) {
        const existing = data.sessions.get(entry.sessionId);

        if (!existing) {
          fail("STATE_RECOVERY_REQUIRED");
        }

        return {
          type: "replay",
          value: clone(existing),
        } satisfies T.CasResult<T.ConnectSession>;
      }

      if (data.sessions.has(input.session.sessionId)) fail("CONNECT_STEP_CONFLICT");
      data.requests.set(this.#key(input.request), {
        digest: input.request.digest,
        sessionId: input.session.sessionId,
      });
      data.sessions.set(input.session.sessionId, clone(input.session));

      return {
        type: "applied",
        value: clone(input.session),
      } satisfies T.CasResult<T.ConnectSession>;
    });
  }

  async getConnectSession(
    sessionId: T.SessionId,
    principalId: string,
  ): Promise<T.ConnectSession | null> {
    return this.database.read(data => {
      const session = data.sessions.get(sessionId);

      return session?.principalId === principalId ? clone(session) : null;
    });
  }

  async claimConnectStep(
    input: Parameters<T.ConnectionStore["claimConnectStep"]>[0],
  ): Promise<
    | { type: "claimed"; claim: T.StepClaim; session: T.ConnectSession }
    | { type: "replay"; result: T.ConnectResult }
    | { type: "busy" }
  > {
    return this.database.write("claimConnectStep", session => {
      const data = session.data;
      const existing = data.sessions.get(input.sessionId);

      if (!existing || existing.principalId !== input.principalId) {
        fail("NOT_FOUND");
      }

      const key = `${input.sessionId}:${input.stepRevision}`;
      const previous = data.steps.get(key);

      if (previous) {
        if (previous.digest !== input.inputDigest) {
          fail("CONNECT_STEP_CONFLICT");
        }

        if (previous.result) {
          return {
            type: "replay" as const,
            result: clone(previous.result),
          };
        }

        if (previous.error) {
          fail(previous.error.code as FailureCode);
        }

        return { type: "busy" as const };
      }

      if (existing.expiresAt <= input.now) {
        fail("CONNECT_SESSION_EXPIRED");
      }

      if (
        existing.stepRevision !== input.stepRevision ||
        existing.status === "done" ||
        existing.status === "indeterminate"
      ) {
        fail("CONNECT_STEP_CONFLICT");
      }

      const claim: T.StepClaim = {
        sessionId: input.sessionId,
        stepRevision: input.stepRevision,
        claimId: input.claimId,
        inputDigest: input.inputDigest,
      };

      data.steps.set(key, { digest: input.inputDigest, claim });
      existing.status = "processing";

      return {
        type: "claimed" as const,
        claim: clone(claim),
        session: clone(existing),
      };
    });
  }

  #step(
    data: Data,
    claim: T.StepClaim,
  ): {
    session: T.ConnectSession;
    entry: StepEntry;
  } {
    const session = data.sessions.get(claim.sessionId);
    const entry = data.steps.get(`${claim.sessionId}:${claim.stepRevision}`);

    if (
      !session ||
      !entry?.claim || canonicalJson(entry.claim) !== canonicalJson(claim) ||
      session.status !== "processing"
    ) {
      fail("CONNECT_STEP_CONFLICT");
    }

    return { session, entry };
  }

  async saveConnectAction(
    input: Parameters<T.ConnectionStore["saveConnectAction"]>[0],
  ): Promise<T.CasResult<T.ConnectResult>> {
    return this.database.write("saveConnectAction", session => {
      const data = session.data;
      const { session: connect, entry } = this.#step(data, input.claim);

      session.assertNotRetired(input.privateState.ref);

      connect.stepRevision++;
      connect.status = "awaiting";
      connect.action = clone(input.action);
      connect.privateStateRef = input.privateState.ref;

      const result: T.ConnectResult = {
        status: "action_required",
        connectSessionId: connect.sessionId,
        stepRevision: connect.stepRevision,
        expiresAt: connect.expiresAt,
        action: clone(input.action),
      };

      entry.result = result;

      return {
        type: "applied",
        value: clone(result),
      } satisfies T.CasResult<T.ConnectResult>;
    });
  }

  async acceptCallback(
    input: Parameters<T.ConnectionStore["acceptCallback"]>[0],
  ): Promise<T.CasResult<T.ConnectSession>> {
    return this.database.write("acceptCallback", session => {
      const data = session.data;
      const connect = data.sessions.get(input.sessionId);

      if (
        !connect ||
        connect.expiresAt <= input.now ||
        connect.stepRevision !== input.expectedStepRevision ||
        connect.status !== "awaiting"
      ) {
        fail("CONNECT_STEP_CONFLICT");
      }

      const key = `callback:${input.sessionId}`;
      const previous = data.requests.get(key);

      if (previous) {
        if (previous.digest !== input.callbackDigest) {
          fail("CONNECT_STEP_CONFLICT");
        }

        return {
          type: "replay",
          value: clone(connect),
        } satisfies T.CasResult<T.ConnectSession>;
      }

      session.assertNotRetired(input.evidence.ref);

      connect.callbackRef = input.evidence.ref;
      data.requests.set(key, { digest: input.callbackDigest });

      return {
        type: "applied",
        value: clone(connect),
      } satisfies T.CasResult<T.ConnectSession>;
    });
  }

  #view(connection: T.ConnectionRecord): T.ConnectionView {
    return {
      connectionId: connection.connectionId,
      account: clone(connection.account),
      ...(connection.label ? { label: connection.label } : {}),
      isDefault: connection.isDefault,
      active: connection.active,
      observations: connection.observations.map(observation => ({
        ...clone(observation),
        stale: false,
      })),
    };
  }

  async commitConnection(
    input: Parameters<T.ConnectionStore["commitConnection"]>[0],
  ): Promise<T.CasResult<T.ConnectResult>> {
    return this.database.write("commitConnection", session => {
      const data = session.data;
      const { session: connect, entry } = this.#step(data, input.claim);
      const connection = clone(input.connection);
      const previous = data.connections.get(connection.connectionId);

      if ((previous?.revision ?? null) !== input.expectedConnectionRevision) {
        return {
          type: "conflict",
        } satisfies T.CasResult<T.ConnectResult>;
      }

      if (
        previous &&
        accountKey(previous.account) !== accountKey(connection.account)
      ) {
        fail("CONNECTION_IDENTITY_CHANGED");
      }

      session.assertNotRetired(input.stagedCredential.ref);

      if (connection.secretRef !== input.stagedCredential.ref) {
        fail("DURABILITY_ERROR");
      }

      const others = [...data.connections.values()].filter(
        candidate => candidate.connectionId !== connection.connectionId,
      );

      if (
        !previous &&
        others.filter(candidate => candidate.active).length >= MAX_CONNECTIONS
      ) {
        fail("CONNECTION_CAPACITY");
      }

      if (
        others.some(
          candidate =>
            accountKey(candidate.account) === accountKey(connection.account),
        )
      ) {
        fail("CONNECTION_IDENTITY_CHANGED");
      }

      if (
        connection.label &&
        others.some(
          candidate =>
            candidate.account.provider === connection.account.provider &&
            (candidate.label === connection.label ||
              candidate.connectionId === connection.label),
        )
      ) {
        fail("INVALID_INPUT");
      }

      if (
        !previous &&
        !others.some(
          candidate =>
            candidate.active &&
            candidate.account.provider === connection.account.provider,
        )
      ) {
        connection.isDefault = true;
      }

      if (connection.isDefault) {
        for (const candidate of others) {
          if (
            candidate.account.provider === connection.account.provider &&
            candidate.isDefault
          ) {
            candidate.isDefault = false;
            candidate.revision++;
          }
        }
      }

      data.connections.set(connection.connectionId, connection);
      connect.connectionId = connection.connectionId;
      connect.status = "done";

      const result: T.ConnectResult = {
        status: "done",
        connection: this.#view(connection),
      };

      entry.result = result;

      return {
        type: "applied",
        value: clone(result),
      } satisfies T.CasResult<T.ConnectResult>;
    });
  }

  async failConnectStep(
    input: Parameters<T.ConnectionStore["failConnectStep"]>[0],
  ): Promise<void> {
    await this.database.write("failConnectStep", write => {
      const { session: connect, entry } = this.#step(write.data, input.claim);

      connect.status = "indeterminate";
      entry.error = clone(
        input.indeterminate
          ? { code: "CONNECT_STEP_UNKNOWN", message: "CONNECT_STEP_UNKNOWN" }
          : input.error,
      );
    });
  }

  async updateConnection(
    input: Parameters<T.ConnectionStore["updateConnection"]>[0],
  ): Promise<T.CasResult<T.ConnectResult>> {
    return this.database.write("updateConnection", session => {
      const data = session.data;
      const entry = this.#entry(data, input.request);

      if (entry?.result) {
        return {
          type: "replay",
          value: clone(entry.result),
        } satisfies T.CasResult<T.ConnectResult>;
      }

      const connection = data.connections.get(input.connectionId);

      if (!connection) {
        fail("NOT_FOUND");
      }

      if (connection.revision !== input.expectedRevision) {
        return {
          type: "conflict",
        } satisfies T.CasResult<T.ConnectResult>;
      }

      if (
        input.changes.label !== undefined &&
        input.changes.label !== null &&
        [...data.connections.values()].some(
          candidate =>
            candidate.connectionId !== connection.connectionId &&
            candidate.account.provider === connection.account.provider &&
            (candidate.label === input.changes.label ||
              candidate.connectionId === input.changes.label),
        )
      ) {
        fail("INVALID_INPUT");
      }

      if (input.changes.label === null) {
        delete connection.label;
      } else if (input.changes.label !== undefined) {
        connection.label = input.changes.label;
      }

      if (input.changes.isDefault !== undefined) {
        if (input.changes.isDefault) {
          for (const candidate of data.connections.values()) {
            if (
              candidate.account.provider === connection.account.provider &&
              candidate.isDefault
            ) {
              candidate.isDefault = false;
              candidate.revision++;
            }
          }
        }

        connection.isDefault = input.changes.isDefault;
      }

      connection.revision++;

      const result: T.ConnectResult = {
        status: "done",
        connection: this.#view(connection),
      };

      data.requests.set(this.#key(input.request), {
        digest: input.request.digest,
        result,
      });

      return {
        type: "applied",
        value: clone(result),
      } satisfies T.CasResult<T.ConnectResult>;
    });
  }

  async disconnectConnection(
    input: Parameters<T.ConnectionStore["disconnectConnection"]>[0],
  ): Promise<T.CasResult<T.ConnectResult>> {
    return this.database.write("disconnectConnection", session => {
      const data = session.data;
      const entry = this.#entry(data, input.request);

      if (entry?.result) {
        return {
          type: "replay",
          value: clone(entry.result),
        } satisfies T.CasResult<T.ConnectResult>;
      }

      const connection = data.connections.get(input.connectionId);

      if (!connection) {
        fail("NOT_FOUND");
      }

      if (connection.revision !== input.expectedRevision) {
        return {
          type: "conflict",
        } satisfies T.CasResult<T.ConnectResult>;
      }

      connection.active = false;
      connection.isDefault = false;
      connection.bindingRevision++;
      connection.revision++;

      const result: T.ConnectResult = {
        status: "done",
        connection: this.#view(connection),
      };

      data.requests.set(this.#key(input.request), {
        digest: input.request.digest,
        result,
      });

      return {
        type: "applied",
        value: clone(result),
      } satisfies T.CasResult<T.ConnectResult>;
    });
  }

  /**
   * Fences a staged secret before issuing a deletion proof.
   *
   * The fence is written in the same writer-lock session as the reference
   * check, so a concurrent commit cannot publish a reference to a blob that has
   * just been proved unreferenced.
   */
  async retireUnreferenced(
    stage: T.SecretStage,
  ): Promise<{ proof: string } | null> {
    return this.database.write("retireUnreferenced", session => {
      const data = session.data;
      const referenced =
        [...data.connections.values()].some(
          connection => connection.secretRef === stage.ref,
        ) ||
        [...data.sessions.values()].some(
          connect =>
            connect.privateStateRef === stage.ref ||
            connect.callbackRef === stage.ref,
        ) ||
        [...data.intents.values()].some(
          intent => intent.approvalSecretRef === stage.ref,
        );

      if (referenced) {
        return null;
      }

      return { proof: session.retire(stage) };
    });
  }
}

function lastSortKey(page: readonly T.OperationRecord[]): string {
  const last = page.at(-1);

  return last === undefined ? "" : `${last.createdAt}\u0000${last.operationId}`;
}
