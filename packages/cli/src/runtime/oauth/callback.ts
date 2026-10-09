import { createHash, randomBytes } from "node:crypto";

import { canonicalJson } from "@syndroo/core";
import type * as T from "@syndroo/core";

import { FilesystemOAuthAttempts, type OAuthAttempt } from "./attempts.js";
import { OAuthError } from "./errors.js";
import {
  defaultRedirectUri,
  parseCallbackUrl,
  parseRedirectUri,
  type RedirectTarget,
} from "./redirect.js";

/**
 * The local (CLI) browser callback adapter.
 *
 * It mirrors the self-hosted server module's security model and shares nothing
 * with it at runtime: the adapter arms the OAuth step with its own high-entropy
 * `state` (plus S256 PKCE where the provider supports it), records a durable
 * single-use attempt keyed by a digest of that state, and turns one verified
 * redirect into stored callback evidence.
 *
 * It never proves that a provider exchange happened. `callback_complete` stays
 * a status query: the exchange runs because evidence this adapter staged is on
 * the session, and Core's step CAS decides whether it runs at all.
 */

/** The official providers whose connect step needs a registered redirect URI. */
export const DEFAULT_OAUTH_PROVIDERS = ["linkedin", "threads", "mastodon"] as const;

/** Default lifetime of one attempt, matching the server module's ceiling. */
export const DEFAULT_ATTEMPT_TTL_MS = 900_000;
export const MAX_ATTEMPT_TTL_MS = 900_000;

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
/** Printable ASCII only: an authorization code is opaque transport data. */
const CODE = /^[\x21-\x7e]{1,2048}$/;
/** The adapter's own 32-byte base64url state, and nothing looser. */
const STATE = /^[A-Za-z0-9._~-]{16,512}$/;
const ALLOWED_PARAMS = ["code", "state", "error", "error_description", "scope"] as const;

export type CallbackOutcome = {
  readonly ok: boolean;
  /** Stable code; never carries a state, code, verifier or path. */
  readonly code: string;
  /**
   * The session a verified redirect was accepted for.
   *
   * Present only on success, so a caller that was handed a redirect URL out of
   * band can resume exactly that step. It is the same `connectSessionId` and
   * `stepRevision` the envelope already prints, so it is not a new disclosure.
   */
  readonly session?: { readonly sessionId: string; readonly stepRevision: number };
};

export type ArmedDraft = {
  readonly provider: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
};

export type LocalOAuthCallbackOptions = {
  readonly stateRoot: string;
  readonly state: T.StateStore;
  readonly credentials: T.CredentialStore;
  readonly clock: T.Clock;
  readonly entropy: T.Entropy;
  readonly principalId: string;
  readonly providers?: readonly string[];
  readonly ttlMs?: number;
  readonly loopbackPort?: number;
};

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function later(now: string, milliseconds: number): string {
  return new Date(Date.parse(now) + milliseconds).toISOString();
}

export class LocalOAuthCallback {
  readonly #state: T.StateStore;
  readonly #credentials: T.CredentialStore;
  readonly #clock: T.Clock;
  readonly #entropy: T.Entropy;
  readonly #principalId: string;
  readonly #attempts: FilesystemOAuthAttempts;
  readonly #providers: ReadonlySet<string>;
  readonly #ttlMs: number;
  readonly #loopbackPort: number;
  /**
   * Armed drafts, keyed by the AbortSignal of the call that armed them.
   *
   * A `WeakMap` is deliberate: an armed draft lives no longer than the call it
   * belongs to, and an unarmed signal simply has no entry, so nothing can be
   * decorated from a previous invocation.
   */
  readonly #drafts = new WeakMap<AbortSignal, ArmedDraft>();

  constructor(options: LocalOAuthCallbackOptions) {
    this.#state = options.state;
    this.#credentials = options.credentials;
    this.#clock = options.clock;
    this.#entropy = options.entropy;
    this.#principalId = options.principalId;
    this.#attempts = new FilesystemOAuthAttempts({ stateRoot: options.stateRoot });
    this.#providers = new Set(options.providers ?? DEFAULT_OAUTH_PROVIDERS);
    this.#ttlMs = options.ttlMs ?? DEFAULT_ATTEMPT_TTL_MS;
    this.#loopbackPort = options.loopbackPort ?? 8765;
  }

  /** True when this adapter drives the connect step for `provider`. */
  supports(provider: string): boolean {
    return this.#providers.has(provider);
  }

