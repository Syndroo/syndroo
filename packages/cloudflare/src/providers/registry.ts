import type * as T from '@syndroo/core';
import { canonicalJson, ProtocolError } from '@syndroo/core';
import bluesky from '@syndroo/provider-bluesky';
import devto from '@syndroo/provider-devto';
import linkedin from '@syndroo/provider-linkedin';
import mastodon from '@syndroo/provider-mastodon';
import threads from '@syndroo/provider-threads';
import { digest } from '../crypto.js';
import { catalog } from './catalog.js';
import * as compiled from './validators.js';

const plugins: Record<string, T.ProviderPlugin> = { bluesky, devto, linkedin, mastodon, threads };
const entries = new Map<string, (typeof catalog)[number]>(catalog.map(entry => [entry.provider, entry]));
const names = ['connectOptions', 'credentialInput', 'content', 'publishOptions'] as const;

export function createOfficialRegistry(): T.ProviderRegistry {
  async function implementation(entry: (typeof catalog)[number]): Promise<T.Implementation> {
    return {
      provider: entry.provider, packageName: entry.packageName, version: entry.manifest.version,
      apiVersion: 1, artifactFingerprint: entry.artifactFingerprint,
      schemaFingerprint: await digest(entry.manifest.schemas as unknown as T.Json),
    };
  }
  return {
    async describe(provider) {
      const entry = entries.get(provider);
      if (!entry) throw new ProtocolError('PROVIDER_UNAVAILABLE');
      return { provider, provenance: 'official', availability: 'available',
        implementation: await implementation(entry), manifest: entry.manifest as unknown as T.ProviderManifest };
    },
    async list() {
      return Promise.all(catalog.map(async entry => ({
        provider: entry.provider, provenance: 'official' as const, availability: 'available' as const,
        implementation: await implementation(entry),
      })));
    },
    async load(provider) {
      const entry = entries.get(provider);
      const plugin = plugins[provider];
      if (!entry || !plugin || canonicalJson(plugin.manifest) !== canonicalJson(entry.manifest))
        throw new ProtocolError('PROVIDER_UNAVAILABLE');
      const validators = Object.fromEntries(names.map(name => {
        const check = compiled[`${provider}_${name}` as keyof typeof compiled];
        if (typeof check !== 'function') throw new ProtocolError('PROVIDER_INVALID');
        return [name, (value: unknown) => check(value) as boolean];
      })) as T.LoadedProvider['validators'];
      return { plugin, implementation: await implementation(entry), validators };
    },
  };
}
