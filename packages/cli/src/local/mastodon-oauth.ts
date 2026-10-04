/**
 * R3 A2 bounded local Mastodon OAuth.
 *
 * This engine owns one authorization flow and nothing else: no state files, no
 * store, no publication lock, no credential writes. It returns the user access
 * token candidate in memory; A1 decides whether to save it after
 * `verify_credentials` proves the token belongs to a real account.
 *
 * Flow shape:
 *   1. normalize the instance origin;
 *   2. read the instance OAuth metadata through the safe transport and require
 *      S256, a matching issuer, and same-origin HTTPS endpoints;
 *   3. ask the caller to confirm the remote app registration;
 *   4. open a one-shot loopback callback on 127.0.0.1:0 with a >=128-bit path,
 *      >=256-bit state, and >=256-bit PKCE verifier (S256);
 *   5. register a fresh per-flow app with the exact redirect URI;
 *   6. launch the system browser without a shell and wait, bounded, for exactly
 *      one valid callback;
 *   7. exchange the code once, with the same redirect URI and verifier.
 *
 * The whole flow shares one deadline (default five minutes) and one abort path
 * (caller signal, SIGINT, or SIGTERM). Every exit path closes the listener,
 * destroys its sockets, clears the timer, and removes the signal/abort
 * listeners. Failures are static and never carry a URL, state, code, verifier,
 * token, or client secret.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import {
  SafeInstanceTransportError,
  createSafeInstanceFetch,
  normalizeInstanceOrigin,
} from "./http/safe-instance-transport.js";

/** The only scopes this flow requests: identity read plus status publish. */
export const MASTODON_OAUTH_SCOPES = ["read:accounts", "write:statuses"] as const;

const DEFAULT_TIMEOUT_MS = 300_000;
const BROWSER_WAIT_MS = 10_000;
const CALLBACK_PATH_BYTES = 16;
const STATE_BYTES = 32;
const VERIFIER_BYTES = 32;
const CLIENT_NAME = "Syndroo CLI (local)";

const SUCCESS_PAGE = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8"><title>Syndroo</title></head>',
  "<body><p>Syndroo received the authorization response. You can close this window and return to the terminal.</p></body></html>",
].join("");

const DENIED_PAGE = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8"><title>Syndroo</title></head>',
  "<body><p>Syndroo authorization was not completed. Return to the terminal for the next step.</p></body></html>",
].join("");

const ERROR_PAGE = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8"><title>Syndroo</title></head>',
  "<body><p>Syndroo could not use this callback. Return to the terminal and try again.</p></body></html>",
].join("");

export type MastodonOAuthFailure =
  | "invalid_instance"
  | "unsupported_instance"
  | "denied"
  | "browser_unavailable"
  | "callback_unavailable"
  | "registration_failed"
  | "token_exchange_failed"
  | "timeout"
  | "aborted"
  | "interrupted"
  | "protocol_error";

/** Static messages only: no URL, state, code, verifier, token, or secret. */
const FAILURE_MESSAGES: Record<MastodonOAuthFailure, string> = {
  invalid_instance: "instance must be a plain https origin on port 443",
  unsupported_instance:
    "this instance does not advertise a supported local OAuth flow; create a user access token in the instance settings and import it with the BYO token option instead",
  denied: "instance authorization was not confirmed",
  browser_unavailable:
    "could not open a local browser; run this connection on the machine with the browser and a local loopback callback, or import a user access token instead",
  callback_unavailable: "could not start the local loopback callback listener",
  registration_failed: "instance app registration failed",
  token_exchange_failed: "instance token exchange failed",
  timeout: "instance authorization timed out",
  aborted: "instance authorization was aborted",
  interrupted: "instance authorization was interrupted by a signal",
  protocol_error: "instance authorization failed",
};

export class MastodonOAuthError extends Error {
  readonly code: MastodonOAuthFailure;

  constructor(code: MastodonOAuthFailure) {
    super(FAILURE_MESSAGES[code]);
    this.name = "MastodonOAuthError";
    this.code = code;
  }
}

function failure(code: MastodonOAuthFailure): MastodonOAuthError {
  return new MastodonOAuthError(code);
}

