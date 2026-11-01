import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import type * as T from '@syndroo/core';
import worker from '../src/worker.js';
import type { WorkerEnv } from '../src/worker.js';
import { createOfficialRegistry } from '../src/providers/registry.js';
import { createD1Storage } from '../src/secrets.js';
import { FakeD1 } from './fake-d1.js';

const ADMIN = 'a'.repeat(48);
const CI = 'c'.repeat(48);
const CONNECTION = 'conn_ci_fixture';
const OTHER_CONNECTION = 'conn_ci_other';
const SCOPE = 'fixture';
const KEY = '11'.repeat(32);
const BUILT_WORKER = new URL('../dist/worker.js', import.meta.url);

afterEach(() => {
  vi.unstubAllGlobals();
});

function env(db = new FakeD1(), overrides: Record<string, unknown> = {}): WorkerEnv {
  return {
    DB: db, WORK_QUEUE: { async send() {} }, SCOPE,
    QUEUE_NAME: 'syndroo-work', DLQ_NAME: 'syndroo-dead',
    SECRET_KEY: KEY, RUNTIME_KEY: '22'.repeat(32),
    API_BEARER: ADMIN, PUBLIC_FETCH_STRICT: 'enabled',
    CI_BEARER: CI, CI_CONNECTION_ID: CONNECTION,
    ...overrides,
  } as WorkerEnv;
}

