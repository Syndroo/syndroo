import { canonicalJson } from "@syndroo/core";
import type * as T from "@syndroo/core";

import {
  createOwnedFile,
  decodeUtf8,
  readOwnedFile,
  removeOwnedFile,
} from "./atomic.js";
import {
  Database,
  type FaultInjector,
  readTombstone,
  recordName,
} from "./database.js";
import { fail } from "./errors.js";
import { secretBlobDirectory, secretBlobPath } from "./paths.js";

/**
 * Filesystem implementation of the frozen `CredentialStore` port.
 *
 * Credential blobs are independent of business generations: `put` is durable
 * before it returns a stage, so a business commit that references the returned
 * `ref` can never outrun the blob. The store keeps blobs under
 * `<root>/secrets/blobs` (0700 directories, 0600 files) and the retirement
 * fences under `<root>/secrets/tombstones`.
 *
 * Local secrets are private files. They are explicitly **not** encrypted, and
 * this store makes no such claim: file ownership and mode are the whole
 * protection, exactly as the blueprint's local-runtime row states.
 *
 * No failure carries a value, an owner, a ref or a path: every code is static.
 */

export type CredentialsOptions = {
  readonly root: string;
  readonly fault?: FaultInjector;
  readonly now?: () => string;
};

type StoredBlob = {
  ref: T.SecretRef;
  creationId: string;
  owner: T.SecretOwner;
  value: T.JsonObject;
};

const CREATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function creationRef(creationId: string): T.SecretRef {
  if (!CREATION_ID.test(creationId)) {
    fail("INVALID_INPUT");
  }

  return `secret_${creationId}`;
}

function parseBlob(text: string, ref: T.SecretRef): StoredBlob {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return fail("STATE_RECOVERY_REQUIRED");
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  const record = value as Partial<StoredBlob>;

  if (
    record.ref !== ref ||
    typeof record.creationId !== "string" ||
    typeof record.owner !== "object" ||
    record.owner === null ||
    typeof record.value !== "object" ||
    record.value === null ||
    Array.isArray(record.value)
  ) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  return record as StoredBlob;
}

export class FilesystemCredentials implements T.CredentialStore {
  readonly database: Database;

  constructor(options: CredentialsOptions) {
    this.database = new Database(
      options.root,
      options.fault,
      options.now ?? (() => new Date().toISOString()),
    );
  }

  async put(
    input: Parameters<T.CredentialStore["put"]>[0],
  ): Promise<T.SecretStage> {
    const ref = creationRef(input.creationId);

    return this.database.write("credentials.put", async session => {
      const target = secretBlobPath(session.root, recordName(ref));
      const existing = await readOwnedFile(target);

      if (existing !== null) {
        const stored = parseBlob(decodeUtf8(existing), ref);

        // Re-staging the identical blob is idempotent; anything else is a
        // durability failure, never a silent overwrite of a staged secret.
        if (
          canonicalJson({
            creationId: stored.creationId,
            owner: stored.owner,
            value: stored.value,
          }) !==
          canonicalJson({
            creationId: input.creationId,
            owner: input.owner,
            value: input.value,
          })
        ) {
          fail("DURABILITY_ERROR");
        }

        return { ref, creationId: input.creationId, owner: input.owner };
      }

      const blob: StoredBlob = {
        ref,
        creationId: input.creationId,
        owner: input.owner,
        value: input.value,
      };

      await createOwnedFile(
        secretBlobDirectory(session.root),
        recordName(ref),
        Buffer.from(JSON.stringify(blob), "utf8"),
      );

      return { ref, creationId: input.creationId, owner: input.owner };
    });
  }

  async get(
    input: Parameters<T.CredentialStore["get"]>[0],
  ): Promise<T.JsonObject> {
    return this.database.read(async (_data, root) => {
      if (root === null) {
        fail("DURABILITY_ERROR");
      }

      const bytes = await readOwnedFile(
        secretBlobPath(root, recordName(input.ref)),
      );

      if (bytes === null) {
        fail("DURABILITY_ERROR");
      }

      const stored = parseBlob(decodeUtf8(bytes), input.ref);

      // The owner tuple (kind, ownerId, version) must match exactly, so a stale
      // credential revision can never read a newer secret.
      if (canonicalJson(stored.owner) !== canonicalJson(input.owner)) {
        fail("DURABILITY_ERROR");
      }

      return structuredClone(stored.value);
    });
  }

  async delete(
    input: Parameters<T.CredentialStore["delete"]>[0],
  ): Promise<void> {
    await this.database.write("credentials.delete", async session => {
      const fence = await readTombstone(session.root, input.stage.ref);

      if (fence === null || fence.proof !== input.unreferencedProof) {
        fail("DURABILITY_ERROR");
      }

      await removeOwnedFile(
        secretBlobPath(session.root, recordName(input.stage.ref)),
      );
    });
  }
}
