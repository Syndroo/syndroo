import { canonicalJson, ProtocolError } from '@syndroo/core';
import type * as T from '@syndroo/core';

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Printable ASCII only: an authorization code is opaque transport data. */
const CODE = /^[\x21-\x7e]{1,2048}$/;
/** The adapter's own 32-byte base64url state, and nothing looser. */
const STATE = /^[A-Za-z0-9._~-]{16,512}$/;
const CALLBACK_PATH = '/oauth/callback/';
const ALLOWED_PARAMS = ['code', 'state', 'error', 'error_description', 'scope'] as const;
const DEFAULT_TTL_MS = 900_000;
const MAX_TTL_MS = 900_000;
const MAX_PROVIDERS = 16;
const DIGEST_LABEL = 'syndroo-oauth-digest-v1';

const HEADERS = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'",
  'Referrer-Policy': 'no-referrer',
};

function page(status: number, message: string, allow?: string): Response {
  const headers: Record<string, string> = allow === undefined ? HEADERS : { ...HEADERS, Allow: allow };
  return new Response(`${message}\n`, { status, headers });
}

function invalid(): never { throw new Error('SERVER_CONFIG_INVALID'); }

function originOf(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128) return invalid();
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || url.pathname !== '/' || !url.hostname) return invalid();
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) return invalid();
    return url.origin;
  } catch { return invalid(); }
}

/**
 * The OAuth callback module is optional; when it is configured it must be
 * complete before any storage is opened. A half-configured module never
 * degrades into "OAuth disabled and the server keeps running".
 */
export type NormalizedOAuthConfig = {
  publicOrigin: string;
  providers: readonly string[];
  ttlMs: number;
};

export function normalizeOAuthConfig(value: unknown): NormalizedOAuthConfig | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['publicOrigin', 'providers', 'ttlMs'].includes(key))) return invalid();
  const publicOrigin = originOf(record.publicOrigin);
  const providers = record.providers;
  if (!Array.isArray(providers) || providers.length < 1 || providers.length > MAX_PROVIDERS) return invalid();
  const unique = new Set<string>();
  for (const provider of providers) {
    if (typeof provider !== 'string' || !PROVIDER_ID.test(provider)) return invalid();
    unique.add(provider);
  }
  if (unique.size !== providers.length) return invalid();
  const ttlMs = record.ttlMs === undefined ? DEFAULT_TTL_MS : record.ttlMs;
  if (!Number.isInteger(ttlMs) || (ttlMs as number) < 60_000 || (ttlMs as number) > MAX_TTL_MS) return invalid();
  return { publicOrigin, providers: [...unique], ttlMs: ttlMs as number };
}

export type OAuthCallbackDependencies = {
  attempts: OAuthAttemptStore;
  state: T.StateStore;
  credentials: T.CredentialStore;
  clock: T.Clock;
  entropy: T.Entropy;
  principalId: string;
  /** Deployment-scoped key material; a dedicated subkey is derived from it. */
  key: Uint8Array;
};

export type OAuthAttemptRecord = {
  stateDigest: string;
  sessionId: string;
  provider: string;
  stepRevision: number;
  redirectUri: string;
  issuer: string;
  codeChallenge: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
};

export type OAuthClaimResult = 'claimed' | 'missing' | 'used' | 'expired';

/** Runtime-neutral durable attempt store. Node may return synchronously; D1 returns promises. */
export type OAuthAttemptStore = {
  insert(record: OAuthAttemptRecord): void | Promise<void>;
  read(stateDigest: string): OAuthAttemptRecord | null | Promise<OAuthAttemptRecord | null>;
  claim(stateDigest: string, now: string): OAuthClaimResult | Promise<OAuthClaimResult>;
  release(stateDigest: string, now: string): void | Promise<void>;
};

type Draft = {
  provider: string;
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  redirectUri: string;
};

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function later(now: string, milliseconds: number): string {
  return new Date(Date.parse(now) + milliseconds).toISOString();
}