function call(
  config: WorkerEnv,
  path: string,
  options: { token?: string | null; body?: unknown; method?: string; key?: string } = {},
): Promise<Response> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  return worker.fetch(new Request(`https://syndroo.example${path}`, {
    method,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    headers: {
      ...(options.token === null || options.token === undefined
        ? {}
        : { authorization: `Bearer ${options.token}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.key === undefined ? {} : { 'idempotency-key': options.key }),
    },
  }), config);
}

async function body<T = unknown>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function stageThreadsConnection(
  db: FakeD1,
  connectionId = CONNECTION,
  accountId = 'threads-user',
): Promise<void> {
  const { state, credentials } = await createD1Storage({ db, scope: SCOPE, key: KEY });
  const loaded = await createOfficialRegistry().load('threads');
  const now = new Date().toISOString();
  const sessionId = `cs_${connectionId}`;
  await state.reserveConnect({
    request: {
      principalId: 'deployment-owner', family: 'connect', key: sessionId, digest: sessionId,
    },
    session: {
      sessionId, principalId: 'deployment-owner', implementation: loaded.implementation,
      provider: 'threads', stepRevision: 0,
      expiresAt: new Date(Date.parse(now) + 900_000).toISOString(),
      connectionId, baselineRevision: null, status: 'awaiting',
    },
    now,
  });
  const step = await state.claimConnectStep({
    sessionId, principalId: 'deployment-owner', stepRevision: 0,
    inputDigest: sessionId, claimId: `claim_${connectionId}`, now,
  });
  if (step.type !== 'claimed') throw Error('connect step missing');
  const secret = await credentials.put({
    creationId: `credential_${connectionId}`,
    owner: { kind: 'credential', ownerId: connectionId, version: 1 },
    value: {
      accessToken: 'fixture-threads-access-token',
      apiHost: 'https://graph.threads.net',
      username: 'fixture_user',
    },
  });
  const saved = await state.commitConnection({
    claim: step.claim,
    expectedConnectionRevision: null,
    stagedCredential: secret,
    now,
    connection: {
      connectionId,
      account: {
        provider: 'threads', accountId, origin: 'https://www.threads.net',
      },
      active: true, isDefault: true, revision: 1, bindingRevision: 1, credentialRevision: 1,
      secretRef: secret.ref, observations: [],
      presentation: {
        accountName: '@fixture_user',
        profileUrl: 'https://www.threads.net/@fixture_user',
      },
    },
  });
  if (saved.type !== 'applied') throw Error('connection seed failed');
}

function prepare(connection = CONNECTION, provider = 'threads'): Record<string, unknown> {
  return {
    type: 'prepare',
    content: { text: 'CI Threads fixture' },
    targets: [{
      provider,
      connection,
      options: { text: 'CI Threads fixture' },
    }],
  };
}

describe('CI credential boundary', () => {
  it('keeps the admin API unchanged when the optional CI pair is absent', async () => {
    const db = new FakeD1();
    const config = env(db, { CI_BEARER: undefined, CI_CONNECTION_ID: undefined });
    expect((await call(config, '/health')).status).toBe(200);
    await createD1Storage({ db, scope: SCOPE, key: KEY });
    const response = await call(config, '/v1/status', {
      token: ADMIN, body: { type: 'overview' },
    });
    expect(response.status).toBe(200);
    expect((await body<{ result: { type: string } }>(response)).result.type).toBe('overview');
  });

  it.each([
    ['only connection id', { CI_BEARER: undefined }],
    ['only bearer', { CI_CONNECTION_ID: undefined }],
    ['empty connection id', { CI_CONNECTION_ID: '' }],
    ['whitespace connection id', { CI_CONNECTION_ID: 'conn_bad id' }],
    ['unexpected connection syntax', { CI_CONNECTION_ID: 'fixture' }],
    ['overlong connection id', { CI_CONNECTION_ID: `conn_${'x'.repeat(124)}` }],
    ['short bearer', { CI_BEARER: 'short' }],
    ['malformed bearer', { CI_BEARER: `*${'c'.repeat(47)}` }],
    ['identical bearer', { CI_BEARER: ADMIN }],
  ])('rejects %s before storage with 503', async (_name, overrides) => {
    const db = new FakeD1();
    const response = await call(env(db, overrides), '/health');
    expect(response.status).toBe(503);
    expect(db.batches).toBe(0);
  });

  it('accepts the runtime maximum 128-character connection id', async () => {
    const db = new FakeD1();
    const response = await call(env(db, {
      CI_CONNECTION_ID: `conn_${'x'.repeat(123)}`,
    }), '/health');
    expect(response.status).toBe(200);
    expect(db.batches).toBe(0);
  });

  it('authenticates admin and CI request-locally and rejects every other bearer', async () => {
    const db = new FakeD1();
    await createD1Storage({ db, scope: SCOPE, key: KEY });
    const config = env(db);
    const [admin, ci] = await Promise.all([
      call(config, '/v1/status', { token: ADMIN, body: { type: 'overview' } }),
      call(config, '/v1/status', { token: CI, body: { type: 'overview' } }),
    ]);
    expect(admin.status).toBe(200);
    expect(ci.status).toBe(403);
    expect((await call(config, '/v1/status', {
      token: 'w'.repeat(48), body: { type: 'operation', operationId: 'op_missing' },
    })).status).toBe(401);
    const withoutPair = env(db, { CI_BEARER: undefined, CI_CONNECTION_ID: undefined });
    expect((await call(withoutPair, '/v1/status', {
      token: CI, body: { type: 'operation', operationId: 'op_missing' },
    })).status).toBe(401);
  });

  it.skipIf(!existsSync(BUILT_WORKER))('maps CI denial through the built Worker bundle', async () => {
    const db = new FakeD1();
    const built = await import(BUILT_WORKER.href) as {
      default: { fetch(request: Request, env: WorkerEnv): Promise<Response> };
    };
    const response = await built.default.fetch(new Request('https://syndroo.example/v1/status', {
      method: 'POST',
      headers: { authorization: `Bearer ${CI}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'overview' }),
    }), env(db));
    expect(response.status).toBe(403);
    expect((await body<{ error: { code: string; message: string } }>(response)).error).toEqual({
      code: 'FORBIDDEN', message: 'FORBIDDEN',
    });
    expect(db.batches).toBe(0);
  });

  it('rejects CI admin and listing APIs before storage', async () => {
    const requests: [string, unknown][] = [
      ['/v1/connect', { type: 'start', provider: 'threads', options: {} }],
      ['/v1/connect', { type: 'update', connectionId: CONNECTION, changes: { label: 'new' } }],
      ['/v1/connect', { type: 'disconnect', connectionId: CONNECTION }],
      ['/v1/status', { type: 'overview' }],
      ['/v1/status', { type: 'provider', provider: 'threads' }],
      ['/v1/status', { type: 'connections' }],
      ['/v1/status', { type: 'operations' }],
    ];
    for (const [path, request] of requests) {
      const db = new FakeD1();
      const response = await call(env(db), path, { token: CI, body: request });
      expect(response.status, path).toBe(403);
      expect((await body<{ error: { code: string } }>(response)).error.code).toBe('FORBIDDEN');
      expect(db.batches, path).toBe(0);
    }
  });

  it('rejects non-exact CI prepare targets before storage', async () => {
    const targets: unknown[] = [
      [],
      [{ provider: 'bluesky', connection: CONNECTION, options: { text: 'x' } }],
      [{ provider: 'threads', options: { text: 'x' } }],
      [{ provider: 'threads', connection: CONNECTION, options: { text: 'x' } },
        { provider: 'threads', connection: CONNECTION, options: { text: 'x' } }],
      [{ provider: 'threads', connection: OTHER_CONNECTION, options: { text: 'x' } }],
      [{ provider: 'threads', connection: 'default', options: { text: 'x' } }],
      [{ provider: 'threads', connection: 'label', options: { text: 'x' } }],
    ];
    for (const [index, list] of targets.entries()) {
      const db = new FakeD1();
      const response = await call(env(db), '/v1/publish', {
        token: CI,
        key: `ci-invalid-${index}`,
        body: { type: 'prepare', content: { text: 'x' }, targets: list },
      });
      expect(response.status, String(index)).toBe(403);
      expect((await body<{ error: { code: string } }>(response)).error.code).toBe('FORBIDDEN');
      expect(db.batches, String(index)).toBe(0);
    }
  });

  it('rejects non-exact CI retry targets before storage', async () => {
    const targets: unknown[] = [
      [],
      [{ provider: 'bluesky', connection: CONNECTION }],
      [{ provider: 'threads' }],
      [{ provider: 'threads', connection: OTHER_CONNECTION }],
      [{ provider: 'threads', connection: CONNECTION },
        { provider: 'threads', connection: CONNECTION }],
    ];
    for (const [index, list] of targets.entries()) {
      const db = new FakeD1();
      const response = await call(env(db), '/v1/publish', {
        token: CI,
        key: `ci-retry-invalid-${index}`,
        body: { type: 'retry', retryOf: 'op_missing', targets: list },
      });
      expect(response.status, String(index)).toBe(403);
      expect(db.batches, String(index)).toBe(0);
    }
  });

  it('binds CI approvals and operation reads to its configured connection principal', async () => {
    const db = new FakeD1();
    await stageThreadsConnection(db);
    vi.stubGlobal('fetch', async () => Response.json({
      id: 'threads-user', username: 'fixture_user',
    }));
    const config = env(db);
    let sends = 0;
    config.WORK_QUEUE.send = async () => { sends++; };

    const adminPreparedResponse = await call(config, '/v1/publish', {
      token: ADMIN, key: 'admin-prepare', body: prepare(),
    });
    expect(adminPreparedResponse.status).toBe(200);
    const adminPrepared = (await body<{
      result: { operationId: string; approvalToken: string };
    }>(adminPreparedResponse)).result;
    expect((await call(config, '/v1/publish', {
      token: CI,
      body: { type: 'execute', approvalToken: adminPrepared.approvalToken },
    })).status).toBe(409);
    expect((await call(config, '/v1/status', {
      token: CI, body: { type: 'operation', operationId: adminPrepared.operationId },
    })).status).toBe(404);
    expect(sends).toBe(0);

    const ciPreparedResponse = await call(config, '/v1/publish', {
      token: CI, key: 'ci-prepare', body: prepare(),
    });
    expect(ciPreparedResponse.status).toBe(200);
    const ciPrepared = (await body<{
      result: { operationId: string; approvalToken: string };
    }>(ciPreparedResponse)).result;
    expect((await call(config, '/v1/publish', {
      token: ADMIN,
      body: { type: 'execute', approvalToken: ciPrepared.approvalToken },
    })).status).toBe(409);
    expect((await call(config, '/v1/status', {
      token: ADMIN, body: { type: 'operation', operationId: ciPrepared.operationId },
    })).status).toBe(404);
    expect(sends).toBe(0);
  });

  it('revokes old CI approvals and operations when its connection configuration changes', async () => {
    const db = new FakeD1();
    await stageThreadsConnection(db, CONNECTION);
    await stageThreadsConnection(db, OTHER_CONNECTION, 'threads-other');
    vi.stubGlobal('fetch', async () => Response.json({
      id: 'threads-user', username: 'fixture_user',
    }));
    const original = env(db);
    const preparedResponse = await call(original, '/v1/publish', {
      token: CI, key: 'revoked-prepare', body: prepare(),
    });
    const prepared = (await body<{
      result: { operationId: string; approvalToken: string };
    }>(preparedResponse)).result;
    expect(preparedResponse.status).toBe(200);

    const changed = env(db, { CI_CONNECTION_ID: OTHER_CONNECTION });
    expect((await call(changed, '/v1/status', {
      token: CI, body: { type: 'operation', operationId: prepared.operationId },
    })).status).toBe(404);
    expect((await call(changed, '/v1/publish', {
      token: CI, body: { type: 'execute', approvalToken: prepared.approvalToken },
    })).status).toBe(409);
  });
});

