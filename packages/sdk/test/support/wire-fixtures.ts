/**
 * Valid wire fixtures shared by the SDK tests.
 *
 * Every object here is a shape the generated envelope validator accepts. Tests
 * that need a broken shape mutate a validator-accepted fixture instead of
 * hand-writing a near miss, so "fails safe" cases stay honest.
 */

export const ACCOUNT = {
  provider: "bluesky",
  accountId: "did:plc:fake",
  origin: "https://bsky.social",
} as const;

export const CONNECTION_DONE = {
  status: "done",
  connection: {
    connectionId: "conn_1",
    account: ACCOUNT,
    isDefault: true,
    active: true,
    observations: [],
  },
} as const;

export const CONNECT_ACTION_REQUIRED = {
  status: "action_required",
  connectSessionId: "cs_1",
  stepRevision: 1,
  expiresAt: "2026-10-08T00:10:00.000Z",
  action: {
    type: "credential_input",
    fields: [{ name: "password", label: "App password", secret: true }],
  },
} as const;

export const PREPARED = {
  status: "confirmation_required",
  operationId: "op_1",
  approvalToken: "approval_1",
  expiresAt: "2026-10-08T00:15:00.000Z",
  preview: [],
} as const;

export const EXECUTION_PENDING = {
  phase: "execution",
  operationId: "op_1",
  status: "pending",
  deliveries: [],
} as const;

export const EXECUTION_SUCCEEDED = {
  phase: "execution",
  operationId: "op_1",
  status: "succeeded",
  deliveries: [
    {
      deliveryId: "delivery_1",
      connectionId: "conn_1",
      account: ACCOUNT,
      attempts: 1,
      outcome: { status: "succeeded", remoteId: "at://fake", url: "https://bsky.app/fake" },
    },
  ],
} as const;

/** An aggregate `unknown` that hides one still-unresolved delivery. */
export const EXECUTION_UNKNOWN_WITH_OPEN_DELIVERY = {
  phase: "execution",
  operationId: "op_1",
  status: "unknown",
  deliveries: [
    {
      deliveryId: "delivery_1",
      connectionId: "conn_1",
      account: ACCOUNT,
      attempts: 1,
      outcome: { status: "unknown", disposition: "unknown", reason: "network" },
    },
    {
      deliveryId: "delivery_2",
      connectionId: "conn_2",
      account: { ...ACCOUNT, accountId: "did:plc:fake2" },
      attempts: 1,
      outcome: null,
    },
  ],
} as const;

export const STATUS_OVERVIEW = {
  type: "overview",
  initialized: true,
  connectionCount: 1,
  providers: [],
  recent: [],
  stateHealth: "ok",
} as const;

export const STATUS_PROVIDER = {
  type: "provider",
  provider: { provider: "bluesky", availability: "available", provenance: "official" },
} as const;

export const STATUS_CONNECTIONS = { type: "connections", connections: [] } as const;

export const STATUS_OPERATION = {
  type: "operation",
  operation: EXECUTION_PENDING,
} as const;

export const STATUS_OPERATIONS = { type: "operations", operations: [] } as const;

/** Wrap a result in a valid success envelope. */
export function okEnvelope(
  operation: "connect" | "publish" | "status",
  result: unknown,
): Record<string, unknown> {
  return { protocolVersion: 1, operation, ok: true, result, error: null };
}

/** Wrap a `SafeError` in a valid rejection envelope. */
export function errorEnvelope(
  operation: "connect" | "publish" | "status",
  code: string,
): Record<string, unknown> {
  return {
    protocolVersion: 1,
    operation,
    ok: false,
    result: null,
    error: { code, message: "static server message" },
  };
}
