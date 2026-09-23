/**
 * Connection-binding material and signing.
 *
 * The typed platform strategy knows which fields actually identify a
 * connection, so it produces the material; the application only signs it. The
 * material is internal: it is never part of a DTO, log event or archive object,
 * and the credential slot's random `bindingId` is metadata rather than the
 * final HMAC.
 */

import type { Platform } from "@syndroo/core";

import { InvalidContractInputError } from "./primitives.js";
import type { CredentialSource } from "./status.js";

export const BINDING_MATERIAL_VERSION = 1;

/** Version prefix of a computed connection binding. Changing it is a migration. */
export const BINDING_FINGERPRINT_PREFIX = "v1";

/**
 * Canonical bytes of the finally selected field group.
 *
 * `source` distinguishes the Env-only path (complete user/app/target fields)
 * from the D1 path (slot binding id plus actual app/target config, without
 * refresh-varying user tokens), so a source switch or a token rotation changes
 * the material exactly when the design says it must.
 */
export interface BindingMaterial {
  readonly version: typeof BINDING_MATERIAL_VERSION;
  readonly source: Exclude<CredentialSource, null>;
  readonly bytes: Uint8Array;
}

export interface BindingMaterialInput {
  readonly platform: Platform;
  readonly source: Exclude<CredentialSource, null>;
  /**
   * Ordered name/value pairs of the finally selected fields. Absent optional
   * fields must be passed as null so that adding or removing one changes the
   * binding instead of silently comparing equal.
   */
  readonly fields: readonly (readonly [string, string | null])[];
}

/**
 * Deterministic, order-independent encoding of binding material.
 *
 * Field names are sorted so the result does not depend on iteration order; the
 * tuple layout and version are fixed so a change invalidates continuity on
 * purpose.
 */
export function encodeBindingMaterial(input: BindingMaterialInput): BindingMaterial {
  const fields = [...input.fields]
    .map(([name, value]) => {
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(name)) {
        throw new InvalidContractInputError("binding field name is not allowlisted");
      }
      return [name, value] as const;
    })
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const canonical = JSON.stringify([
    "syndroo-binding",
    BINDING_MATERIAL_VERSION,
    input.platform,
    input.source,
    fields,
  ]);
  return Object.freeze({
    version: BINDING_MATERIAL_VERSION,
    source: input.source,
    bytes: new TextEncoder().encode(canonical),
  });
}

/**
 * HMAC-SHA-256 over binding material. The Worker supplies a WebCrypto
 * implementation; tests supply a deterministic double. This is a single
 * injected function, not a crypto framework.
 */
export interface BindingSigner {
  sign(material: BindingMaterial): Promise<string>;
}

/**
 * Compute the versioned connection binding stored on a publication.
 *
 * The returned value is an HMAC digest, never the slot's random `bindingId`.
 */
export async function computeCredentialBinding(
  material: BindingMaterial,
  signer: BindingSigner,
): Promise<string> {
  if (material.version !== BINDING_MATERIAL_VERSION) {
    throw new InvalidContractInputError("binding material version is not supported");
  }
  if (material.bytes.byteLength === 0) {
    throw new InvalidContractInputError("binding material must not be empty");
  }
  const digest = await signer.sign(material);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new InvalidContractInputError("binding signer must return a lowercase hex digest");
  }
  return `${BINDING_FINGERPRINT_PREFIX}:${digest}`;
}

/**
 * Binding equality check used by publication guards. Two computed bindings are
 * compared as opaque values; the material itself is never stored on a
 * publication.
 */
export function credentialBindingMatches(
  stored: string | null,
  computed: string,
): boolean {
  return stored !== null && stored === computed;
}
