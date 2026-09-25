import { createHash, createHmac, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  FrozenDelivery,
  LocalProviderId,
  ProviderOutcome,
  TargetBinding,
  TargetStatus,
} from "@syndroo/core";

import { CliError } from "../../cli-error.js";
import { EXIT_CODE } from "../../exit-codes.js";
import {
  MAX_LOCAL_CONTENT_CODE_POINTS,
  canonicalJson,
} from "../document.js";
import { localError } from "../errors.js";
import type { CredentialReference } from "../ports/credentials.js";
import {
  LOCAL_ID_PATTERN,
  type AdmissionState,
  type ConnectionRecord,
  type DeliveryRecord,
  type LocalPlan,
  type LocalStore,
  type OperationRecord,
  type PlanAction,
  type PlanItem,
  type PlanKind,
} from "../ports/local-store.js";
import {
  INTEGRITY_KEY_BYTES,
  admissionFailure,
  assertControlledDirectory,
  assertSupportedRuntime,
  atomicWriteFile,
  commitFailure,
  encodeStateRecord,
  ensureChildDirectory,
  ensureStateDirectory,
  isErrno,
  parseStateValue,
  pathExists,
  readControlledFile,
  removeControlledDirectory,
  requireStateDirectory,
  stateFailure,
  type FaultInjector,
  type StoreFaultPoint,
} from "./atomic.js";
import {
  LOCK_RELEASE_FAILURE,
  LocalLockReleaseError,
  QUARANTINE_DIR_NAME,
  RECOVERY_GUARD_DIR_NAME,
  WRITE_LOCK_DIR_NAME,
  assertNoRecoveryGuard,
  lockOwnerView,
  lockReleaseFailureOf,
  processIsAlive,
  quarantineDir,
  readLockState,
  recoveryGuardDir,
  writeLockDir,
  withLocalWriteLock,
  type LockOwnerView,
} from "./lock.js";
import {
  corrupt,
  requireArray,
  requireBoolean,
  requireExactFields,
  requireHex,
  requireInteger,
  requireIsoTime,
  requireRecord,
  requireString,
  requireVersion,
} from "./validate.js";

/**
 * The concrete local file store.
 *
 * One authoritative delivery record per logical target, a deterministic
 * `preparing` -> `ready` operation manifest, a cooperative global write lock,
 * and an explicit recovery path. Every path is fixed by this module; callers
 * never supply a record location.
 */

export const INSTALLATION_FILE_NAME = "installation.json";
export const INTEGRITY_KEY_FILE_NAME = "integrity.key";
export const CONNECTIONS_DIR_NAME = "connections";
export const PLANS_DIR_NAME = "plans";
export const OPERATIONS_DIR_NAME = "operations";
export const DELIVERIES_DIR_NAME = "deliveries";

/** Local providers this version can hold a binding for. */
const LOCAL_PROVIDERS: readonly LocalProviderId[] = ["bluesky", "threads"];

const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const INSTALLATION_ID_PATTERN = /^inst_[0-9a-f]{32}$/;
/** Mirrors `KEY_PATTERN` in `local/document.ts`; frozen with the input contract. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_CODE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** Printable, bounded, no control characters. */
const TARGET_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,256}$/;
const REMOTE_ID_PATTERN = /^[!-~]{1,256}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** Temporary file name an interrupted atomic write leaves behind. */
const TEMP_FILE_PATTERN = /^\.tmp-[0-9a-f]{16}$/;

/** Content attempt limit for one logical delivery, across every operation. */
const MAX_ATTEMPTS = 3;
const MAX_PLAN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PLAN_ITEMS = 32;
const MAX_LIST_LIMIT = 100;
const MAX_CONTENT_CHARS = MAX_LOCAL_CONTENT_CODE_POINTS * 2;

/** Fixed collection directories every initialized state owns. */
const COLLECTION_DIR_NAMES = [
  CONNECTIONS_DIR_NAME,
  PLANS_DIR_NAME,
  OPERATIONS_DIR_NAME,
  DELIVERIES_DIR_NAME,
  QUARANTINE_DIR_NAME,
] as const;

/** Static code for an `in_flight` record that recovery turned into `unknown`. */
const RECOVERED_ORPHAN_CODE = "RECOVERED_ORPHAN";

export interface LocalStoreOptions {
  /** Test-only fault injection. Never reachable from a command line. */
  readonly fault?: FaultInjector;
  readonly now?: () => Date;
}

export interface LocalStateDefect {
  /** Fixed collection label: `root`, `installation`, `integrity`, `lock`, ... */
  readonly collection: string;
  /** Record identity, or a fixed label when the defect is the container. */
  readonly id: string;
  readonly code: string;
}

export interface LocalStateInspection {
  readonly stateHome: string;
  readonly exists: boolean;
  /** The state root itself is a plain directory this user owns with mode 0700. */
  readonly safe: boolean;
  readonly schemaVersion: number | null;
  readonly installationId: string | null;
  readonly lock: {
    readonly held: boolean;
    readonly owner: LockOwnerView | null;
  };
  readonly recoveryGuard: boolean;
  readonly preparingOperations: readonly string[];
  readonly orphanInFlight: readonly string[];
  readonly temporaryFiles: readonly string[];
  readonly corrupt: readonly LocalStateDefect[];
}

export interface LocalRecoveryOptions {
  readonly confirmNoWriters: boolean;
  readonly yes: boolean;
  /** Test-only fault injection, the same shape the store accepts. */
  readonly fault?: FaultInjector;
}

export interface LocalRecoveryReport {
  readonly stateHome: string;
  readonly quarantined: readonly string[];
  readonly recovered: readonly string[];
  readonly orphanInFlight: readonly string[];
}

export interface InstallationRecord {
  readonly schemaVersion: 1;
  readonly installationId: string;
}

interface StoreContext {
  readonly stateHome: string;
  readonly fault: FaultInjector | undefined;
  readonly now: () => Date;
}

export { withLocalWriteLock, LocalLockReleaseError, LOCK_RELEASE_FAILURE, lockReleaseFailureOf, readLockState, writeLockDir, recoveryGuardDir, quarantineDir, assertNoRecoveryGuard, processIsAlive };
export type { StoreFaultPoint, FaultInjector, LockOwnerView };

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmacHex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function recordDomain(collection: string, id: string): string {
  return `record:v1:${collection}:${id}`;
}

function recordMac(key: Buffer, collection: string, id: string, data: unknown): string {
  return hmacHex(key, `${recordDomain(collection, id)}:${canonicalJson(data)}`);
}

function encodeEnvelope(
  key: Buffer,
  collection: string,
  id: string,
  data: unknown,
): Buffer {
  return encodeStateRecord({
    schemaVersion: 1,
    data,
    mac: recordMac(key, collection, id, data),
  });
}

/** A post-write refusal or failure: never reported as a usage error. */
function postWriteFailure(message: string, stage: string): CliError {
  return new CliError(`STATE_COMMIT_FAILED: ${message}`, {
    code: "STATE_COMMIT_FAILED",
    exitCode: EXIT_CODE.FAILURE,
    details: { stage, committed: false },
  });
}

function planTampered(): CliError {
  return localError(
    "PLAN_TAMPERED",
    "the plan integrity check failed",
    EXIT_CODE.USAGE,
  );
}

function requireId(value: unknown, pattern: RegExp, what: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw admissionFailure(
      "INVALID_DOCUMENT",
      `${what} is not in the accepted format`,
    );
  }

  return value;
}

function isLocalProvider(value: unknown): value is LocalProviderId {
  return (
    typeof value === "string" &&
    (LOCAL_PROVIDERS as readonly string[]).includes(value)
  );
}

function sameBinding(left: TargetBinding, right: TargetBinding): boolean {
  return (
    left.provider === right.provider &&
    left.targetId === right.targetId &&
    left.connectionId === right.connectionId &&
    left.bindingRevision === right.bindingRevision
  );
}

function countCodePoints(value: string): number {
  let count = 0;

  for (const _ of value) {
    count++;
  }

  return count;
}

function errorCodeOf(error: unknown): string {
  if (error instanceof CliError) {
    return error.code;
  }

  return "STATE_CORRUPT";
}

type ReadAttempt =
  | { readonly ok: true; readonly bytes: Buffer | null }
  | { readonly ok: false };

