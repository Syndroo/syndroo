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

/**
 * Optional publication-output fields (design 2026-10-14).
 *
 * The fixtures below describe the protocol extension: account presentation,
 * per-delivery public `state`/`preview`, and the reviewed safe diagnostic. They
 * are split from the plain fixtures above so a test can contrast a pre-design
 * server response (`..._LEGACY`, which omits every new optional field) with a
 * projected one, and with an unknown extra field that the relaxed response
 * validator has to ignore rather than reject.
 */

/** Account presentation fields; a display hint, never a stable identity. */
export const ACCOUNT_PRESENTATION = {
  accountName: "@syndroo.bsky.social",
  profileUrl: "https://bsky.app/profile/syndroo.bsky.social",
} as const;

/** `TargetPresentation` adds the connection label at freeze time. */
export const TARGET_PRESENTATION = {
  ...ACCOUNT_PRESENTATION,
  label: "Syndroo Official",
} as const;

/** The frozen preview a target carries in `preview`/`preview[]`. */
export const PROVIDER_PREVIEW = {
  content: { text: "Syndroo now publishes from the command line." },
  fields: [{ name: "visibility", value: "public" }],
} as const;

/** A connection as a pre-design server returned it: no `presentation`. */
export const CONNECTION_DONE_LEGACY = CONNECTION_DONE;

/** The same connection from a server that stores the design's presentation. */
export const CONNECTION_DONE_WITH_PRESENTATION = {
  ...CONNECTION_DONE,
  connection: { ...CONNECTION_DONE.connection, presentation: ACCOUNT_PRESENTATION },
} as const;

/** The connection view a `status`/`connections` result carries. */
export const CONNECTION_VIEW_WITH_PRESENTATION = {
  connectionId: "conn_1",
  account: ACCOUNT,
  isDefault: true,
  active: true,
  observations: [],
  presentation: ACCOUNT_PRESENTATION,
} as const;

/** A pre-design `connections` status result: empty, so no presentation. */
export const STATUS_CONNECTIONS_WITH_PRESENTATION = {
  type: "connections",
  connections: [CONNECTION_VIEW_WITH_PRESENTATION],
} as const;

/** A pre-design prepare result: no `preview[].presentation`. */
export const PREPARED_LEGACY = PREPARED;

/** A prepare result whose frozen targets carry identity and content. */
export const PREPARED_WITH_PRESENTATION = {
  status: "confirmation_required",
  operationId: "op_1",
  approvalToken: "approval_1",
  expiresAt: "2026-10-08T00:15:00.000Z",
  preview: [
    {
      deliveryId: "delivery_1",
      connectionId: "conn_1",
      account: ACCOUNT,
      provider: "bluesky",
      preview: PROVIDER_PREVIEW,
      presentation: TARGET_PRESENTATION,
    },
  ],
} as const;

/** A pre-design succeeded execution: no `state`/`preview`/`presentation`. */
export const EXECUTION_SUCCEEDED_LEGACY = EXECUTION_SUCCEEDED;

/** The same success projected with the design's public fields. */
export const EXECUTION_SUCCEEDED_PROJECTED = {
  phase: "execution",
  operationId: "op_1",
  status: "succeeded",
  deliveries: [
    {
      deliveryId: "delivery_1",
      connectionId: "conn_1",
      account: ACCOUNT,
      attempts: 1,
      outcome: { status: "succeeded", url: "https://bsky.app/profile/syndroo.bsky.social/post/1" },
      state: "settled",
      preview: PROVIDER_PREVIEW,
      presentation: TARGET_PRESENTATION,
    },
  ],
} as const;

/** A confirmed failure whose reviewed safe diagnostic travels with it. */
export const EXECUTION_FAILED_WITH_DIAGNOSTIC = {
  phase: "execution",
  operationId: "op_1",
  status: "failed",
  deliveries: [
    {
      deliveryId: "delivery_1",
      connectionId: "conn_1",
      account: ACCOUNT,
      attempts: 1,
      outcome: {
        status: "failed",
        disposition: "not_applied",
        retryable: false,
        reason: "auth",
        diagnostic: {
          providerCode: "AUTH_FAILED",
          httpStatus: 401,
          message: "Authentication failed.",
        },
      },
      state: "settled",
      preview: PROVIDER_PREVIEW,
    },
  ],
} as const;

/** An unknown outcome: it may have been accepted, so it carries no retry. */
export const EXECUTION_UNKNOWN_WITH_DIAGNOSTIC = {
  phase: "execution",
  operationId: "op_1",
  status: "unknown",
  deliveries: [
    {
      deliveryId: "delivery_1",
      connectionId: "conn_1",
      account: ACCOUNT,
      attempts: 1,
      outcome: {
        status: "unknown",
        disposition: "unknown",
        reason: "network",
        diagnostic: { providerCode: "NETWORK_ERROR", message: "The request did not complete." },
      },
      state: "settled",
      preview: PROVIDER_PREVIEW,
    },
  ],
} as const;

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
