import { ProtocolError } from '@syndroo/core';
import { hmacKey } from './crypto.js';

const BEARER = /^[A-Za-z0-9._~+/-]{32,1024}$/;
const CONNECTION_ID = /^conn_[A-Za-z0-9._:-]{1,123}$/;

export type AuthEnvironment = {
  API_BEARER: string;
  CI_BEARER?: string;
  CI_CONNECTION_ID?: string;
};

export type AuthConfig =
  | { type: 'admin'; adminBearer: string }
  | { type: 'split'; adminBearer: string; ciBearer: string; connectionId: string };

export type RequestRole =
  | { type: 'admin'; principalId: 'deployment-owner' }
  | { type: 'ci'; principalId: string; connectionId: string };

function invalid(): never {
  throw new ProtocolError('STORAGE_CONFIG_INVALID');
}

/** Validate the optional pair as configuration, never as live request input. */
export function resolveAuthConfig(env: AuthEnvironment): AuthConfig {
  if (env.CI_BEARER === undefined && env.CI_CONNECTION_ID === undefined) {
    return { type: 'admin', adminBearer: env.API_BEARER };
  }
  if (typeof env.CI_BEARER !== 'string' || !BEARER.test(env.CI_BEARER)
    || typeof env.CI_CONNECTION_ID !== 'string' || !CONNECTION_ID.test(env.CI_CONNECTION_ID)
    || env.CI_BEARER === env.API_BEARER) invalid();
  return {
    type: 'split',
    adminBearer: env.API_BEARER,
    ciBearer: env.CI_BEARER,
    connectionId: env.CI_CONNECTION_ID,
  };
}

async function bearerMatches(candidate: string, expected: string): Promise<boolean> {
  if (candidate.length !== expected.length) return false;
  const fresh = crypto.getRandomValues(new Uint8Array(32));
  const key = await hmacKey(fresh);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(expected));
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(candidate));
}

/** Resolve exactly one request role; the caller must keep this value request-local. */
export async function selectRequestRole(
  config: AuthConfig,
  authorization: string | null,
): Promise<RequestRole | null> {
  if (!authorization || authorization.length > 1031 || !authorization.startsWith('Bearer ')) return null;
  const candidate = authorization.slice(7);
  if (await bearerMatches(candidate, config.adminBearer)) {
    return { type: 'admin', principalId: 'deployment-owner' };
  }
  if (config.type === 'split' && await bearerMatches(candidate, config.ciBearer)) {
    return {
      type: 'ci',
      principalId: `threads-ci:${config.connectionId}`,
      connectionId: config.connectionId,
    };
  }
  return null;
}