/**
 * Converts anything that is not already a static OAuth error into one, so an
 * injected or unexpected throw cannot echo a URL, header, or token.
 */
function toStaticError(error: unknown): MastodonOAuthError {
  if (error instanceof MastodonOAuthError) {
    return error;
  }

  if (error instanceof SafeInstanceTransportError) {
    switch (error.code) {
      case "timeout":
        return failure("timeout");
      case "aborted":
        return failure("aborted");
      case "invalid_origin":
      case "invalid_request_url":
      case "non_public_address":
      case "dns_resolution_failed":
        return failure("unsupported_instance");
      default:
        return failure("protocol_error");
    }
  }

  return failure("protocol_error");
}

export interface MastodonOAuthPreview {
  readonly instance: string;
  readonly scopes: readonly string[];
}

export interface MastodonOAuthCredentials {
  readonly provider: "mastodon";
  readonly instance: string;
  readonly accessToken: string;
}

export interface MastodonOAuthResult {
  readonly credentials: MastodonOAuthCredentials;
  readonly scopes: readonly string[];
}

export interface MastodonOAuthOptions {
  readonly instance: string;
  readonly signal: AbortSignal;
  /**
   * Runs before `POST /api/v1/apps`. Returning false cancels the flow without
   * any registration request. The preview names the instance and the exact
   * scopes; the caller renders the remote-effect explanation.
   */
  readonly confirmRegistration: (preview: MastodonOAuthPreview) => Promise<boolean>;
  /** Test seam. Default launches `open` (macOS) or `xdg-open` (Linux). */
  readonly openBrowser?: (url: string) => Promise<void>;
  /** Test seam. Default is the accepted safe instance transport. */
  readonly fetch?: typeof fetch;
  /** Test seam. Default is the five-minute design budget. */
  readonly timeoutMs?: number;
  /** Test seam for deterministic random material. */
  readonly randomBytes?: (size: number) => Uint8Array;
  /** Test seam for the explicit callback expiry check. */
  readonly now?: () => number;
}

function guard<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort: () => MastodonOAuthError,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      signal.removeEventListener("abort", handleAbort);
      action();
    };

    const handleAbort = (): void => {
      finish(() => reject(onAbort()));
    };

    // Attach the rejection handler before the abort check: a promise that is
    // already rejected when the signal is already aborted must never surface as
    // an unhandled rejection.
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );

    if (signal.aborted) {
      handleAbort();
      return;
    }

    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");

  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scopeList(value: unknown): readonly string[] | null {
  if (typeof value === "string") {
    return value.split(/\s+/).filter(part => part !== "");
  }

  if (Array.isArray(value) && value.every(entry => typeof entry === "string")) {
    return value as readonly string[];
  }

  return null;
}

function scopeIncludes(value: unknown, required: readonly string[]): boolean {
  const granted = scopeList(value);
  return granted !== null && required.every(scope => granted.includes(scope));
}

async function readJson(
  response: Response,
  code: MastodonOAuthFailure,
  signal: AbortSignal,
  onAbort: () => MastodonOAuthError,
): Promise<unknown> {
  if (!response.ok) {
    throw failure(code);
  }

  try {
    return await guard(response.json(), signal, onAbort);
  } catch (error) {
    if (error instanceof MastodonOAuthError) {
      throw error;
    }

    throw failure(code);
  }
}

interface MastodonMetadata {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function sameOriginEndpoint(value: unknown, origin: string): string {
  if (typeof value !== "string" || value === "") {
    throw failure("unsupported_instance");
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw failure("unsupported_instance");
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.origin !== origin
  ) {
    throw failure("unsupported_instance");
  }