export type OAuthCallbackInput = {
  url: URL;
  state: string;
  code: string;
};

/** Validate route syntax without opening storage. */
export function inspectOAuthCallback(
  request: Request,
  provider: string,
  config: NormalizedOAuthConfig,
): OAuthCallbackInput | Response {
  if (request.method !== 'GET') return page(405, 'Callback rejected.', 'GET');
  if (!config.providers.includes(provider)) return page(404, 'Callback rejected.');
  let url: URL;
  try { url = new URL(request.url); } catch { return page(400, 'Callback rejected.'); }
  if (url.pathname !== `${CALLBACK_PATH}${provider}`) return page(404, 'Callback rejected.');
  for (const key of url.searchParams.keys()) {
    if (!(ALLOWED_PARAMS as readonly string[]).includes(key)) return page(400, 'Callback rejected.');
  }
  for (const key of ALLOWED_PARAMS) {
    if (url.searchParams.getAll(key).length > 1) return page(400, 'Callback rejected.');
  }
  if (url.searchParams.has('error')) return page(400, 'Callback rejected.');
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (state === null || !STATE.test(state) || code === null || !CODE.test(code)) {
    return page(400, 'Callback rejected.');
  }
  return { url, state, code };
}

/**
 * The browser-facing half of the OAuth transport.
 *
 * The adapter owns three things and nothing else: the unguessable `state` plus
 * S256 PKCE material offered to a provider at `connect start`, the durable
 * single-use attempt keyed by a digest of that state, and the callback route
 * that turns a verified redirect into stored evidence.
 *
 * It never proves that an exchange happened. The client's `callback_complete`
 * is a status query; the exchange is driven by the evidence this adapter
 * stored, and Core's step CAS decides whether it runs at all.
 */
export class OAuthCallbackAdapter {
  readonly #attempts: OAuthAttemptStore;
  readonly #state: T.StateStore;
  readonly #credentials: T.CredentialStore;
  readonly #clock: T.Clock;
  readonly #entropy: T.Entropy;
  readonly #principalId: string;
  readonly #digestKey: Promise<CryptoKey>;
  readonly #origin: string;
  readonly #providers: ReadonlySet<string>;
  readonly #ttlMs: number;
  readonly #drafts = new WeakMap<AbortSignal, Draft>();

  constructor(
    config: NormalizedOAuthConfig,
    deps: OAuthCallbackDependencies,
  ) {
    if (!deps || typeof deps.principalId !== 'string' || !deps.principalId
      || !(deps.key instanceof Uint8Array)
      || !deps.attempts || !deps.state || !deps.credentials
      || typeof deps.clock?.now !== 'function' || typeof deps.entropy?.id !== 'function') invalid();
    this.#attempts = deps.attempts;
    this.#state = deps.state;
    this.#credentials = deps.credentials;
    this.#clock = deps.clock;
    this.#entropy = deps.entropy;
    this.#principalId = deps.principalId;
    const key = new Uint8Array(deps.key);
    this.#digestKey = crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .then(parent => crypto.subtle.sign('HMAC', parent, new TextEncoder().encode(DIGEST_LABEL)))
      .then(bytes => crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
    this.#origin = config.publicOrigin;
    this.#providers = new Set(config.providers);
    this.#ttlMs = config.ttlMs;
  }

  supports(provider: string): boolean {
    return this.#providers.has(provider);
  }

  async #digest(value: string): Promise<string> {
    const bytes = await crypto.subtle.sign('HMAC', await this.#digestKey, new TextEncoder().encode(value));
    return hex(new Uint8Array(bytes));
  }

  #redirectUri(provider: string): string {
    return `${this.#origin}${CALLBACK_PATH}${provider}`;
  }

