import { ProtocolError } from '@syndroo/core';
import type { CoreDependencies, ProviderRegistry } from '@syndroo/core';
import {
  createBuiltinCatalog,
  createNodeProviderRuntime,
  createProviderTransportResolver,
} from '@syndroo/cli/runtime';
import type {
  BuiltinProviderCatalogEntry,
  NodeTransportDependencies,
} from '@syndroo/cli/runtime';

/**
 * The Node provider half of a self-hosted deployment.
 *
 * The architecture keeps one implementation of the Node provider runtime: the
 * trust loader and the SSRF-hardened transport live in `@syndroo/cli/runtime`,
 * and a server deployment reuses them instead of growing a second one. This
 * module is the thin composition that turns an operator's config file and state
 * root into the two Core dependencies a deployment must inject:
 *
 * - `providers`, the registry that inspects, approves and imports plugin code;
 * - `providerContext`, which hands each provider the one transport its own
 *   declared egress policy allows.
 *
 * It performs no I/O beyond reading the provider selector when Core asks; the
 * filesystem state and the SQLite stores stay the server's own composition.
 */
export type NodeProviderCompositionOptions = {
  /** Absolute path of the provider config file (the CLI's `--config` format). */
  configFile: string;
  /** Absolute state root that holds plugin approval records. */
  stateRoot: string;
  /** Generated official catalog; the CLI's built-in catalog by default. */
  catalog?: readonly BuiltinProviderCatalogEntry[];
  /**
   * Trusted host/testing seam for the transport. It never carries provider or
   * operator input; production deployments leave it unset.
   */
  transportDependencies?: NodeTransportDependencies;
  /**
   * Trusted host/testing seam. Production deployments leave it unset and get
   * the Node trust loader from `@syndroo/cli/runtime`.
   */
  registry?: ProviderRegistry;
};

function invalid(): never {
  throw new Error('SERVER_CONFIG_INVALID');
}

export type NodeProviderComposition = {
  readonly providers: ProviderRegistry;
  readonly providerContext: CoreDependencies['providerContext'];
};

/** Every code the Node trust loader may raise (`ProviderLoaderCode`). */
const LOADER_CODES = new Set<string>([
  'PROVIDER_CONFIG_INVALID', 'PROVIDER_UNAVAILABLE', 'PROVIDER_METADATA_INVALID',
  'PROVIDER_ENTRYPOINT_INVALID', 'PROVIDER_ARTIFACT_INVALID', 'PROVIDER_DEPENDENCY_INVALID',
  'PROVIDER_TRUST_REQUIRED', 'PROVIDER_APPROVAL_INVALID', 'PROVIDER_STATE_INVALID',
  'PROVIDER_DURABILITY_ERROR', 'PROVIDER_INVALID', 'PROVIDER_ID_MISMATCH',
  'PROVIDER_VERSION_MISMATCH', 'PROVIDER_API_INCOMPATIBLE', 'PROVIDER_SCHEMA_INVALID',
  'PROVIDER_IMPORT_FAILED', 'PROVIDER_RESTART_REQUIRED',
]);

/**
 * Re-raise a foreign copy's protocol error as this package's own type.
 *
 * Every published host package inlines its own private copy of
 * `@syndroo/core`, so an error thrown by the CLI's trust loader is not an
 * `instanceof` this deployment's `ProtocolError`; the shared handler would
 * downgrade it to `DURABILITY_ERROR`. The contract is the error code, and the
 * codes the loader may raise are a fixed list, so translate exactly those and
 * leave every other error untouched.
 */
function translateLoaderErrors<T>(work: () => Promise<T>): Promise<T> {
  return work().catch((error: unknown) => {
    const code = (error as { readonly code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && LOADER_CODES.has(code)) throw new ProtocolError(code);
    throw error;
  });
}

function translateRegistry(registry: ProviderRegistry): ProviderRegistry {
  return {
    describe: (provider) => translateLoaderErrors(() => registry.describe(provider)),
    list: () => translateLoaderErrors(() => registry.list()),
    load: (provider, mode) => translateLoaderErrors(() => registry.load(provider, mode)),
  };
}

export function createNodeProviderComposition(
  options: NodeProviderCompositionOptions,
): NodeProviderComposition {
  if (!options || typeof options !== 'object'
    || typeof options.configFile !== 'string' || !options.configFile.startsWith('/')
    || typeof options.stateRoot !== 'string' || !options.stateRoot.startsWith('/')
    || (options.catalog !== undefined && !Array.isArray(options.catalog))) {
    invalid();
  }
  const catalog = options.catalog ?? createBuiltinCatalog();
  const providers = translateRegistry(options.registry ?? createNodeProviderRuntime({
    configFile: options.configFile,
    stateRoot: options.stateRoot,
    catalog,
  }).registry);
  const transportFor = createProviderTransportResolver({ catalog, providers }, options.transportDependencies);
  const now = () => new Date().toISOString();
  return {
    providers,
    providerContext: async (provider, signal) => ({
      now: now(),
      signal,
      transport: await transportFor(provider),
    }),
  };
}