  return url.toString();
}

function validateMetadata(document: unknown, origin: string): MastodonMetadata {
  if (!isRecord(document)) {
    throw failure("unsupported_instance");
  }

  const methods = document["code_challenge_methods_supported"];

  if (!Array.isArray(methods) || !methods.includes("S256")) {
    throw failure("unsupported_instance");
  }

  const issuer = document["issuer"];

  if (issuer !== undefined && issuer !== origin) {
    throw failure("unsupported_instance");
  }

  const grants = document["grant_types_supported"];

  if (grants !== undefined && (!Array.isArray(grants) || !grants.includes("authorization_code"))) {
    throw failure("unsupported_instance");
  }

  const responses = document["response_types_supported"];

  if (responses !== undefined && (!Array.isArray(responses) || !responses.includes("code"))) {
    throw failure("unsupported_instance");
  }

  return {
    authorizationEndpoint: sameOriginEndpoint(document["authorization_endpoint"], origin),
    tokenEndpoint: sameOriginEndpoint(document["token_endpoint"], origin),
  };
}

async function readMetadata(
  origin: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  onAbort: () => MastodonOAuthError,
): Promise<MastodonMetadata> {
  const response = await guard(
    fetchImpl(`${origin}/.well-known/oauth-authorization-server`, {
      headers: { accept: "application/json" },
      signal,
    }),
    signal,
    onAbort,
  );

  const document = await readJson(response, "unsupported_instance", signal, onAbort);

  return validateMetadata(document, origin);
}

/**
 * Design §4.3 step 1: the instance capability document is read, unauthenticated,
 * before the user is asked to confirm a remote app registration. A missing or
 * malformed limit means the instance is not supported, so the flow stops before
 * any application record is created.
 */
async function readInstanceCapabilities(
  origin: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  onAbort: () => MastodonOAuthError,
): Promise<void> {
  const response = await guard(
    fetchImpl(`${origin}/api/v2/instance`, {
      headers: { accept: "application/json" },
      signal,
    }),
    signal,
    onAbort,
  );

  const document = await readJson(response, "unsupported_instance", signal, onAbort);

  if (!isRecord(document)) {
    throw failure("unsupported_instance");
  }

  const configuration = document["configuration"];
  const statuses = isRecord(configuration) ? configuration["statuses"] : undefined;

  if (!isRecord(statuses)) {
    throw failure("unsupported_instance");
  }

  if (
    positiveSafeInteger(statuses["max_characters"]) === null ||
    positiveSafeInteger(statuses["characters_reserved_per_url"]) === null
  ) {
    throw failure("unsupported_instance");
  }
}

interface RegisteredApplication {
  readonly clientId: string;
  readonly clientSecret: string;
}

async function registerApplication(
  origin: string,
  redirectUri: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  onAbort: () => MastodonOAuthError,
): Promise<RegisteredApplication> {
  const response = await guard(
    fetchImpl(`${origin}/api/v1/apps`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: redirectUri,
        scopes: MASTODON_OAUTH_SCOPES.join(" "),
      }),
      signal,
    }),
    signal,
    onAbort,
  );

  const document = await readJson(response, "registration_failed", signal, onAbort);

  if (!isRecord(document)) {
    throw failure("registration_failed");
  }

  const clientId = document["client_id"];
  const clientSecret = document["client_secret"];

  if (typeof clientId !== "string" || clientId === "" || typeof clientSecret !== "string" || clientSecret === "") {
    throw failure("registration_failed");
  }

  const returnedRedirect = document["redirect_uri"];

  if (returnedRedirect !== undefined && returnedRedirect !== redirectUri) {
    throw failure("registration_failed");
  }

  const returnedScopes = document["scopes"];

  if (returnedScopes !== undefined && !scopeIncludes(returnedScopes, MASTODON_OAUTH_SCOPES)) {
    throw failure("registration_failed");
  }

  return { clientId, clientSecret };
}

interface TokenResult {
  readonly accessToken: string;
  readonly scopes: readonly string[];
}

async function exchangeCode(
  tokenEndpoint: string,
  input: {
    readonly code: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly verifier: string;
  },
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  onAbort: () => MastodonOAuthError,
): Promise<TokenResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });

  const response = await guard(
    fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body,
      signal,
    }),
    signal,
    onAbort,
  );

  const document = await readJson(response, "token_exchange_failed", signal, onAbort);

  if (!isRecord(document)) {
    throw failure("token_exchange_failed");
  }

  const accessToken = document["access_token"];
  const tokenType = document["token_type"];

  if (typeof accessToken !== "string" || accessToken === "") {
    throw failure("token_exchange_failed");
  }

  if (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer") {
    throw failure("token_exchange_failed");
  }

  const granted = document["scope"];

  if (granted === undefined) {
    return { accessToken, scopes: [...MASTODON_OAUTH_SCOPES] };
  }

  if (!scopeIncludes(granted, MASTODON_OAUTH_SCOPES)) {
    throw failure("token_exchange_failed");
  }

  return { accessToken, scopes: scopeList(granted) ?? [...MASTODON_OAUTH_SCOPES] };
}

