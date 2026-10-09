import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { canonicalJson, createCore } from '@syndroo/core';
import type * as T from '@syndroo/core';
import { createHttpHandler } from '../http/handler.js';
import { OAuthCallbackAdapter, normalizeOAuthConfig } from '../oauth/index.js';
import { deploymentKey } from '../secrets/encrypted.js';
import { createSqliteStorage } from '../state/index.js';

/**
 * The optional OAuth callback module. It is configuration, never a runtime
 * switch: a deployment either starts with a complete module or refuses to
 * start, and there is no API that turns it on or off later.
 */
export type SelfHostedOAuthOptions = {
  publicOrigin: string;
  providers: readonly string[];
  ttlMs?: number;
};

export type SelfHostedOptions = {
  bearerSecret: string;
  statePath: string;
  secretsPath: string;
  secretStoreKey: string | Uint8Array;
  providers: T.ProviderRegistry;
  providerContext: T.CoreDependencies['providerContext'];
  oauth?: SelfHostedOAuthOptions;
  scope?: string;
  principalId?: string;
  trustedProxyAddresses?: readonly string[];
  requestTimeoutMs?: number;
};

function invalid(): never { throw new Error('SERVER_CONFIG_INVALID'); }

/** A configured bearer is exactly 32 random bytes encoded canonically as base64url. */
export function createDeploymentAuthenticator(secret: string): (authorization: string | null) => boolean {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)
    || Buffer.from(secret, 'base64url').byteLength !== 32
    || Buffer.from(secret, 'base64url').toString('base64url') !== secret) invalid();
  const expected = createHash('sha256').update(secret, 'utf8').digest();
  return authorization => {
    // Even malformed and wrong-length candidates pass through the same
    // fixed-length digest comparison. Headers over 1 KiB are never hashed.
    const match = typeof authorization === 'string' && authorization.length <= 1024
      ? /^Bearer ([A-Za-z0-9_-]+)$/i.exec(authorization) : null;
    const candidate = match?.[1] ?? '';
    const actual = createHash('sha256').update(candidate, 'utf8').digest();
    return timingSafeEqual(expected, actual) && match !== null;
  };
}

function validOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || url.pathname !== '/' || !url.hostname) return null;
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}

function loopbackAddress(address: string | undefined): boolean {
  return address === '::1' || address === '127.0.0.1'
    || !!address && (address.startsWith('127.') || address.startsWith('::ffff:127.'));
}

/** Forwarded headers are considered only from an explicitly named immediate peer. */
export function resolveCanonicalOrigin(
  peerAddress: string | undefined,
  headers: IncomingHttpHeaders,
  trustedProxyAddresses: readonly string[],
  directOrigin = 'http://localhost',
): string {
  if (!peerAddress || !trustedProxyAddresses.includes(peerAddress)) return directOrigin;
  const protocol = headers['x-forwarded-proto'];
  const host = headers['x-forwarded-host'];
  if (typeof protocol !== 'string' || typeof host !== 'string'
    || protocol.includes(',') || host.includes(',') || !/^(https|http)$/.test(protocol)) return directOrigin;
  return validOrigin(`${protocol}://${host}`) ?? directOrigin;
}

function nodeRequest(req: IncomingMessage, origin: string,
  signal: AbortSignal): Request {
  const rawPath = req.url ?? '/';
  if (!rawPath.startsWith('/') || rawPath.startsWith('//')) throw new Error('BAD_REQUEST');
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method ?? 'GET', headers, signal,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' as const } : {}),
  };
  return new Request(origin + rawPath, init);
}

