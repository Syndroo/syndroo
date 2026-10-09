import { parseStrictJson, ProtocolError } from '@syndroo/core';
import type * as T from '@syndroo/core';

export type Operation = 'connect' | 'publish' | 'status';
export type Authentication = (authorization: string | null) => boolean | Promise<boolean>;
export type HttpHandlerOptions = {
  core: T.Core;
  authenticate: Authentication;
  principalId: string;
  timeoutMs?: number;
  /**
   * Optional browser transport. When present it owns `GET /oauth/callback/*`
   * and receives the request before authentication, because a browser holds no
   * deployment bearer. When absent the path stays a plain 404.
   */
  oauthCallback?: (request: Request, provider: string) => Promise<Response>;
};

const REQUEST_LIMIT = 65_536;
const RESPONSE_LIMIT = 1_048_576;
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const ALLOWED_CODES = new Set([
  'INVALID_INPUT', 'BODY_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'UNAUTHORIZED',
  'FORBIDDEN', 'NOT_FOUND', 'TARGET_AMBIGUOUS', 'DUPLICATE_TARGET',
  'CONNECTION_IDENTITY_CHANGED', 'CONNECTION_CAPACITY', 'PROVIDER_TRUST_REQUIRED',
  'PROVIDER_INVALID', 'PROVIDER_UNAVAILABLE', 'STALE_INTENT', 'STALE_BINDING',
  'APPROVAL_INVALID', 'APPROVAL_EXPIRED', 'IDEMPOTENCY_CONFLICT',
  'REQUEST_IN_PROGRESS', 'RETRY_INELIGIBLE', 'CONNECT_SESSION_EXPIRED',
  'CONNECT_STEP_CONFLICT', 'CONNECT_STEP_UNKNOWN', 'STATE_RECOVERY_REQUIRED',
  'DURABILITY_ERROR', 'OUTCOME_NOT_DURABLE', 'RATE_LIMITED', 'REQUEST_TIMEOUT',
  'CANCELLED', 'RESPONSE_TOO_LARGE', 'METHOD_NOT_ALLOWED',
]);

function statusFor(code: string): number {
  if (code === 'BODY_TOO_LARGE') return 413;
  if (code === 'UNSUPPORTED_MEDIA_TYPE') return 415;
  if (code === 'METHOD_NOT_ALLOWED') return 405;
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'FORBIDDEN' || code === 'PROVIDER_TRUST_REQUIRED') return 403;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'REQUEST_TIMEOUT') return 504;
  if (code === 'PROVIDER_UNAVAILABLE' || code === 'STATE_RECOVERY_REQUIRED') return 503;
  if (code === 'DURABILITY_ERROR' || code === 'OUTCOME_NOT_DURABLE'
    || code === 'CONNECT_STEP_UNKNOWN' || code === 'RESPONSE_TOO_LARGE') return 500;
  if (code === 'INVALID_INPUT' || code === 'PROVIDER_INVALID') return 400;
  return 409;
}

function safeCode(error: unknown): string {
  return error instanceof ProtocolError && ALLOWED_CODES.has(error.code)
    ? error.code : 'DURABILITY_ERROR';
}

function jsonResponse(value: unknown, status: number): Response {
  const text = JSON.stringify(value);
  const body = new TextEncoder().encode(text);
  if (body.byteLength > RESPONSE_LIMIT) {
    return jsonResponse({
      protocolVersion: 1, operation: (value as { operation?: Operation }).operation ?? 'status',
      ok: false, result: null,
      error: { code: 'RESPONSE_TOO_LARGE', message: 'RESPONSE_TOO_LARGE' },
    }, 500);
  }
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
}

function envelope(operation: Operation, result: unknown, status = 200): Response {
  return jsonResponse({ protocolVersion: 1, operation, ok: true, result, error: null }, status);
}
function rejection(operation: Operation, code: string): Response {
  return jsonResponse({
    protocolVersion: 1, operation, ok: false, result: null,
    error: { code, message: code },
  }, statusFor(code));
}