type CallbackOutcome =
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "denied" }
  | { readonly kind: "expired" };

interface CallbackLifecycle {
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly expiresAt: number;
  readonly onAbort: () => MastodonOAuthError;
}

interface CallbackListener {
  readonly redirectUri: string;
  readonly state: string;
  readonly verifier: string;
  readonly challenge: string;
  waitForCallback(): Promise<CallbackOutcome>;
  close(): Promise<void>;
}

async function startCallbackListener(
  random: (size: number) => Uint8Array,
  lifecycle: CallbackLifecycle,
): Promise<CallbackListener> {
  const pathSegment = base64url(random(CALLBACK_PATH_BYTES));
  const callbackPath = `/${pathSegment}`;
  const state = base64url(random(STATE_BYTES));
  const verifier = base64url(random(VERIFIER_BYTES));
  const challenge = base64url(createHash("sha256").update(verifier, "ascii").digest());

  const sockets = new Set<Socket>();
  let boundPort = 0;
  let consumed = false;
  let settled = false;
  let resolveOutcome: (outcome: CallbackOutcome) => void = () => undefined;

  const outcome = new Promise<CallbackOutcome>(resolve => {
    resolveOutcome = resolve;
  });

  const settle = (value: CallbackOutcome): void => {
    if (settled) {
      return;
    }

    settled = true;
    resolveOutcome(value);
  };

  const respond = (response: ServerResponse, status: number, body: string): void => {
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  };

  const fail = (response: ServerResponse): void => {
    try {
      if (!response.headersSent) {
        respond(response, 400, ERROR_PAGE);
        return;
      }
    } catch {
      // Fall through and destroy the socket.
    }

    response.destroy();
  };

  const route = (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method !== "GET") {
      respond(response, 405, ERROR_PAGE);
      return;
    }

    if (request.headers.host !== `127.0.0.1:${boundPort}`) {
      respond(response, 400, ERROR_PAGE);
      return;
    }

    // Origin-form only. Absolute-form (`http://host/...`) and scheme-relative
    // (`//host/...`) targets are refused before any parsing, so a hostile
    // request cannot steer the listener or reach the URL parser.
    const target = request.url ?? "";

    if (!target.startsWith("/") || target.startsWith("//")) {
      respond(response, 400, ERROR_PAGE);
      return;
    }

    // Fragments and backslashes are never valid in a request-target and can
    // smuggle a path that only looks exact after URL normalization.
    if (target.includes("\\") || target.includes("#")) {
      respond(response, 400, ERROR_PAGE);
      return;
    }

    const queryIndex = target.indexOf("?");
    const rawPath = queryIndex === -1 ? target : target.slice(0, queryIndex);

    // Exact raw path first: `/x/../<random>` must not count as `<random>`.
    if (rawPath !== callbackPath) {
      respond(response, 400, ERROR_PAGE);
      return;
    }

    let url: URL;

    try {
      url = new URL(target, "http://127.0.0.1");
    } catch {
      respond(response, 400, ERROR_PAGE);
      return;
    }

    if (url.pathname !== callbackPath) {
      respond(response, 400, ERROR_PAGE);
      return;
    }

    // Explicit lifecycle checks: the handler does not depend on the timer
    // having fired, and never consumes a callback after abort or expiry.
    if (lifecycle.signal.aborted) {
      respond(response, 410, ERROR_PAGE);
      return;
    }

    if (lifecycle.now() >= lifecycle.expiresAt) {
      respond(response, 410, ERROR_PAGE);
      settle({ kind: "expired" });
      return;
    }

    const counts = new Map<string, number>();

    for (const key of url.searchParams.keys()) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    if ([...counts.values()].some(count => count > 1)) {
      respond(response, 400, ERROR_PAGE);
      return;
    }

    const states = url.searchParams.getAll("state");

    // State is checked before any outcome: a forged or replayed callback can
    // never cancel the flow, and a mismatched state never reaches the exchange.
    if (states.length !== 1 || !safeEqual(states[0]!, state)) {
      respond(response, 400, ERROR_PAGE);
      return;
    }

    if (consumed) {
      respond(response, 409, ERROR_PAGE);
      return;
    }

    const errors = url.searchParams.getAll("error");
    const codes = url.searchParams.getAll("code");

    // Simultaneous success and error parameters are never a valid callback, and
    // the request must not be consumed.
    if (errors.length > 0 && codes.length > 0) {
      respond(response, 400, ERROR_PAGE);
      return;
    }

    if (errors.length === 1) {
      consumed = true;
      respond(response, 200, DENIED_PAGE);
      settle({ kind: "denied" });
      return;
    }

    if (codes.length !== 1 || codes[0] === "") {
      respond(response, 400, ERROR_PAGE);
      return;
    }

    consumed = true;
    respond(response, 200, SUCCESS_PAGE);
    settle({ kind: "code", code: codes[0]! });
  };

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    try {
      route(request, response);
    } catch {
      // A malformed request-target must never escape as an uncaught exception
      // or echo the raw target; answer with the static error page.
      fail(response);
    }
  };

  const server: Server = createServer(handle);

  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const closeServer = async (): Promise<void> => {
    for (const socket of sockets) {
      socket.destroy();
    }

    sockets.clear();

    await new Promise<void>(resolve => {
      if (!server.listening) {
        resolve();
        return;
      }

      server.close(() => resolve());
    });
  };

  await new Promise<void>((resolve, reject) => {
    let settledListen = false;

    const finish = (action: () => void): void => {
      if (settledListen) {
        return;
      }

      settledListen = true;
      lifecycle.signal.removeEventListener("abort", handleAbort);
      action();
    };

    const handleAbort = (): void => {
      if (server.listening) {
        server.close(() => undefined);
      }

      finish(() => reject(lifecycle.onAbort()));
    };

    const onError = (): void => {
      server.removeListener("listening", onListening);
      finish(() => reject(failure("callback_unavailable")));
    };

    const onListening = (): void => {
      server.removeListener("error", onError);

      // Abort-aware initialization: a listener that finishes binding after the
      // flow was aborted closes itself instead of leaking.
      if (lifecycle.signal.aborted) {
        server.close(() => undefined);
        finish(() => reject(lifecycle.onAbort()));
        return;
      }

      finish(resolve);
    };

    lifecycle.signal.addEventListener("abort", handleAbort, { once: true });
    server.once("error", onError);
    server.once("listening", onListening);

    if (lifecycle.signal.aborted) {
      handleAbort();
      return;
    }

    try {
      server.listen(0, "127.0.0.1");
    } catch {
      finish(() => reject(failure("callback_unavailable")));
    }
  });

  if (lifecycle.signal.aborted) {
    await closeServer();
    throw lifecycle.onAbort();
  }

  const address = server.address();

  if (address === null || typeof address === "string") {
    await closeServer();
    throw failure("callback_unavailable");
  }

  boundPort = address.port;

  return {
    redirectUri: `http://127.0.0.1:${boundPort}${callbackPath}`,
    state,
    verifier,
    challenge,
    waitForCallback: () => outcome,
    close: closeServer,
  };
}