async function attemptRead(filePath: string): Promise<ReadAttempt> {
  try {
    return { ok: true, bytes: await readControlledFile(filePath) };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Record shapes
// ---------------------------------------------------------------------------

function readInstallationShape(value: unknown): InstallationRecord {
  const what = "the installation record";
  const record = requireRecord(value, what);

  requireExactFields(record, ["schemaVersion", "installationId"], what);

  return {
    schemaVersion: requireVersion(record["schemaVersion"], what),
    installationId: requireString(
      record["installationId"],
      `${what} identity`,
      { pattern: INSTALLATION_ID_PATTERN },
    ),
  };
}

function readProvider(value: unknown, what: string): LocalProviderId {
  if (!isLocalProvider(value)) {
    corrupt(what, "names a provider without a local path");
  }

  return value;
}

function readPlanKind(value: unknown, what: string): PlanKind {
  if (value === "publish" || value === "retry") {
    return value;
  }

  corrupt(what, "has an unsupported plan kind");
}

function readPlanAction(value: unknown, what: string): PlanAction {
  if (
    value === "publish" ||
    value === "retry" ||
    value === "skip" ||
    value === "blocked"
  ) {
    return value;
  }

  corrupt(what, "has an unsupported action");
}

function readAdmissionState(value: unknown, what: string): AdmissionState {
  if (value === "preparing" || value === "ready") {
    return value;
  }

  corrupt(what, "has an unsupported admission state");
}

function readTargetStatus(value: unknown, what: string): TargetStatus {
  if (
    value === "not_started" ||
    value === "in_flight" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "unknown"
  ) {
    return value;
  }

  corrupt(what, "has an unsupported target status");
}

function readBinding(value: unknown, what: string): TargetBinding {
  const record = requireRecord(value, what);

  requireExactFields(
    record,
    ["provider", "targetId", "connectionId", "bindingRevision"],
    what,
  );

  return {
    provider: readProvider(record["provider"], what),
    targetId: requireString(record["targetId"], `${what} target`, {
      pattern: TARGET_ID_PATTERN,
    }),
    connectionId: requireString(record["connectionId"], `${what} connection`, {
      pattern: LOCAL_ID_PATTERN.connectionId,
    }),
    bindingRevision: requireInteger(
      record["bindingRevision"],
      `${what} revision`,
      { min: 1, max: 1_000_000 },
    ),
  };
}

function readContent(value: unknown, what: string): string {
  const text = requireString(value, what, { max: MAX_CONTENT_CHARS });

  if (text.trim().length === 0) {
    corrupt(what, "is blank");
  }

  if (countCodePoints(text) > MAX_LOCAL_CONTENT_CODE_POINTS) {
    corrupt(what, "exceeds the accepted length");
  }

  return text;
}

function readFrozenDelivery(value: unknown, what: string): FrozenDelivery {
  const record = requireRecord(value, what);

  requireExactFields(
    record,
    [
      "deliveryId",
      "key",
      "namespace",
      "target",
      "content",
      "payloadVersion",
      "payloadHash",
      "payload",
    ],
    what,
  );

  const payloadVersion = requireInteger(
    record["payloadVersion"],
    `${what} payload version`,
    { min: 1, max: 1_000 },
  );
  const payload = requireRecord(record["payload"], `${what} payload`);
  const payloadHash = requireHex(
    record["payloadHash"],
    `${what} payload hash`,
    64,
  );

  if (sha256Hex(canonicalJson({ payloadVersion, payload })) !== payloadHash) {
    corrupt(what, "payload hash does not match its payload");
  }

  return {
    deliveryId: requireString(record["deliveryId"], `${what} identity`, {
      pattern: LOCAL_ID_PATTERN.deliveryId,
    }),
    key: requireString(record["key"], `${what} key`, { pattern: KEY_PATTERN }),
    namespace: requireString(record["namespace"], `${what} namespace`, {
      pattern: NAMESPACE_PATTERN,
    }),
    target: readBinding(record["target"], `${what} target`),
    content: readContent(record["content"], `${what} content`),
    payloadVersion,
    payloadHash,
    payload,
  };
}

function readPlanItem(
  value: unknown,
  namespace: string,
  kind: PlanKind,
): PlanItem {
  const what = "the plan item";
  const record = requireRecord(value, what);

  requireExactFields(record, ["delivery", "action", "previousBinding"], what);

  const delivery = readFrozenDelivery(record["delivery"], `${what} delivery`);

  if (delivery.namespace !== namespace) {
    corrupt(what, "does not belong to the plan namespace");
  }

  const action = readPlanAction(record["action"], what);
  const previousValue = record["previousBinding"];
  const previousBinding =
    previousValue === null
      ? null
      : readBinding(previousValue, `${what} previous binding`);

  if (previousBinding !== null) {
    if (kind !== "retry") {
      corrupt(what, "replaces a binding outside a retry plan");
    }

    if (sameBinding(previousBinding, delivery.target)) {
      corrupt(what, "replaces a binding with itself");
    }

    if (
      previousBinding.targetId !== delivery.target.targetId ||
      previousBinding.provider !== delivery.target.provider
    ) {
      corrupt(what, "replaces a binding with a different account");
    }
  }

  return { delivery, action, previousBinding };
}

function readPlanShape(value: unknown): LocalPlan {
  const what = "the plan record";
  const record = requireRecord(value, what);

  requireExactFields(
    record,
    [
      "schemaVersion",
      "installationId",
      "planId",
      "kind",
      "namespace",
      "createdAt",
      "expiresAt",
      "items",
      "parentOperationId",
      "digest",
      "mac",
    ],
    what,
  );

  const namespace = requireString(record["namespace"], `${what} namespace`, {
    pattern: NAMESPACE_PATTERN,
  });
  const kind = readPlanKind(record["kind"], what);
  const createdAt = requireIsoTime(record["createdAt"], `${what} creation time`);
  const expiresAt = requireIsoTime(record["expiresAt"], `${what} expiry`);
  const createdMs = Date.parse(createdAt);
  const expiresMs = Date.parse(expiresAt);

  if (expiresMs <= createdMs) {
    corrupt(what, "expires before it was created");
  }

  if (expiresMs - createdMs > MAX_PLAN_TTL_MS) {
    corrupt(what, "is valid for longer than a day");
  }

  const items = requireArray(record["items"], `${what} items`, {
    min: 1,
    max: MAX_PLAN_ITEMS,
  }).map(item => readPlanItem(item, namespace, kind));

  if (new Set(items.map(item => item.delivery.deliveryId)).size !== items.length) {
    corrupt(what, "repeats a delivery");
  }

  const parentValue = record["parentOperationId"];
  const parentOperationId =
    parentValue === null
      ? null
      : requireString(parentValue, `${what} parent operation`, {
          pattern: LOCAL_ID_PATTERN.operationId,
        });

  if (kind === "publish" && parentOperationId !== null) {
    corrupt(what, "is a publish plan with a parent operation");
  }

  if (kind === "retry" && parentOperationId === null) {
    corrupt(what, "is a retry plan without a parent operation");
  }

  return {
    schemaVersion: requireVersion(record["schemaVersion"], what),
    installationId: requireString(
      record["installationId"],
      `${what} installation`,
      { pattern: INSTALLATION_ID_PATTERN },
    ),
    planId: requireString(record["planId"], `${what} identity`, {
      pattern: LOCAL_ID_PATTERN.planId,
    }),
    kind,
    namespace,
    createdAt,
    expiresAt,
    items,
    parentOperationId,
    digest: requireHex(record["digest"], `${what} digest`, 64),
    mac: requireHex(record["mac"], `${what} mac`, 64),
  };
}

function readConnectionShape(
  value: unknown,
  provider: LocalProviderId,
): ConnectionRecord {
  const what = "the connection record";
  const record = requireRecord(value, what);

  requireExactFields(
    record,
    ["schemaVersion", "target", "source", "fingerprint", "removed"],
    what,
  );

  const target = readBinding(record["target"], `${what} target`);

  if (target.provider !== provider) {
    corrupt(what, "belongs to a different provider");
  }

  return {
    schemaVersion: requireVersion(record["schemaVersion"], what),
    target,
    source: readCredentialSource(record["source"], provider),
    fingerprint: requireString(record["fingerprint"], `${what} fingerprint`, {
      pattern: FINGERPRINT_PATTERN,
    }),
    removed: requireBoolean(record["removed"], `${what} tombstone`),
  };
}

function readCredentialSource(
  value: unknown,
  provider: LocalProviderId,
): CredentialReference {
  const what = "the connection credential source";
  const record = requireRecord(value, what);

  if (record["kind"] === "env") {
    requireExactFields(record, ["kind", "provider"], what);

    if (readProvider(record["provider"], what) !== provider) {
      corrupt(what, "belongs to a different provider");
    }

    return { kind: "env", provider };
  }

  if (record["kind"] === "file") {
    requireExactFields(record, ["kind", "provider", "path"], what);

    if (readProvider(record["provider"], what) !== provider) {
      corrupt(what, "belongs to a different provider");
    }

    return {
      kind: "file",
      provider,
      path: requireString(record["path"], `${what} location`, {
        max: 4096,
      }),
    };
  }

  corrupt(what, "names an unsupported source kind");
}

function readOutcome(value: unknown, what: string): ProviderOutcome {
  const outcomeWhat = `${what} outcome`;
  const record = requireRecord(value, outcomeWhat);

  if (record["kind"] === "succeeded") {
    requireExactFields(record, ["kind", "remoteId", "url"], outcomeWhat);

    const url = record["url"];

    return {
      kind: "succeeded",
      remoteId: requireString(
        record["remoteId"],
        `${outcomeWhat} remote id`,
        { pattern: REMOTE_ID_PATTERN },
      ),
      url:
        url === null
          ? null
          : requireString(url, `${outcomeWhat} url`, { max: 2048 }),
    };
  }

  if (record["kind"] === "failed") {
    requireExactFields(
      record,
      ["kind", "code", "writeDisposition", "retryable", "retryNotBefore"],
      outcomeWhat,
    );

    if (record["writeDisposition"] !== "not_applied") {
      corrupt(outcomeWhat, "is not a definite non-write");
    }

    const retryNotBefore = record["retryNotBefore"];

    return {
      kind: "failed",
      code: requireString(record["code"], `${outcomeWhat} code`, {
        pattern: PROVIDER_CODE_PATTERN,
      }),
      writeDisposition: "not_applied",
      retryable: requireBoolean(record["retryable"], `${outcomeWhat} retry flag`),
      retryNotBefore:
        retryNotBefore === null
          ? null
          : requireIsoTime(retryNotBefore, `${outcomeWhat} retry time`),
    };
  }

  if (record["kind"] === "unknown") {
    requireExactFields(
      record,
      ["kind", "code", "writeDisposition"],
      outcomeWhat,
    );

    if (record["writeDisposition"] !== "unknown") {
      corrupt(outcomeWhat, "does not record an unknown write");
    }

    return {
      kind: "unknown",
      code: requireString(record["code"], `${outcomeWhat} code`, {
        pattern: PROVIDER_CODE_PATTERN,
      }),
      writeDisposition: "unknown",
    };
  }

  corrupt(outcomeWhat, "names an unsupported outcome");
}

function readDeliveryShape(value: unknown): DeliveryRecord {
  const what = "the delivery record";
  const record = requireRecord(value, what);

  requireExactFields(
    record,
    [
      "schemaVersion",
      "delivery",
      "status",
      "attempts",
      "operationId",
      "outcome",
      "updatedAt",
    ],
    what,
  );

  const delivery = readFrozenDelivery(record["delivery"], `${what} delivery`);
  const status = readTargetStatus(record["status"], what);
  const attempts = requireInteger(record["attempts"], `${what} attempts`, {
    min: 0,
    max: MAX_ATTEMPTS,
  });
  const operationId = requireString(
    record["operationId"],
    `${what} operation`,
    { pattern: LOCAL_ID_PATTERN.operationId },
  );
  const outcomeValue = record["outcome"];
  const outcome =
    outcomeValue === null ? null : readOutcome(outcomeValue, what);

  if (status === "not_started") {
    if (attempts !== 0) {
      corrupt(what, "counts attempts before any attempt started");
    }

    if (outcome !== null) {
      corrupt(what, "has an outcome before any attempt started");
    }
  } else if (status === "in_flight") {
    if (attempts < 1) {
      corrupt(what, "is in flight without an attempt");
    }

    if (outcome !== null) {
      corrupt(what, "is in flight with a committed outcome");
    }
  } else {
    if (attempts < 1) {
      corrupt(what, "has an outcome without an attempt");
    }

    if (outcome === null) {
      corrupt(what, "has no outcome for its status");
    }

    if (outcome.kind !== status) {
      corrupt(what, "has an outcome that does not match its status");
    }
  }

  return {
    schemaVersion: requireVersion(record["schemaVersion"], what),
    delivery,
    status,
    attempts,
    operationId,
    outcome,
    updatedAt: requireIsoTime(record["updatedAt"], `${what} update time`),
  };
}

function readOperationShape(value: unknown): OperationRecord {
  const what = "the operation record";
  const record = requireRecord(value, what);

  requireExactFields(
    record,
    [
      "schemaVersion",
      "operationId",
      "planId",
      "kind",
      "namespace",
      "admissionState",
      "deliveryIds",
      "createdAt",
      "interrupted",
    ],
    what,
  );

  const deliveryIds = requireArray(record["deliveryIds"], `${what} deliveries`, {
    min: 1,
    max: MAX_PLAN_ITEMS,
  }).map(id =>
    requireString(id, `${what} delivery`, {
      pattern: LOCAL_ID_PATTERN.deliveryId,
    }),
  );

  if (new Set(deliveryIds).size !== deliveryIds.length) {
    corrupt(what, "repeats a delivery");
  }

  return {
    schemaVersion: requireVersion(record["schemaVersion"], what),
    operationId: requireString(record["operationId"], `${what} identity`, {
      pattern: LOCAL_ID_PATTERN.operationId,
    }),
    planId: requireString(record["planId"], `${what} plan`, {
      pattern: LOCAL_ID_PATTERN.planId,
    }),
    kind: readPlanKind(record["kind"], what),
    namespace: requireString(record["namespace"], `${what} namespace`, {
      pattern: NAMESPACE_PATTERN,
    }),
    admissionState: readAdmissionState(record["admissionState"], what),
    deliveryIds,
    createdAt: requireIsoTime(record["createdAt"], `${what} creation time`),
    interrupted: requireBoolean(record["interrupted"], `${what} interrupt flag`),
  };
}

// ---------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------

async function storeRoot(
  context: StoreContext,
  create: boolean,
): Promise<string> {
  return create
    ? ensureStateDirectory(context.stateHome)
    : requireStateDirectory(context.stateHome);
}

async function requireStateIdentity(
  root: string,
): Promise<{ installation: InstallationRecord; key: Buffer }> {
  const bytes = await readControlledFile(path.join(root, INSTALLATION_FILE_NAME));

  if (bytes === null) {
    throw stateFailure(
      "STATE_CORRUPT",
      "the state installation record is missing",
    );
  }

  const installation = readInstallationShape(parseStateValue(bytes));
  const keyBytes = await readControlledFile(
    path.join(root, INTEGRITY_KEY_FILE_NAME),
  );

  if (keyBytes === null) {
    throw stateFailure("STATE_CORRUPT", "the state integrity key is missing");
  }

  if (keyBytes.byteLength !== INTEGRITY_KEY_BYTES) {
    throw stateFailure(
      "STATE_CORRUPT",
      "the state integrity key has the wrong length",
    );
  }

  return { installation, key: keyBytes };
}

async function readVerifiedRecord(
  key: Buffer,
  filePath: string,
  collection: string,
  id: string,
  what: string,
): Promise<unknown | null> {
  const bytes = await readControlledFile(filePath);

  if (bytes === null) {
    return null;
  }

  const record = requireRecord(parseStateValue(bytes), what);

  requireExactFields(record, ["schemaVersion", "data", "mac"], what);
  requireVersion(record["schemaVersion"], what);

  const mac = requireHex(record["mac"], `${what} mac`, 64);
  const data = record["data"];

  if (mac !== recordMac(key, collection, id, data)) {
    corrupt(what, "failed its integrity check");
  }

  return data;
}

async function verifyPlanSignature(
  installation: InstallationRecord,
  key: Buffer,
  plan: LocalPlan,
): Promise<void> {
  if (plan.installationId !== installation.installationId) {
    throw planTampered();
  }

  const { digest, mac, ...body } = plan;
  const bytes = canonicalJson(body);

  if (sha256Hex(bytes) !== digest) {
    throw planTampered();
  }

  if (hmacHex(key, `plan:v1:${bytes}`) !== mac) {
    throw planTampered();
  }
}

async function readPlanRecord(
  root: string,
  installation: InstallationRecord,
  key: Buffer,
  planId: string,
): Promise<LocalPlan | null> {
  const dir = path.join(root, PLANS_DIR_NAME);

  await assertControlledDirectory(dir);

  const bytes = await readControlledFile(path.join(dir, `${planId}.json`));

  if (bytes === null) {
    return null;
  }

  const plan = readPlanShape(parseStateValue(bytes));

  if (plan.planId !== planId) {
    corrupt("the plan record", "does not match its file name");
  }

  await verifyPlanSignature(installation, key, plan);

  return plan;
}

async function readConnectionRecord(
  root: string,
  key: Buffer,
  provider: LocalProviderId,
): Promise<ConnectionRecord | null> {
  const dir = path.join(root, CONNECTIONS_DIR_NAME);

  await assertControlledDirectory(dir);

  const data = await readVerifiedRecord(
    key,
    path.join(dir, `${provider}.json`),
    CONNECTIONS_DIR_NAME,
    provider,
    "the connection record",
  );

  return data === null ? null : readConnectionShape(data, provider);
}

async function readDeliveryRecord(
  root: string,
  key: Buffer,
  deliveryId: string,
): Promise<DeliveryRecord | null> {
  const dir = path.join(root, DELIVERIES_DIR_NAME);

  await assertControlledDirectory(dir);

  const data = await readVerifiedRecord(
    key,
    path.join(dir, `${deliveryId}.json`),
    DELIVERIES_DIR_NAME,
    deliveryId,
    "the delivery record",
  );

  if (data === null) {
    return null;
  }

  const record = readDeliveryShape(data);

  if (record.delivery.deliveryId !== deliveryId) {
    corrupt("the delivery record", "does not match its file name");
  }

  return record;
}

async function readOperationRecord(
  root: string,
  key: Buffer,
  operationId: string,
): Promise<OperationRecord | null> {
  const dir = path.join(root, OPERATIONS_DIR_NAME);

  await assertControlledDirectory(dir);

  const data = await readVerifiedRecord(
    key,
    path.join(dir, `${operationId}.json`),
    OPERATIONS_DIR_NAME,
    operationId,
    "the operation record",
  );

  if (data === null) {
    return null;
  }

  const record = readOperationShape(data);

  if (record.operationId !== operationId) {
    corrupt("the operation record", "does not match its file name");
  }

  return record;
}

function deriveOperationId(installationId: string, planId: string): string {
  return `op_${sha256Hex(canonicalJson([installationId, planId]))}`;
}

function assertPlanNotExpired(context: StoreContext, plan: LocalPlan): void {
  if (Date.parse(plan.expiresAt) <= context.now().getTime()) {
    throw admissionFailure(
      "PLAN_EXPIRED",
      "the plan expired before it was admitted",
    );
  }
}

async function assertFreshState(root: string): Promise<void> {
  const known = [
    INSTALLATION_FILE_NAME,
    INTEGRITY_KEY_FILE_NAME,
    CONNECTIONS_DIR_NAME,
    PLANS_DIR_NAME,
    OPERATIONS_DIR_NAME,
    DELIVERIES_DIR_NAME,
    QUARANTINE_DIR_NAME,
    WRITE_LOCK_DIR_NAME,
    RECOVERY_GUARD_DIR_NAME,
  ];

  for (const entry of await fs.readdir(root)) {
    if (!known.includes(entry)) {
      throw stateFailure(
        "STATE_CORRUPT",
        "the state directory holds entries this version did not create",
      );
    }
  }

  for (const name of COLLECTION_DIR_NAMES) {
    if ((await fs.readdir(path.join(root, name))).length > 0) {
      throw stateFailure(
        "STATE_CORRUPT",
        "the state directory already holds history",
      );
    }
  }
}

/** Requires every fixed collection directory of an initialized state. */
async function assertCompleteLayout(root: string): Promise<void> {
  for (const name of COLLECTION_DIR_NAMES) {
    await assertControlledDirectory(path.join(root, name));
  }
}

async function initializeStore(context: StoreContext): Promise<void> {
  const root = await storeRoot(context, true);

  const hasInstallation = await pathExists(
    path.join(root, INSTALLATION_FILE_NAME),
  );
  const hasKey = await pathExists(path.join(root, INTEGRITY_KEY_FILE_NAME));

  if (hasInstallation && hasKey) {
    await requireStateIdentity(root);
    // An initialized state is never repaired: a missing or unsafe collection
    // directory stops initialization instead of being recreated.
    await assertCompleteLayout(root);

    return;
  }

  if (hasInstallation !== hasKey) {
    throw stateFailure("STATE_CORRUPT", "the state identity is incomplete");
  }

  for (const name of COLLECTION_DIR_NAMES) {
    await ensureChildDirectory(root, name);
  }

  await assertFreshState(root);

  const installation: InstallationRecord = {
    schemaVersion: 1,
    installationId: `inst_${randomBytes(16).toString("hex")}`,
  };

  await atomicWriteFile(
    root,
    INTEGRITY_KEY_FILE_NAME,
    randomBytes(INTEGRITY_KEY_BYTES),
    context.fault,
  );
  await atomicWriteFile(
    root,
    INSTALLATION_FILE_NAME,
    encodeStateRecord(installation),
    context.fault,
  );
}

async function getInstallation(
  context: StoreContext,
): Promise<{ schemaVersion: 1; installationId: string }> {
  const root = await storeRoot(context, false);
  const { installation } = await requireStateIdentity(root);

  return {
    schemaVersion: installation.schemaVersion,
    installationId: installation.installationId,
  };
}

async function authenticate(
  context: StoreContext,
  value: string,
): Promise<string> {
  if (typeof value !== "string") {
    throw admissionFailure(
      "INVALID_DOCUMENT",
      "the value to authenticate is not a string",
    );
  }

  const root = await storeRoot(context, false);
  const { key } = await requireStateIdentity(root);

  return hmacHex(key, value);
}

async function getConnection(
  context: StoreContext,
  provider: LocalProviderId,
): Promise<ConnectionRecord | null> {
  if (!isLocalProvider(provider)) {
    throw admissionFailure(
      "INVALID_DOCUMENT",
      "the provider has no local binding slot",
    );
  }

  const root = await storeRoot(context, false);
  const { key } = await requireStateIdentity(root);

  return readConnectionRecord(root, key, provider);
}

async function putConnection(
  context: StoreContext,
  record: ConnectionRecord,
  expectedRevision: number | null,
): Promise<void> {
  const candidate = requireRecord(record, "the connection record");
  const target = readBinding(candidate["target"], "the connection record target");
  const validated = readConnectionShape(record, target.provider);
  const root = await storeRoot(context, false);
  const { key } = await requireStateIdentity(root);
  const dir = path.join(root, CONNECTIONS_DIR_NAME);

  await assertControlledDirectory(dir);

  const existing = await readConnectionRecord(root, key, target.provider);

  if (existing === null) {
    if (expectedRevision !== null) {
      throw admissionFailure(
        "BINDING_CHANGED",
        "the account binding changed before it was written",
      );
    }
  } else {
    if (
      expectedRevision === null ||
      expectedRevision !== existing.target.bindingRevision
    ) {
      throw admissionFailure(
        "BINDING_CHANGED",
        "the account binding changed before it was written",
      );
    }

    if (validated.target.bindingRevision <= existing.target.bindingRevision) {
      throw admissionFailure(
        "BINDING_CHANGED",
        "the account binding revision must increase",
      );
    }
  }

  await atomicWriteFile(
    dir,
    `${target.provider}.json`,
    encodeEnvelope(key, CONNECTIONS_DIR_NAME, target.provider, validated),
    context.fault,
  );
}

async function getPlan(
  context: StoreContext,
  planId: string,
): Promise<LocalPlan | null> {
  const id = requireId(planId, LOCAL_ID_PATTERN.planId, "the plan id");
  const root = await storeRoot(context, false);
  const { installation, key } = await requireStateIdentity(root);

  return readPlanRecord(root, installation, key, id);
}

async function putPlan(
  context: StoreContext,
  plan: LocalPlan,
): Promise<void> {
  const validated = readPlanShape(plan);
  const root = await storeRoot(context, false);
  const { installation, key } = await requireStateIdentity(root);

  await verifyPlanSignature(installation, key, validated);

  const dir = path.join(root, PLANS_DIR_NAME);

  await assertControlledDirectory(dir);

  const existing = await readPlanRecord(root, installation, key, validated.planId);

  if (existing !== null) {
    if (canonicalJson(existing) !== canonicalJson(validated)) {
      throw admissionFailure(
        "IDEMPOTENCY_CONFLICT",
        "a different plan is already stored under this plan id",
      );
    }

    return;
  }

  await atomicWriteFile(
    dir,
    `${validated.planId}.json`,
    encodeStateRecord(validated),
    context.fault,
  );
}

async function getDelivery(
  context: StoreContext,
  deliveryId: string,
): Promise<DeliveryRecord | null> {
  const id = requireId(deliveryId, LOCAL_ID_PATTERN.deliveryId, "the delivery id");
  const root = await storeRoot(context, false);
  const { key } = await requireStateIdentity(root);

  return readDeliveryRecord(root, key, id);
}

async function getOperation(
  context: StoreContext,
  operationId: string,
): Promise<OperationRecord | null> {
  const id = requireId(
    operationId,
    LOCAL_ID_PATTERN.operationId,
    "the operation id",
  );
  const root = await storeRoot(context, false);
  const { key } = await requireStateIdentity(root);

  return readOperationRecord(root, key, id);
}

async function listOperations(
  context: StoreContext,
  limit: number,
  namespace?: string,
): Promise<readonly OperationRecord[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw admissionFailure(
      "INVALID_DOCUMENT",
      "the operation limit is outside the accepted range",
    );
  }

  const filter =
    namespace === undefined
      ? undefined
      : requireId(namespace, NAMESPACE_PATTERN, "the namespace");
  const root = await storeRoot(context, false);
  const { key } = await requireStateIdentity(root);
  const dir = path.join(root, OPERATIONS_DIR_NAME);

  await assertControlledDirectory(dir);

  const records: OperationRecord[] = [];

  for (const entry of await fs.readdir(dir)) {
    if (entry.startsWith(".tmp-")) {
      // An interrupted atomic write leaves its own temporary file behind.
      // It is never authoritative and is never treated as history.
      continue;
    }

    const id = entry.endsWith(".json") ? entry.slice(0, -5) : null;

    if (id === null || !LOCAL_ID_PATTERN.operationId.test(id)) {
      throw stateFailure(
        "STATE_CORRUPT",
        "the operations directory holds an entry this version did not create",
      );
    }

    const record = await readOperationRecord(root, key, id);

    if (record === null) {
      throw stateFailure(
        "STATE_CORRUPT",
        "an operation record disappeared while it was read",
      );
    }

    if (filter !== undefined && record.namespace !== filter) {
      continue;
    }

    records.push(record);
  }

  records.sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt < right.createdAt ? 1 : -1;
    }

    return left.operationId < right.operationId ? 1 : -1;
  });

  return records.slice(0, limit);
}

