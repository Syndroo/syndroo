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
