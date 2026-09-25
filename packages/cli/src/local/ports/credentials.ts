import type { LocalProviderId } from "@syndroo/core";

/**
 * Where a connection's credentials come from.
 *
 * This is a reference, never a secret value: the store keeps the source kind
 * plus an installation-keyed group fingerprint, so losing the state directory
 * does not leak a token.
 */
export type CredentialReference =
  | { readonly kind: "env"; readonly provider: LocalProviderId }
  | {
      readonly kind: "file";
      readonly provider: LocalProviderId;
      readonly path: string;
    };
