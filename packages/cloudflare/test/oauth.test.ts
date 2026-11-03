import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as T from '@syndroo/core';
import { OAuthCallbackAdapter } from '@syndroo/server/http';
import worker from '../src/worker.js';
import type { WorkerEnv } from '../src/worker.js';
import { createD1Storage } from '../src/secrets.js';
import { FakeD1 } from './fake-d1.js';

const TOKEN = 't'.repeat(48);
const ORIGIN = 'https://syndroo.example';
const REDIRECT_URI = `${ORIGIN}/oauth/callback/threads`;
const CLIENT_ID = 'threads-client-id';
const CLIENT_SECRET = 'threads-client-secret-canary';
const CODE = 'authorization-code-canary';

type TestEnv = WorkerEnv & { PUBLIC_ORIGIN?: string };

function env(db: FakeD1, publicOrigin?: string): TestEnv {
  return {
    DB: db,
    WORK_QUEUE: { async send() {} },
    SCOPE: 'fixture',
    QUEUE_NAME: 'syndroo-work',
    DLQ_NAME: 'syndroo-dead',
    SECRET_KEY: '11'.repeat(32),
    RUNTIME_KEY: '22'.repeat(32),
    API_BEARER: TOKEN,
    PUBLIC_FETCH_STRICT: 'enabled',
    ...(publicOrigin === undefined ? {} : { PUBLIC_ORIGIN: publicOrigin }),
  };
}

function post(path: string, body: unknown, key: string, authorized = true): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      ...(authorized ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function callback(state: string, origin = ORIGIN): Request {
  return new Request(`${origin}/oauth/callback/threads?code=${encodeURIComponent(CODE)}&state=${encodeURIComponent(state)}`);
}

function responseBody(response: Response): Promise<any> {
  return response.json() as Promise<any>;
}

function installTransport(): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const path = new URL(url).pathname;
    if (path === '/oauth/access_token') {
      return Response.json({ access_token: 'short-lived-token' });
    }
    if (path === '/access_token') {
      return Response.json({ access_token: 'long-lived-token' });
    }
    if (path === '/me') {
      return Response.json({ id: 'threads-account', username: 'fixture_user' });
    }
    return new Response('unexpected request', { status: 500 });
  }));
  return { calls };
}

