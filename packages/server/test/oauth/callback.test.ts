import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type * as T from '@syndroo/core';
import { createSelfHostedRuntime, type SelfHostedOptions } from '../../src/compose/index.js';

const roots: string[] = [];
const runtimes: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

type Seen = {
  authorize: { url: string; state: string; redirectUri: string; codeChallenge: string }[];
  callbacks: T.CallbackEvidence[];
};

/** A provider whose only connect path is the browser callback. */
function plugin(id: string, seen: Seen): T.ProviderPlugin {
  const account: T.AccountIdentity = { provider: id, accountId: 'acct_1', origin: 'https://social.example' };
  return {
    manifest: {
      id, name: id, version: '1.0.0', apiVersion: 1, declaredCapabilities: ['text'],
      egress: { fixedOrigins: ['https://social.example'] },
      schemas: { connectOptions: {}, credentialInput: {}, content: {}, publishOptions: {} },
    },
    connect: {
      async run(input, context): Promise<T.ProviderConnectResult> {
        if (input.type === 'start') {
          const oauth = context.oauth;
          if (!oauth || !oauth.codeChallenge) throw new Error('oauth_material_missing');
          const url = `https://auth.example/authorize?state=${encodeURIComponent(oauth.state)}`
            + `&code_challenge=${encodeURIComponent(oauth.codeChallenge)}&code_challenge_method=S256`;
          seen.authorize.push({
            url, state: oauth.state, redirectUri: oauth.redirectUri, codeChallenge: oauth.codeChallenge,
          });
          return {
            status: 'action_required', action: { type: 'open_url', url },
            privateState: { state: oauth.state, redirectUri: oauth.redirectUri, codeVerifier: oauth.codeVerifier ?? null },
          };
        }
        if (input.input.type !== 'callback') throw new Error('callback_required');
        const evidence = input.input.evidence;
        const material = input.privateState;
        if (evidence.state !== material.state || evidence.redirectUri !== material.redirectUri) {
          throw new Error('state_mismatch');
        }
        if (context.oauth && (context.oauth.state !== evidence.state || context.oauth.redirectUri !== evidence.redirectUri)) {
          throw new Error('context_mismatch');
        }
        seen.callbacks.push(structuredClone(evidence));
        return { status: 'done', credentials: { accessToken: `token-${evidence.code}` }, identity: { account, evidence: [] } };
      },
      async verify(): Promise<T.VerifiedIdentity> {
        return { account, evidence: [] };
      },
    },
    freeze(input) {
      return {
        payloadVersion: 1, payload: { text: input.content.text ?? '' },
        effectiveContent: input.content, effectiveOptions: input.options,
        preview: { content: input.content, fields: [] },
      };
    },
    async publish() {
      return { status: 'failed', disposition: 'not_applied', retryable: false, reason: 'unsupported' };
    },
  };
}

function registry(plugin: T.ProviderPlugin): T.ProviderRegistry {
  const implementation: T.Implementation = {
    provider: plugin.manifest.id, packageName: `@syndroo/provider-${plugin.manifest.id}`,
    version: plugin.manifest.version, apiVersion: 1,
    artifactFingerprint: `artifact-${plugin.manifest.id}`, schemaFingerprint: `schema-${plugin.manifest.id}`,
  };
  const loaded: T.LoadedProvider = {
    plugin, implementation,
    validators: {
      connectOptions: () => true, credentialInput: () => true, content: () => true, publishOptions: () => true,
    },
  };
  return {
    async describe(provider: string) {
      if (provider !== plugin.manifest.id) throw new Error('PROVIDER_UNAVAILABLE');
      return { provider, availability: 'available', provenance: 'official', implementation, manifest: plugin.manifest };
    },
    async list() {
      return [{ provider: plugin.manifest.id, availability: 'available', provenance: 'official', implementation }];
    },
    async load(provider: string) {
      if (provider !== plugin.manifest.id) throw new Error('PROVIDER_UNAVAILABLE');
      return { ...loaded, implementation: structuredClone(implementation) };
    },
  };
}

async function config(oauth?: SelfHostedOptions['oauth']): Promise<{ options: SelfHostedOptions; seen: Seen }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'syndroo-oauth-')));
  roots.push(root);
  const seen: Seen = { authorize: [], callbacks: [] };
  const plugins = ['fake', 'other'].map(id => plugin(id, seen));
  const registries = new Map(plugins.map(entry => [entry.manifest.id, registry(entry)]));
  return {
    seen,
    options: {
      bearerSecret: randomBytes(32).toString('base64url'),
      statePath: path.join(root, 'state.db'),
      secretsPath: path.join(root, 'secrets.db'),
      secretStoreKey: randomBytes(32).toString('hex'),
      providers: {
        describe: provider => registries.get(provider)!.describe(provider),
        list: async () => (await Promise.all([...registries.values()].map(entry => entry.list()))).flat(),
        load: provider => registries.get(provider)!.load(provider),
      },
      providerContext: (_provider, signal) => ({
        now: new Date().toISOString(), signal,
        transport: { async request() { throw new Error('no network'); } },
      }),
      ...(oauth === undefined ? {} : { oauth }),
    },
  };
}

