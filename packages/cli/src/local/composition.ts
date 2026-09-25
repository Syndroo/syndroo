import type { LocalProvider, LocalProviderId } from "@syndroo/core";

import { configError } from "../cli-error.js";
import { flagValue, type CommandContext } from "../commands/context.js";
import { resolveForExecution } from "./auth.js";
import {
  LOCAL_NAMESPACE_PATTERN,
  localConfigPath,
  readLocalConfig,
  resolveStateHome,
} from "./config.js";
import type { ConnectionRecord, LocalStore } from "./ports/local-store.js";
import { createLocalFileStore } from "./state/store.js";

/**
 * The one place the local command surface is wired together.
 *
 * Every local command builds its runtime here, so there is exactly one
 * production composition: two providers, the file store, and the credential
 * resolver. The optional overrides exist for tests only; no flag, environment
 * variable, or config field can reach them.
 */

export interface LocalRunOverrides {
  /** Test-only provider set. Replaces both providers together. */
  readonly providers?: Readonly<Record<LocalProviderId, LocalProvider>>;
  /** Test-only clock, shared with the store so TTLs are deterministic. */
  readonly clock?: () => Date;
}

export interface LocalRuntime {
  readonly stateHome: string;
  readonly configPath: string;
  /** The explicit `--namespace` override, when the command was given one. */
  readonly explicitNamespace: string | undefined;
  readonly store: LocalStore;
  readonly providers: Readonly<Record<LocalProviderId, LocalProvider>>;
  readonly clock: () => Date;
}

/** `--state-home`, else `$XDG_STATE_HOME`/`$HOME/.local/state`, then `syndroo`. */
export function localStateHome(
  context: CommandContext,
  overrides: LocalRunOverrides,
): string {
  void overrides;

  return resolveStateHome(
    context.io.env,
    flagValue(context, "state-home"),
    context.io.cwd,
  );
}

function localClock(overrides: LocalRunOverrides): () => Date {
  return overrides.clock ?? (() => new Date());
}

/**
 * Constructs the two local providers.
 *
 * The provider packages are imported lazily so a legacy remote command does not
 * pay for them, and so a broken optional install cannot take down `syndroo
 * version`. Construction itself is zero-network.
 */
export async function localProviders(
  overrides: LocalRunOverrides,
): Promise<Readonly<Record<LocalProviderId, LocalProvider>>> {
  if (overrides.providers !== undefined) {
    return overrides.providers;
  }

  const [bluesky, threads] = await Promise.all([
    import("@syndroo/bluesky"),
    import("@syndroo/threads"),
  ]);

  return {
    bluesky: new bluesky.BlueskyLocalProvider(),
    threads: new threads.ThreadsLocalProvider(),
  };
}

/** Builds the runtime without initializing anything on disk. */
export async function openLocalRuntime(
  context: CommandContext,
  overrides: LocalRunOverrides = {},
): Promise<LocalRuntime> {
  const clock = localClock(overrides);
  const stateHome = localStateHome(context, overrides);

  return {
    stateHome,
    configPath: localConfigPath(context.io.env),
    explicitNamespace: explicitNamespace(context),
    store: createLocalFileStore(stateHome, { now: clock }),
    providers: await localProviders(overrides),
    clock,
  };
}

/** Validates an explicit `--namespace`, or returns `undefined`. */
export function explicitNamespace(
  context: CommandContext,
): string | undefined {
  const value = flagValue(context, "namespace");

  if (value === undefined) {
    return undefined;
  }

  if (!LOCAL_NAMESPACE_PATTERN.test(value)) {
    throw configError("the requested namespace is not usable");
  }

  return value;
}

/**
 * The namespace this command works in: the explicit flag, else the saved config.
 *
 * A missing config is a usage error that points at `init`; it is never silently
 * replaced with a default namespace, because that would create a second
 * deduplication domain behind the operator's back.
 */
export async function requireNamespace(
  context: CommandContext,
  runtime: LocalRuntime,
): Promise<string> {
  if (runtime.explicitNamespace !== undefined) {
    return runtime.explicitNamespace;
  }

  const config = await readLocalConfig(context.io.env);

  if (config === null) {
    throw configError("no local config exists; run `syndroo init` first");
  }

  return config.namespace;
}

/**
 * The credential seam for one execution.
 *
 * It resolves the frozen connection's source once and returns values that live
 * only for this run. No path, fingerprint, or source descriptor is returned.
 */
export function credentialResolver(
  context: CommandContext,
  runtime: LocalRuntime,
): (connection: ConnectionRecord) => Promise<
  Awaited<ReturnType<typeof resolveForExecution>>
> {
  return connection =>
    resolveForExecution(connection, {
      store: runtime.store,
      provider: connection.target.provider,
      env: context.io.env,
    });
}
