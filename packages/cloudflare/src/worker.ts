import { canonicalJson, createCore, ProtocolError } from '@syndroo/core';
import type * as T from '@syndroo/core';
import {
  createHttpHandler, inspectOAuthCallback, normalizeOAuthConfig, OAuthCallbackAdapter,
} from '@syndroo/server/http';
import type { NormalizedOAuthConfig } from '@syndroo/server/http';
import {
  resolveAuthConfig, selectRequestRole,
} from './auth.js';
import type { AuthConfig, RequestRole } from './auth.js';
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
  PUBLIC_ORIGIN?: string;
  CI_BEARER?: string;
  CI_CONNECTION_ID?: string;
  /** Deployment must also set Wrangler's global_fetch_strictly_public flag. */
  PUBLIC_FETCH_STRICT: 'enabled';
};

function oauthConfig(env: WorkerEnv): NormalizedOAuthConfig | null {
  if (env.PUBLIC_ORIGIN === undefined) return null;
  const config = normalizeOAuthConfig({
    publicOrigin: env.PUBLIC_ORIGIN,
    providers: ['threads'],
  });
  if (!config || env.PUBLIC_ORIGIN !== config.publicOrigin
    || new URL(config.publicOrigin).protocol !== 'https:') {
    throw new ProtocolError('STORAGE_CONFIG_INVALID');
  }
  return config;
}

function assertEnv(env: WorkerEnv): AuthConfig {
  if (!env || !env.DB || !env.WORK_QUEUE || typeof env.WORK_QUEUE.send !== 'function'
    || typeof env.API_BEARER !== 'string' || env.API_BEARER.length < 32
    || env.API_BEARER.length > 1024 || !/^[A-Za-z0-9._~+/-]+$/.test(env.API_BEARER)
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(env.SCOPE)
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(env.QUEUE_NAME)
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(env.DLQ_NAME)
    || env.QUEUE_NAME === env.DLQ_NAME
    || env.PUBLIC_FETCH_STRICT !== 'enabled') throw new ProtocolError('STORAGE_CONFIG_INVALID');
  oauthConfig(env);
  keyBytes(env.SECRET_KEY).fill(0);
  keyBytes(env.RUNTIME_KEY).fill(0);
  return resolveAuthConfig(env);
}

function forbidden(): never {
  throw new ProtocolError('FORBIDDEN');
}

function ciPublishAllowed(input: T.PublishRequest, connectionId: string): void {
  if (input.type === 'execute') return;
  if ((input.type !== 'prepare' && input.type !== 'retry')
    || !Array.isArray(input.targets) || input.targets.length !== 1) forbidden();
  const target = input.targets[0];
  if (!target || typeof target !== 'object' || target.provider !== 'threads'
    || target.connection !== connectionId) forbidden();
}

function selectedRole(role: RequestRole | null): RequestRole {
  if (!role) forbidden();
  return role;
}

function contextFor<TContext extends T.CallContext>(context: TContext, role: RequestRole): TContext {
  return { ...context, principalId: role.principalId };
}

