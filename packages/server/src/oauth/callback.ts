import { createHash, createHmac, randomBytes } from 'node:crypto';
import { canonicalJson, ProtocolError } from '@syndroo/core';
import type * as T from '@syndroo/core';

import type { Database } from '../state/database.js';

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
export function normalizeOAuthConfig(value: unknown): { publicOrigin: string; providers: readonly string[]; ttlMs: number } | null {
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
  database: Database;
  state: T.StateStore;
  credentials: T.CredentialStore;
  clock: T.Clock;
  entropy: T.Entropy;
  principalId: string;
  /** Deployment-scoped key material; a dedicated subkey is derived from it. */
  key: Uint8Array;
};

type Draft = {
  provider: string;
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  redirectUri: string;
};

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function later(now: string, milliseconds: number): string {
  return new Date(Date.parse(now) + milliseconds).toISOString();
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
  readonly #database: Database;
  readonly #state: T.StateStore;
  readonly #credentials: T.CredentialStore;
  readonly #clock: T.Clock;
  readonly #entropy: T.Entropy;
  readonly #principalId: string;
  readonly #digestKey: Buffer;
  readonly #origin: string;
  readonly #providers: ReadonlySet<string>;
  readonly #ttlMs: number;
  readonly #drafts = new WeakMap<AbortSignal, Draft>();

  constructor(
    config: { publicOrigin: string; providers: readonly string[]; ttlMs: number },
    deps: OAuthCallbackDependencies,
  ) {
    if (!deps || typeof deps.principalId !== 'string' || !deps.principalId
      || !(deps.key instanceof Uint8Array)
      || !deps.database?.oauthAttempts || !deps.state || !deps.credentials
      || typeof deps.clock?.now !== 'function' || typeof deps.entropy?.id !== 'function') invalid();
    this.#database = deps.database;
    this.#state = deps.state;
    this.#credentials = deps.credentials;
    this.#clock = deps.clock;
    this.#entropy = deps.entropy;
    this.#principalId = deps.principalId;
    this.#digestKey = createHmac('sha256', Buffer.from(deps.key)).update('syndroo-oauth-digest-v1').digest();
    this.#origin = config.publicOrigin;
    this.#providers = new Set(config.providers);
    this.#ttlMs = config.ttlMs;
  }

  supports(provider: string): boolean {
    return this.#providers.has(provider);
  }

  #digest(value: string): string {
    return createHmac('sha256', this.#digestKey).update(value, 'utf8').digest('hex');
  }

  #redirectUri(provider: string): string {
    return `${this.#origin}${CALLBACK_PATH}${provider}`;
  }

  /**
   * Run one connect call with this adapter's transport behavior.
   *
   * Only `start` calls for a configured provider are armed with fresh state and
   * S256 PKCE material, and only an `open_url` outcome durably records an
   * attempt. Every other call is delegated untouched, so a provider that is not
   * configured for the callback route keeps its own audited behavior instead of
   * receiving half-supported OAuth.
   */
  async runStart(
    request: T.ConnectRequest,
    signal: AbortSignal,
    run: () => Promise<T.ConnectResult>,
  ): Promise<T.ConnectResult> {
    if (request.type !== 'start' || !this.supports(request.provider)
      || !(signal instanceof AbortSignal)) return run();
    const draft = this.#arm(request.provider, signal);
    try {
      const result = await run();
      this.record(draft, result);
      return result;
    } finally {
      this.#drafts.delete(signal);
    }
  }

  #arm(provider: T.ProviderId, signal: AbortSignal): Draft {
    const verifier = base64url(randomBytes(32));
    const draft: Draft = {
      provider,
      state: base64url(randomBytes(32)),
      codeVerifier: verifier,
      codeChallenge: base64url(createHash('sha256').update(verifier, 'utf8').digest()),
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

  /** Record the attempt after Core reserved the session. */
  record(draft: Draft, result: T.ConnectResult): void {
    if (result.status !== 'action_required' || result.action.type !== 'open_url') return;
    let url: URL;
    try { url = new URL(result.action.url); } catch { return; }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return;
    const now = this.#clock.now();
    const cap = later(now, this.#ttlMs);
    this.#database.oauthAttempts.insert({
      stateDigest: this.#digest(draft.state),
      sessionId: result.connectSessionId,
      provider: draft.provider,
      stepRevision: result.stepRevision,
      redirectUri: draft.redirectUri,
      issuer: url.origin,
      codeChallenge: draft.codeChallenge,
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
    if (request.method !== 'GET') return page(405, 'Callback rejected.', 'GET');
    if (!this.supports(provider)) return page(404, 'Callback rejected.');
    let url: URL;
    try { url = new URL(request.url); } catch { return page(400, 'Callback rejected.'); }
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
    const now = this.#clock.now();
    const stateDigest = this.#digest(state);
    const attempt = this.#database.oauthAttempts.read(stateDigest);
    if (!attempt) return page(404, 'Callback rejected.');
    if (attempt.provider !== provider) return page(409, 'Callback rejected.');
    if (attempt.expiresAt <= now) return page(400, 'Callback rejected.');
    const session = await this.#state.getConnectSession(attempt.sessionId, this.#principalId);
    if (!session || session.status !== 'awaiting'
      || session.stepRevision !== attempt.stepRevision || session.expiresAt <= now) {
      return page(409, 'Callback rejected.');
    }
    const claim = this.#database.oauthAttempts.claim(stateDigest, now);
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
      this.#database.oauthAttempts.release(stateDigest, now);
      return page(500, 'Callback rejected.');
    }
    try {
      const accepted = await this.#state.acceptCallback({
        sessionId: attempt.sessionId,
        expectedStepRevision: attempt.stepRevision,
        callbackDigest: this.#digest(canonicalJson(evidence as unknown as T.Json)),
        evidence: stage,
        now,
      });
      if (accepted.type === 'applied' || accepted.type === 'replay') {
        return page(200, 'Syndroo authorization completed. You can return to the client.');
      }
      await this.#discard(stage);
      this.#database.oauthAttempts.release(stateDigest, now);
      return page(409, 'Callback rejected.');
    } catch (error) {
      await this.#discard(stage);
      this.#database.oauthAttempts.release(stateDigest, now);
      if (error instanceof ProtocolError && error.code === 'CONNECT_STEP_CONFLICT') {
        return page(409, 'Callback rejected.');
      }
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
