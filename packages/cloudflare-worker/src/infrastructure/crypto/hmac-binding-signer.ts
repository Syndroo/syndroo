/**
 * HMAC-SHA-256 connection-binding signer.
 *
 * The signer covers the frozen `BindingMaterial` bytes exactly. It is a single
 * injected function, not a crypto framework, and it never logs or returns key
 * material.
 */
import {
  BINDING_MATERIAL_VERSION,
  CipherUnavailableError,
  InvalidContractInputError,
  type BindingMaterial,
  type BindingSigner,
} from "@syndroo/application";

import { decodeBindingKey } from "./keys.js";

export interface HmacBindingSignerOptions {
  /** Canonical base64 secret of at least 32 bytes; independent of every other key. */
  readonly key: string;
}

export function createHmacBindingSigner(options: HmacBindingSignerOptions): BindingSigner {
  // Fail closed at construction: a missing or short binding key must never
  // produce a "binding" that silently compares equal to another connection.
  const keyBytes = decodeBindingKey(options.key);

  return {
    async sign(material: BindingMaterial): Promise<string> {
      if (material === null || typeof material !== "object") {
        throw new InvalidContractInputError("binding material must be an object");
      }

      if (material.version !== BINDING_MATERIAL_VERSION) {
        throw new InvalidContractInputError("binding material version is not supported");
      }

      if (!(material.bytes instanceof Uint8Array) || material.bytes.byteLength === 0) {
        throw new InvalidContractInputError("binding material must be non-empty bytes");
      }

      // Snapshot before awaiting: the caller may reuse its buffer.
      const bytes = Uint8Array.from(material.bytes);

      let digest: Uint8Array;

      try {
        const key = await crypto.subtle.importKey(
          "raw",
          keyBytes,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
      } catch {
        // Fixed safe error: no key, input or runtime text escapes.
        throw new CipherUnavailableError("binding signer is unavailable");
      }

      return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
    },
  };
}