async function runtime(env: WorkerEnv, config: NormalizedOAuthConfig | null, readOnly = false) {
  const { state, credentials } = readOnly
    ? { state: new D1State({ db: env.DB, scope: env.SCOPE }),
      credentials: await D1Credentials.openExisting(env.DB, env.SCOPE, env.SECRET_KEY) }
    : await createD1Storage({ db: env.DB, scope: env.SCOPE, key: env.SECRET_KEY });
  const raw = keyBytes(env.RUNTIME_KEY);
  const hmac = await hmacKey(raw);
  raw.fill(0);
  const transport = createWorkerTransport();
  const now = () => new Date().toISOString();
  const entropy = { id: (prefix: string) => `${prefix}_${randomHex(16)}`, token: () => randomHex(32) };
  const oauthKey = keyBytes(env.RUNTIME_KEY);
  const oauth = config === null ? null : new OAuthCallbackAdapter(config, {
    attempts: state.database.oauthAttempts,
    state, credentials,
    clock: { now }, entropy, principalId: 'deployment-owner', key: oauthKey,
  });
  oauthKey.fill(0);
  const hash = async (value: T.Json) => digest(value);
  const sensitive = async (value: T.Json) => hex(new Uint8Array(await crypto.subtle.sign('HMAC', hmac,
    new TextEncoder().encode(canonicalJson(value)))));
  const deps: T.CoreDependencies = {
    state, credentials, providers: createOfficialRegistry(),
    clock: { now }, entropy,
    digests: { canonical: hash, sensitive },
    providerContext: (provider, signal) => {
      const base: T.ProviderContext = { now: now(), signal, transport };
      return oauth === null ? base : oauth.decorate(base, provider);
    },
    execution: { type: 'durable_async', notifier: {
      notify: work => env.WORK_QUEUE.send({ scope: env.SCOPE, ...work }),
    } },
  };
  const created = createCore(deps);
  const baseCore = created.core;
  const core: T.Core = oauth === null ? baseCore : {
    connect: (input, context) => oauth.runStart(
      input, context.signal, () => baseCore.connect(input, context),
    ),
    publish: baseCore.publish,
    status: baseCore.status,
  };
  return { ...created, core, state, oauth };
}

/** Worker entry. HTTP initializes storage only after the shared handler authenticates. */
const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    let auth: AuthConfig;
    try { auth = assertEnv(env); }
    catch { return new Response(null, { status: 503 }); }
    const config = oauthConfig(env);
    let initialized: ReturnType<typeof runtime> | undefined;
    let existing: ReturnType<typeof runtime> | undefined;
    let requestRole: RequestRole | null = null;
    const get = () => (initialized ??= runtime(env, config));
    const getExisting = () => (existing ??= runtime(env, config, true));
    const core: T.Core = {
      connect: async (input, context) => {
        const role = selectedRole(requestRole);
        if (role.type === 'ci') forbidden();
        return (await get()).core.connect(input, contextFor(context, role));
      },
      publish: (async (input: T.PublishRequest, context: T.CallContext) => {
        const role = selectedRole(requestRole);
        if (role.type === 'ci') ciPublishAllowed(input, role.connectionId);
        return (await get()).core.publish(
          input as T.PrepareRequest, contextFor(context, role),
        );
      }) as T.Core['publish'],
      status: (async (input: T.StatusRequest, context: T.CallContext) => {
        const role = selectedRole(requestRole);
        if (role.type === 'ci' && input.type !== 'operation') forbidden();
        return (await getExisting()).core.status(input, contextFor(context, role));
      }) as T.Core['status'],
    };
    return createHttpHandler({
      core, principalId: 'deployment-owner',
      authenticate: async authorization => {
        const role = await selectRequestRole(auth, authorization);
        if (!role) return false;
        requestRole = role;
        return true;
      },
      ...(config === null ? {} : {
        oauthCallback: async (request: Request, provider: string): Promise<Response> => {
          let requestUrl: URL;
          try { requestUrl = new URL(request.url); }
          catch { return new Response(null, { status: 400 }); }
          if (requestUrl.origin !== config.publicOrigin) return new Response(null, { status: 400 });
          const inspected = inspectOAuthCallback(request, provider, config);
          if (inspected instanceof Response) return inspected;
          try {
            const { oauth } = await get();
            if (!oauth) return new Response(null, { status: 500 });
            return await oauth.handle(request, provider);
          } catch {
            return new Response(null, { status: 500 });
          }
        },
      }),
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
    const { state, executor } = await runtime(env, oauthConfig(env));
    await consumeMessages({ messages: batch.messages, scope: env.SCOPE, state, executor,
      now: () => new Date().toISOString(), signal: new AbortController().signal });
  },
  async scheduled(_event: unknown, env: WorkerEnv): Promise<void> {
    assertEnv(env);
    const { state } = await runtime(env, oauthConfig(env));
    await scanPending({ scope: env.SCOPE, state, sender: env.WORK_QUEUE,
      ownerId: `cron_${randomHex(16)}`, now: new Date().toISOString(), limit: 100 });
  },
};

export default worker;
