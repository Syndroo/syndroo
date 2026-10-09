import { canonicalJson, createCore, ProtocolError } from '@syndroo/core';
import type * as T from '@syndroo/core';
import { createHttpHandler } from '@syndroo/server/http';
import type { D1Database } from './d1.js';
import { digest, hmacKey, keyBytes, randomHex, hex } from './crypto.js';
import { createOfficialRegistry } from './providers/registry.js';
import { consumeMessages, scanPending } from './queue.js';
import { createD1Storage, D1Credentials } from './secrets.js';
import { D1State } from './state/state.js';
import { createWorkerTransport } from './transport.js';

export type WorkerEnv = {
  DB: D1Database;
  WORK_QUEUE: { send(body: { scope: string; operationId: string; executionRevision: number }): Promise<void> };
  QUEUE_NAME: string;
  DLQ_NAME: string;
  API_BEARER: string;
  SECRET_KEY: string;
  RUNTIME_KEY: string;
  SCOPE: string;
  /** Deployment must also set Wrangler's global_fetch_strictly_public flag. */
  PUBLIC_FETCH_STRICT: 'enabled';
};

function assertEnv(env: WorkerEnv): void {
  if (!env || !env.DB || !env.WORK_QUEUE || typeof env.WORK_QUEUE.send !== 'function'
    || typeof env.API_BEARER !== 'string' || env.API_BEARER.length < 32
    || env.API_BEARER.length > 1024 || !/^[A-Za-z0-9._~+/-]+$/.test(env.API_BEARER)
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(env.SCOPE)
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(env.QUEUE_NAME)
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(env.DLQ_NAME)
    || env.QUEUE_NAME === env.DLQ_NAME
    || env.PUBLIC_FETCH_STRICT !== 'enabled') throw new ProtocolError('STORAGE_CONFIG_INVALID');
  keyBytes(env.SECRET_KEY).fill(0);
  keyBytes(env.RUNTIME_KEY).fill(0);
}

async function authenticate(authorization: string | null, expected: string): Promise<boolean> {
  if (!authorization || authorization.length > 1031 || !authorization.startsWith('Bearer ')) return false;
  const candidate = authorization.slice(7);
  if (candidate.length !== expected.length) return false;
  const fresh = crypto.getRandomValues(new Uint8Array(32));
  const key = await hmacKey(fresh);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(expected));
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(candidate));
}

async function runtime(env: WorkerEnv, readOnly = false) {
  const { state, credentials } = readOnly
    ? { state: new D1State({ db: env.DB, scope: env.SCOPE }),
      credentials: await D1Credentials.openExisting(env.DB, env.SCOPE, env.SECRET_KEY) }
    : await createD1Storage({ db: env.DB, scope: env.SCOPE, key: env.SECRET_KEY });
  const raw = keyBytes(env.RUNTIME_KEY);
  const hmac = await hmacKey(raw);
  raw.fill(0);
  const transport = createWorkerTransport();
  const now = () => new Date().toISOString();
  const hash = async (value: T.Json) => digest(value);
  const sensitive = async (value: T.Json) => hex(new Uint8Array(await crypto.subtle.sign('HMAC', hmac,
    new TextEncoder().encode(canonicalJson(value)))));
  const deps: T.CoreDependencies = {
    state, credentials, providers: createOfficialRegistry(),
    clock: { now }, entropy: { id: prefix => `${prefix}_${randomHex(16)}`, token: () => randomHex(32) },
    digests: { canonical: hash, sensitive },
    providerContext: (_provider, signal) => ({ now: now(), signal, transport }),
    execution: { type: 'durable_async', notifier: {
      notify: work => env.WORK_QUEUE.send({ scope: env.SCOPE, ...work }),
    } },
  };
  return { ...createCore(deps), state };
}

/** Worker entry. HTTP initializes storage only after the shared handler authenticates. */
const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try { assertEnv(env); }
    catch { return new Response(null, { status: 503 }); }
    let initialized: ReturnType<typeof runtime> | undefined;
    let existing: ReturnType<typeof runtime> | undefined;
    const get = () => (initialized ??= runtime(env));
    const getExisting = () => (existing ??= runtime(env, true));
    const core: T.Core = {
      connect: (input, context) => get().then(({ core }) => core.connect(input, context)),
      publish: ((input: T.PublishRequest, context: T.CallContext) => get().then(({ core }) =>
        core.publish(input as T.PrepareRequest, context))) as T.Core['publish'],
      status: ((input: T.StatusRequest, context: T.CallContext) => getExisting().then(({ core }) =>
        core.status(input, context))) as T.Core['status'],
    };
    return createHttpHandler({
      core, principalId: 'deployment-owner',
      authenticate: authorization => authenticate(authorization, env.API_BEARER),
    })(request);
  },
  async queue(batch: { queue: string; messages: { body: unknown; ack(): void; retry(): void }[] }, env: WorkerEnv): Promise<void> {
    assertEnv(env);
    if (batch.queue !== env.QUEUE_NAME && batch.queue !== env.DLQ_NAME) {
      for (const message of batch.messages) message.ack();
      return;
    }
    if (batch.queue === env.DLQ_NAME) {
      for (const message of batch.messages) message.ack();
      return;
    }
    const { state, executor } = await runtime(env);
    await consumeMessages({ messages: batch.messages, scope: env.SCOPE, state, executor,
      now: () => new Date().toISOString(), signal: new AbortController().signal });
  },
  async scheduled(_event: unknown, env: WorkerEnv): Promise<void> {
    assertEnv(env);
    const { state } = await runtime(env);
    await scanPending({ scope: env.SCOPE, state, sender: env.WORK_QUEUE,
      ownerId: `cron_${randomHex(16)}`, now: new Date().toISOString(), limit: 100 });
  },
};

export default worker;
