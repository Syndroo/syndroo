import path from "node:path";

import { configError } from "../cli-error.js";
import {
  atomicCreateFile,
  atomicWriteFile,
  encodeStateRecord,
  ensureStateDirectory,
  pathExists,
  parseStateValue,
  readControlledFile,
  requireStateDirectory,
} from "./state/atomic.js";

/**
 * The local installation config.
 *
 * The file is deliberately tiny: a schema version and one namespace. There is
 * no `defaultPlatforms`, no credential material, and no endpoint. The namespace
 * is a deduplication domain, not a permission boundary, so this file never
 * grants authority.
 */

export const LOCAL_CONFIG_DIR_NAME = "syndroo";
export const LOCAL_CONFIG_FILE_NAME = "config.json";
export const LOCAL_STATE_DIR_NAME = "syndroo";

/** Used when the first `init` omits `--namespace`. */
export const DEFAULT_LOCAL_NAMESPACE = "default";

/** Frozen with the state schema; a namespace is not a free-form string. */
export const LOCAL_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface LocalConfig {
  readonly schemaVersion: 1;
  readonly namespace: string;
}

const CONFIG_FIELDS: readonly string[] = ["schemaVersion", "namespace"];

function clean(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Reads an XDG base-directory variable.
 *
 * The XDG Base Directory specification requires an implementation to treat a
 * relative value as invalid and ignore it. Honouring one would make the config
 * and state locations depend on the caller's working directory, so the same
 * installation could silently resolve to a different config file per `cd`.
 * An ignored value falls back to the `$HOME` default.
 */
function xdgBaseDirectory(value: string | undefined): string | undefined {
  const cleaned = clean(value);

  return cleaned !== undefined && path.isAbsolute(cleaned) ? cleaned : undefined;
}

function homeDirectory(env: NodeJS.ProcessEnv): string {
  const home = clean(env["HOME"]);

  if (home === undefined) {
    throw configError("the local home directory is not set");
  }

  return home;
}

/** `$XDG_CONFIG_HOME` or `$HOME/.config`, then the Syndroo directory. */
export function localConfigDir(env: NodeJS.ProcessEnv): string {
  const base =
    xdgBaseDirectory(env["XDG_CONFIG_HOME"]) ??
    path.join(homeDirectory(env), ".config");

  return path.join(base, LOCAL_CONFIG_DIR_NAME);
}

export function localConfigPath(env: NodeJS.ProcessEnv): string {
  return path.join(localConfigDir(env), LOCAL_CONFIG_FILE_NAME);
}

/**
 * `$XDG_STATE_HOME` or `$HOME/.local/state`, then the Syndroo directory.
 *
 * An explicit `--state-home` wins; a relative override resolves against the
 * caller's working directory, never against a path the user did not name.
 */
export function resolveStateHome(
  env: NodeJS.ProcessEnv,
  override: string | undefined,
  cwd: string,
): string {
  const explicit = clean(override);

  if (explicit !== undefined) {
    return path.resolve(cwd, explicit);
  }

  const base =
    xdgBaseDirectory(env["XDG_STATE_HOME"]) ??
    path.join(homeDirectory(env), ".local", "state");

  return path.join(base, LOCAL_STATE_DIR_NAME);
}

/** Strict shape check for a config file read from disk. */
export function parseLocalConfig(value: unknown): LocalConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw configError("the local config file is not a JSON object");
  }

  const record = value as Readonly<Record<string, unknown>>;
  const allowed: ReadonlySet<string> = new Set(CONFIG_FIELDS);

  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) {
      throw configError(
        "the local config file has a field this version does not accept",
      );
    }
  }

  if (record["schemaVersion"] !== 1) {
    throw configError("the local config schemaVersion must be the number 1");
  }

  const namespace = record["namespace"];

  if (
    typeof namespace !== "string" ||
    !LOCAL_NAMESPACE_PATTERN.test(namespace)
  ) {
    throw configError("the local config namespace is not usable");
  }

  return { schemaVersion: 1, namespace };
}

/**
 * Reads the config, or `null` when it has never been created.
 *
 * A present but unreadable, unsafe, or malformed file fails closed instead of
 * being treated as "no config": the operator has to look at the real file.
 */
export async function readLocalConfig(
  env: NodeJS.ProcessEnv,
): Promise<LocalConfig | null> {
  const directory = localConfigDir(env);

  if (!(await pathExists(directory))) {
    return null;
  }

  // Validate the directory and every caller-controlled ancestor first: a
  // symlinked or unsafe config directory must fail closed rather than let the
  // no-follow open be bypassed by a redirected parent.
  const resolved = await requireStateDirectory(directory);
  const bytes = await readControlledFile(
    `${resolved}${path.sep}${LOCAL_CONFIG_FILE_NAME}`,
  );

  if (bytes === null) {
    return null;
  }

  return parseLocalConfig(parseStateValue(bytes));
}

/**
 * Writes the config atomically into a controlled directory, replacing any
 * existing file.
 *
 * `init` must use `createLocalConfig` instead: only the create-only primitive
 * can refuse a concurrent creator without overwriting its namespace.
 */
export async function writeLocalConfig(
  config: LocalConfig,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const directory = await ensureStateDirectory(localConfigDir(env));

  await atomicWriteFile(
    directory,
    LOCAL_CONFIG_FILE_NAME,
    encodeStateRecord(config),
    undefined,
  );
}

/**
 * Creates the config only when no config exists yet.
 *
 * Returns `true` when this call published the file and `false` when another
 * creator got there first. The existing file is never replaced, which is what
 * keeps two concurrent `init` runs from overwriting each other's namespace:
 * the global write lock is held on the *state* root, so it cannot protect a
 * config directory that two runs with different `--state-home` values share.
 */
export async function createLocalConfig(
  config: LocalConfig,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const directory = await ensureStateDirectory(localConfigDir(env));

  return atomicCreateFile(
    directory,
    LOCAL_CONFIG_FILE_NAME,
    encodeStateRecord(config),
    undefined,
  );
}

export interface InitLocalConfigResult {
  readonly config: LocalConfig;
  readonly created: boolean;
}

/**
 * Creates the config once, or accepts the identical one.
 *
 * A different namespace on an existing installation is refused rather than
 * overwritten, so `init` can never silently move an operator into a fresh
 * deduplication domain.
 */
export async function initLocalConfig(
  requestedNamespace: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<InitLocalConfigResult> {
  const requested = clean(requestedNamespace);

  if (requested !== undefined && !LOCAL_NAMESPACE_PATTERN.test(requested)) {
    throw configError("the requested namespace is not usable");
  }

  const existing = await readLocalConfig(env);

  if (existing !== null) {
    if (requested !== undefined && requested !== existing.namespace) {
      throw configError(
        "this installation already has a different namespace; init never overwrites it",
      );
    }

    return { config: existing, created: false };
  }

  const config: LocalConfig = {
    schemaVersion: 1,
    namespace: requested ?? DEFAULT_LOCAL_NAMESPACE,
  };

  if (await createLocalConfig(config, env)) {
    return { config, created: true };
  }

  // Another creator published a config first. Re-read it and never overwrite:
  // the same namespace is accepted as a no-op, anything else is refused. A read
  // that lands inside the winner's transient two-link publish window refuses
  // conservatively instead of waiting or guessing.
  const winner = await readLocalConfig(env);

  if (winner === null) {
    throw configError(
      "the local config could not be read after a concurrent init",
    );
  }

  if (winner.namespace !== config.namespace) {
    throw configError(
      "this installation already has a different namespace; init never overwrites it",
    );
  }

  return { config: winner, created: false };
}
