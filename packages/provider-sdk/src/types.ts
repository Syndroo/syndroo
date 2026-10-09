/**
 * The public Provider contract for syndroo architecture v1.
 *
 * Transcribed from the architecture-v1 blueprint ("Provider SDK" section) so the
 * published types and the reviewed blueprint cannot drift silently. This module
 * is types plus constant-free aliases only:
 *
 * - no Core imports, no Node imports and no runtime value imports;
 * - no schema compilation, no filesystem or network access, no side effects on
 *   load, so importing the package root stays inert;
 * - strings with named aliases are still untrusted at runtime. TypeScript is
 *   not a trust boundary; `defineProvider` performs the bounded structural
 *   validation instead.
 *
 * `defineProvider` lives in `./define-provider.js` and `providerContractTests`
 * in `./testing.js`. `testing` is a separate subpath and is never imported by
 * the production root export.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type Schema = JsonObject;
export type IsoTime = string;
export type Digest = string;
export type ProviderId = string;
export type OperationId = string;
export type ConnectionId = string;
export type SessionId = string;
export type SecretRef = string;
export type Revision = number;
export type Content = { text?: string };
export type AccountIdentity = { provider: ProviderId; accountId: string; origin: string };
export type Implementation = {
  provider: ProviderId; packageName: string; version: string; apiVersion: 1;
  artifactFingerprint: Digest; schemaFingerprint: Digest;
};
export type Capability = "text" | "article";
export type Observation = {
  capability: Capability | "identity" | "publish_permission";
  value: "supported" | "unsupported" | "unknown";
  source: string; verifiedAt: IsoTime; expiresAt?: IsoTime;
  account: AccountIdentity; credentialRevision: Revision;
  artifactFingerprint: Digest; schemaFingerprint: Digest;
};
export type ProviderManifest = {
  id: ProviderId; name: string; version: string; apiVersion: 1;
  declaredCapabilities: readonly Capability[];
  egress: ProviderEgress;
  schemas: { connectOptions: Schema; credentialInput: Schema; content: Schema; publishOptions: Schema };
};
/**
 * The network scope a provider declares for its own calls.
 *
 * `fixedOrigins` is the allowlist the host transport enforces; a provider that
 * talks to more than one host of the same platform lists each canonical
 * `https://host` origin exactly once. `federated: true` marks a provider whose
 * target is an operator-supplied instance (a fediverse server), where the
 * exact origin is not known before the call and is only constrained by the
 * host's public-address policy.
 */
export type ProviderEgress = {
  fixedOrigins: readonly string[];
  federated?: true;
};
export type ConnectAction =
  | { type: "credential_input"; fields: readonly { name: string; label: string; secret: boolean }[] }
  | { type: "open_url"; url: string }
  | { type: "wait_for_callback" };
export type CredentialBundle = JsonObject; // Internal secret; never a public result.
export type ProviderEvidence = {
  capability: Observation["capability"]; value: Observation["value"];
  source: string; verifiedAt: IsoTime; expiresAt?: IsoTime;
};
export type VerifiedIdentity = { account: AccountIdentity; evidence: readonly ProviderEvidence[] };
export type ProviderConnectResult =
  | { status: "action_required"; action: ConnectAction; privateState: JsonObject }
  | { status: "done"; credentials: CredentialBundle; identity: VerifiedIdentity };
export type CallbackEvidence = { code: string; state: string; issuer: string; redirectUri: string };
export type ProviderConnectInput =
  | { type: "start"; options: JsonObject; credentials?: CredentialBundle }
  | { type: "resume"; privateState: JsonObject;
      input: { type: "credentials"; credentials: CredentialBundle }
        | { type: "callback"; evidence: CallbackEvidence } };
export type OAuthMaterial = {
  state: string; redirectUri: string; codeVerifier?: string; codeChallenge?: string;
};
export type ProviderContext = {
  now: IsoTime; signal: AbortSignal; transport: ProviderTransport;
  oauth?: OAuthMaterial; appCredentials?: CredentialBundle;
};
export interface ProviderConnect {
  run(input: ProviderConnectInput, context: ProviderContext): Promise<ProviderConnectResult>;
  verify(credentials: CredentialBundle, context: ProviderContext): Promise<VerifiedIdentity>;
}
export type PreviewField = { name: string; value: Json };
export type ProviderPreview = {
  content: Content; fields: readonly PreviewField[];
};
export type FreezeInput = {
  content: Content; options: JsonObject; account: AccountIdentity;
  now: IsoTime; seed: string;
};
export type FrozenProviderPayload = {
  payloadVersion: 1; payload: JsonObject; effectiveContent: Content;
  effectiveOptions: JsonObject; preview: ProviderPreview;
};
export type ProviderFailureReason = "auth" | "validation" | "rate_limited"
  | "provider_unavailable" | "network" | "permission" | "unsupported" | "unknown";
export type ProviderWriteOutcome =
  | { status: "succeeded"; remoteId?: string; url?: string }
  | { status: "failed"; disposition: "not_applied"; retryable: boolean;
      reason: ProviderFailureReason; retryAfter?: IsoTime }
  | { status: "unknown"; disposition: "unknown"; reason: ProviderFailureReason };
export type ProviderPublishInput = {
  frozen: FrozenProviderPayload; account: AccountIdentity; credentials: CredentialBundle;
  submissionId: string; context: ProviderContext;
};
export interface ProviderPlugin {
  manifest: ProviderManifest;
  connect: ProviderConnect;
  freeze(input: FreezeInput): FrozenProviderPayload;
  publish(input: ProviderPublishInput): Promise<ProviderWriteOutcome>;
}
export type ProviderHttpRequest = {
  url: string; method: "GET" | "POST"; headers?: Readonly<Record<string, string>>;
  body?: string; signal: AbortSignal;
};
export type ProviderHttpResult =
  | { type: "response"; status: number; headers: Readonly<Record<string, string>>; body: string }
  | { type: "transport_error"; stage: "before_request" | "possibly_sent"; code: string };
export interface ProviderTransport {
  request(input: ProviderHttpRequest): Promise<ProviderHttpResult>;
}
export type ContractCase = {
  name: string; input: FreezeInput; expected: FrozenProviderPayload;
};
