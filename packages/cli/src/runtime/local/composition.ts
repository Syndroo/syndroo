import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCore } from "@syndroo/core";
import type {
  Clock,
  Core,
  CoreDependencies,
  Executor,
  ProviderContext,
  ProviderRegistry,
  ProviderTransport,
} from "@syndroo/core";

import type { ResolvedConfig } from "../../config.js";
import { createFilesystemRuntime } from "../filesystem/index.js";
import { LocalOAuthCallback } from "../oauth/callback.js";
import type { LocalOAuthCallbackOptions } from "../oauth/callback.js";
import { createProviderTransportResolver } from "../transport/policy.js";
import type { BuiltinProviderCatalogEntry } from "../providers/index.js";
import { createNodeProviderRuntime } from "../providers/index.js";
import { BUILTIN_PROVIDER_CATALOG } from "../providers/generated/catalog.js";
import { createLocalDigests } from "./digests.js";

/**
 * The CLI package root, found by walking up to the nearest directory that owns a
 * `package.json`.
 *
 * The published JavaScript is a bundle: this module no longer lives at
 * `src/runtime/local/composition.ts`, so a fixed relative climb would resolve
 * one level short inside `dist/bin.js`. Walking up finds the same directory in
 * the repository (`packages/cli`), in the compiled `dist` tree, and inside an
 * installed `node_modules/@syndroo/cli`.
 */
function packageRootOf(moduleUrl: string): string {
  const origin = path.dirname(fileURLToPath(moduleUrl));
  let directory = origin;

  for (;;) {
    if (existsSync(path.join(directory, "package.json"))) {
      return directory;
    }

    const parent = path.dirname(directory);

    if (parent === directory) {
      return path.resolve(origin, "..", "..", "..");
    }

    directory = parent;
  }
}

const CLI_PACKAGE_ROOT = packageRootOf(import.meta.url);

/**
 * The repository root that holds `packages/*`, derived from the CLI package
 * root. Inside a packed install this points into `node_modules` and matches
 * nothing, which is correct: the installed package wins there.
 */
const REPOSITORY_ROOT = path.resolve(CLI_PACKAGE_ROOT, "..", "..");

/** True when the path exists and is a directory. */
function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The installed `node_modules/<packageName>` directory, searched upwards the way
 * Node resolves it, or `undefined` when it is not installed.
 */
function installedPackageRoot(packageName: string): string | undefined {
  let directory = CLI_PACKAGE_ROOT;

  for (;;) {
    const candidate = path.join(directory, "node_modules", packageName);

    if (isDirectory(candidate)) {
      try {
        return realpathSync(candidate);
      } catch {
        return undefined;
      }
    }

    const parent = path.dirname(directory);

    if (parent === directory) {
      return undefined;
    }

    directory = parent;
  }
}

/**
 * Resolve one generated catalog entry to the absolute root the trust loader
 * inspects. Fixed order, never a silent mix:
 *
 *   1. the installed `@syndroo/provider-<id>` package, found from the CLI package
 *      root the way Node finds it. This is what a packed tarball uses, and in
 *      this repository the workspace symlink resolves to the same directory;
 *   2. the checkout path stored in the artifact (`packages/provider-<id>`
 *      joined with the repository root), which is the in-repository fallback.
 *
 * When neither exists the checkout path is returned unchanged, so the provider
 * still appears in `status` as `unavailable` instead of disappearing. There is
 * no third candidate and no implicit download.
 */
function resolveBuiltinRoot(entry: BuiltinProviderCatalogEntry): string {
  const installed = installedPackageRoot(entry.packageName);

  if (installed !== undefined) {
    return installed;
  }

  return path.resolve(REPOSITORY_ROOT, entry.resolvedRoot);
}

/**
 * The official providers, with absolute roots for this installation.
 *
 * This is generated data, not a runtime import of provider code: the manifest
 * already travelled through the generator, so `status`, `list` and `describe`
 * can serve an official provider without ever importing it (design section 8.4).
 */
export function createBuiltinCatalog(): readonly BuiltinProviderCatalogEntry[] {
  return BUILTIN_PROVIDER_CATALOG.map((entry) => ({
    ...entry,
    resolvedRoot: resolveBuiltinRoot(entry),
  }));
}

export type LocalRuntimeOverrides = {
  /** Injected provider registry/loader. Never reachable from a CLI flag. */
  readonly providers?: ProviderRegistry;
  /** Injected provider transport. Never reachable from a CLI flag. */
  readonly transport?: ProviderTransport;
  /**
   * Injected official-provider catalog, with absolute roots, replacing the
   * generated one. Never reachable from a CLI flag; it exists so a test can
   * point the real composition at a purpose-built package instead of a repo
   * build.
   */
  readonly catalog?: readonly BuiltinProviderCatalogEntry[];
  /**
   * The OAuth callback adapter's own settings. Never reachable from a CLI flag:
   * the redirect URI stays a command-line choice, while this exists so a test
   * can shrink the attempt TTL or move the loopback port.
   */
  readonly oauth?: {
    readonly providers?: readonly string[];
    readonly ttlMs?: number;
    readonly loopbackPort?: number;
  };
};