describe('offline CI Threads publication', () => {
  it('publishes once across execute replay and duplicate queue delivery', async () => {
    const db = new FakeD1();
    await stageThreadsConnection(db);
    const queue: { scope: string; operationId: string; executionRevision: number }[] = [];
    const config = env(db);
    config.WORK_QUEUE.send = async message => { queue.push(message); };

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input
        : input instanceof URL ? input.toString() : input.url);
      expect(url.origin).toBe('https://graph.threads.net');
      const authorization = new Headers(init?.headers).get('authorization');
      expect(authorization).toBe('Bearer fixture-threads-access-token');
      if (url.pathname === '/me' && init?.method === 'GET') {
        expect(url.searchParams.get('fields')).toBe('id,username');
        return Response.json({ id: 'threads-user', username: 'fixture_user' });
      }
      if (url.pathname === '/me/threads' && init?.method === 'POST') {
        expect(url.searchParams.get('text')).toBe('CI Threads fixture');
        expect(url.searchParams.get('media_type')).toBe('TEXT');
        expect(url.searchParams.get('auto_publish_text')).toBe('true');
        return Response.json({ id: 'post_fixture' });
      }
      throw Error(`unexpected fixture request ${init?.method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const preparation = prepare();
    const preparedResponse = await call(config, '/v1/publish', {
      token: CI, key: 'stable-ci-request', body: preparation,
    });
    expect(preparedResponse.status).toBe(200);
    const prepared = (await body<{
      result: { operationId: string; approvalToken: string };
    }>(preparedResponse)).result;

    const execution = await call(config, '/v1/publish', {
      token: CI,
      body: { type: 'execute', approvalToken: prepared.approvalToken },
    });
    expect(execution.status).toBe(202);
    expect(queue).toHaveLength(1);

    const delivery = async () => {
      const calls = { ack: 0, retry: 0 };
      await worker.queue({
        queue: config.QUEUE_NAME,
        messages: [{
          body: queue[0],
          ack() { calls.ack++; },
          retry() { calls.retry++; },
        }],
      }, config);
      expect(calls).toEqual({ ack: 1, retry: 0 });
    };
    await delivery();
    await delivery();

    const published = await call(config, '/v1/status', {
      token: CI,
      body: { type: 'operation', operationId: prepared.operationId },
    });
    expect(published.status).toBe(200);
    const publishedBody = await body<{
      result: {
        operation: {
          phase: string;
          status?: string;
          deliveries: { outcome?: { status?: string; remoteId?: string } | null }[];
        };
      };
    }>(published);
    expect(publishedBody.result.operation.phase).toBe('execution');
    expect(publishedBody.result.operation.status).toBe('succeeded');
    expect(publishedBody.result.operation.deliveries[0]?.outcome).toMatchObject({
      status: 'succeeded', remoteId: 'post_fixture',
    });

    const replayedPreparation = await call(config, '/v1/publish', {
      token: CI, key: 'stable-ci-request', body: preparation,
    });
    expect(replayedPreparation.status).toBe(200);
    const replayed = (await body<{ result: { operationId: string } }>(replayedPreparation)).result;
    expect(replayed.operationId).toBe(prepared.operationId);
    const replayedExecution = await call(config, '/v1/publish', {
      token: CI,
      body: { type: 'execute', approvalToken: prepared.approvalToken },
    });
    expect(replayedExecution.status).toBe(200);
    expect(queue).toHaveLength(1);

    const publishCalls = fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(typeof input === 'string' ? input
        : input instanceof URL ? input.toString() : input.url);
      return url.pathname === '/me/threads' && init?.method === 'POST';
    });
    expect(publishCalls).toHaveLength(1);
  });
});
