import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ProviderHttpRequest } from '@syndroo/provider-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { BuiltinProviderCatalogEntry } from '@syndroo/cli/runtime';
import { createNodeProviderComposition } from '../../src/compose/node-provider.js';

/**
 * The Node provider composition a self-hosted deployment injects.
 *
 * It must reuse the CLI runtime pieces (trust loader + SSRF-hardened
 * transport), resolve each provider's declared egress policy, and stay
 * fail-closed for anything it cannot resolve. No request leaves the process:
 * the transport's trusted seam supplies the DNS answer.
 */

const request = (url: string): ProviderHttpRequest => ({
  url, method: 'GET', signal: new AbortController().signal,
});

const MANIFEST = {
  id: 'offline', name: 'Offline', version: '1.0.0', apiVersion: 1 as const,
  declaredCapabilities: ['text' as const],
  egress: { fixedOrigins: ['https://provider.invalid'] },
  schemas: {
    connectOptions: { type: 'object' }, credentialInput: { type: 'object' },
    content: { type: 'object' }, publishOptions: { type: 'object' },
  },
};

let workDir = '';

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(tmpdir(), 'syndroo-server-providers-'));
});

afterAll(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

async function composition(
  catalog: readonly BuiltinProviderCatalogEntry[],
  lookup: (hostname: string) => Promise<readonly { address: string; family: number }[]> = async () => [],
) {
  const root = await fs.mkdtemp(path.join(workDir, 'case-'));
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, '{}\n');
  return createNodeProviderComposition({
    configFile,
    stateRoot: path.join(root, 'state'),
    catalog,
    transportDependencies: { lookup, connect: vi.fn() },
  });
}

/** Built after `beforeAll`: the root has to exist before it can be absolute. */
function catalog(): readonly BuiltinProviderCatalogEntry[] {
  return [{
    provider: 'offline',
    packageName: '@syndroo/provider-offline',
    resolvedRoot: path.join(workDir, 'packages', 'provider-offline'),
    artifactFingerprint: '0'.repeat(64),
    manifest: MANIFEST,
  }];
}

describe('self-hosted Node provider composition', () => {
  it('hands a provider the transport its own declaration allows', async () => {
    const composed = await composition(catalog());
    const context = await composed.providerContext('offline', new AbortController().signal);

    expect(await context.transport.request(request('https://undeclared.example/x'))).toEqual({
      type: 'transport_error', stage: 'before_request', code: 'ORIGIN_NOT_ALLOWED',
    });
  });

  it('keeps the address policy behind the allowlist', async () => {
    const lookup = vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }]);
    const composed = await composition(catalog(), lookup);
    const context = await composed.providerContext('offline', new AbortController().signal);

    expect(await context.transport.request(request('https://provider.invalid/x'))).toEqual({
      type: 'transport_error', stage: 'before_request', code: 'ADDRESS_NOT_ALLOWED',
    });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('stays fail-closed for a provider it cannot resolve, and never imports it', async () => {
    const composed = await composition(catalog());
    // The catalog entry is listed from data, without importing the artifact.
    expect(await composed.providers.list()).toMatchObject([
      { provider: 'offline', provenance: 'official', availability: 'unavailable' },
    ]);
    const context = await composed.providerContext('unconfigured', new AbortController().signal);

    expect(await context.transport.request(request('https://provider.invalid/x'))).toEqual({
      type: 'transport_error', stage: 'before_request', code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('refuses a relative config path instead of guessing one', async () => {
    const composed = await composition(catalog());
    expect(composed.providers).toBeTypeOf('object');
    expect(() => createNodeProviderComposition({ configFile: 'config.json', stateRoot: '/tmp' }))
      .toThrow('SERVER_CONFIG_INVALID');
    expect(() => createNodeProviderComposition({ configFile: '/tmp/config.json', stateRoot: 'state' }))
      .toThrow('SERVER_CONFIG_INVALID');
    expect(() => createNodeProviderComposition(
      { configFile: '/tmp/config.json', stateRoot: '/tmp', catalog: 'nope' as unknown as [] },
    )).toThrow('SERVER_CONFIG_INVALID');
  });
});

describe('cross-package error identity', () => {
  it('re-raises a foreign copy of a loader error as this package\'s ProtocolError', async () => {
    const { ProtocolError } = await import('@syndroo/core');
    const root = await fs.mkdtemp(path.join(workDir, 'identity-'));
    const configFile = path.join(root, 'config.json');
    await fs.writeFile(configFile, '{}\n');
    // A registry from another inlined copy of Core: same code, different class.
    const foreign = {
      describe: async () => { throw Object.assign(new Error('foreign'), { code: 'PROVIDER_TRUST_REQUIRED' }); },
      list: async () => [],
      load: async () => { throw Object.assign(new Error('foreign'), { code: 'PROVIDER_UNAVAILABLE' }); },
    };
    const composed = createNodeProviderComposition({
      configFile, stateRoot: path.join(root, 'state'), registry: foreign,
    });

    await expect(composed.providers.load('foreign')).rejects.toBeInstanceOf(ProtocolError);
    await expect(composed.providers.load('foreign')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    await expect(composed.providers.describe('foreign')).rejects.toBeInstanceOf(ProtocolError);

    // Anything outside the loader's own code list is not promoted.
    const stranger = {
      describe: async () => { throw Object.assign(new Error('boom'), { code: 'NOT_A_CODE' }); },
      list: async () => [],
      load: async () => { throw new Error('plain'); },
    };
    const other = createNodeProviderComposition({
      configFile, stateRoot: path.join(root, 'state'), registry: stranger,
    });
    await expect(other.providers.describe('x')).rejects.not.toBeInstanceOf(ProtocolError);
    await expect(other.providers.load('x')).rejects.toThrow('plain');
  });
});