async function defaultOpenBrowser(url: string, signal: AbortSignal): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;

  if (command === null) {
    throw failure("browser_unavailable");
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      action();
    };

    // Abort kills only the launcher helper; a browser the helper already
    // opened is not ours to close.
    const onAbort = (): void => {
      child.kill("SIGTERM");
      finish(() => reject(failure("aborted")));
    };

    const child = spawn(command, [url], { stdio: "ignore", shell: false });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(failure("browser_unavailable")));
    }, BROWSER_WAIT_MS);

    child.once("error", () => finish(() => reject(failure("browser_unavailable"))));
    child.once("exit", code => {
      if (code === 0) {
        finish(resolve);
      } else {
        finish(() => reject(failure("browser_unavailable")));
      }
    });

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A browser launch failure is always the same static, actionable error; the
 * underlying spawn error may carry the URL and must not escape.
 */
async function launchBrowser(openBrowser: (url: string) => Promise<void>, url: string): Promise<void> {
  try {
    await openBrowser(url);
  } catch {
    throw failure("browser_unavailable");
  }
}

function buildAuthorizeUrl(
  authorizationEndpoint: string,
  input: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly challenge: string;
  },
): string {
  const url = new URL(authorizationEndpoint);

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", MASTODON_OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return url.toString();
}