async function operationIdFor(
  context: StoreContext,
  planId: string,
): Promise<string> {
  const id = requireId(planId, LOCAL_ID_PATTERN.planId, "the plan id");
  const root = await storeRoot(context, false);
  const { installation } = await requireStateIdentity(root);

  return deriveOperationId(installation.installationId, id);
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

function checkDeliveryMatchesItem(item: PlanItem, record: DeliveryRecord): void {
  const frozen = item.delivery;
  const stored = record.delivery;

  // Logical identity and the frozen payload are immutable. A later binding
  // revision is deliberately not part of this comparison: a plan item that
  // references an existing record carries the current active binding, while the
  // record still holds the binding it was first prepared under.
  if (
    stored.deliveryId !== frozen.deliveryId ||
    stored.namespace !== frozen.namespace ||
    stored.key !== frozen.key ||
    stored.payloadVersion !== frozen.payloadVersion ||
    stored.payloadHash !== frozen.payloadHash ||
    stored.content !== frozen.content ||
    stored.target.provider !== frozen.target.provider ||
    stored.target.targetId !== frozen.target.targetId
  ) {
    corrupt("the delivery record", "does not match the frozen plan");
  }

  if (item.previousBinding !== null) {
    // A retry that rotated the binding names the binding the record still holds.
    if (!sameBinding(stored.target, item.previousBinding)) {
      corrupt("the delivery record", "does not match the retry plan");
    }

    return;
  }

  if (item.action === "skip") {
    // A skip only reads a recorded success and never rewrites it, so the stored
    // binding may be an older revision than the frozen one.
    return;
  }

  if (!sameBinding(stored.target, frozen.target)) {
    corrupt("the delivery record", "does not match the frozen plan");
  }
}

function applyActionMatrix(
  item: PlanItem,
  record: DeliveryRecord,
  operationId: string,
  now: Date,
): void {
  if (item.action === "skip") {
    if (record.status !== "succeeded") {
      throw admissionFailure(
        "IDEMPOTENCY_CONFLICT",
        "the plan skips a delivery without a recorded success",
      );
    }

    return;
  }

  if (record.status === "unknown") {
    throw admissionFailure(
      "OUTCOME_UNKNOWN",
      "the delivery result is unknown and must not be sent again",
    );
  }

  if (record.status === "in_flight") {
    throw admissionFailure(
      "STATE_BUSY",
      "the delivery is already in flight",
    );
  }

  if (record.status === "succeeded") {
    throw admissionFailure(
      "IDEMPOTENCY_CONFLICT",
      "the delivery already succeeded and must be skipped",
    );
  }

  if (record.status === "failed") {
    if (item.action !== "retry") {
      throw admissionFailure(
        "IDEMPOTENCY_CONFLICT",
        "a failed delivery is only retried explicitly",
      );
    }

    const outcome = record.outcome;

    if (
      outcome === null ||
      outcome.kind !== "failed" ||
      outcome.writeDisposition !== "not_applied" ||
      !outcome.retryable
    ) {
      throw admissionFailure(
        "IDEMPOTENCY_CONFLICT",
        "the recorded failure is not safely retryable",
      );
    }

    if (record.attempts >= MAX_ATTEMPTS) {
      throw admissionFailure(
        "ATTEMPTS_EXHAUSTED",
        "the delivery used every attempt",
      );
    }

    if (
      outcome.retryNotBefore !== null &&
      Date.parse(outcome.retryNotBefore) > now.getTime()
    ) {
      throw admissionFailure(
        "RETRY_NOT_READY",
        "the retry window has not opened",
      );
    }

    return;
  }

  if (item.action === "publish" && record.operationId !== operationId) {
    throw admissionFailure(
      "IDEMPOTENCY_CONFLICT",
      "an ordinary publish only starts a delivery it prepared",
    );
  }
}

/**
 * Validates every frozen target before the first new delivery record is
 * written, then returns the records this admission still has to create.
 */
async function validateAdmission(
  context: StoreContext,
  root: string,
  key: Buffer,
  plan: LocalPlan,
  operationId: string,
  strictPreparing: boolean,
): Promise<DeliveryRecord[]> {
  const now = context.now();
  const pending: DeliveryRecord[] = [];

  for (const item of plan.items) {
    if (item.action === "blocked") {
      throw admissionFailure(
        "INVALID_DOCUMENT",
        "the plan holds an item this version cannot execute",
      );
    }

    const provider = item.delivery.target.provider;
    const connection = await readConnectionRecord(root, key, provider);

    if (
      connection === null ||
      connection.removed ||
      !sameBinding(connection.target, item.delivery.target)
    ) {
      throw admissionFailure(
        "BINDING_CHANGED",
        "the plan binding is not the current account binding",
      );
    }

    const record = await readDeliveryRecord(
      root,
      key,
      item.delivery.deliveryId,
    );

    if (record === null) {
      if (item.action === "skip") {
        throw admissionFailure(
          "IDEMPOTENCY_CONFLICT",
          "the plan skips a delivery without a recorded success",
        );
      }

      if (item.action === "retry") {
        // A retry plan names a parent operation, so the authoritative record
        // existed before this preview. Recreating it would reset attempts.
        throw stateFailure(
          "STATE_CORRUPT",
          "the authoritative delivery record for this retry is missing",
        );
      }

      pending.push({
        schemaVersion: 1,
        delivery: item.delivery,
        status: "not_started",
        attempts: 0,
        operationId,
        outcome: null,
        updatedAt: now.toISOString(),
      });

      continue;
    }

    checkDeliveryMatchesItem(item, record);

    if (strictPreparing) {
      if (record.status === "in_flight" || record.status === "unknown") {
        corrupt(
          "the delivery record",
          "conflicts with an unfinished admission",
        );
      }

      if (
        record.operationId === operationId &&
        (record.status !== "not_started" ||
          record.attempts !== 0 ||
          record.outcome !== null)
      ) {
        corrupt(
          "the delivery record",
          "conflicts with an unfinished admission",
        );
      }
    }

    applyActionMatrix(item, record, operationId, now);
  }

  return pending;
}

async function writeManifest(
  context: StoreContext,
  root: string,
  key: Buffer,
  plan: LocalPlan,
  operationId: string,
  admissionState: AdmissionState,
  createdAt: string,
  interrupted: boolean,
): Promise<OperationRecord> {
  const record: OperationRecord = {
    schemaVersion: 1,
    operationId,
    planId: plan.planId,
    kind: plan.kind,
    namespace: plan.namespace,
    admissionState,
    deliveryIds: plan.items.map(item => item.delivery.deliveryId),
    createdAt,
    interrupted,
  };
  const dir = path.join(root, OPERATIONS_DIR_NAME);

  await assertControlledDirectory(dir);

  await atomicWriteFile(
    dir,
    `${operationId}.json`,
    encodeEnvelope(key, OPERATIONS_DIR_NAME, operationId, record),
    context.fault,
  );

  return record;
}

async function writeDeliveries(
  context: StoreContext,
  root: string,
  key: Buffer,
  records: readonly DeliveryRecord[],
): Promise<void> {
  if (records.length === 0) {
    return;
  }

  const dir = path.join(root, DELIVERIES_DIR_NAME);

  await assertControlledDirectory(dir);

  for (const record of records) {
    await atomicWriteFile(
      dir,
      `${record.delivery.deliveryId}.json`,
      encodeEnvelope(
        key,
        DELIVERIES_DIR_NAME,
        record.delivery.deliveryId,
        record,
      ),
      context.fault,
    );
  }
}

async function readmitOperation(
  context: StoreContext,
  root: string,
  key: Buffer,
  plan: LocalPlan,
  existing: OperationRecord,
): Promise<OperationRecord> {
  const planDeliveryIds = plan.items.map(item => item.delivery.deliveryId);

  if (
    existing.planId !== plan.planId ||
    existing.kind !== plan.kind ||
    existing.namespace !== plan.namespace ||
    existing.deliveryIds.length !== planDeliveryIds.length ||
    existing.deliveryIds.some((id, index) => id !== planDeliveryIds[index])
  ) {
    corrupt("the operation record", "does not match the plan it names");
  }

  if (existing.admissionState === "ready") {
    // An admitted operation is returned unchanged. Its plan may have expired
    // since; replay never resets attempts, outcomes, or admission.
    return existing;
  }

  assertPlanNotExpired(context, plan);

  const pending = await validateAdmission(
    context,
    root,
    key,
    plan,
    existing.operationId,
    true,
  );

  await writeDeliveries(context, root, key, pending);

  return writeManifest(
    context,
    root,
    key,
    plan,
    existing.operationId,
    "ready",
    existing.createdAt,
    existing.interrupted,
  );
}

async function admitOperation(
  context: StoreContext,
  root: string,
  key: Buffer,
  plan: LocalPlan,
  operationId: string,
): Promise<OperationRecord> {
  assertPlanNotExpired(context, plan);

  const pending = await validateAdmission(
    context,
    root,
    key,
    plan,
    operationId,
    false,
  );
  const createdAt = context.now().toISOString();

  await writeManifest(
    context,
    root,
    key,
    plan,
    operationId,
    "preparing",
    createdAt,
    false,
  );
  await writeDeliveries(context, root, key, pending);

  return writeManifest(
    context,
    root,
    key,
    plan,
    operationId,
    "ready",
    createdAt,
    false,
  );
}

async function reserveOperation(
  context: StoreContext,
  plan: LocalPlan,
): Promise<OperationRecord> {
  const validated = readPlanShape(plan);
  const root = await storeRoot(context, false);
  const { installation, key } = await requireStateIdentity(root);

  await verifyPlanSignature(installation, key, validated);

  const operationId = deriveOperationId(
    installation.installationId,
    validated.planId,
  );
  const existing = await readOperationRecord(root, key, operationId);

  if (existing !== null) {
    return readmitOperation(context, root, key, validated, existing);
  }

  return admitOperation(context, root, key, validated, operationId);
}

// ---------------------------------------------------------------------------
// Attempts and outcomes
// ---------------------------------------------------------------------------

async function beginAttempt(
  context: StoreContext,
  operationId: string,
  deliveryId: string,
  target: TargetBinding,
): Promise<number> {
  const id = requireId(
    operationId,
    LOCAL_ID_PATTERN.operationId,
    "the operation id",
  );
  const deliveryKey = requireId(
    deliveryId,
    LOCAL_ID_PATTERN.deliveryId,
    "the delivery id",
  );
  const requested = readBinding(target, "the attempt target");
  const root = await storeRoot(context, false);
  const { installation, key } = await requireStateIdentity(root);
  const operation = await readOperationRecord(root, key, id);

  if (operation === null) {
    throw stateFailure("STATE_CORRUPT", "the operation record is missing");
  }

  if (operation.admissionState !== "ready") {
    throw admissionFailure(
      "STATE_BUSY",
      "the operation has not finished admission",
    );
  }

  if (!operation.deliveryIds.includes(deliveryKey)) {
    throw admissionFailure(
      "INVALID_DOCUMENT",
      "the delivery is not part of this operation",
    );
  }

  const plan = await readPlanRecord(root, installation, key, operation.planId);

  if (plan === null) {
    throw stateFailure("STATE_CORRUPT", "the plan record is missing");
  }

  if (plan.kind !== operation.kind) {
    corrupt("the operation record", "does not match the kind of its plan");
  }

  const item = plan.items.find(
    candidate => candidate.delivery.deliveryId === deliveryKey,
  );

  if (item === undefined) {
    throw stateFailure(
      "STATE_CORRUPT",
      "the plan does not hold the delivery it admitted",
    );
  }

  if (item.action !== "publish" && item.action !== "retry") {
    throw admissionFailure(
      "INVALID_DOCUMENT",
      "the plan item is not an executable action",
    );
  }

  if (!sameBinding(requested, item.delivery.target)) {
    throw admissionFailure(
      "BINDING_CHANGED",
      "the attempt target is not the frozen plan binding",
    );
  }

  const connection = await readConnectionRecord(
    root,
    key,
    requested.provider,
  );

  if (
    connection === null ||
    connection.removed ||
    !sameBinding(connection.target, requested)
  ) {
    throw admissionFailure(
      "BINDING_CHANGED",
      "the attempt target is not the current account binding",
    );
  }

  const record = await readDeliveryRecord(root, key, deliveryKey);

  if (record === null) {
    throw stateFailure("STATE_CORRUPT", "the delivery record is missing");
  }

  if (record.status === "in_flight") {
    throw admissionFailure("STATE_BUSY", "the delivery is already in flight");
  }

  if (record.status === "unknown") {
    throw admissionFailure(
      "OUTCOME_UNKNOWN",
      "the delivery result is unknown and must not be sent again",
    );
  }

  if (record.status === "succeeded") {
    throw admissionFailure(
      "IDEMPOTENCY_CONFLICT",
      "the delivery already succeeded",
    );
  }

  if (record.status === "failed") {
    const outcome = record.outcome;

    if (
      outcome === null ||
      outcome.kind !== "failed" ||
      outcome.writeDisposition !== "not_applied" ||
      !outcome.retryable
    ) {
      throw admissionFailure(
        "IDEMPOTENCY_CONFLICT",
        "the recorded failure is not safely retryable",
      );
    }

    if (
      outcome.retryNotBefore !== null &&
      Date.parse(outcome.retryNotBefore) > context.now().getTime()
    ) {
      throw admissionFailure(
        "RETRY_NOT_READY",
        "the retry window has not opened",
      );
    }
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    throw admissionFailure(
      "ATTEMPTS_EXHAUSTED",
      "the delivery used every attempt",
    );
  }

  if (operation.kind === "publish") {
    if (
      record.operationId !== id ||
      record.status !== "not_started" ||
      record.attempts !== 0
    ) {
      throw admissionFailure(
        "IDEMPOTENCY_CONFLICT",
        "an ordinary publish only starts a delivery it prepared",
      );
    }
  }

  let delivery = record.delivery;

  if (!sameBinding(delivery.target, item.delivery.target)) {
    if (
      operation.kind !== "retry" ||
      item.previousBinding === null ||
      !sameBinding(item.previousBinding, delivery.target) ||
      item.previousBinding.targetId !== item.delivery.target.targetId
    ) {
      throw admissionFailure(
        "BINDING_CHANGED",
        "the recorded binding cannot rotate for this attempt",
      );
    }

    delivery = { ...delivery, target: item.delivery.target };
  }

  const next: DeliveryRecord = {
    schemaVersion: 1,
    delivery,
    status: "in_flight",
    attempts: record.attempts + 1,
    operationId: id,
    outcome: null,
    updatedAt: context.now().toISOString(),
  };

  await atomicWriteFile(
    path.join(root, DELIVERIES_DIR_NAME),
    `${deliveryKey}.json`,
    encodeEnvelope(key, DELIVERIES_DIR_NAME, deliveryKey, next),
    context.fault,
  );

  return next.attempts;
}

async function commitOutcome(
  context: StoreContext,
  operationId: string,
  deliveryId: string,
  attempt: number,
  outcome: ProviderOutcome,
): Promise<void> {
  try {
    await context.fault?.("before-outcome-commit");
  } catch (error) {
    throw commitFailure("before-outcome-commit", false, error);
  }

  // Everything below happens after a provider request may already have been
  // sent, so no failure here is ever reported as a usage error.
  if (
    typeof operationId !== "string" ||
    !LOCAL_ID_PATTERN.operationId.test(operationId)
  ) {
    throw postWriteFailure("the operation id is not usable", "outcome-argument");
  }

  if (
    typeof deliveryId !== "string" ||
    !LOCAL_ID_PATTERN.deliveryId.test(deliveryId)
  ) {
    throw postWriteFailure("the delivery id is not usable", "outcome-argument");
  }

  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS) {
    throw postWriteFailure("the attempt is not usable", "outcome-argument");
  }

  const root = await storeRoot(context, false);
  const { key } = await requireStateIdentity(root);
  const operation = await readOperationRecord(root, key, operationId);

  if (operation === null) {
    throw stateFailure("STATE_CORRUPT", "the operation record is missing");
  }

  if (!operation.deliveryIds.includes(deliveryId)) {
    throw postWriteFailure(
      "the delivery is not part of this operation",
      "outcome-precondition",
    );
  }

  const record = await readDeliveryRecord(root, key, deliveryId);

  if (record === null) {
    throw stateFailure("STATE_CORRUPT", "the delivery record is missing");
  }

  if (
    record.operationId !== operationId ||
    record.status !== "in_flight" ||
    record.attempts !== attempt
  ) {
    throw postWriteFailure(
      "the delivery is not in flight for this attempt",
      "outcome-precondition",
    );
  }

  const validated = readOutcome(outcome, "the provider outcome");
  const next: DeliveryRecord = {
    schemaVersion: 1,
    delivery: record.delivery,
    status: validated.kind,
    attempts: record.attempts,
    operationId,
    outcome: validated,
    updatedAt: context.now().toISOString(),
  };

  await atomicWriteFile(
    path.join(root, DELIVERIES_DIR_NAME),
    `${deliveryId}.json`,
    encodeEnvelope(key, DELIVERIES_DIR_NAME, deliveryId, next),
    context.fault,
  );
}

