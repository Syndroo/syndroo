import type { ProviderManifest, ProviderRegistry, ProviderTransport } from "@syndroo/core";
import { createNodeTransport, type NodeTransportDependencies } from "./node-transport.js";

/**
 * The transport a provider gets when no egress policy can be resolved for it.
 *
 * It answers every request with a `before_request` transport error, which is
 * unambiguous ("the request was never sent"), and performs no DNS, socket or
 * TLS work. A provider only ever receives a real transport once its own
 * manifest has declared where it may connect.
 */
export const failClosedTransport: ProviderTransport = {
  async request() {
    return { type: "transport_error", stage: "before_request", code: "PROVIDER_UNAVAILABLE" };
  },
};

/**
 * Response headers the official providers must be able to read.
 *
 * LinkedIn returns its created record id in `x-restli-id`; the others read only
 * `retry-after`, which the transport always exposes. The list is deliberately
 * tiny: every extra header is another value a plugin can observe.
 */
export const PROVIDER_RESPONSE_HEADERS = ["x-restli-id"] as const;

/**
 * Build the one transport a provider's declared egress policy allows.
 *
 * A fixed policy is an allowlist of canonical origins. A federated policy (a
 * fediverse instance chosen by the operator) cannot name its origin before the
 * call, so it permits any public HTTPS origin while every address, DNS-pinning,
 * redirect, header and size rule still applies. A policy that cannot be read
 * fails closed rather than guessing. `dependencies` is the same trusted
 * host/testing seam the transport itself documents, never provider input.
 */
export function createPolicyTransport(
  manifest: ProviderManifest | undefined,
  dependencies?: NodeTransportDependencies,
): ProviderTransport {
  const egress = manifest?.egress as { fixedOrigins?: unknown; federated?: unknown } | undefined;
  if (!egress || !Array.isArray(egress.fixedOrigins)) {
    return failClosedTransport;
  }
  try {
    return createNodeTransport({
      allowedOrigins: egress.fixedOrigins as string[],
      allowAnyPublicOrigin: egress.federated === true,
      responseHeaderNames: [...PROVIDER_RESPONSE_HEADERS],
    }, dependencies);
  } catch {
    return failClosedTransport;
  }
}

/** The catalog data a host needs to resolve a policy without importing a plugin. */
export type ProviderEgressSource = {
  readonly catalog: readonly { readonly provider: string; readonly manifest: ProviderManifest }[];
  readonly providers: Pick<ProviderRegistry, "describe">;
};

/**
 * Resolve one memoised policy transport per provider.
 *
 * An official provider is answered from the generated catalog data alone. A
 * configured third-party provider is asked for its saved manifest, so a host
 * still never imports plugin code to find out where it may connect. Anything
 * that cannot be resolved keeps the fail-closed transport.
 */
export function createProviderTransportResolver(
  source: ProviderEgressSource,
  dependencies?: NodeTransportDependencies,
): (provider: string) => Promise<ProviderTransport> {
  const transports = new Map<string, ProviderTransport>();
  const resolving = new Map<string, Promise<ProviderTransport>>();
  return async (providerId: string): Promise<ProviderTransport> => {
    const ready = transports.get(providerId);
    if (ready) return ready;
    const inFlight = resolving.get(providerId);
    if (inFlight) return inFlight;
    const pending = (async (): Promise<ProviderTransport> => {
      let manifest: ProviderManifest | undefined = source.catalog.find(
        (entry) => entry.provider === providerId,
      )?.manifest;
      if (!manifest) {
        try {
          manifest = (await source.providers.describe(providerId)).manifest;
        } catch {
          manifest = undefined;
        }
      }
      const transport = createPolicyTransport(manifest, dependencies);
      transports.set(providerId, transport);
      resolving.delete(providerId);
      return transport;
    })();
    resolving.set(providerId, pending);
    return pending;
  };
}