  /**
   * Classify the redirect URI for one provider.
   *
   * An explicit URI is used exactly as given; the default is the
   * pre-registerable loopback URI for that provider. Anything this adapter
   * cannot verify exactly throws instead of degrading.
   */
  redirectTarget(provider: string, requested?: string): RedirectTarget {
    if (!this.supports(provider)) {
      throw new OAuthError("OAUTH_PROVIDER_UNSUPPORTED");
    }

    return parseRedirectUri(requested ?? defaultRedirectUri(provider, this.#loopbackPort));
  }

  /**
   * Arm one connect `start` with fresh OAuth material.
   *
   * The draft never leaves this process: it is offered to the provider through
   * the decorated context, and only a digest of its state reaches the attempt
   * store.
   */
  arm(input: { readonly provider: T.ProviderId; readonly redirectUri: string; readonly signal: AbortSignal }): ArmedDraft {
    const codeVerifier = base64url(randomBytes(32));
    const draft: ArmedDraft = {
      provider: input.provider,
      state: base64url(randomBytes(32)),
      codeVerifier,
      codeChallenge: base64url(createHash("sha256").update(codeVerifier, "utf8").digest()),
      redirectUri: input.redirectUri,
    };

    this.#drafts.set(input.signal, draft);

    return draft;
  }

  /** True when a draft is armed for this signal and provider. */
  armed(signal: AbortSignal, provider: string): boolean {
    const draft = this.#drafts.get(signal);

    return draft !== undefined && draft.provider === provider;
  }

  /**
   * Add the armed OAuth material to a provider context.
   *
   * A context for any other signal or provider is returned untouched, so a
   * provider that was not armed keeps its own audited behaviour.
   */
  decorateContext(base: T.ProviderContext, provider: string): T.ProviderContext {
    const draft = this.#drafts.get(base.signal);

    if (draft === undefined || draft.provider !== provider) {
      return base;
    }

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

  /**
   * Record the durable attempt once Core has admitted the session.
   *
   * Only an `open_url` action whose URL is an absolute `https:` URL with no
   * credentials and no fragment produces a record; anything else leaves no
   * attempt behind, so a later callback cannot be matched to it.
   */
  async recordIfOpenUrl(draft: ArmedDraft, result: T.ConnectResult): Promise<void> {
    if (result.status !== "action_required" || result.action.type !== "open_url") {
      return;
    }

    let url: URL;

    try {
      url = new URL(result.action.url);
    } catch {
      return;
    }

    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
      return;
    }

    const now = this.#clock.now();
    const cap = later(now, this.#ttlMs);
    const digest = await this.#attempts.digest(draft.state);

    await this.#attempts.create(digest, {
      provider: draft.provider,
      sessionId: result.connectSessionId,
      stepRevision: result.stepRevision,
      redirectUri: draft.redirectUri,
      issuer: url.origin,
      createdAt: now,
      expiresAt: result.expiresAt < cap ? result.expiresAt : cap,
    });
  }

  /** Best-effort removal of expired attempts; never fails a command. */
  async sweep(): Promise<void> {
    await this.#attempts.sweep(this.#clock.now()).catch(() => undefined);
  }

  /**
   * Verify one redirect and, when it is sound, stage evidence and accept it.
   *
   * Every check below refuses on its own, and nothing consumes the single-use
   * claim until the state, provider, expiry and live session have all matched.
   *
   * `expected` pins the session the caller believes it is completing. A caller
   * that started a session passes it, so a redirected URL that belongs to a
   * different session is refused *before* the attempt is claimed and stays
   * available to the caller that owns it. A caller that was handed a URL out of
   * band omits it and recovers the session from the attempt.
   */
  async handleRedirect(
    provider: string,
    rawUrl: string,
    expected?: { readonly sessionId: string; readonly stepRevision: number },
  ): Promise<CallbackOutcome> {
    let url: URL;

    try {
      url = parseCallbackUrl(rawUrl);
    } catch {
      return { ok: false, code: "OAUTH_CALLBACK_REJECTED" };
    }

    if (!this.supports(provider)) {
      return { ok: false, code: "OAUTH_CALLBACK_REJECTED" };
    }

    for (const key of url.searchParams.keys()) {
      if (!(ALLOWED_PARAMS as readonly string[]).includes(key)) {
        return { ok: false, code: "OAUTH_CALLBACK_REJECTED" };
      }
    }

    for (const key of ALLOWED_PARAMS) {
      if (url.searchParams.getAll(key).length > 1) {
        return { ok: false, code: "OAUTH_CALLBACK_REJECTED" };
      }
    }

    // The provider itself refused; that is never a successful connect.
    if (url.searchParams.has("error")) {
      return { ok: false, code: "OAUTH_CALLBACK_REJECTED" };
    }

    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");

    if (state === null || !STATE.test(state) || code === null || !CODE.test(code)) {
      return { ok: false, code: "OAUTH_CALLBACK_REJECTED" };
    }

    let stateDigest: string;

    try {
      stateDigest = await this.#attempts.digest(state);
    } catch {
      return { ok: false, code: "OAUTH_CALLBACK_REJECTED" };
    }

    const attempt = await this.#attempts.read(stateDigest);

    if (attempt === null || attempt.provider !== provider) {
      return { ok: false, code: "OAUTH_CALLBACK_REJECTED" };
    }

    if (!this.#sameRedirect(attempt, url)) {
      return { ok: false, code: "OAUTH_CALLBACK_REJECTED" };
    }

    const now = this.#clock.now();

    if (attempt.expiresAt <= now) {
      return { ok: false, code: "OAUTH_CALLBACK_REJECTED" };
    }

    const session = await this.#state.getConnectSession(attempt.sessionId, this.#principalId);

    if (
      session === null ||
      session.status !== "awaiting" ||
      session.stepRevision !== attempt.stepRevision ||
      session.expiresAt <= now
    ) {
      return { ok: false, code: "OAUTH_CALLBACK_REJECTED" };
    }

    if (
      expected !== undefined &&
      (attempt.sessionId !== expected.sessionId || attempt.stepRevision !== expected.stepRevision)
    ) {
      return { ok: false, code: "OAUTH_CALLBACK_REJECTED" };
    }

    const claim = await this.#attempts.claim(stateDigest);

    if (claim !== "claimed") {
      return { ok: false, code: "OAUTH_CALLBACK_REJECTED" };
    }

    // The state reached this adapter for this provider, so the authorization
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
        creationId: this.#entropy.id("cb"),
        owner: { kind: "callback", ownerId: attempt.sessionId, version: attempt.stepRevision },
        value: evidence as unknown as T.JsonObject,
      });
    } catch {
      await this.#attempts.release(stateDigest);

      return { ok: false, code: "OAUTH_CALLBACK_REJECTED" };
    }

    try {
      const accepted = await this.#state.acceptCallback({
        sessionId: attempt.sessionId,
        expectedStepRevision: attempt.stepRevision,
        callbackDigest: this.#digestEvidence(evidence),
        evidence: stage,
        now,
      });

      if (accepted.type === "applied" || accepted.type === "replay") {
        return {
          ok: true,
          code: "OAUTH_CALLBACK_ACCEPTED",
          session: { sessionId: attempt.sessionId, stepRevision: attempt.stepRevision },
        };
      }
    } catch {
      // Falls through to the shared cleanup below: a rejected callback leaves
      // no staged secret and no consumed claim behind.
    }

    await this.#discard(stage);
    await this.#attempts.release(stateDigest);

    return { ok: false, code: "OAUTH_CALLBACK_REJECTED" };
  }

  /** The evidence digest Core fences one session against. */
  #digestEvidence(evidence: T.CallbackEvidence): string {
    return createHash("sha256")
      .update(canonicalJson(evidence as unknown as T.Json), "utf8")
      .digest("hex");
  }

  /**
   * The callback must arrive at the registered redirect, exactly.
   *
   * Port and path are always compared literally. The host is compared literally
   * for a registered remote URI, and within the loopback class otherwise, so a
   * browser that normalises `localhost` to `127.0.0.1` does not fail a redirect
   * that was registered as loopback.
   */
  #sameRedirect(attempt: OAuthAttempt, incoming: URL): boolean {
    let registered: URL;

    try {
      registered = new URL(attempt.redirectUri);
    } catch {
      return false;
    }

    if (incoming.pathname !== registered.pathname) {
      return false;
    }

    const incomingPort = incoming.port === "" ? defaultPort(incoming.protocol) : incoming.port;
    const registeredPort = registered.port === "" ? defaultPort(registered.protocol) : registered.port;

    if (incomingPort !== registeredPort) {
      return false;
    }

    const incomingHost = bareHost(incoming.hostname);
    const registeredHost = bareHost(registered.hostname);

    if (incomingHost === registeredHost) {
      return true;
    }

    return isLoopback(incomingHost) && isLoopback(registeredHost);
  }

  /** Best-effort cleanup of a staged secret no session referenced. */
  async #discard(stage: T.SecretStage): Promise<void> {
    try {
      const retired = await this.#state.retireUnreferenced(stage);

      if (retired !== null) {
        await this.#credentials.delete({ stage, unreferencedProof: retired.proof });
      }
    } catch {
      /* Cleanup never replaces the caller's outcome. */
    }
  }
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