async function setup(oauth?: SelfHostedOptions['oauth']) {
  const { options, seen } = await config(oauth ?? { publicOrigin: 'https://syndroo.example', providers: ['fake', 'other'] });
  const runtime = createSelfHostedRuntime(options);
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const address = runtime.server.address();
  if (!address || typeof address === 'string') throw Error('no test port');
  const result = {
    ...runtime, options, seen,
    base: `http://127.0.0.1:${address.port}`,
    auth: { authorization: `Bearer ${options.bearerSecret}`, 'content-type': 'application/json' },
  };
  runtimes.push(result);
  return result;
}

type Started = { connectSessionId: string; stepRevision: number; action: { type: string; url: string } };

let keys = 0;
function nextKey(): string { return `key_${++keys}_${Date.now()}`; }

async function start(r: Awaited<ReturnType<typeof setup>>, provider = 'fake'): Promise<Started> {
  const response = await fetch(`${r.base}/v1/connect`, {
    method: 'POST',
    headers: { ...r.auth, 'idempotency-key': nextKey() },
    body: JSON.stringify({ type: 'start', provider }),
  });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.result.status).toBe('action_required');
  return body.result as Started;
}

function stateOf(started: Started): string {
  return new URL(started.action.url).searchParams.get('state')!;
}

async function resume(r: Awaited<ReturnType<typeof setup>>, started: Started, key = nextKey()) {
  return fetch(`${r.base}/v1/connect`, {
    method: 'POST', headers: { ...r.auth, 'idempotency-key': key },
    body: JSON.stringify({
      type: 'resume', connectSessionId: started.connectSessionId,
      stepRevision: started.stepRevision, input: { type: 'callback_complete' },
    }),
  });
}

it('a verified browser callback drives the exchange and the client only asks for status', async () => {
  const r = await setup();
  const started = await start(r);
  const state = stateOf(started);
  expect(r.seen.authorize).toHaveLength(1);
  expect(r.seen.authorize[0]!.redirectUri).toBe('https://syndroo.example/oauth/callback/fake');

  const callback = await fetch(`${r.base}/oauth/callback/fake?code=code_one&state=${encodeURIComponent(state)}`);
  expect(callback.status).toBe(200);
  expect(callback.headers.get('cache-control')).toBe('no-store');
  expect(callback.headers.get('referrer-policy')).toBe('no-referrer');
  const text = await callback.text();
  expect(text).not.toContain('code_one');
  expect(text).not.toContain(state);

  const pending = await resume(r, started);
  expect(pending.status).toBe(200);
  const body = await pending.json();
  expect(body.result.status).toBe('done');
  // A repeated resume replays the recorded result and never exchanges again.
  const replayed = await resume(r, started);
  expect(replayed.status).toBe(200);
  expect((await replayed.json()).result).toEqual(body.result);
  expect(r.seen.callbacks).toEqual([{
    code: 'code_one', state, issuer: 'https://auth.example',
    redirectUri: 'https://syndroo.example/oauth/callback/fake',
  }]);
  const connections = await (await fetch(`${r.base}/v1/status`, {
    method: 'POST', headers: r.auth, body: JSON.stringify({ type: 'connections' }),
  })).json();
  expect(connections.result.connections).toHaveLength(1);
  expect(JSON.stringify(connections)).not.toContain('code_one');
});

it('callback_complete alone is not authentication evidence', async () => {
  const r = await setup();
  const started = await start(r);
  const pending = await resume(r, started);
  expect(pending.status).toBe(200);
  const body = await pending.json();
  expect(body.result.status).toBe('action_required');
  expect(body.result.action.type).toBe('open_url');
  expect(r.seen.callbacks).toEqual([]);
});

it('a forged state is rejected and leaves the real attempt usable', async () => {
  const r = await setup();
  const started = await start(r);
  const state = stateOf(started);
  const forged = await fetch(`${r.base}/oauth/callback/fake?code=code_one&state=${encodeURIComponent('x'.repeat(43))}`);
  expect(forged.status).toBe(404);
  expect(r.seen.callbacks).toEqual([]);

  const callback = await fetch(`${r.base}/oauth/callback/fake?code=code_one&state=${encodeURIComponent(state)}`);
  expect(callback.status).toBe(200);
  expect((await resume(r, started)).status).toBe(200);
  expect(r.seen.callbacks).toHaveLength(1);
});