export function createSelfHostedRuntime(options: SelfHostedOptions): {
  server: Server;
  core: T.Core;
  close(): Promise<void>;
} {
  if (!options || typeof options !== 'object'
    || typeof options.statePath !== 'string' || !options.statePath
    || typeof options.secretsPath !== 'string' || !options.secretsPath
    || !options.providers || typeof options.providers.load !== 'function'
    || typeof options.providers.describe !== 'function'
    || typeof options.providers.list !== 'function'
    || typeof options.providerContext !== 'function'
    || (options.principalId !== undefined
      && (typeof options.principalId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(options.principalId)))
    || (options.trustedProxyAddresses ?? []).some(address => isIP(address) === 0)
    || (options.requestTimeoutMs !== undefined
      && (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1
        || options.requestTimeoutMs > 120_000))
    || Object.keys(options).some(key => ['AUTH_DISABLED', 'SECURITY_ENABLED', 'authDisabled', 'securityEnabled'].includes(key))) {
    invalid();
  }
  // A configured module must be complete before any file exists on disk.
  const oauthConfig = normalizeOAuthConfig(options.oauth);
  const principalId = options.principalId ?? 'deployment';
  const authenticate = createDeploymentAuthenticator(options.bearerSecret);
  const rawKey = deploymentKey(options.secretStoreKey);
  const sensitiveKey = createHmac('sha256', rawKey).update('syndroo-sensitive-digest-v1').digest();
  rawKey.fill(0);
  let storage: ReturnType<typeof createSqliteStorage>;
  try {
    storage = createSqliteStorage({
      statePath: options.statePath, secretsPath: options.secretsPath,
      scope: options.scope ?? 'self-hosted', key: options.secretStoreKey,
    });
  } catch (error) {
    sensitiveKey.fill(0);
    throw error;
  }
  const clock: T.Clock = { now: () => new Date().toISOString() };
  const entropy: T.Entropy = {
    id: prefix => `${prefix}_${randomBytes(24).toString('base64url')}`,
    token: () => randomBytes(32).toString('base64url'),
  };
  const oauth = oauthConfig === null ? null : new OAuthCallbackAdapter(oauthConfig, {
    database: storage.state.database, state: storage.state, credentials: storage.credentials,
    clock, entropy, principalId, key: sensitiveKey,
  });
  const digest = (value: T.Json, keyed: boolean) => {
    const bytes = canonicalJson(value);
    return keyed
      ? createHmac('sha256', sensitiveKey).update(bytes, 'utf8').digest('hex')
      : createHash('sha256').update(bytes, 'utf8').digest('hex');
  };
  const { core: baseCore } = createCore({
    state: storage.state, credentials: storage.credentials, providers: options.providers,
    providerContext: oauth === null
      ? options.providerContext
      : async (provider, signal) => oauth.decorate(await options.providerContext(provider, signal), provider),
    clock,
    entropy,
    digests: {
      canonical: async value => digest(value, false),
      sensitive: async value => digest(value, true),
    },
    execution: { type: 'foreground' },
  });
  const core: T.Core = oauth === null ? baseCore : {
    connect: (request, ctx) => oauth.runStart(request, ctx.signal, () => baseCore.connect(request, ctx)),
    publish: baseCore.publish,
    status: baseCore.status,
  };
  const handler = createHttpHandler({
    core, authenticate, principalId,
    ...(oauth === null ? {} : { oauthCallback: (request: Request, provider: string) => oauth.handle(request, provider) }),
    ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }),
  });
  const trusted = options.trustedProxyAddresses ?? [];
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    try {
      // This is an HTTP listener. Public traffic must arrive through an
      // explicitly trusted TLS-terminating proxy; direct cleartext is refused.
      if (!loopbackAddress(req.socket.localAddress)
        && !trusted.includes(req.socket.remoteAddress ?? '')) {
        res.statusCode = 403;
        res.setHeader('Cache-Control', 'no-store');
        res.end();
        return;
      }
      const origin = resolveCanonicalOrigin(req.socket.remoteAddress, req.headers, trusted);
      const response = await handler(nodeRequest(req, origin, controller.signal));
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.setHeader(name, value));
      if (response.status === 413) { res.shouldKeepAlive = false; res.setHeader('Connection', 'close'); }
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.statusCode = 500;
      res.setHeader('Cache-Control', 'no-store');
      res.end();
    }
  });
  server.requestTimeout = options.requestTimeoutMs ?? 30_000;
  return {
    server, core,
    async close() {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      storage.close();
      sensitiveKey.fill(0);
    },
  };
}