async function markInterrupted(
  context: StoreContext,
  operationId: string,
): Promise<void> {
  const id = requireId(
    operationId,
    LOCAL_ID_PATTERN.operationId,
    "the operation id",
  );
  const root = await storeRoot(context, false);
  const { key } = await requireStateIdentity(root);
  const operation = await readOperationRecord(root, key, id);

  if (operation === null) {
    throw stateFailure("STATE_CORRUPT", "the operation record is missing");
  }

  if (operation.interrupted) {
    return;
  }

  const next: OperationRecord = { ...operation, interrupted: true };
  const dir = path.join(root, OPERATIONS_DIR_NAME);

  await assertControlledDirectory(dir);
  await atomicWriteFile(
    dir,
    `${id}.json`,
    encodeEnvelope(key, OPERATIONS_DIR_NAME, id, next),
    context.fault,
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLocalFileStore(
  stateHome: string,
  options: LocalStoreOptions = {},
): LocalStore {
  const context: StoreContext = {
    stateHome,
    fault: options.fault,
    now: options.now ?? (() => new Date()),
  };

  return {
    initialize: () => initializeStore(context),
    getInstallation: () => getInstallation(context),
    authenticate: value => authenticate(context, value),
    getConnection: provider => getConnection(context, provider),
    putConnection: (record, expectedRevision) =>
      putConnection(context, record, expectedRevision),
    getPlan: planId => getPlan(context, planId),
    putPlan: plan => putPlan(context, plan),
    getDelivery: deliveryId => getDelivery(context, deliveryId),
    getOperation: operationId => getOperation(context, operationId),
    listOperations: (limit, namespace) =>
      listOperations(context, limit, namespace),
    operationIdFor: planId => operationIdFor(context, planId),
    reserveOperation: plan => reserveOperation(context, plan),
    beginAttempt: (operationId, deliveryId, target) =>
      beginAttempt(context, operationId, deliveryId, target),
    commitOutcome: (operationId, deliveryId, attempt, outcome) =>
      commitOutcome(context, operationId, deliveryId, attempt, outcome),
    markInterrupted: operationId => markInterrupted(context, operationId),
  };
}

// ---------------------------------------------------------------------------
// Diagnostics and explicit maintenance
// ---------------------------------------------------------------------------

/**
 * Reads state for diagnosis only.
 *
 * Never creates a directory, never changes a permission, never repairs. The
 * view is not a transactional snapshot: a live writer can change what a later
 * call sees.
 */
export async function inspectLocalState(
  stateHome: string,
): Promise<LocalStateInspection> {
  assertSupportedRuntime();

  const absolute = path.resolve(stateHome);
  const defects: LocalStateDefect[] = [];
  const preparingOperations: string[] = [];
  const orphanInFlight: string[] = [];
  const temporaryFiles: string[] = [];
  let schemaVersion: number | null = null;
  let installationId: string | null = null;
  let lockHeld = false;
  let lockOwner: LockOwnerView | null = null;
  let recoveryGuard = false;
  let safe = true;

  const defect = (
    collection: string,
    id: string,
    code = "STATE_CORRUPT",
  ): void => {
    safe = false;
    defects.push({ collection, id, code });
  };

  const base = (exists: boolean): LocalStateInspection => ({
    stateHome: absolute,
    exists,
    safe,
    schemaVersion,
    installationId,
    lock: { held: lockHeld, owner: lockOwner },
    recoveryGuard,
    preparingOperations,
    orphanInFlight,
    temporaryFiles,
    corrupt: defects,
  });

  const rootStat = await fs.lstat(absolute).catch(error => {
    if (isErrno(error, "ENOENT")) {
      return null;
    }

    throw stateFailure("STATE_CORRUPT", "the state directory is not readable");
  });

  if (rootStat === null) {
    safe = false;

    return base(false);
  }

  try {
    await assertControlledDirectory(absolute);
  } catch {
    defect("root", "state");

    return base(true);
  }

  const installationAttempt = await attemptRead(
    path.join(absolute, INSTALLATION_FILE_NAME),
  );
  let installation: InstallationRecord | null = null;

  if (!installationAttempt.ok) {
    defect("installation", "installation");
  } else if (installationAttempt.bytes === null) {
    // A missing identity is a defect, not an empty history.
    defect("installation", "installation");
  } else {
    try {
      const parsed = requireRecord(
        parseStateValue(installationAttempt.bytes),
        "the installation record",
      );
      const raw = parsed["schemaVersion"];

      if (typeof raw === "number" && Number.isInteger(raw)) {
        schemaVersion = raw;
      }

      installation = readInstallationShape(parsed);

      schemaVersion = installation.schemaVersion;
      installationId = installation.installationId;
    } catch (error) {
      defect("installation", "installation", errorCodeOf(error));
    }
  }

  const keyAttempt = await attemptRead(path.join(absolute, INTEGRITY_KEY_FILE_NAME));
  const key =
    keyAttempt.ok &&
    keyAttempt.bytes !== null &&
    keyAttempt.bytes.byteLength === INTEGRITY_KEY_BYTES
      ? keyAttempt.bytes
      : null;

  if (key === null) {
    defect("integrity", "key");
  }

  for (const name of COLLECTION_DIR_NAMES) {
    try {
      await assertControlledDirectory(path.join(absolute, name));
    } catch {
      defect(name, "directory");
    }
  }

  const lock = await readLockState(absolute);

  lockHeld = lock.held;
  lockOwner = lock.owner === null ? null : lockOwnerView(lock.owner);

  if (lock.held && lock.owner === null) {
    defect("lock", "owner");
  }

  recoveryGuard = await pathExists(recoveryGuardDir(absolute));

  await inspectCollection({
    root: absolute,
    dirName: DELIVERIES_DIR_NAME,
    pattern: LOCAL_ID_PATTERN.deliveryId,
    key,
    defect,
    temporaryFiles,
    envelope: true,
    visit: value => {
      const record = readDeliveryShape(value);

      if (record.status === "in_flight") {
        orphanInFlight.push(record.delivery.deliveryId);
      }
    },
  });

  await inspectCollection({
    root: absolute,
    dirName: OPERATIONS_DIR_NAME,
    pattern: LOCAL_ID_PATTERN.operationId,
    key,
    defect,
    temporaryFiles,
    envelope: true,
    visit: value => {
      const record = readOperationShape(value);

      if (record.admissionState === "preparing") {
        preparingOperations.push(record.operationId);
      }
    },
  });

  await inspectCollection({
    root: absolute,
    dirName: PLANS_DIR_NAME,
    pattern: LOCAL_ID_PATTERN.planId,
    key,
    defect,
    temporaryFiles,
    envelope: false,
    visit: async (value, id) => {
      const plan = readPlanShape(value);

      if (plan.planId !== id) {
        corrupt("the plan record", "does not match its file name");
      }

      if (installation !== null && key !== null) {
        await verifyPlanSignature(installation, key, plan);
      }
    },
  });

  await inspectCollection({
    root: absolute,
    dirName: CONNECTIONS_DIR_NAME,
    pattern: /^(?:bluesky|threads)$/,
    key,
    defect,
    temporaryFiles,
    envelope: true,
    visit: (value, id) => {
      readConnectionShape(value, readProvider(id, "the connection record"));
    },
  });

  return base(true);
}

interface InspectCollectionOptions {
  readonly root: string;
  readonly dirName: string;
  readonly pattern: RegExp;
  readonly key: Buffer | null;
  readonly defect: (collection: string, id: string, code?: string) => void;
  readonly temporaryFiles: string[];
  readonly visit: (value: unknown, id: string) => void | Promise<void>;
  /** Records here are `{schemaVersion,data,mac}` envelopes; plans are not. */
  readonly envelope: boolean;
}

async function inspectCollection(
  options: InspectCollectionOptions,
): Promise<void> {
  const dir = path.join(options.root, options.dirName);

  // The directory is validated before it is listed, so a symlinked or unsafe
  // collection is reported instead of followed.
  try {
    await assertControlledDirectory(dir);
  } catch {
    options.defect(options.dirName, "directory");

    return;
  }

  const entries = await fs.readdir(dir).catch(() => null);

  if (entries === null) {
    options.defect(options.dirName, "directory");

    return;
  }

  for (const entry of entries) {
    if (TEMP_FILE_PATTERN.test(entry)) {
      options.temporaryFiles.push(`${options.dirName}/${entry}`);

      continue;
    }

    const id = entry.endsWith(".json") ? entry.slice(0, -5) : null;

    if (id === null || !options.pattern.test(id)) {
      // The raw entry name never reaches a diagnostic: it is not validated and
      // could carry control characters or a secret.
      options.defect(options.dirName, "unrecognized-entry");

      continue;
    }

    const attempt = await attemptRead(path.join(dir, entry));

    if (!attempt.ok || attempt.bytes === null) {
      options.defect(options.dirName, id);

      continue;
    }

    try {
      const parsed = parseStateValue(attempt.bytes);
      let data: unknown;

      if (options.key !== null && options.envelope) {
        data = await readVerifiedRecord(
          options.key,
          path.join(dir, entry),
          options.dirName,
          id,
          "the state record",
        );
      } else if (options.envelope) {
        // Without the installation key only the shape can be checked; the
        // missing key is reported as its own defect.
        const envelope = requireRecord(parsed, "the state record");

        requireExactFields(
          envelope,
          ["schemaVersion", "data", "mac"],
          "the state record",
        );
        requireVersion(envelope["schemaVersion"], "the state record");
        data = envelope["data"];
      } else {
        // Plans carry their own digest and MAC as fields.
        data = parsed;
      }

      if (data === undefined || data === null) {
        options.defect(options.dirName, id);

        continue;
      }

      await options.visit(data, id);
    } catch (error) {
      options.defect(options.dirName, id, errorCodeOf(error));
    }
  }
}

/**
 * Explicit, operator-confirmed maintenance.
 *
 * Both confirmations are required, the guard is exclusive, and a lock owned by
 * a live process, another host, or an unreadable owner record stops the run.
 * Orphan `in_flight` deliveries become `unknown`; attempts are never reset and
 * no preparing record is touched.
 */
export async function recoverLocalState(
  stateHome: string,
  options: LocalRecoveryOptions,
): Promise<LocalRecoveryReport> {
  assertSupportedRuntime();

  if (options.confirmNoWriters !== true || options.yes !== true) {
    throw admissionFailure(
      "CONFIRMATION_REQUIRED",
      "recovery needs both explicit confirmations",
    );
  }

  const root = await requireStateDirectory(stateHome);
  const guard = recoveryGuardDir(root);

  try {
    await fs.mkdir(guard, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw commitFailure("recovery-guard", false, error);
    }

    const stat = await fs.lstat(guard).catch(() => null);

    if (stat !== null && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw stateFailure(
        "STATE_CORRUPT",
        "the state recovery guard is not a plain directory",
      );
    }

    throw admissionFailure(
      "STATE_BUSY",
      "state recovery is already in progress",
    );
  }

  let guardDevice: number;
  let guardInode: number;

  try {
    await fs.chmod(guard, 0o700);

    const stat = await fs.lstat(guard);

    guardDevice = stat.dev;
    guardInode = stat.ino;
  } catch (error) {
    throw commitFailure("recovery-guard", false, error);
  }

  let report: LocalRecoveryReport | undefined;
  let failure: unknown = NO_RECOVERY_FAILURE;

  try {
    report = await runRecovery(root, options.fault);
  } catch (error) {
    failure = error;
  }

  let guardError: unknown = null;

  try {
    await removeOwnGuard(guard, guardDevice, guardInode);
  } catch (error) {
    guardError = error;
  }

  if (failure !== NO_RECOVERY_FAILURE) {
    attachSecondaryReleaseFailure(failure, guardError);

    throw failure;
  }

  if (guardError !== null) {
    throw commitFailure("recovery-guard-release", false, guardError);
  }

  return report as LocalRecoveryReport;
}

const NO_RECOVERY_FAILURE: unique symbol = Symbol(
  "syndroo.local.noRecoveryFailure",
);

/**
 * Removes the recovery guard this run created.
 *
 * The device and inode are checked first: a guard replaced while the run was in
 * progress is left in place and reported, so the next writer still sees a guard
 * this process did not create.
 */
async function removeOwnGuard(
  guard: string,
  device: number,
  inode: number,
): Promise<void> {
  const stat = await fs.lstat(guard).catch(error => {
    if (isErrno(error, "ENOENT")) {
      return null;
    }

    throw error;
  });

  if (stat === null) {
    return;
  }

  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.dev !== device ||
    stat.ino !== inode
  ) {
    throw stateFailure(
      "STATE_CORRUPT",
      "the state recovery guard changed while it was held",
    );
  }

  await removeControlledDirectory(guard);
}

/**
 * Attaches a cleanup failure to a primary error.
 *
 * The same mechanism covers the write lock and the recovery guard: a directory
 * this process owned could not be removed. The primary error is never replaced.
 */
function attachSecondaryReleaseFailure(
  primary: unknown,
  cleanup: unknown,
): void {
  if (cleanup === null || typeof primary !== "object" || primary === null) {
    return;
  }

  try {
    Object.defineProperty(primary, LOCK_RELEASE_FAILURE, {
      value: {
        code: "STATE_COMMIT_FAILED",
        message: "the state recovery guard could not be released",
      },
      enumerable: false,
      configurable: true,
      writable: false,
    });
  } catch {
    // The primary error stays primary even when it cannot carry the secondary.
  }
}

async function runRecovery(
  root: string,
  fault: FaultInjector | undefined,
): Promise<LocalRecoveryReport> {
  const quarantined: string[] = [];
  const recovered: string[] = [];
  const lock = await readLockState(root);

  if (lock.held) {
    const owner = lock.owner;

    if (owner === null) {
      throw stateFailure(
        "STATE_CORRUPT",
        "the state write lock owner record is unreadable",
      );
    }

    if (owner.hostname !== os.hostname()) {
      throw admissionFailure(
        "STATE_BUSY",
        "the state write lock belongs to another host",
      );
    }

    if (processIsAlive(owner.pid)) {
      throw admissionFailure(
        "STATE_BUSY",
        "the state write lock owner is still running",
      );
    }

    const again = await readLockState(root);

    if (
      !again.held ||
      again.owner === null ||
      again.owner.token !== owner.token ||
      again.owner.pid !== owner.pid ||
      again.owner.hostname !== owner.hostname ||
      again.owner.createdAt !== owner.createdAt ||
      again.device !== lock.device ||
      again.inode !== lock.inode
    ) {
      throw admissionFailure(
        "STATE_BUSY",
        "the state write lock changed during recovery",
      );
    }

    await assertControlledDirectory(path.join(root, QUARANTINE_DIR_NAME));

    const label = `lock-${randomBytes(8).toString("hex")}`;

    await fs.rename(writeLockDir(root), path.join(quarantineDir(root), label));
    quarantined.push(`${QUARANTINE_DIR_NAME}/${label}`);
  }

  const { key } = await requireStateIdentity(root);
  const deliveriesDir = path.join(root, DELIVERIES_DIR_NAME);

  await assertControlledDirectory(deliveriesDir);

  const pending: DeliveryRecord[] = [];
  const updatedAt = new Date().toISOString();

  for (const entry of await fs.readdir(deliveriesDir)) {
    if (entry.startsWith(".tmp-")) {
      continue;
    }

    const id = entry.endsWith(".json") ? entry.slice(0, -5) : null;

    if (id === null || !LOCAL_ID_PATTERN.deliveryId.test(id)) {
      throw stateFailure(
        "STATE_CORRUPT",
        "the deliveries directory holds an entry this version did not create",
      );
    }

    const record = await readDeliveryRecord(root, key, id);

    if (record === null) {
      throw stateFailure(
        "STATE_CORRUPT",
        "a delivery record disappeared during recovery",
      );
    }

    if (record.status !== "in_flight") {
      continue;
    }

    pending.push({
      schemaVersion: 1,
      delivery: record.delivery,
      status: "unknown",
      attempts: record.attempts,
      operationId: record.operationId,
      outcome: {
        kind: "unknown",
        code: RECOVERED_ORPHAN_CODE,
        writeDisposition: "unknown",
      },
      updatedAt,
    });
    recovered.push(id);
  }

  for (const record of pending) {
    await atomicWriteFile(
      deliveriesDir,
      `${record.delivery.deliveryId}.json`,
      encodeEnvelope(
        key,
        DELIVERIES_DIR_NAME,
        record.delivery.deliveryId,
        record,
      ),
      fault,
    );
  }

  return {
    stateHome: root,
    quarantined,
    recovered,
    orphanInFlight: recovered,
  };
}
