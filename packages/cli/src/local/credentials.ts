import { constants as fsConstants, realpathSync } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";

import type { LocalCredentials, LocalProviderId } from "@syndroo/core";

import { CliError, usageError } from "../cli-error.js";
import { canonicalJson, parseLocalJson } from "./document.js";
import { localError } from "./errors.js";
import type { CredentialReference } from "./ports/credentials.js";
import type { LocalStore } from "./ports/local-store.js";

/**
 * Credential references, snapshots, and the installation-keyed group
 * fingerprint.
 *
 * A reference is what the store keeps; a snapshot is what a command holds in
 * memory for the length of one call. Neither the value nor a bare hash of it is
 * ever written: only `credentialFingerprint`, an HMAC under the installation
 * key, reaches the connection record.
 */

/** Credential files share the local document limit. */
export const MAX_LOCAL_CREDENTIAL_FILE_BYTES = 65_536;

/** The only Bluesky host this version will talk to without further policy. */
export const TRUSTED_BLUESKY_HOST = "bsky.social";

/** Domain separation for the installation HMAC. */
export const CREDENTIAL_FINGERPRINT_DOMAIN = "credential:v1:";

/**
 * Fixed environment variable names.
 *
 * `--from-env` reads this group and nothing else: an arbitrary variable name
 * never selects a credential, and a partially present group is an error rather
 * than a fallback to another source.
 */
export const LOCAL_CREDENTIAL_ENV_FIELDS: Readonly<
  Record<
    LocalProviderId,
    { readonly required: readonly string[]; readonly optional: readonly string[] }
  >
> = {
  bluesky: {
    required: ["BLUESKY_IDENTIFIER", "BLUESKY_PASSWORD"],
    optional: ["BLUESKY_HOST"],
  },
  threads: { required: ["THREADS_ACCESS_TOKEN"], optional: [] },
};

const CREDENTIAL_FILE_ROOT_FIELDS: readonly string[] = [
  "schemaVersion",
  "provider",
  "credentials",
];

const BLUESKY_CREDENTIAL_FIELDS: readonly string[] = [
  "identifier",
  "password",
  "host",
];

const THREADS_CREDENTIAL_FIELDS: readonly string[] = ["accessToken"];

/** C0, DEL, and C1: every control code that could rewrite a terminal. */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * System alias roots that are resolved instead of refused.
 *
 * macOS ships `/tmp`, `/var`, and `/etc` as symlinks into `/private`, and the
 * system temporary directory lives under one of them. Resolving exactly these
 * fixed aliases keeps that working; every component the caller chose after them
 * still has to be a real directory.
 */
function systemAliasRoots(): ReadonlySet<string> {
  return process.platform === "darwin"
    ? new Set(["/tmp", "/var", "/etc"])
    : new Set<string>();
}

/**
 * Rewrites a known system alias prefix to its resolved form.
 *
 * Only the fixed root is resolved. The rest of the path is left exactly as the
 * caller supplied it, so a symlinked component the caller controls cannot be
 * hidden by this rewrite.
 */
function normalizeTrustedPrefix(absolute: string): string {
  for (const alias of systemAliasRoots()) {
    if (absolute !== alias && !absolute.startsWith(`${alias}/`)) {
      continue;
    }

    let resolved: string;

    try {
      resolved = realpathSync(alias);
    } catch {
      return absolute;
    }

    return resolved === alias
      ? absolute
      : `${resolved}${absolute.slice(alias.length)}`;
  }

  return absolute;
}

function sourceUnavailable(message: string): CliError {
  return localError("AUTH_SOURCE_UNAVAILABLE", message);
}

function isJsonObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** A secret: present, not blank. Its value never appears in a message. */
function readSecret(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw sourceUnavailable(`${field} must be a non-blank string`);
  }

  return value;
}

/** A name-like field: additionally free of control characters. */
function readName(value: unknown, field: string): string {
  const text = readSecret(value, field);

  if (CONTROL_CHARACTER_PATTERN.test(text)) {
    throw sourceUnavailable(`${field} must not contain control characters`);
  }

  return text;
}

function readTrustedHost(value: unknown, field: string): string {
  const host = readName(value, field).trim().toLowerCase();

  if (host !== TRUSTED_BLUESKY_HOST) {
    throw sourceUnavailable(`${field} must be ${TRUSTED_BLUESKY_HOST}`);
  }

  return host;
}

function assertOnlyFields(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  const allowedSet: ReadonlySet<string> = new Set(allowed);

  for (const field of Object.keys(record)) {
    if (!allowedSet.has(field)) {
      throw sourceUnavailable(
        `the credential file has a field this version does not accept (allowed: ${allowed.join(", ")})`,
      );
    }
  }
}