  /**
   * Run one connect call with this adapter's transport behavior.
   *
   * A supported start is armed with fresh state and S256 PKCE material. After
   * Core applies an `open_url` result, the attempt is recorded from Core's
   * persisted OAuth state rather than the temporary draft. That makes a start
   * replay retain its original authorization URL and lets a credential-input
   * resume record the state that was persisted during the first step.
   */
  async runStart(
    request: T.ConnectRequest,
    signal: AbortSignal,
    run: () => Promise<T.ConnectResult>,
  ): Promise<T.ConnectResult> {
    if (!(signal instanceof AbortSignal)) return run();
    if (request.type === 'start') {
      if (!this.supports(request.provider)) return run();
      if (request.options?.redirectUri !== undefined
        && request.options.redirectUri !== this.#redirectUri(request.provider)) {
        throw new ProtocolError('INVALID_INPUT');
      }
    }
    if (request.type === 'start') await this.#arm(request.provider, signal);
    try {
      const result = await run();
      await this.record(result);
      return result;
    } finally {
      this.#drafts.delete(signal);
    }
  }

  async #arm(provider: T.ProviderId, signal: AbortSignal): Promise<Draft> {
    const random = () => crypto.getRandomValues(new Uint8Array(32));
    const verifier = base64url(random());
    const challenge = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const draft: Draft = {
      provider,
      state: base64url(random()),
      codeVerifier: verifier,
      codeChallenge: base64url(challenge),
      redirectUri: this.#redirectUri(provider),
    };
    this.#drafts.set(signal, draft);
    return draft;
  }

  /** Add the armed OAuth material to the provider context of this start call. */
  decorate(base: T.ProviderContext, provider: T.ProviderId): T.ProviderContext {
    const draft = this.#drafts.get(base.signal);
    if (!draft || draft.provider !== provider) return base;
    return {
      ...base,
      oauth: {
        state: draft.state,
        redirectUri: draft.redirectUri,
        codeVerifier: draft.codeVerifier,
        codeChallenge: draft.codeChallenge,
      },
    };
  }

  /** Record an attempt from the OAuth material Core persisted for this result. */
  async record(result: T.ConnectResult): Promise<void> {
    if (result.status !== 'action_required' || result.action.type !== 'open_url') return;
    let url: URL;
    try { url = new URL(result.action.url); } catch { return; }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return;
    const session = await this.#state.getConnectSession(result.connectSessionId, this.#principalId);
    if (!session || session.status !== 'awaiting' || session.stepRevision !== result.stepRevision
      || !session.privateStateRef) return;
    if (!this.supports(session.provider)) return;
    const saved = await this.#credentials.get({
      ref: session.privateStateRef,
      owner: { kind: 'connect_state', ownerId: session.sessionId, version: result.stepRevision },
    });
    const material = saved.oauth as Partial<T.OAuthMaterial> | undefined;
    if (!material || typeof material.state !== 'string' || typeof material.redirectUri !== 'string'
      || typeof material.codeChallenge !== 'string'
      || material.redirectUri !== this.#redirectUri(session.provider)
      || url.searchParams.get('state') !== material.state
      || (url.searchParams.has('redirect_uri') && url.searchParams.get('redirect_uri') !== material.redirectUri)) {
      throw new ProtocolError('PROVIDER_INVALID');
    }
    const now = this.#clock.now();
    if (result.expiresAt <= now) return;
    const stateDigest = await this.#digest(material.state);
    const existing = await this.#attempts.read(stateDigest);
    if (existing) {
      if (existing.sessionId !== result.connectSessionId
        || existing.provider !== session.provider
        || existing.stepRevision !== result.stepRevision
        || existing.redirectUri !== material.redirectUri
        || existing.issuer !== url.origin
        || existing.codeChallenge !== material.codeChallenge) {
        throw new ProtocolError('DURABILITY_ERROR');
      }
      return;
    }
    const cap = later(now, this.#ttlMs);
    await this.#attempts.insert({
      stateDigest,
      sessionId: result.connectSessionId,
      provider: session.provider,
      stepRevision: result.stepRevision,
      redirectUri: material.redirectUri,
      issuer: url.origin,
      codeChallenge: material.codeChallenge,
      createdAt: now,
      expiresAt: result.expiresAt < cap ? result.expiresAt : cap,
      usedAt: null,
    });
  }

  /**
   * Handle one `GET /oauth/callback/<provider>`.
   *
   * Authentication is deliberately absent: the browser holds no deployment
   * bearer. Ownership is proven by the unguessable single-use state, and the
   * response carries no business data.
   */
  async handle(request: Request, provider: string): Promise<Response> {
    try {
      return await this.#route(request, provider);
    } catch {
      // A transport failure answers with a constant page and no diagnostics.
      return page(500, 'Callback rejected.');
    }
  }

  async #route(request: Request, provider: string): Promise<Response> {
    const inspected = inspectOAuthCallback(request, provider, {
      publicOrigin: this.#origin,
      providers: [...this.#providers],
      ttlMs: this.#ttlMs,
    });
    if (inspected instanceof Response) return inspected;
    const { state, code } = inspected;
    const now = this.#clock.now();
    const stateDigest = await this.#digest(state);
    const attempt = await this.#attempts.read(stateDigest);
    if (!attempt) return page(404, 'Callback rejected.');
    if (attempt.provider !== provider) return page(409, 'Callback rejected.');
    if (attempt.expiresAt <= now) return page(400, 'Callback rejected.');
    const session = await this.#state.getConnectSession(attempt.sessionId, this.#principalId);
    if (!session || session.status !== 'awaiting'
      || session.stepRevision !== attempt.stepRevision || session.expiresAt <= now) {
      return page(409, 'Callback rejected.');
    }
    const claim = await this.#attempts.claim(stateDigest, now);
    if (claim === 'used') return page(409, 'Callback rejected.');
    if (claim !== 'claimed') return page(400, 'Callback rejected.');
    // The state reached this deployment for this provider; the authorization
    // server identity is the origin the browser was actually sent to.
    const evidence: T.CallbackEvidence = {
      code,
      state,
      issuer: attempt.issuer,
      redirectUri: attempt.redirectUri,
    };
    let stage: T.SecretStage;
    try {
      stage = await this.#credentials.put({
        creationId: this.#entropy.id('cb'),
        owner: { kind: 'callback', ownerId: attempt.sessionId, version: attempt.stepRevision },
        value: evidence as unknown as T.JsonObject,
      });
    } catch {
      await this.#attempts.release(stateDigest, now);
      return page(500, 'Callback rejected.');
    }
    try {
      const accepted = await this.#state.acceptCallback({
        sessionId: attempt.sessionId,
        expectedStepRevision: attempt.stepRevision,
        callbackDigest: await this.#digest(canonicalJson(evidence as unknown as T.Json)),
        evidence: stage,
        now,
      });
      if (accepted.type === 'applied' || accepted.type === 'replay') {
        return page(200, 'Syndroo authorization completed. You can return to the client.');
      }
      await this.#discard(stage);
      await this.#attempts.release(stateDigest, now);
      return page(409, 'Callback rejected.');
    } catch (error) {
      const definitelyUnaccepted = error instanceof ProtocolError
        && (error.code === 'CONNECT_STEP_CONFLICT' || error.code === 'STALE_BINDING');
      if (!definitelyUnaccepted) return page(500, 'Callback rejected.');
      await this.#discard(stage);
      await this.#attempts.release(stateDigest, now);
      if (error.code === 'CONNECT_STEP_CONFLICT') return page(409, 'Callback rejected.');
      return page(500, 'Callback rejected.');
    }
  }

  /** Best-effort cleanup of a staged secret that no session referenced. */
  async #discard(stage: T.SecretStage): Promise<void> {
    try {
      const retired = await this.#state.retireUnreferenced(stage);
      if (retired) await this.#credentials.delete({ stage, unreferencedProof: retired.proof });
    } catch { /* Cleanup never replaces the caller's outcome. */
    }
  }
}
