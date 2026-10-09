import { describe, expect, it } from 'vitest';
import worker from '../src/worker.js';
import type { WorkerEnv } from '../src/worker.js';
import { createOfficialRegistry } from '../src/providers/registry.js';
import { createD1Storage } from '../src/secrets.js';
import { FakeD1 } from './fake-d1.js';

const TOKEN = 't'.repeat(48);
function env(db = new FakeD1()): WorkerEnv {
  return { DB: db, WORK_QUEUE: { async send() {} }, SCOPE: 'fixture',
    QUEUE_NAME: 'syndroo-work', DLQ_NAME: 'syndroo-dead',
    SECRET_KEY: '11'.repeat(32), RUNTIME_KEY: '22'.repeat(32),
    API_BEARER: TOKEN, PUBLIC_FETCH_STRICT: 'enabled' };
}
function request(path: string, body?: string, authorized = true): Request {
  return new Request(`https://syndroo.example${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body }),
    headers: { ...(authorized ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  });
}

describe('Worker composition in offline fetch fixture', () => {
  it('serves public health and keeps unauthorized requests out of storage', async () => {
    const db = new FakeD1();
    const config = env(db);
    expect((await worker.fetch(request('/health'), config)).status).toBe(200);
    expect((await worker.fetch(request('/v1/status', '{}', false), config)).status).toBe(401);
    expect(db.batches).toBe(0);
    await createD1Storage({ db, scope: 'fixture', key: config.SECRET_KEY });
    const before = db.batches;
    expect((await worker.fetch(request('/v1/status', '{"type":"overview"}'), config)).status).toBe(200);
    expect(db.batches).toBe(before);
  });

  it('fails startup when mandatory auth, key or egress configuration is absent', async () => {
    const config = env();
    expect((await worker.fetch(request('/health'), { ...config, API_BEARER: '' })).status).toBe(503);
    expect((await worker.fetch(request('/health'), { ...config, SECRET_KEY: '' })).status).toBe(503);
    expect((await worker.fetch(request('/health'), { ...config, PUBLIC_FETCH_STRICT: '' as 'enabled' })).status).toBe(503);
  });

  it('uses explicit built-in implementations and standalone validators for all five providers', async () => {
    const registry = createOfficialRegistry();
    expect((await registry.list()).map(provider => provider.provider))
      .toEqual(['bluesky', 'devto', 'linkedin', 'mastodon', 'threads']);
    for (const id of ['bluesky', 'devto', 'linkedin', 'mastodon', 'threads']) {
      const loaded = await registry.load(id);
      expect(loaded.implementation.artifactFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(loaded.validators.connectOptions({})).toBeTypeOf('boolean');
    }
    await expect(registry.load('untrusted')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('acknowledges DLQ and unrecognized queue deliveries without publishing', async () => {
    const config = env();
    let acknowledged = 0;
    const batch = (queue: string) => ({ queue, messages: [{
      body: { scope: 'fixture', operationId: 'op_one', executionRevision: 0 },
      ack() { acknowledged++; }, retry() { throw Error('unexpected retry'); },
    }] });
    await worker.queue(batch(config.DLQ_NAME), config);
    await worker.queue(batch('unknown-queue'), config);
    expect(acknowledged).toBe(2);
  });
});