async function readEnvCredentials(
  provider: LocalProviderId,
  env: NodeJS.ProcessEnv,
): Promise<LocalCredentials> {
  const fields = LOCAL_CREDENTIAL_ENV_FIELDS[provider];
  const missing = fields.required.filter(name => !isPresent(env[name]));

  if (missing.length > 0) {
    throw sourceUnavailable(
      `the environment does not hold a complete credential group (missing: ${missing.join(", ")})`,
    );
  }

  if (provider === "bluesky") {
    const identifier = readName(env["BLUESKY_IDENTIFIER"], "BLUESKY_IDENTIFIER");
    const password = readSecret(env["BLUESKY_PASSWORD"], "BLUESKY_PASSWORD");
    const host = env["BLUESKY_HOST"];

    return {
      provider: "bluesky",
      identifier,
      password,
      // Only a *missing* host takes the trusted default. A present but blank
      // host is a mistake, not an invitation to guess.
      host:
        host === undefined
          ? TRUSTED_BLUESKY_HOST
          : readTrustedHost(host, "BLUESKY_HOST"),
    };
  }

  return {
    provider: "threads",
    accessToken: readSecret(env["THREADS_ACCESS_TOKEN"], "THREADS_ACCESS_TOKEN"),
  };
}

/**
 * Reads the file once.
 *
 * Only the fixed macOS system alias prefix is resolved (`/tmp`, `/var`,
 * `/etc`). Everything the caller chose after it must be symlink-free, so
 * `realpath` has to return the normalized path unchanged; the whole supplied
 * path is never resolved wholesale. The open then adds `O_NOFOLLOW` and
 * `O_NONBLOCK` (a FIFO cannot stall the CLI), and the `fstat` after open
 * rejects a path swapped between the check and the read.
 */
async function readCredentialFileBytes(path: string): Promise<Uint8Array> {
  if (path.length === 0 || path.includes("\u0000")) {
    throw sourceUnavailable("the credential file reference is not usable");
  }

  const candidate = normalizeTrustedPrefix(path);
  let canonical: string;

  try {
    canonical = await realpath(candidate);
  } catch {
    throw sourceUnavailable("the credential file cannot be read");
  }

  if (canonical !== candidate) {
    throw sourceUnavailable(
      "the credential file path must not traverse a symbolic link",
    );
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const nonBlocking = fsConstants.O_NONBLOCK ?? 0;
  let handle: FileHandle;

  try {
    handle = await open(
      candidate,
      fsConstants.O_RDONLY | noFollow | nonBlocking,
    );
  } catch {
    throw sourceUnavailable("the credential file cannot be read");
  }

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw sourceUnavailable("the credential file must be a regular file");
    }

    if (stats.size > MAX_LOCAL_CREDENTIAL_FILE_BYTES) {
      throw sourceUnavailable("the credential file exceeds the 64 KiB limit");
    }

    if ((stats.mode & 0o777) !== 0o600) {
      throw sourceUnavailable(
        "the credential file must have mode 600 (owner read/write only)",
      );
    }

    const uid = typeof process.getuid === "function" ? process.getuid() : null;

    if (uid !== null && stats.uid !== uid) {
      throw sourceUnavailable(
        "the credential file must be owned by the current user",
      );
    }

    const buffer = Buffer.allocUnsafe(MAX_LOCAL_CREDENTIAL_FILE_BYTES + 1);
    let total = 0;

    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        total,
      );

      if (bytesRead === 0) {
        break;
      }

      total += bytesRead;
    }

    if (total > MAX_LOCAL_CREDENTIAL_FILE_BYTES) {
      throw sourceUnavailable("the credential file exceeds the 64 KiB limit");
    }

    return new Uint8Array(buffer.subarray(0, total));
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    throw sourceUnavailable("the credential file cannot be read");
  } finally {
    try {
      await handle.close();
    } catch {
      // A close failure must never replace the safe error being reported, and
      // the bytes were already read into memory.
    }
  }
}

function decodeCredentialText(bytes: Uint8Array): string {
  let decoded: string;

  try {
    decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw sourceUnavailable("the credential file is not valid UTF-8");
  }

  const text = decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded;

  if (text.startsWith("\uFEFF")) {
    throw sourceUnavailable("the credential file has more than one leading BOM");
  }

  return text;
}

function parseCredentialDocument(text: string): unknown {
  try {
    return parseLocalJson(text);
  } catch {
    throw sourceUnavailable("the credential file is not strict JSON");
  }
}

