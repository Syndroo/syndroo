import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { ProtocolError } from '@syndroo/core';
import { harness } from '../../../../tests/fixtures/state/harness.js';
import { EncryptedCredentials } from '../../src/secrets/encrypted.js';
import { Database } from '../../src/state/database.js';
import { SQLiteState } from '../../src/state/state.js';
import { createSelfHostedRuntime, resolveCanonicalOrigin, type SelfHostedOptions } from '../../src/compose/index.js';
import { createHttpHandler } from '../../src/http/index.js';
import type * as T from '@syndroo/core';

const roots: string[] = [];
const runtimes: { close(): Promise<void> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function config(): Promise<SelfHostedOptions> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'syndroo-http-')));
  roots.push(root);
  const h = harness();
  return {
    bearerSecret: randomBytes(32).toString('base64url'),
    statePath: path.join(root, 'state.db'),
    secretsPath: path.join(root, 'secrets.db'),
    secretStoreKey: randomBytes(32).toString('hex'),
    providers: h.providers,
    providerContext: h.deps.providerContext,
  };
}

async function setup() {
  const options = await config();
  const runtime = createSelfHostedRuntime(options);
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const address = runtime.server.address();
  if (!address || typeof address === 'string') throw Error('no test port');
  const result = {
    ...runtime, options,
    base: `http://127.0.0.1:${address.port}`,
    port: address.port,
    auth: { authorization: `Bearer ${options.bearerSecret}` },
  };
  runtimes.push(result);
  return result;
}

/**
 * The real handler over the real Core and the shared fake provider harness.
 *
 * Deliberately socket-free: this sandbox refuses `listen(127.0.0.1)` with
 * `EPERM`, so every case that needs a bound port is skipped here (see
 * `docs/testing.md`). What remains under test is still the whole path a request
 * takes — `createHttpHandler`, the real `@syndroo/core`, the SQLite state
 * adapter on a temp directory, and the envelope serializer.
 */
async function handlerWithFakeProvider(h = harness()) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'syndroo-http-')));
  roots.push(root);
  const options: SelfHostedOptions = {
    bearerSecret: randomBytes(32).toString('base64url'),
    statePath: path.join(root, 'state.db'),
    secretsPath: path.join(root, 'secrets.db'),
    secretStoreKey: randomBytes(32).toString('hex'),
    providers: h.providers,
    providerContext: h.deps.providerContext,
  };
  const runtime = createSelfHostedRuntime(options);
  runtimes.push(runtime);
  const handler = createHttpHandler({
    core: runtime.core, authenticate: () => true, principalId: 'deployment',
  });
  const post = (path: string, body: object, key?: string) => handler(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify(body),
  }));
  /** `POST /v1/publish`, the operation most cases here exercise. */
  const call = (body: object, key?: string) => post('/v1/publish', body, key);
  return { h, options, runtime, post, call };
}

function envelopeKeys(value: unknown): void {
  expect(Object.keys(value as object).sort()).toEqual(
    ['error', 'ok', 'operation', 'protocolVersion', 'result'].sort(),
  );
}

