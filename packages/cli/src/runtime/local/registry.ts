import { ProtocolError } from "@syndroo/core";
import type {
  LoadedProvider,
  ProviderId,
  ProviderRegistry,
  ProviderView,
} from "@syndroo/core";

/**
 * The registry a machine with no configuration file uses.
 *
 * The default config file may legitimately be absent: `status`, `--help` and
 * `--version` need no provider resolution. This registry answers from a saved
 * catalog that is always empty, so `status` still returns a complete envelope
 * without a configuration file, and any command that actually needs a provider
 * fails closed with `PROVIDER_UNAVAILABLE`. It imports no plugin and performs
 * no I/O.
 */
export function createUnconfiguredRegistry(): ProviderRegistry {
  function view(provider: ProviderId): ProviderView {
    return {
      provider,
      provenance: "third_party",
      availability: "unavailable",
    };
  }

  return {
    async describe(provider: ProviderId): Promise<ProviderView> {
      return view(provider);
    },
    async list() {
      return [];
    },
    async load(): Promise<LoadedProvider> {
      throw new ProtocolError("PROVIDER_UNAVAILABLE");
    },
  };
}
