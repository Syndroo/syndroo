import { createHash, createHmac, randomBytes } from "node:crypto";
import path from "node:path";

import { canonicalJson } from "@syndroo/core";
import type { Digest, Digests, Json } from "@syndroo/core";

import {
  ensureOwnedDirectory,
  ensureStateRoot,
  readOwnedFile,
  replaceOwnedFile,
} from "../filesystem/atomic.js";

/** Bytes of the persisted HMAC key material. */
export const RUNTIME_KEY_BYTES = 32;

/**
 * The runtime HMAC key for sensitive digests (approval tokens, connect input).
 *
 * The key is random, persisted under `<stateRoot>/keys/hmac` at mode 0600
 * inside the 0700 state root, and created lazily: a command that never needs a
 * sensitive digest (help, version, status, dry-run) never creates it and never
 * creates the state root. It is deliberately independent of any bearer token,
 * so rotating an API credential cannot invalidate a stored approval.
 *
 * Key material is read and written with the filesystem runtime's own atomic
 * helpers, so an owned-directory or owned-file check always runs first.
 */
export async function loadRuntimeKey(stateRoot: string): Promise<Buffer> {
  const root = await ensureStateRoot(stateRoot);
  const directory = path.join(root, "keys");
  await ensureOwnedDirectory(directory);

  const existing = await readOwnedFile(path.join(directory, "hmac"));
  if (existing !== null && existing.length >= RUNTIME_KEY_BYTES) {
    return existing;
  }

  const created = randomBytes(RUNTIME_KEY_BYTES);
  await replaceOwnedFile(directory, "hmac", created);

  return created;
}

export type LocalDigestsOptions = {
  /** Absolute state root. Resolved through the filesystem runtime. */
  readonly stateRoot: string;
  /** Test seam: supply key material instead of touching the filesystem. */
  readonly key?: () => Promise<Buffer>;
};

/**
 * Core's `Digests` port over WebCrypto-compatible Node primitives.
 *
 * `canonical` is a plain SHA-256 over Core's canonical JSON, so a digest cannot
 * depend on key order. `sensitive` is HMAC-SHA-256 under the runtime key, so a
 * digest of a bearer value is not a bare hash an attacker can precompute.
 */
export function createLocalDigests(options: LocalDigestsOptions): Digests {
  let pending: Promise<Buffer> | undefined;

  const key = (): Promise<Buffer> => {
    if (options.key !== undefined) {
      return options.key();
    }

    pending ??= loadRuntimeKey(options.stateRoot);

    return pending;
  };

  return {
    async canonical(value: Json): Promise<Digest> {
      return createHash("sha256").update(canonicalJson(value)).digest("hex");
    },
    async sensitive(value: Json): Promise<Digest> {
      const material = await key();

      return createHmac("sha256", material).update(canonicalJson(value)).digest("hex");
    },
  };
}
