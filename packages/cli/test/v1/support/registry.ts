import { ProtocolError } from "@syndroo/core";
import type * as T from "@syndroo/core";

import {
  createFakeProvider,
  FAKE_PROVIDER_VERSION,
} from "../../../../../tests/fixtures/providers/fake.js";

/**
 * The implementation record the injected registry reports for the fixture.
 *
 * Core compares a frozen implementation against the loaded one, so the same
 * object must be returned on every load. The two fingerprints are fixed,
 * well-formed digests; the fixture never publishes under a real provider.
 */
export const FAKE_IMPLEMENTATION: T.Implementation = {
  provider: "fake",
  packageName: "@syndroo/provider-fake",
  version: FAKE_PROVIDER_VERSION,
  apiVersion: 1,
  artifactFingerprint: "a".repeat(64),
  schemaFingerprint: "b".repeat(64),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural stand-ins for the fixture's four schemas.
 *
 * The real runtime compiles these with Ajv; the injected registry only has to
 * decide membership for the values the fake emits, so each predicate mirrors
 * the one schema property the fixture relies on (`canary` required, `text`
 * optional). `connectOptions` is closed, matching `additionalProperties: false`.
 */
const FAKE_VALIDATORS: T.LoadedProvider["validators"] = {
  connectOptions: (value) => isRecord(value) && Object.keys(value).length === 0,
  credentialInput: (value) => isRecord(value) && typeof value["canary"] === "string",
  content: (value) =>
    isRecord(value) &&
    (value["text"] === undefined || typeof value["text"] === "string"),
  publishOptions: (value) => isRecord(value),
};

/**
 * A `ProviderRegistry` over the deterministic fake plugin.
 *
 * The CLI composes Core from `LocalRuntimeOverrides.providers`/`.transport`,
 * exposing exactly this seam to a test. It is never reachable from a flag: the
 * shipped default registry loads no plugin until C3 declares allowed origins.
 */
export function fakeRegistry(
  plugin: T.ProviderPlugin = createFakeProvider(),
): T.ProviderRegistry {
  const view: T.ProviderView = {
    provider: "fake",
    availability: "available",
    provenance: "third_party",
    implementation: FAKE_IMPLEMENTATION,
    manifest: plugin.manifest,
  };

  return {
    async describe(provider): Promise<T.ProviderView> {
      if (provider === "fake") {
        return structuredClone(view);
      }

      return { provider, availability: "unavailable", provenance: "third_party" };
    },
    async list(): Promise<readonly Omit<T.ProviderView, "manifest">[]> {
      const { manifest: _manifest, ...rest } = view;

      return [rest];
    },
    async load(provider, _mode): Promise<T.LoadedProvider> {
      if (provider !== "fake") {
        throw new ProtocolError("PROVIDER_UNAVAILABLE");
      }

      return {
        plugin,
        implementation: FAKE_IMPLEMENTATION,
        validators: FAKE_VALIDATORS,
      };
    },
  };
}