it('real socket: unauthorized requests have zero provider, secret, and state access', async () => {
  const r = await setup();
  const provider = vi.spyOn(r.options.providers, 'load');
  const secret = vi.spyOn(EncryptedCredentials.prototype, 'get');
  const write = vi.spyOn(Database.prototype, 'write');
  const read = vi.spyOn(Database.prototype, 'read');
  for (const target of ['/v1/connect', '/v1/publish', '/v1/status']) {
    const response = await fetch(r.base + target, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'secret-canary',
    });
    expect(response.status).toBe(401);
    const result = await response.json();
    envelopeKeys(result);
    expect(result).toMatchObject({
      protocolVersion: 1, ok: false, result: null,
      error: { code: 'UNAUTHORIZED', message: 'UNAUTHORIZED' },
    });
    expect(JSON.stringify(result)).not.toContain('secret-canary');
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  for (const token of ['short', randomBytes(32).toString('base64url')]) {
    const response = await fetch(r.base + '/v1/status', {
      method: 'POST', headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json',
      }, body: '{"type":"connections"}',
    });
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain(token);
  }
  expect(provider).not.toHaveBeenCalled();
  expect(secret).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it('real socket: a valid status call returns one bounded safe envelope', async () => {
  const r = await setup();
  const response = await fetch(r.base + '/v1/status', {
    method: 'POST', headers: { ...r.auth, 'content-type': 'application/json' },
    body: '{"type":"connections"}',
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-security-policy')).toBe("default-src 'none'");
  const text = await response.text();
  const value = JSON.parse(text);
  envelopeKeys(value);
  expect(value).toEqual({
    protocolVersion: 1, operation: 'status', ok: true,
    result: { type: 'connections', connections: [] }, error: null,
  });
  expect(text).not.toContain(r.options.bearerSecret);
  const health = await fetch(r.base + '/health');
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: 'ok' });
  expect((await fetch(r.base + '/oauth/callback/fake')).status).toBe(404);
});

it('real socket: maps malformed, oversized, unsupported, and rate-limited calls', async () => {
  const r = await setup();
  const send = (body: string, contentType = 'application/json') => fetch(r.base + '/v1/status', {
    method: 'POST', headers: { ...r.auth, 'content-type': contentType }, body,
  });
  const bad = await send('{"type":"connections","type":"operations"}');
  expect(bad.status).toBe(400);
  expect((await bad.json()).error.code).toBe('INVALID_INPUT');
  const media = await send('{}', 'text/plain');
  expect(media.status).toBe(415);
  expect((await media.json()).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  const encoded = await fetch(r.base + '/v1/status', {
    method: 'POST', headers: {
      ...r.auth, 'content-type': 'application/json', 'content-encoding': 'gzip',
    }, body: '{}',
  });
  expect(encoded.status).toBe(415);
  const wrongMethod = await fetch(r.base + '/v1/status', {
    method: 'PUT', headers: r.auth,
  });
  expect(wrongMethod.status).toBe(405);
  const large = await send('x'.repeat(65_537));
  expect(large.status).toBe(413);
  expect((await large.json()).error.code).toBe('BODY_TOO_LARGE');
  const throttled = vi.spyOn(SQLiteState.prototype, 'listConnections')
    .mockRejectedValueOnce(new ProtocolError('RATE_LIMITED'));
  const limited = await send('{"type":"connections"}');
  expect(limited.status).toBe(429);
  expect((await limited.json()).error.code).toBe('RATE_LIMITED');
  expect(throttled).toHaveBeenCalledTimes(1);
  for (const response of [bad, media, encoded, wrongMethod, large, limited]) {
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
});

it('uses 202 only for admitted nonterminal execute, and enforces request deadlines', async () => {
  const pending = {
    phase: 'execution', status: 'pending', operationId: 'op_test', deliveries: [],
  };
  const core = {
    connect: async () => ({ status: 'done' }),
    publish: async () => pending,
    status: async () => new Promise<never>(() => undefined),
  } as unknown as T.Core;
  const handler = createHttpHandler({
    core, authenticate: () => true, principalId: 'owner', timeoutMs: 10,
  });
  const call = (route: string, body: object) => handler(new Request(`http://localhost${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  expect((await call('/v1/publish', { type: 'execute' })).status).toBe(202);
  expect((await call('/v1/publish', { type: 'prepare' })).status).toBe(200);
  const timeout = await call('/v1/status', { type: 'connections' });
  expect(timeout.status).toBe(504);
  expect((await timeout.json() as { error: { code: string } }).error.code).toBe('REQUEST_TIMEOUT');
});

it('accepts only authentic-looking ProtocolError values from an independent Core copy', async () => {
  class IndependentProtocolError extends Error {
    readonly code: string;

    constructor(code: string, message = code) {
      super(message);
      this.name = 'ProtocolError';
      this.code = code;
    }
  }

  const cases: {
    name: string;
    thrown: unknown;
    status: number;
    code: string;
    hidden?: string;
  }[] = [
    {
      name: 'same-copy ProtocolError',
      thrown: new ProtocolError('FORBIDDEN'),
      status: 403,
      code: 'FORBIDDEN',
    },
    {
      name: 'independently bundled ProtocolError',
      thrown: new IndependentProtocolError('FORBIDDEN'),
      status: 403,
      code: 'FORBIDDEN',
    },
    {
      name: 'independently bundled approval error',
      thrown: new IndependentProtocolError('APPROVAL_INVALID'),
      status: 409,
      code: 'APPROVAL_INVALID',
    },
    {
      name: 'independent error details stay hidden',
      thrown: Object.assign(new IndependentProtocolError('FORBIDDEN'), {
        details: { operationId: 'secret-details' },
      }),
      status: 403,
      code: 'FORBIDDEN',
      hidden: 'secret-details',
    },
    {
      name: 'ordinary error',
      thrown: new Error('FORBIDDEN'),
      status: 500,
      code: 'DURABILITY_ERROR',
    },
    {
      name: 'code-only ordinary error',
      thrown: Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' }),
      status: 500,
      code: 'DURABILITY_ERROR',
    },
    {
      name: 'plain object',
      thrown: { name: 'ProtocolError', code: 'FORBIDDEN', message: 'FORBIDDEN' },
      status: 500,
      code: 'DURABILITY_ERROR',
    },
    {
      name: 'unknown code',
      thrown: new IndependentProtocolError('UNKNOWN_SECRET_CODE'),
      status: 500,
      code: 'DURABILITY_ERROR',
      hidden: 'UNKNOWN_SECRET_CODE',
    },
    {
      name: 'secret message',
      thrown: new IndependentProtocolError('FORBIDDEN', 'secret-canary'),
      status: 500,
      code: 'DURABILITY_ERROR',
      hidden: 'secret-canary',
    },
  ];

  for (const test of cases) {
    const core = {
      connect: async () => ({ status: 'done' }),
      publish: async () => ({ status: 'confirmation_required' }),
      status: async () => { throw test.thrown; },
    } as unknown as T.Core;
    const handler = createHttpHandler({
      core, authenticate: () => true, principalId: 'owner',
    });
    const response = await handler(new Request('http://localhost/v1/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"type":"connections"}',
    }));
    const text = await response.text();
    expect(response.status, test.name).toBe(test.status);
    expect(JSON.parse(text), test.name).toMatchObject({
      protocolVersion: 1,
      operation: 'status',
      ok: false,
      result: null,
      error: { code: test.code, message: test.code },
    });
    if (test.hidden) expect(text, test.name).not.toContain(test.hidden);
  }
});

it('returns the frozen presentation without credential material and keeps 202 off a terminal round', async () => {
  const r = await handlerWithFakeProvider();
  r.h.plugin.connect.verify = async () => ({
    account: { provider: 'fake', accountId: 'alice', origin: 'https://social.example' },
    evidence: [],
    presentation: { accountName: '@alice', profileUrl: 'https://social.example/@alice' },
  });

  // The connection has to live in the runtime's own SQLite state, so it is made
  // through the real connect round trip rather than the memory fixture.
  const start = await r.post('/v1/connect', { type: 'start', provider: 'fake', options: {} }, 'connect-start-1');
  expect(start.status).toBe(200);
  const started = (await start.json() as {
    result: { status: string; connectSessionId: string; stepRevision: number };
  }).result;
  expect(started.status).toBe('action_required');
  const resumed = await r.post('/v1/connect', {
    type: 'resume',
    connectSessionId: started.connectSessionId,
    stepRevision: started.stepRevision,
    input: { type: 'credentials', credentials: { token: 'fixture-credential' } },
  }, 'connect-resume-1');
  expect(resumed.status).toBe(200);
  const connected = (await resumed.json() as {
    result: { status: string; connection: { connectionId: string } };
  }).result;
  expect(connected.status).toBe('done');

  const preparedResponse = await r.call({
    type: 'prepare',
    content: { text: 'hello' },
    targets: [{ provider: 'fake', connection: connected.connection.connectionId }],
  }, 'http-library-1');
  expect(preparedResponse.status).toBe(200);
  const prepared = (await preparedResponse.json() as {
    result: { approvalToken: string; preview: readonly { preview?: unknown; presentation?: unknown }[] };
  }).result;
  // The frozen preview travels with the prepare result: the same content and
  // the account presentation resolved when the intent was frozen.
  expect(prepared.preview[0]?.preview).toEqual({ content: { text: 'hello' }, fields: [] });
  expect(prepared.preview[0]?.presentation).toEqual({
    accountName: '@alice', profileUrl: 'https://social.example/@alice',
  });

  const executeResponse = await r.call({ type: 'execute', approvalToken: prepared.approvalToken }, 'http-library-exec-1');
  // A foreground execution is already terminal, so it answers 200. 202 belongs
  // only to a durably admitted round that has not finished, and neither status
  // means the platform user can see the post.
  expect(executeResponse.status).toBe(200);
  const text = await executeResponse.text();
  const execution = (JSON.parse(text) as {
    result: { status: string; deliveries: readonly { state?: string; preview?: unknown; presentation?: unknown }[] };
  }).result;
  expect(execution.status).toBe('succeeded');
  expect(execution.deliveries[0]?.state).toBe('settled');
  expect(execution.deliveries[0]?.preview).toEqual({ content: { text: 'hello' }, fields: [] });
  expect(execution.deliveries[0]?.presentation).toEqual({
    accountName: '@alice', profileUrl: 'https://social.example/@alice',
  });
  // Display metadata only: no credential, no canary, no store key.
  expect(text).not.toContain('FAKE_SECRET_CANARY');
  expect(text).not.toContain(r.options.secretStoreKey);
});

it('real socket: rejects declared over-limit body before the client sends it', async () => {
  const r = await setup();
  const socket = createConnection({ host: '127.0.0.1', port: r.port });
  await once(socket, 'connect');
  const packet = [
    'POST /v1/status HTTP/1.1', 'Host: localhost',
    `Authorization: Bearer ${r.options.bearerSecret}`,
    'Content-Type: application/json', 'Content-Length: 70000',
    'Connection: close', '', 'x',
  ].join('\r\n');
  socket.write(packet);
  const response = await Promise.race([
    new Promise<string>((resolve, reject) => {
      let text = '';
      socket.on('data', chunk => {
        text += chunk.toString('utf8');
        if (text.includes('\r\n\r\n')) resolve(text);
      });
      socket.on('error', reject);
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(Error('body was fully awaited')), 2_000)),
  ]);
  expect(response).toMatch(/^HTTP\/1\.1 413 /);
  socket.destroy();
});

it('refuses startup with every required security component absent or malformed', async () => {
  const good = await config();
  const cases: [string, Record<string, unknown>][] = [
    ['bearer missing', { bearerSecret: undefined }],
    ['bearer empty', { bearerSecret: '' }],
    ['bearer short', { bearerSecret: 'short' }],
    ['bearer malformed', { bearerSecret: '*'.repeat(43) }],
    ['state path missing', { statePath: undefined }],
    ['secret store key missing', { secretStoreKey: undefined }],
    ['secret store key short', { secretStoreKey: 'abcd' }],
    ['provider registry missing', { providers: undefined }],
    ['provider context missing', { providerContext: undefined }],
    ['auth-disable switch present', { authDisabled: true }],
  ];
  for (const [name, override] of cases) {
    expect(() => createSelfHostedRuntime({ ...good, ...override } as SelfHostedOptions), name).toThrow();
  }
  await expect(fs.stat(good.statePath)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(good.secretsPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('accepts forwarded origin only from an explicitly trusted immediate proxy', () => {
  const forwarded = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'public.example' };
  expect(resolveCanonicalOrigin('198.51.100.1', forwarded, ['203.0.113.1']))
    .toBe('http://localhost');
  expect(resolveCanonicalOrigin('203.0.113.1', forwarded, ['203.0.113.1']))
    .toBe('https://public.example');
  expect(resolveCanonicalOrigin('203.0.113.1', {
    'x-forwarded-proto': 'https', 'x-forwarded-host': 'public.example,evil.example',
  }, ['203.0.113.1'])).toBe('http://localhost');
});