async function readBounded(request: Request, signal: AbortSignal): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declared)) throw new ProtocolError('INVALID_INPUT');
    if (Number(declared) > REQUEST_LIMIT) throw new ProtocolError('BODY_TOO_LARGE');
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        if (signal.aborted) { reject(new ProtocolError('REQUEST_TIMEOUT')); return; }
        const abort = () => reject(new ProtocolError('REQUEST_TIMEOUT'));
        signal.addEventListener('abort', abort, { once: true });
        reader.read().then(
          value => { signal.removeEventListener('abort', abort); resolve(value); },
          error => { signal.removeEventListener('abort', abort); reject(error); },
        );
      });
      if (next.done) break;
      size += next.value.byteLength;
      if (size > REQUEST_LIMIT) throw new ProtocolError('BODY_TOO_LARGE');
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

async function withinDeadline<Value>(work: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) throw new ProtocolError('REQUEST_TIMEOUT');
  return new Promise<Value>((resolve, reject) => {
    const abort = () => reject(new ProtocolError('REQUEST_TIMEOUT'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

/** The portable fetch-style adapter. Authentication precedes every business input check. */
export function createHttpHandler(options: HttpHandlerOptions): (request: Request) => Promise<Response> {
  if (!options.core || typeof options.authenticate !== 'function' || !options.principalId) {
    throw new Error('HTTP_CONFIG_INVALID');
  }
  if (options.oauthCallback !== undefined && typeof options.oauthCallback !== 'function') {
    throw new Error('HTTP_CONFIG_INVALID');
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error('HTTP_CONFIG_INVALID');
  }
  return async request => {
    let pathname: string;
    try { pathname = new URL(request.url).pathname; }
    catch { return new Response(null, { status: 400 }); }
    if (pathname === '/health' && request.method === 'GET') {
      return jsonResponse({ status: 'ok' }, 200);
    }
    if (pathname.startsWith('/oauth/callback/') && options.oauthCallback) {
      let provider: string;
      try { provider = decodeURIComponent(pathname.slice('/oauth/callback/'.length)); }
      catch { return new Response(null, { status: 404 }); }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(provider)) {
        return new Response(null, { status: 404 });
      }
      return options.oauthCallback(request, provider);
    }
    const operation = pathname === '/v1/connect' ? 'connect'
      : pathname === '/v1/publish' ? 'publish'
      : pathname === '/v1/status' ? 'status' : null;
    if (!operation) return new Response(null, { status: 404 });

    let authorized = false;
    try { authorized = await options.authenticate(request.headers.get('authorization')); }
    catch { authorized = false; }
    if (!authorized) return rejection(operation, 'UNAUTHORIZED');
    if (request.method !== 'POST') return rejection(operation, 'METHOD_NOT_ALLOWED');
    if (!CONTENT_TYPE.test(request.headers.get('content-type') ?? '')) {
      return rejection(operation, 'UNSUPPORTED_MEDIA_TYPE');
    }
    if (request.headers.get('content-encoding')
      && request.headers.get('content-encoding')!.toLowerCase() !== 'identity') {
      return rejection(operation, 'UNSUPPORTED_MEDIA_TYPE');
    }
    const key = request.headers.get('idempotency-key');
    if (key !== null && !KEY.test(key)) return rejection(operation, 'INVALID_INPUT');

    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
    let parsed: unknown;
    try { parsed = parseStrictJson(await readBounded(request, signal)); }
    catch (error) { return rejection(operation, safeCode(error)); }
    if (signal.aborted) return rejection(operation, 'REQUEST_TIMEOUT');
    const context: T.CallContext = {
      principalId: options.principalId,
      ...(key === null ? {} : { idempotencyKey: key }),
      signal,
    };
    try {
      let result: unknown;
      if (operation === 'connect') {
        result = await withinDeadline(options.core.connect(parsed as T.ConnectRequest, context), signal);
      } else if (operation === 'publish') {
        const request = parsed as T.PublishRequest;
        const call = request.type === 'execute'
          ? options.core.publish(request as T.ExecuteRequest, context)
          : options.core.publish(request as T.PrepareRequest | T.RetryRequest, context);
        result = await withinDeadline(call, signal);
      } else {
        result = await withinDeadline(options.core.status(parsed as T.StatusRequest, context), signal);
      }
      const admittedPending = operation === 'publish'
        && (parsed as { type?: string }).type === 'execute'
        && !!result && typeof result === 'object'
        && 'phase' in result && result.phase === 'execution'
        && 'status' in result && (result.status === 'pending' || result.status === 'running');
      return envelope(operation, result, admittedPending ? 202 : 200);
    } catch (error) {
      return rejection(operation, safeCode(error));
    }
  };
}