function readCredentialGroup(
  value: unknown,
  provider: LocalProviderId,
): LocalCredentials {
  if (!isJsonObject(value)) {
    throw sourceUnavailable("the credential file must be a JSON object");
  }

  assertOnlyFields(value, CREDENTIAL_FILE_ROOT_FIELDS);

  if (value["schemaVersion"] !== 1) {
    throw sourceUnavailable("schemaVersion must be the number 1");
  }

  if (value["provider"] !== provider) {
    throw sourceUnavailable(
      "the credential file names a different provider than the command",
    );
  }

  const group = value["credentials"];

  if (!isJsonObject(group)) {
    throw sourceUnavailable("credentials must be a JSON object");
  }

  if (provider === "bluesky") {
    assertOnlyFields(group, BLUESKY_CREDENTIAL_FIELDS);

    const identifier = readName(group["identifier"], "identifier");
    const password = readSecret(group["password"], "password");
    const host = group["host"];

    return {
      provider: "bluesky",
      identifier,
      password,
      host:
        host === undefined
          ? TRUSTED_BLUESKY_HOST
          : readTrustedHost(host, "host"),
    };
  }

  assertOnlyFields(group, THREADS_CREDENTIAL_FIELDS);

  return {
    provider: "threads",
    accessToken: readSecret(group["accessToken"], "accessToken"),
  };
}

async function readFileCredentials(
  provider: LocalProviderId,
  path: string,
): Promise<LocalCredentials> {
  const bytes = await readCredentialFileBytes(path);
  const text = decodeCredentialText(bytes);
  const value = parseCredentialDocument(text);

  return readCredentialGroup(value, provider);
}

/**
 * Resolves one reference into an in-memory snapshot.
 *
 * The whole group comes from one source. A missing field, an unreadable file,
 * or an invalid shape is `AUTH_SOURCE_UNAVAILABLE`; there is no fallback and no
 * mixing between the environment and a file.
 */
export async function resolveCredentialSource(
  reference: CredentialReference,
  deps: { readonly env: NodeJS.ProcessEnv },
): Promise<LocalCredentials> {
  return reference.kind === "env"
    ? readEnvCredentials(reference.provider, deps.env)
    : readFileCredentials(reference.provider, reference.path);
}

/**
 * Installation-keyed HMAC of the complete credential group.
 *
 * The group includes the provider and the (defaulted) host, so rotating a
 * token, changing an optional host, or pointing the same token at another
 * provider all change the fingerprint. The store owns the key; this function
 * never hashes a secret on its own.
 */
export async function credentialFingerprint(
  credentials: LocalCredentials,
  store: Pick<LocalStore, "authenticate">,
): Promise<string> {
  const group: Readonly<Record<string, unknown>> =
    credentials.provider === "bluesky"
      ? {
          provider: credentials.provider,
          identifier: credentials.identifier,
          password: credentials.password,
          host: credentials.host,
        }
      : {
          provider: credentials.provider,
          accessToken: credentials.accessToken,
        };

  return store.authenticate(
    `${CREDENTIAL_FINGERPRINT_DOMAIN}${canonicalJson(group)}`,
  );
}

/**
 * Chooses the one source a command was asked to use.
 *
 * Exactly one of `fromEnv` and `credentialFile` must be selected. A file path is
 * resolved against the real working directory, so a caller whose own working
 * directory sits behind a symbolic link still produces a canonical path; the
 * path itself is never part of a public result or an error message.
 */
export function selectCredentialReference(
  provider: LocalProviderId,
  options: {
    readonly fromEnv: boolean;
    readonly credentialFile?: string | undefined;
    readonly cwd: string;
  },
): CredentialReference {
  const hasFile = options.credentialFile !== undefined;

  if (options.fromEnv && hasFile) {
    throw usageError(
      "auth set accepts exactly one of --from-env or --credential-file",
    );
  }

  if (!options.fromEnv && !hasFile) {
    throw usageError(
      "auth set needs exactly one of --from-env or --credential-file",
    );
  }

  if (!options.fromEnv) {
    const file = options.credentialFile ?? "";

    if (file.trim().length === 0 || file.includes("\u0000")) {
      throw usageError("--credential-file needs a file path");
    }

    let base = resolve(options.cwd);

    try {
      base = realpathSync(base);
    } catch {
      // A working directory that does not resolve is left as given; the read
      // path reports the unusable file without echoing it.
    }

    return {
      kind: "file",
      provider,
      path: normalizeTrustedPrefix(resolve(base, file)),
    };
  }

  return { kind: "env", provider };
}