it('a duplicate callback is rejected and never exchanges twice', async () => {
  const r = await setup();
  const started = await start(r);
  const state = stateOf(started);
  const url = `${r.base}/oauth/callback/fake?code=code_one&state=${encodeURIComponent(state)}`;
  expect((await fetch(url)).status).toBe(200);
  expect((await fetch(url)).status).toBe(409);
  const key = nextKey();
  const first = await resume(r, started, key);
  expect(first.status).toBe(200);
  const firstBody = await first.json();
  const replayed = await resume(r, started, key);
  expect(replayed.status).toBe(200);
  expect(await replayed.json()).toEqual(firstBody);
  const withAnotherKey = await resume(r, started);
  expect(withAnotherKey.status).toBe(200);
  expect(await withAnotherKey.json()).toEqual(firstBody);
  expect(r.seen.callbacks).toHaveLength(1);
});

it('concurrent callbacks for one state admit exactly one', async () => {
  const r = await setup();
  const started = await start(r);
  const state = stateOf(started);
  const responses = await Promise.all([
    fetch(`${r.base}/oauth/callback/fake?code=code_a&state=${encodeURIComponent(state)}`),
    fetch(`${r.base}/oauth/callback/fake?code=code_b&state=${encodeURIComponent(state)}`),
  ]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  expect((await resume(r, started)).status).toBe(200);
  expect(r.seen.callbacks).toHaveLength(1);
});

it('a callback for the wrong provider is rejected', async () => {
  const r = await setup();
  const started = await start(r, 'fake');
  const state = stateOf(started);
  const wrong = await fetch(`${r.base}/oauth/callback/other?code=code_one&state=${encodeURIComponent(state)}`);
  expect(wrong.status).toBe(409);
  const unconfigured = await fetch(`${r.base}/oauth/callback/absent?code=code_one&state=${encodeURIComponent(state)}`);
  expect(unconfigured.status).toBe(404);
  expect(r.seen.callbacks).toEqual([]);
});

it('an expired attempt is rejected before any exchange', async () => {
  const r = await setup();
  const started = await start(r);
  const state = stateOf(started);
  const observer = new DatabaseSync(r.options.statePath);
  try {
    observer.prepare('UPDATE oauth_attempts SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
  } finally { observer.close(); }
  const callback = await fetch(`${r.base}/oauth/callback/fake?code=code_one&state=${encodeURIComponent(state)}`);
  expect(callback.status).toBe(400);
  expect(r.seen.callbacks).toEqual([]);
});

it('the callback route requires only a well-formed single state and code', async () => {
  const r = await setup();
  const started = await start(r);
  const state = stateOf(started);
  const cases = [
    `${r.base}/oauth/callback/fake?state=${encodeURIComponent(state)}`,
    `${r.base}/oauth/callback/fake?code=code_one`,
    `${r.base}/oauth/callback/fake?code=code_one&state=${encodeURIComponent(state)}&state=${encodeURIComponent(state)}`,
    `${r.base}/oauth/callback/fake?code=code_one&state=${encodeURIComponent(state)}&extra=1`,
    `${r.base}/oauth/callback/fake?error=access_denied&state=${encodeURIComponent(state)}`,
    `${r.base}/oauth/callback/fake?code=${'c'.repeat(2049)}&state=${encodeURIComponent(state)}`,
  ];
  for (const url of cases) expect((await fetch(url)).status).toBe(400);
  const posted = await fetch(`${r.base}/oauth/callback/fake`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  expect(posted.status).toBe(405);
  expect(r.seen.callbacks).toEqual([]);
});

it('an incomplete OAuth module refuses to start and creates no storage', async () => {
  for (const oauth of [
    { publicOrigin: 'https://syndroo.example' },
    { publicOrigin: 'https://syndroo.example', providers: [] },
    { publicOrigin: 'http://syndroo.example', providers: ['fake'] },
    { publicOrigin: 'https://syndroo.example', providers: ['fake'], ttlMs: 1000 },
    { publicOrigin: 'https://syndroo.example', providers: ['fake'], extra: true },
  ]) {
    const { options } = await config(oauth as SelfHostedOptions['oauth']);
    expect(() => createSelfHostedRuntime(options)).toThrowError('SERVER_CONFIG_INVALID');
    await expect(fs.stat(options.statePath)).rejects.toThrow();
    await expect(fs.stat(options.secretsPath)).rejects.toThrow();
  }
});

it('without the OAuth module the callback path stays a plain 404', async () => {
  const { options, seen } = await config();
  const runtime = createSelfHostedRuntime(options);
  runtimes.push(runtime);
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const address = runtime.server.address();
  if (!address || typeof address === 'string') throw Error('no test port');
  const response = await fetch(`http://127.0.0.1:${address.port}/oauth/callback/fake?code=x&state=y`);
  expect(response.status).toBe(404);
  expect(seen.authorize).toEqual([]);
});