export async function authorizeMastodon(options: MastodonOAuthOptions): Promise<MastodonOAuthResult> {
  let origin: string;

  try {
    origin = normalizeInstanceOrigin(options.instance);
  } catch {
    throw failure("invalid_instance");
  }

  const internal = new AbortController();
  let timedOut = false;
  let interrupted: NodeJS.Signals | null = null;

  const abortFailure = (): MastodonOAuthError =>
    failure(interrupted !== null ? "interrupted" : timedOut ? "timeout" : "aborted");

  const fetchImpl = options.fetch ?? createSafeInstanceFetch();
  const random = options.randomBytes ?? randomBytes;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const expiresAt = now() + timeoutMs;
  const openBrowser = options.openBrowser ?? ((url: string) => defaultOpenBrowser(url, internal.signal));

  const onCallerAbort = (): void => {
    internal.abort();
  };

  const processHandlers: Array<readonly [NodeJS.Signals, () => void]> = [];
  let listener: CallbackListener | null = null;
  let timer: NodeJS.Timeout | null = null;

  try {
    if (options.signal.aborted) {
      throw failure("aborted");
    }

    options.signal.addEventListener("abort", onCallerAbort, { once: true });

    // A signal must interrupt this flow, not the whole process: the handlers
    // live only for the duration of the flow and are removed in `finally`.
    for (const name of ["SIGINT", "SIGTERM"] as const) {
      const handler = (): void => {
        interrupted = name;
        internal.abort();
      };

      process.on(name, handler);
      processHandlers.push([name, handler]);
    }

    timer = setTimeout(() => {
      timedOut = true;
      internal.abort();
    }, timeoutMs);

    const metadata = await readMetadata(origin, fetchImpl, internal.signal, abortFailure);
    await readInstanceCapabilities(origin, fetchImpl, internal.signal, abortFailure);

    const approved = await guard(
      options.confirmRegistration({ instance: origin, scopes: [...MASTODON_OAUTH_SCOPES] }),
      internal.signal,
      abortFailure,
    );

    if (!approved) {
      throw failure("denied");
    }

    if (internal.signal.aborted) {
      throw abortFailure();
    }

    listener = await startCallbackListener(random, {
      signal: internal.signal,
      now,
      expiresAt,
      onAbort: abortFailure,
    });

    if (internal.signal.aborted) {
      throw abortFailure();
    }

    const application = await registerApplication(
      origin,
      listener.redirectUri,
      fetchImpl,
      internal.signal,
      abortFailure,
    );

    const authorizeUrl = buildAuthorizeUrl(metadata.authorizationEndpoint, {
      clientId: application.clientId,
      redirectUri: listener.redirectUri,
      state: listener.state,
      challenge: listener.challenge,
    });

    await guard(launchBrowser(openBrowser, authorizeUrl), internal.signal, abortFailure);

    const outcome = await guard(listener.waitForCallback(), internal.signal, abortFailure);

    if (outcome.kind === "expired") {
      throw failure("timeout");
    }

    if (outcome.kind === "denied") {
      throw failure("denied");
    }

    const token = await exchangeCode(
      metadata.tokenEndpoint,
      {
        code: outcome.code,
        clientId: application.clientId,
        clientSecret: application.clientSecret,
        redirectUri: listener.redirectUri,
        verifier: listener.verifier,
      },
      fetchImpl,
      internal.signal,
      abortFailure,
    );

    return {
      credentials: { provider: "mastodon", instance: origin, accessToken: token.accessToken },
      scopes: token.scopes,
    };
  } catch (error) {
    throw toStaticError(error);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }

    options.signal.removeEventListener("abort", onCallerAbort);

    for (const [name, handler] of processHandlers) {
      process.removeListener(name, handler);
    }

    if (listener !== null) {
      await listener.close();
    }
  }
}
