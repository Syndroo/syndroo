import type { TargetInput, PostDocument, PrepareRequest, ExecuteRequest, RetryRequest, PublishRequest, ConnectRequest, ConnectionView, ConnectResult, TargetPreview, PreparedResult, ExecutionStatus, NotStarted, DeliveryResult, ExecutionResult, OperationView, ProviderView, OperationSummary, StatusRequest, StatusResultMap } from '../protocol/generated/types.js';
export type { TargetInput, PostDocument, PrepareRequest, ExecuteRequest, RetryRequest, PublishRequest, ConnectRequest, ConnectionView, ConnectResult, TargetPreview, PreparedResult, ExecutionStatus, NotStarted, DeliveryResult, ExecutionResult, OperationView, ProviderView, OperationSummary, StatusRequest, StatusResultMap } from '../protocol/generated/types.js';
import type { Json, JsonObject, Schema, IsoTime, Digest, ProviderId, OperationId, ConnectionId, SessionId, SecretRef, Revision, Content, AccountIdentity, Implementation, Capability, Observation, ProviderManifest, ConnectAction, CredentialBundle, ProviderEvidence, VerifiedIdentity, ProviderConnectResult, CallbackEvidence, ProviderConnectInput, OAuthMaterial, ProviderContext, ProviderConnect, PreviewField, ProviderPreview, FreezeInput, FrozenProviderPayload, ProviderFailureReason, ProviderWriteOutcome, ProviderPublishInput, ProviderPlugin, ProviderHttpRequest, ProviderHttpResult, ProviderTransport, ContractCase } from '@syndroo/provider-sdk';
export type { Json, JsonObject, Schema, IsoTime, Digest, ProviderId, OperationId, ConnectionId, SessionId, SecretRef, Revision, Content, AccountIdentity, Implementation, Capability, Observation, ProviderManifest, ConnectAction, CredentialBundle, ProviderEvidence, VerifiedIdentity, ProviderConnectResult, CallbackEvidence, ProviderConnectInput, OAuthMaterial, ProviderContext, ProviderConnect, PreviewField, ProviderPreview, FreezeInput, FrozenProviderPayload, ProviderFailureReason, ProviderWriteOutcome, ProviderPublishInput, ProviderPlugin, ProviderHttpRequest, ProviderHttpResult, ProviderTransport, ContractCase } from '@syndroo/provider-sdk';
export type PublishResult = PreparedResult | ExecutionResult;
export type StatusResult<T extends StatusRequest> = StatusResultMap[T["type"]];
export type CallContext = {
    principalId: string;
    idempotencyKey?: string;
    signal: AbortSignal;
};
export type SafeError = {
    code: string;
    message: string;
    details?: {
        field?: string;
        operationId?: string;
        retryAt?: IsoTime;
    };
};
export type Envelope<T> = {
    protocolVersion: 1;
    operation: "connect" | "publish" | "status";
    ok: true;
    result: T;
    error: null;
} | {
    protocolVersion: 1;
    operation: "connect" | "publish" | "status";
    ok: false;
    result: null;
    error: SafeError;
};
export interface Core {
    connect(request: ConnectRequest, context: CallContext): Promise<ConnectResult>;
    publish(request: ExecuteRequest, context: CallContext): Promise<ExecutionResult>;
    publish(request: PrepareRequest | RetryRequest, context: CallContext): Promise<PublishResult>;
    status<T extends StatusRequest>(request: T, context: CallContext): Promise<StatusResult<T>>;
}
export type DryRunResult = {
    status: "preview";
    preview: readonly TargetPreview[];
    unverified: readonly string[];
};
export type RequestIdentity = {
    principalId: string;
    family: "connect" | "publish";
    key: string;
    digest: Digest;
};
export type ConnectionRecord = {
    connectionId: ConnectionId;
    account: AccountIdentity;
    label?: string;
    isDefault: boolean;
    active: boolean;
    revision: Revision;
    bindingRevision: Revision;
    credentialRevision: Revision;
    secretRef: SecretRef;
    observations: readonly Observation[];
};
export type Binding = {
    connectionId: ConnectionId;
    account: AccountIdentity;
    bindingRevision: Revision;
};
export type FrozenTarget = {
    deliveryId: string;
    binding: Binding;
    implementation: Implementation;
    canonicalContent: Content;
    canonicalOptions: JsonObject;
    frozen: FrozenProviderPayload;
};
export type FrozenIntent = {
    format: "syndroo-runtime-v1";
    operationId: OperationId;
    executionRevision: Revision;
    principalId: string;
    request: RequestIdentity;
    canonicalRequest: PrepareRequest | RetryRequest;
    targets: readonly FrozenTarget[];
    createdAt: IsoTime;
    expiresAt: IsoTime;
    approvalDigest: Digest;
    approvalSecretRef: SecretRef;
    intentDigest: Digest;
};
export type Claim = {
    operationId: OperationId;
    executionRevision: Revision;
    deliveryId: string;
    claimId: string;
    ownerId: string;
    submissionId: string;
    attempt: number;
    claimedAt: IsoTime;
    expiresAt: IsoTime;
};
export type DeliveryRecord = DeliveryResult & {
    state: "ready" | "in_flight" | "settled";
    claim?: Claim;
    history: readonly {
        claim: Claim;
        outcome: ProviderWriteOutcome;
    }[];
};
export type OperationRecord = {
    operationId: OperationId;
    principalId: string;
    version: Revision;
    createdAt: IsoTime;
    canonicalOriginal: PrepareRequest;
    executionRevision: Revision;
    phase: "preparing" | "prepared" | "execution";
    status?: ExecutionStatus;
    intentDigest?: Digest;
    pendingPreparation?: PreparationTicket;
    preparedRetry?: {
        executionRevision: Revision;
        intentDigest: Digest;
    };
    deliveries: readonly DeliveryRecord[];
    work: {
        pending: boolean;
        nextWakeAt: IsoTime;
        notifyClaim?: string;
        notifyClaimUntil?: IsoTime;
    };
};
export type PreparationTicket = {
    operationId: OperationId;
    executionRevision: Revision;
    ownerId: string;
    fence: Revision;
    expectedVersion: Revision;
    request: RequestIdentity;
    expiresAt: IsoTime;
};
export type ConnectSession = {
    sessionId: SessionId;
    principalId: string;
    implementation: Implementation;
    provider: ProviderId;
    stepRevision: Revision;
    expiresAt: IsoTime;
    connectionId: ConnectionId;
    baselineRevision: Revision | null;
    label?: string;
    privateStateRef?: SecretRef;
    callbackRef?: SecretRef;
    action?: ConnectAction;
    status: "awaiting" | "processing" | "done" | "indeterminate";
};
export type StepClaim = {
    sessionId: SessionId;
    stepRevision: Revision;
    claimId: string;
    inputDigest: Digest;
};
export type SecretOwner = {
    kind: "credential" | "connect_state" | "callback" | "approval";
    ownerId: string;
    version: Revision;
};
export type SecretStage = {
    ref: SecretRef;
    creationId: string;
    owner: SecretOwner;
};
export type WorkRef = {
    operationId: OperationId;
    executionRevision: Revision;
};
export type NotifyClaim = {
    work: WorkRef;
    claimId: string;
};
export type CasResult<T> = {
    type: "applied" | "replay";
    value: T;
} | {
    type: "conflict";
};
export type Reservation = {
    type: "owned";
    ticket: PreparationTicket;
} | {
    type: "replay";
    operation: OperationRecord;
    intent?: FrozenIntent;
} | {
    type: "busy";
    retryAt: IsoTime;
};
export interface OperationStore {
    getExecutionIntent(work: WorkRef): Promise<FrozenIntent | null>;
    reservePreparation(input: {
        request: RequestIdentity;
        canonical: PrepareRequest;
        operationId: OperationId;
        ownerId: string;
        now: IsoTime;
    }): Promise<Reservation>;
    savePreparedIntent(input: {
        ticket: PreparationTicket;
        intent: FrozenIntent;
        now: IsoTime;
    }): Promise<CasResult<FrozenIntent>>;
    failPreparation(input: {
        ticket: PreparationTicket;
        error: SafeError;
        now: IsoTime;
    }): Promise<void>;
    prepareRetry(input: {
        request: RequestIdentity;
        operationId: OperationId;
        expectedVersion: Revision;
        deliveryIds: readonly string[];
        ownerId: string;
        now: IsoTime;
    }): Promise<Reservation>;
    readApproval(input: {
        principalId: string;
        approvalDigest: Digest;
    }): Promise<{
        intent: FrozenIntent;
        admitted: boolean;
        operation: OperationRecord;
    } | null>;
    admitExecution(input: {
        principalId: string;
        approvalDigest: Digest;
        intentDigest: Digest;
        expectedVersion: Revision;
        bindings: readonly Binding[];
        now: IsoTime;
    }): Promise<CasResult<OperationRecord>>;
    claimDelivery(input: {
        work: WorkRef;
        deliveryId: string;
        expectedVersion: Revision;
        claimId: string;
        ownerId: string;
        submissionId: string;
        now: IsoTime;
    }): Promise<Claim | null>;
    recordOutcome(input: {
        claim: Claim;
        outcome: ProviderWriteOutcome;
        now: IsoTime;
    }): Promise<CasResult<OperationRecord>>;
    stopUnstarted(input: {
        work: WorkRef;
        expectedVersion: Revision;
        outcome: NotStarted;
        now: IsoTime;
    }): Promise<CasResult<OperationRecord>>;
    recoverInterrupted(input: {
        work: WorkRef;
        expectedVersion: Revision;
        now: IsoTime;
    }): Promise<CasResult<OperationRecord>>;
    getOperation(operationId: OperationId, principalId: string): Promise<OperationRecord | null>;
    getIntent(work: WorkRef, principalId: string): Promise<FrozenIntent | null>;
    listOperations(input: {
        principalId: string;
        limit: number;
        cursor?: string;
    }): Promise<{
        operations: readonly OperationRecord[];
        nextCursor?: string;
    }>;
    claimNotifications(input: {
        ownerId: string;
        now: IsoTime;
        limit: number;
    }): Promise<readonly NotifyClaim[]>;
    recordNotification(input: {
        claim: NotifyClaim;
        sent: boolean;
        now: IsoTime;
    }): Promise<void>;
}
export interface ConnectionStore {
    readConnectRequest(request: RequestIdentity): Promise<ConnectResult | null>;
    replayConnectStep(input: {
        sessionId: SessionId;
        principalId: string;
        stepRevision: Revision;
        inputDigest: Digest;
    }): Promise<ConnectResult | null>;
    listConnections(provider?: ProviderId): Promise<readonly ConnectionRecord[]>;
    getConnection(connectionId: ConnectionId): Promise<ConnectionRecord | null>;
    reserveConnect(input: {
        request: RequestIdentity;
        session: ConnectSession;
        now: IsoTime;
    }): Promise<CasResult<ConnectSession>>;
    getConnectSession(sessionId: SessionId, principalId: string): Promise<ConnectSession | null>;
    claimConnectStep(input: {
        sessionId: SessionId;
        principalId: string;
        stepRevision: Revision;
        inputDigest: Digest;
        claimId: string;
        now: IsoTime;
    }): Promise<{
        type: "claimed";
        claim: StepClaim;
        session: ConnectSession;
    } | {
        type: "replay";
        result: ConnectResult;
    } | {
        type: "busy";
    }>;
    saveConnectAction(input: {
        claim: StepClaim;
        action: ConnectAction;
        privateState: SecretStage;
        now: IsoTime;
    }): Promise<CasResult<ConnectResult>>;
    acceptCallback(input: {
        sessionId: SessionId;
        expectedStepRevision: Revision;
        callbackDigest: Digest;
        evidence: SecretStage;
        now: IsoTime;
    }): Promise<CasResult<ConnectSession>>;
    commitConnection(input: {
        claim: StepClaim;
        expectedConnectionRevision: Revision | null;
        connection: ConnectionRecord;
        stagedCredential: SecretStage;
        now: IsoTime;
    }): Promise<CasResult<ConnectResult>>;
    failConnectStep(input: {
        claim: StepClaim;
        error: SafeError;
        indeterminate: boolean;
        now: IsoTime;
    }): Promise<void>;
    updateConnection(input: {
        request: RequestIdentity;
        connectionId: ConnectionId;
        expectedRevision: Revision;
        changes: {
            label?: string | null;
            isDefault?: boolean;
        };
        now: IsoTime;
    }): Promise<CasResult<ConnectResult>>;
    disconnectConnection(input: {
        request: RequestIdentity;
        connectionId: ConnectionId;
        expectedRevision: Revision;
        now: IsoTime;
    }): Promise<CasResult<ConnectResult>>;
}
export interface CredentialStore {
    put(input: {
        creationId: string;
        owner: SecretOwner;
        value: JsonObject;
    }): Promise<SecretStage>;
    get(input: {
        ref: SecretRef;
        owner: SecretOwner;
    }): Promise<JsonObject>;
    delete(input: {
        stage: SecretStage;
        unreferencedProof: string;
    }): Promise<void>;
}
export interface SecretReferences {
    retireUnreferenced(stage: SecretStage): Promise<{
        proof: string;
    } | null>;
}
export type StateStore = OperationStore & ConnectionStore & SecretReferences;
export type ProviderCandidate = {
    provider: ProviderId;
    packageName: string;
    version: string;
    resolvedRoot: string;
    entrypoint: string;
    artifactFingerprint: Digest;
    provenance: "official" | "third_party";
};
export type ProviderApproval = {
    fingerprint: Digest;
    approvedAt: IsoTime;
    source: "interactive" | "administrator" | "distribution";
};
export type LoadedProvider = {
    plugin: ProviderPlugin;
    implementation: Implementation;
    validators: {
        [K in keyof ProviderManifest['schemas']]: (value: unknown) => boolean;
    };
};
export interface ProviderRegistry {
    describe(provider: ProviderId): Promise<ProviderView>; // Saved catalog only.
    list(): Promise<readonly Omit<ProviderView, "manifest">[]>;
    load(provider: ProviderId, mode?: "active" | "read_only"): Promise<LoadedProvider>; // Trust before import.
}
export interface ProviderLoader {
    inspect(provider: ProviderId): Promise<ProviderCandidate>; // No module evaluation.
    approve(candidate: ProviderCandidate, approval: ProviderApproval): Promise<void>;
    load(candidate: ProviderCandidate): Promise<LoadedProvider>;
}
export interface Clock {
    now(): IsoTime;
}
export interface Entropy {
    id(prefix: string): string;
    token(): string;
}
export interface Digests {
    canonical(value: Json): Promise<Digest>;
    sensitive(value: Json): Promise<Digest>;
}
export interface Notifier {
    notify(work: WorkRef): Promise<void>;
}
export interface Executor {
    run(work: WorkRef, signal: AbortSignal): Promise<ExecutionResult>;
}
export type CoreDependencies = {
    state: StateStore;
    credentials: CredentialStore;
    providers: ProviderRegistry;
    clock: Clock;
    entropy: Entropy;
    digests: Digests;
    // A host resolves the provider's saved manifest before it can build the
    // matching egress policy, so the result may be asynchronous; Core awaits it.
    providerContext(provider: ProviderId, signal: AbortSignal): ProviderContext | Promise<ProviderContext>;
    execution: {
        type: "foreground";
    } | {
        type: "durable_async";
        notifier: Notifier;
    };
};
