import { constants as FS, promises as fs } from "node:fs";
import path from "node:path";

import { parseStrictJson, ProtocolError } from "@syndroo/core";

import { defaultStateRoot } from "./runtime/filesystem/index.js";

/**
 * The one configuration source the architecture-v1 CLI accepts.
 *
 * `--config <path>` is the only way to select configuration, and configuration
 * is never inferred from the working directory. A missing default file is not an
 * error for the commands that need no provider resolution; a missing explicit
 * `--config` file is. State root and provider paths resolve against the config
 * file's directory, so switching the working directory cannot change which
 * plugin or which state a run uses.
 */
export const MAX_CONFIG_BYTES = 65_536;
export const CONFIG_VERSION = 1;

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SECRET_KEY = /(?:token|secret|password|passwd|api[_-]?key|credential|private[_-]?key)/i;
const TOP_LEVEL_KEYS: readonly string[] = ["version", "stateRoot", "providers"];
const PROVIDER_KEYS: readonly string[] = ["path"];

export type ResolvedConfig = {
  /** Absolute path that was opened, whether or not it exists. */
  readonly configFile: string;
  readonly configDirectory: string;
  /** False only for an absent default configuration file. */
  readonly exists: boolean;
  /** Absolute state root. */
  readonly stateRoot: string;
  /** Provider id -> absolute local root selected by the configuration. */
  readonly providers: Readonly<Record<string, string>>;
};

export type ConfigSelection = {
  readonly path: string;
  /** True when the path came from `--config` rather than the default. */
  readonly explicit: boolean;
};

function fail(code: string): never {
  throw new ProtocolError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `$XDG_CONFIG_HOME/syndroo/config.json`, else `$HOME/.config/syndroo/config.json`. */
export function defaultConfigFile(env: NodeJS.ProcessEnv): string {
  const xdg = env["XDG_CONFIG_HOME"];

  if (xdg !== undefined && path.isAbsolute(xdg)) {
    return path.join(xdg, "syndroo", "config.json");
  }

  const home = env["HOME"];

  if (home === undefined || !path.isAbsolute(home)) {
    fail("CONFIG_INVALID");
  }

  return path.join(home, ".config", "syndroo", "config.json");
}

/**
 * Decide which file `--config` selects.
 *
 * An explicit value must be an absolute path; a relative one is refused rather
 * than resolved, so an accidental `--config config.json` cannot silently pick a
 * file out of the working directory.
 */
export function resolveConfigPath(
  env: NodeJS.ProcessEnv,
  explicit?: string,
): ConfigSelection {
  if (explicit === undefined) {
    return { path: defaultConfigFile(env), explicit: false };
  }

  if (
    explicit.length === 0 ||
    explicit.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(explicit)
  ) {
    fail("CONFIG_INVALID");
  }

  if (!path.isAbsolute(explicit)) {
    fail("CONFIG_PATH_NOT_ABSOLUTE");
  }

  return { path: path.normalize(explicit), explicit: true };
}

function ownedString(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail("CONFIG_INVALID");
  }

  return value;
}

function stateRootFrom(env: NodeJS.ProcessEnv): string {
  try {
    return defaultStateRoot(env);
  } catch {
    return fail("CONFIG_INVALID");
  }
}

async function readBounded(file: string): Promise<Buffer | null> {
  let handle;

  try {
    handle = await fs.open(file, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return null;
    }

    return fail("CONFIG_INVALID");
  }

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) {
      fail("CONFIG_INVALID");
    }

    const bytes = await handle.readFile();

    if (bytes.length > MAX_CONFIG_BYTES) {
      fail("CONFIG_INVALID");
    }

    return bytes;
  } catch (error) {
    if (error instanceof ProtocolError) {
      throw error;
    }

    return fail("CONFIG_INVALID");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Read and validate one configuration file.
 *
 * Strictness matches request input: at most 64 KiB, duplicate keys rejected by
 * Core's strict parser, unknown top-level keys rejected, `version` must be `1`,
 * and any key that looks like a token, secret, password, API key or credential
 * is rejected rather than ignored. Other versions are refused explicitly and
 * never migrated.
 */
export async function loadConfig(
  selection: ConfigSelection,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedConfig> {
  const configFile = selection.path;
  const configDirectory = path.dirname(configFile);
  const bytes = await readBounded(configFile);

  if (bytes === null) {
    if (selection.explicit) {
      fail("CONFIG_NOT_FOUND");
    }

    return {
      configFile,
      configDirectory,
      exists: false,
      stateRoot: stateRootFrom(env),
      providers: {},
    };
  }

  let parsed: unknown;

  try {
    parsed = parseStrictJson(bytes);
  } catch {
    fail("CONFIG_INVALID");
  }

  if (!isRecord(parsed)) {
    fail("CONFIG_INVALID");
  }

  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      fail(SECRET_KEY.test(key) ? "CONFIG_SECRET_REJECTED" : "CONFIG_INVALID");
    }
  }

  if (parsed["version"] !== CONFIG_VERSION) {
    fail("CONFIG_VERSION_UNSUPPORTED");
  }

  const rawStateRoot = parsed["stateRoot"];
  const stateRoot =
    rawStateRoot === undefined
      ? stateRootFrom(env)
      : path.resolve(configDirectory, ownedString(rawStateRoot));
  const providers: Record<string, string> = {};
  const rawProviders = parsed["providers"];

  if (rawProviders !== undefined) {
    if (!isRecord(rawProviders)) {
      fail("CONFIG_INVALID");
    }

    const entries = Object.entries(rawProviders);

    if (entries.length > 100) {
      fail("CONFIG_INVALID");
    }

    for (const [provider, value] of entries) {
      if (!PROVIDER_ID.test(provider) || !isRecord(value)) {
        fail("CONFIG_INVALID");
      }

      const keys = Object.keys(value);

      if (keys.length !== 1 || !PROVIDER_KEYS.includes(keys[0] as string)) {
        fail("CONFIG_INVALID");
      }

      const target = ownedString(value["path"]);

      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        fail("CONFIG_INVALID");
      }

      providers[provider] = path.resolve(configDirectory, target);
    }
  }

  return { configFile, configDirectory, exists: true, stateRoot, providers };
}
