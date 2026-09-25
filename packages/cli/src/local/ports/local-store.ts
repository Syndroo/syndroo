import type {
  FrozenDelivery,
  LocalProviderId,
  ProviderOutcome,
  TargetBinding,
  TargetStatus,
} from "@syndroo/core";

import type { CredentialReference } from "./credentials.js";

/**
 * Identifier shapes for the local state files.
 *
 * They are opaque: nothing outside the store derives meaning from them, but
 * every writer must produce exactly this shape.
 */
export const LOCAL_ID_PATTERN = {
  planId: /^plan_[0-9a-f]{32}$/,
  operationId: /^op_[0-9a-f]{64}$/,
  deliveryId: /^[0-9a-f]{64}$/,
  connectionId: /^conn_[0-9a-f]{32}$/,
} as const;

export type PlanKind = "publish" | "retry";

export type PlanAction = "publish" | "retry" | "skip" | "blocked";

export type AdmissionState = "preparing" | "ready";

/**
 * One registered account binding.
 *
 * `removed` is a tombstone: removing a binding never deletes the user's source
 * file and never claims to revoke a remote token.
 */
export interface ConnectionRecord {
  readonly schemaVersion: 1;
  readonly target: TargetBinding;
  readonly source: CredentialReference;
  /** Installation-keyed HMAC of the resolved credential group; never a raw hash. */
  readonly fingerprint: string;
  readonly removed: boolean;
}

/** One frozen target inside a plan. */
export interface PlanItem {
  readonly delivery: FrozenDelivery;
  readonly action: PlanAction;
  /** Set only when a retry preview shows a changed binding. */
  readonly previousBinding: TargetBinding | null;
}

/**
 * A frozen plan.
 *
 * `digest` covers the plan content; `mac` binds it to this installation, so a
 * plan copied into another independently initialized state is rejected. A copy
 * of the whole state (integrity key included) is outside that guarantee:
 * whole-state copies and restored backups have no cross-device protection.
 */
export interface LocalPlan {
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly planId: string;
  readonly kind: PlanKind;
  readonly namespace: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly items: readonly PlanItem[];
  readonly parentOperationId: string | null;
  readonly digest: string;
  readonly mac: string;
}

/**
 * The authoritative record for one logical delivery.
 *
 * `operationId` identifies the owner of the latest attempt, while the legacy
 * operation manifests keep their own delivery references.
 */
export interface DeliveryRecord {
  readonly schemaVersion: 1;
  readonly delivery: FrozenDelivery;
  readonly status: TargetStatus;
  readonly attempts: number;
  readonly operationId: string;
  readonly outcome: ProviderOutcome | null;
  readonly updatedAt: string;
}

/**
 * One admission manifest.
 *
 * The store writes `preparing` first, verifies every delivery record, and only
 * then flips the manifest to `ready`. No content request happens before that
 * flip, so a crash mid-admission is recoverable.
 */
export interface OperationRecord {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly planId: string;
  readonly kind: PlanKind;
  readonly namespace: string;
  readonly admissionState: AdmissionState;
  readonly deliveryIds: readonly string[];
  readonly createdAt: string;
  readonly interrupted: boolean;
}

/**
 * Narrow local persistence port.
 *
 * Every write assumes the caller already holds the global write lock; the
 * implementation owns schema and integrity checks plus manifest admission. It
 * is deliberately not a generic CRUD surface.
 */
export interface LocalStore {
  initialize(): Promise<void>;
  getInstallation(): Promise<{ schemaVersion: 1; installationId: string }>;
  /** HMAC under the installation key; the key itself never leaves the store. */
  authenticate(value: string): Promise<string>;
  getConnection(provider: LocalProviderId): Promise<ConnectionRecord | null>;
  putConnection(
    record: ConnectionRecord,
    expectedRevision: number | null,
  ): Promise<void>;
  getPlan(planId: string): Promise<LocalPlan | null>;
  putPlan(plan: LocalPlan): Promise<void>;
  getDelivery(deliveryId: string): Promise<DeliveryRecord | null>;
  getOperation(operationId: string): Promise<OperationRecord | null>;
  /** Newest first. `namespace` filters before `limit`, so a domain view is not clipped by other namespaces. */
  listOperations(
    limit: number,
    namespace?: string,
  ): Promise<readonly OperationRecord[]>;
  /** Derived from the installation id and the immutable plan id. */
  operationIdFor(planId: string): Promise<string>;
  reserveOperation(plan: LocalPlan): Promise<OperationRecord>;
  /** Returns the attempt number, persisted before any provider request. */
  beginAttempt(
    operationId: string,
    deliveryId: string,
    target: TargetBinding,
  ): Promise<number>;
  commitOutcome(
    operationId: string,
    deliveryId: string,
    attempt: number,
    outcome: ProviderOutcome,
  ): Promise<void>;
  markInterrupted(operationId: string): Promise<void>;
}