/**
 * The single identity every local call runs as.
 *
 * It lives here rather than in the command layer because the composition, not
 * the parser, owns who a local session belongs to.
 */
export const LOCAL_PRINCIPAL_ID = "local";

export type LocalRuntime = {
  readonly core: Core;
  readonly executor: Executor;
  readonly providers: ProviderRegistry;
  /**
   * The transport this composition would hand to the named provider, resolved
   * from the provider's own egress declaration. It exists so a test (and any
   * future diagnostic) can prove the egress policy without issuing a request.
   */
  readonly providerTransport: (provider: string) => Promise<ProviderTransport>;
  readonly stateRoot: string;
  readonly configFile: string;
  readonly configDirectory: string;
  readonly configured: boolean;
  /**
   * The local OAuth callback adapter.
   *
   * Construction is inert: no listener is bound and no file is written until a
   * connect step is armed and an `open_url` result is recorded.
   */
  readonly oauth: LocalOAuthCallback;
};

/**
 * Compose one local Core instance.
 *
 * Construction creates nothing: the filesystem runtime only records its root,
 * the provider runtime only validates its options, and the built-in catalog only
 * performs read-only existence checks to bind each official provider to the
 * installed package or to the checkout. Reads happen when a command asks for
 * them, and the state root is created by the first business write. That is what
 * lets `--help`, `--version` and `status` run on a machine that has never used
 * Syndroo.
 */
export function createLocalRuntime(
  config: ResolvedConfig,
  overrides: LocalRuntimeOverrides = {},
): LocalRuntime {
  const runtime = createFilesystemRuntime({ root: config.stateRoot });
  // The catalog is always wired in, even when the default config file is
  // absent: the official providers must be listed and their status readable on
  // a machine that has never written a config file, matching `--help`,
  // `--version` and an empty `status`. The loader tolerates the missing file and
  // treats it as "no overrides"; an explicit `providers` config entry still
  // replaces its catalog entry (including provenance), and a broken override
  // fails instead of falling back. Nothing here is executed at construction: the
  // provider runtime only validates its options, and filesystem reads happen
  // when a command asks for them.
  const catalog = overrides.catalog ?? createBuiltinCatalog();
  const providers =
    overrides.providers ??
    createNodeProviderRuntime({
      configFile: config.configFile,
      stateRoot: config.stateRoot,
      catalog,
    }).registry;
  // One policy transport per provider, resolved from the provider's own
  // declaration and memoised for the life of this composition.
  const transportFor = createProviderTransportResolver({ catalog, providers });
  const clock: Clock = runtime.clock;

  const oauthOptions: LocalOAuthCallbackOptions = {
    stateRoot: runtime.root,
    state: runtime.state,
    credentials: runtime.credentials,
    clock: runtime.clock,
    entropy: runtime.entropy,
    principalId: LOCAL_PRINCIPAL_ID,
    ...(overrides.oauth?.providers === undefined ? {} : { providers: overrides.oauth.providers }),
    ...(overrides.oauth?.ttlMs === undefined ? {} : { ttlMs: overrides.oauth.ttlMs }),
    ...(overrides.oauth?.loopbackPort === undefined ? {} : { loopbackPort: overrides.oauth.loopbackPort }),
  };
  const oauth = new LocalOAuthCallback(oauthOptions);

  /**
   * The provider context of one call, with the armed OAuth material merged in.
   *
   * Decoration is keyed by the call's own signal, so a call that did not arm the
   * adapter receives the plain context and the provider keeps its own behaviour.
   */
  const baseContext = overrides.transport
    ? (_provider: string, signal: AbortSignal): Promise<ProviderContext> =>
        Promise.resolve({ now: clock.now(), signal, transport: overrides.transport! })
    : async (provider: string, signal: AbortSignal): Promise<ProviderContext> => ({
        now: clock.now(),
        signal,
        transport: await transportFor(provider),
      });

  const dependencies: CoreDependencies = {
    state: runtime.state,
    credentials: runtime.credentials,
    providers,
    clock,
    entropy: runtime.entropy,
    digests: createLocalDigests({ stateRoot: runtime.root }),
    providerContext: async (provider, signal) =>
      oauth.decorateContext(await baseContext(provider, signal), provider),
    execution: { type: "foreground" },
  };

  const { core, executor } = createCore(dependencies);

  return {
    core,
    executor,
    providers,
    providerTransport: transportFor,
    stateRoot: runtime.root,
    configFile: config.configFile,
    configDirectory: config.configDirectory,
    configured: config.exists,
    oauth,
  };
}