async function directStart(runtimeEnv: TestEnv) {
  const response = await worker.fetch(post('/v1/connect', {
    type: 'start',
    provider: 'threads',
    options: {
      redirectUri: REDIRECT_URI,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    },
  }, 'start-direct'), runtimeEnv);
  const body = await responseBody(response);
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.result.status).toBe('action_required');
  expect(body.result.action.type).toBe('open_url');
  return body.result as {
    connectSessionId: string;
    stepRevision: number;
    action: { url: string };
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Worker Threads OAuth', () => {
  it('completes credential input, callback storage, and callback completion without a live request', async () => {
    const db = new FakeD1();
    const runtimeEnv = env(db, ORIGIN);
    const transport = installTransport();

    const start = await worker.fetch(post('/v1/connect', {
      type: 'start',
      provider: 'threads',
      options: { redirectUri: REDIRECT_URI },
    }, 'start-input'), runtimeEnv);
    const pending = await responseBody(start);
    expect(start.status, JSON.stringify(pending)).toBe(200);
    expect(pending.result).toMatchObject({
      status: 'action_required',
      action: { type: 'credential_input' },
    });
    expect(JSON.stringify(pending)).not.toContain(CLIENT_SECRET);

    const resumed = await worker.fetch(post('/v1/connect', {
      type: 'resume',
      connectSessionId: pending.result.connectSessionId,
      stepRevision: pending.result.stepRevision,
      input: {
        type: 'credentials',
        credentials: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
      },
    }, 'resume-credentials'), runtimeEnv);
    const authorized = await responseBody(resumed);
    expect(resumed.status, JSON.stringify(authorized)).toBe(200);
    expect(authorized.result.action.type).toBe('open_url');
    expect(authorized.result.action.url).not.toContain(CLIENT_SECRET);

    const state = new URL(authorized.result.action.url).searchParams.get('state');
    expect(state).toBeTruthy();
    expect(db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM oauth_attempts WHERE session_id=? AND provider=?',
    ).get(authorized.result.connectSessionId, 'threads')).toEqual({ count: 1 });

    const forged = await worker.fetch(post('/v1/connect', {
      type: 'resume',
      connectSessionId: authorized.result.connectSessionId,
      stepRevision: authorized.result.stepRevision,
      input: { type: 'callback_complete' },
    }, 'forged-complete'), runtimeEnv);
    expect((await responseBody(forged)).result.action.type).toBe('open_url');
    expect(transport.calls).toHaveLength(0);

    const callbackResponse = await worker.fetch(callback(state!), runtimeEnv);
    expect(callbackResponse.status).toBe(200);
    const callbackText = await callbackResponse.text();
    expect(callbackText).not.toContain(CODE);
    expect(callbackText).not.toContain(state!);

    const completed = await worker.fetch(post('/v1/connect', {
      type: 'resume',
      connectSessionId: authorized.result.connectSessionId,
      stepRevision: authorized.result.stepRevision,
      input: { type: 'callback_complete' },
    }, 'complete-callback'), runtimeEnv);
    const done = await responseBody(completed);
    expect(completed.status, JSON.stringify(done)).toBe(200);
    expect(done.result).toMatchObject({
      status: 'done',
      connection: {
        account: {
          provider: 'threads',
          accountId: 'threads-account',
          origin: 'https://www.threads.net',
        },
      },
    });
    expect(transport.calls).toHaveLength(3);
    expect(JSON.stringify(done)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(done)).not.toContain(CODE);
  });

  it('retains the original state when a successful start is replayed', async () => {
    const db = new FakeD1();
    const runtimeEnv = env(db, ORIGIN);
    installTransport();
    const startBody = {
      type: 'start',
      provider: 'threads',
      options: {
        redirectUri: REDIRECT_URI,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      },
    };

    const first = await responseBody(await worker.fetch(post('/v1/connect', startBody, 'start-replay'), runtimeEnv));
    const second = await responseBody(await worker.fetch(post('/v1/connect', startBody, 'start-replay'), runtimeEnv));
    const firstState = new URL(first.result.action.url).searchParams.get('state');
    const secondState = new URL(second.result.action.url).searchParams.get('state');

    expect(second.result).toEqual(first.result);
    expect(secondState).toBe(firstState);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM oauth_attempts').get()).toEqual({ count: 1 });
  });

  it('rejects a redirect URI that conflicts with PUBLIC_ORIGIN', async () => {
    const db = new FakeD1();
    const runtimeEnv = env(db, ORIGIN);

    const response = await worker.fetch(post('/v1/connect', {
      type: 'start',
      provider: 'threads',
      options: {
        redirectUri: 'https://other.example/oauth/callback/threads',
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      },
    }, 'conflicting-redirect'), runtimeEnv);
    const body = await responseBody(response);

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('INVALID_INPUT');
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM oauth_attempts').get()).toEqual({ count: 0 });
    expect(JSON.stringify(body)).not.toContain(CLIENT_SECRET);
  });

  it('rejects noncanonical and non-HTTPS PUBLIC_ORIGIN before storage initialization', async () => {
    for (const publicOrigin of ['https://syndroo.example/', 'http://127.0.0.1']) {
      const db = new FakeD1();
      const response = await worker.fetch(callback('s'.repeat(43), publicOrigin), env(db, publicOrigin));

      expect(response.status).toBe(503);
      expect(db.batches).toBe(0);
    }
  });

  it('reuses the original attempt expiry and used marker when replay happens after time advances', async () => {
    const db = new FakeD1();
    const storage = await createD1Storage({ db, scope: 'fixture', key: '11'.repeat(32) });
    let now = '2026-11-01T00:00:00.000Z';
    const state = 's'.repeat(43);
    const redirectUri = REDIRECT_URI;
    const sessionId = 'cs_fixture';
    const result: T.ConnectResult = {
      status: 'action_required',
      connectSessionId: sessionId,
      stepRevision: 1,
      expiresAt: '2026-11-01T00:15:00.000Z',
      action: {
        type: 'open_url',
        url: `https://www.threads.net/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      },
    };
    const session: T.ConnectSession = {
      sessionId,
      principalId: 'deployment-owner',
      implementation: {
        provider: 'threads',
        packageName: '@syndroo/provider-threads',
        version: '0.7.0',
        apiVersion: 1,
        artifactFingerprint: 'fixture',
        schemaFingerprint: 'fixture',
      },
      provider: 'threads',
      stepRevision: 1,
      expiresAt: result.expiresAt,
      connectionId: 'conn_fixture',
      baselineRevision: null,
      privateStateRef: 'secret_fixture',
      status: 'awaiting',
    };
    const otherState = 't'.repeat(43);
    const otherSessionId = 'cs_other';
    const otherResult: T.ConnectResult = {
      status: 'action_required',
      connectSessionId: otherSessionId,
      stepRevision: 1,
      expiresAt: '2026-11-01T00:15:01.000Z',
      action: {
        type: 'open_url',
        url: `https://www.threads.net/oauth/authorize?state=${otherState}`
          + `&redirect_uri=${encodeURIComponent(redirectUri)}`,
      },
    };
    const otherSession: T.ConnectSession = {
      ...session,
      sessionId: otherSessionId,
      expiresAt: otherResult.expiresAt,
      privateStateRef: 'secret_other',
    };
    const sessions = new Map([[sessionId, session], [otherSessionId, otherSession]]);
    const stateStore = {
      async getConnectSession(id: string, principalId: string) {
        return principalId === 'deployment-owner' ? sessions.get(id) ?? null : null;
      },
    } as unknown as T.StateStore;
    const credentials = {
      async get(input: { ref: string }) {
        const oauthState = input.ref === otherSession.privateStateRef ? otherState : state;
        return {
          oauth: {
            state: oauthState,
            redirectUri,
            codeChallenge: 'c'.repeat(43),
            codeVerifier: 'v'.repeat(43),
          },
        };
      },
    } as unknown as T.CredentialStore;
    const adapter = new OAuthCallbackAdapter({
      publicOrigin: ORIGIN,
      providers: ['threads'],
      ttlMs: 60_000,
    }, {
      attempts: storage.state.database.oauthAttempts,
      state: stateStore,
      credentials,
      clock: { now: () => now },
      entropy: { id: prefix => `${prefix}_fixture`, token: () => 'fixture' },
      principalId: 'deployment-owner',
      key: new Uint8Array(32).fill(7),
    });

    await adapter.record(result);
    const original = db.sqlite.prepare(
      'SELECT state_digest,created_at,expires_at,used_at FROM oauth_attempts WHERE session_id=?',
    ).get(sessionId) as { state_digest: string; created_at: string; expires_at: string; used_at: string | null };
    expect(original.expires_at).toBe('2026-11-01T00:01:00.000Z');
    const claimedAt = now;
    await storage.state.database.oauthAttempts.claim(original.state_digest, now);

    now = '2026-11-01T00:01:01.000Z';
    await adapter.record(otherResult);
    await adapter.record(result);
    expect(db.sqlite.prepare(
      'SELECT created_at,expires_at,used_at FROM oauth_attempts WHERE session_id=?',
    ).get(sessionId)).toEqual({
      created_at: original.created_at,
      expires_at: original.expires_at,
      used_at: claimedAt,
    });
  });

  it('keeps the first D1 attempt binding when concurrent records compute different TTL caps', async () => {
    const db = new FakeD1();
    const storage = await createD1Storage({ db, scope: 'fixture', key: '11'.repeat(32) });
    const first = {
      stateDigest: 'd'.repeat(64),
      sessionId: 'cs_race',
      provider: 'threads',
      stepRevision: 1,
      redirectUri: REDIRECT_URI,
      issuer: 'https://www.threads.net',
      codeChallenge: 'c'.repeat(43),
      createdAt: '2026-11-01T00:00:00.000Z',
      expiresAt: '2026-11-01T00:01:00.000Z',
      usedAt: null,
    };
    const second = {
      ...first,
      createdAt: '2026-11-01T00:00:01.000Z',
      expiresAt: '2026-11-01T00:01:01.000Z',
    };

    await Promise.all([
      storage.state.database.oauthAttempts.insert(first),
      storage.state.database.oauthAttempts.insert(second),
    ]);
    expect(await storage.state.database.oauthAttempts.read(first.stateDigest)).toEqual(first);
  });

  it('rejects malformed, forged, expired, and differently bound callbacks', async () => {
    const db = new FakeD1();
    const runtimeEnv = env(db, ORIGIN);
    const started = await directStart(runtimeEnv);
    const state = new URL(started.action.url).searchParams.get('state')!;
    const withoutOAuth = { ...runtimeEnv };
    delete withoutOAuth.PUBLIC_ORIGIN;

    expect((await worker.fetch(callback(state), withoutOAuth)).status).toBe(404);
    expect((await worker.fetch(callback(state, 'https://other.example'), runtimeEnv)).status).toBe(400);
    expect((await worker.fetch(new Request(
      `${ORIGIN}/oauth/callback/threads?code=${CODE}&state=${state}&state=${state}`,
    ), runtimeEnv)).status).toBe(400);
    expect((await worker.fetch(new Request(
      `${ORIGIN}/oauth/callback/threads?code=${CODE}&state=${'x'.repeat(43)}`,
    ), runtimeEnv)).status).toBe(404);

    db.sqlite.prepare("UPDATE oauth_attempts SET provider='linkedin' WHERE session_id=?").run(started.connectSessionId);
    expect((await worker.fetch(callback(state), runtimeEnv)).status).toBe(409);

    db.sqlite.prepare("UPDATE oauth_attempts SET provider='threads', step_revision=step_revision+1 WHERE session_id=?")
      .run(started.connectSessionId);
    expect((await worker.fetch(callback(state), runtimeEnv)).status).toBe(409);

    db.sqlite.prepare("UPDATE oauth_attempts SET step_revision=step_revision-1, expires_at='2000-01-01T00:00:00.000Z' WHERE session_id=?")
      .run(started.connectSessionId);
    expect((await worker.fetch(callback(state), runtimeEnv)).status).toBe(400);
  });

  it('admits exactly one callback under concurrent claims', async () => {
    const db = new FakeD1();
    const runtimeEnv = env(db, ORIGIN);
    const transport = installTransport();
    const started = await directStart(runtimeEnv);
    const state = new URL(started.action.url).searchParams.get('state')!;

    const responses = await Promise.all([
      worker.fetch(callback(state), runtimeEnv),
      worker.fetch(callback(state), runtimeEnv),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(transport.calls).toHaveLength(0);

    const completed = await worker.fetch(post('/v1/connect', {
      type: 'resume',
      connectSessionId: started.connectSessionId,
      stepRevision: started.stepRevision,
      input: { type: 'callback_complete' },
    }, 'concurrent-complete'), runtimeEnv);
    expect(completed.status).toBe(200);
    expect(transport.calls).toHaveLength(3);

    await worker.fetch(post('/v1/connect', {
      type: 'resume',
      connectSessionId: started.connectSessionId,
      stepRevision: started.stepRevision,
      input: { type: 'callback_complete' },
    }, 'concurrent-replay'), runtimeEnv);
    expect(transport.calls).toHaveLength(3);
  });

  it('fails closed when a callback claim commits but acknowledgement is lost', async () => {
    const db = new FakeD1();
    const runtimeEnv = env(db, ORIGIN);
    const transport = installTransport();
    const started = await directStart(runtimeEnv);
    const state = new URL(started.action.url).searchParams.get('state')!;

    const batch = db.batch.bind(db);
    let lost = false;
    vi.spyOn(db, 'batch').mockImplementation(async statements => {
      const results = await batch(statements);
      if (!lost && statements.some(statement =>
        (statement as unknown as { sql: string }).sql.includes('UPDATE oauth_attempts SET used_at'))) {
        lost = true;
        throw new Error('injected claim acknowledgement loss');
      }
      return results;
    });
    expect((await worker.fetch(callback(state), runtimeEnv)).status).toBe(500);
    expect((await worker.fetch(callback(state), runtimeEnv)).status).toBe(409);

    const completed = await worker.fetch(post('/v1/connect', {
      type: 'resume',
      connectSessionId: started.connectSessionId,
      stepRevision: started.stepRevision,
      input: { type: 'callback_complete' },
    }, 'lost-ack-complete'), runtimeEnv);
    expect(completed.status).toBe(200);
    expect((await responseBody(completed)).result.action.type).toBe('open_url');
    expect(transport.calls).toHaveLength(0);
  });

  it('preserves a committed callback claim and evidence when acceptance acknowledgement is lost', async () => {
    const db = new FakeD1();
    const runtimeEnv = env(db, ORIGIN);
    const transport = installTransport();
    const started = await directStart(runtimeEnv);
    const state = new URL(started.action.url).searchParams.get('state')!;

    const batch = db.batch.bind(db);
    let lost = false;
    vi.spyOn(db, 'batch').mockImplementation(async statements => {
      const results = await batch(statements);
      if (!lost && statements[0]
        && (statements[0] as unknown as { sql: string }).sql.includes('INSERT INTO mutations')) {
        lost = true;
        throw new Error('injected accept acknowledgement loss');
      }
      return results;
    });

    expect((await worker.fetch(callback(state), runtimeEnv)).status).toBe(500);
    expect(db.sqlite.prepare(
      'SELECT used_at FROM oauth_attempts WHERE session_id=?',
    ).get(started.connectSessionId)).toEqual({ used_at: expect.any(String) });
    expect(db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM secret_blobs WHERE json_extract(owner,'$.kind')='callback'",
    ).get()).toEqual({ count: 1 });
    expect((await worker.fetch(callback(state), runtimeEnv)).status).toBe(409);

    const completed = await worker.fetch(post('/v1/connect', {
      type: 'resume',
      connectSessionId: started.connectSessionId,
      stepRevision: started.stepRevision,
      input: { type: 'callback_complete' },
    }, 'accept-lost-ack-complete'), runtimeEnv);
    expect(completed.status).toBe(200);
    expect((await responseBody(completed)).result.status).toBe('done');
    expect(transport.calls).toHaveLength(3);
    const replayedCompletion = await worker.fetch(post('/v1/connect', {
      type: 'resume',
      connectSessionId: started.connectSessionId,
      stepRevision: started.stepRevision,
      input: { type: 'callback_complete' },
    }, 'accept-lost-ack-replay'), runtimeEnv);
    expect(replayedCompletion.status).toBe(200);
    expect(transport.calls).toHaveLength(3);
    expect(db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM secret_blobs WHERE json_extract(owner,'$.kind')='callback'",
    ).get()).toEqual({ count: 1 });
  });

  it('does not initialize storage for malformed callbacks or unauthorized API requests', async () => {
    const db = new FakeD1();
    const runtimeEnv = env(db, ORIGIN);

    const malformed = await worker.fetch(new Request(`${ORIGIN}/oauth/callback/threads?code=x&state=short`), runtimeEnv);
    expect(malformed.status).toBe(400);
    expect(db.batches).toBe(0);

    const unauthorized = await worker.fetch(post('/v1/connect', {
      type: 'start',
      provider: 'threads',
      options: { redirectUri: REDIRECT_URI },
    }, 'unauthorized', false), runtimeEnv);
    expect(unauthorized.status).toBe(401);
    expect(db.batches).toBe(0);
  });
});
