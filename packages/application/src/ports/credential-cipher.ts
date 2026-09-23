/**
 * Credential cipher port.
 *
 * Production wiring must use a real AES-256-GCM implementation; a test double
 * declares itself as such so a mis-wired production bundle fails closed instead
 * of silently storing plaintext.
 */

import type { CipherContext, EncryptedCredential } from "../contracts/credentials.js";
import { InvalidContractInputError } from "../contracts/primitives.js";

export type CredentialCipherKind = "aes-256-gcm" | "test-double";

export class CipherUnavailableError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CipherUnavailableError";
  }
}

export interface CredentialCipher {
  readonly kind: CredentialCipherKind;
  readonly keyId: string;
  encrypt(payload: Uint8Array, context: CipherContext): Promise<EncryptedCredential>;
  /** Must fail closed on wrong key, IV, tag, AAD or envelope version. */
  decrypt(envelope: EncryptedCredential, context: CipherContext): Promise<Uint8Array>;
}

/** Reject a no-op/test cipher in production wiring. */
export function assertProductionCipher(cipher: CredentialCipher): void {
  if (cipher.kind !== "aes-256-gcm") {
    throw new CipherUnavailableError("production credential cipher must be AES-256-GCM");
  }
  if (typeof cipher.keyId !== "string" || cipher.keyId.length === 0) {
    throw new CipherUnavailableError("credential cipher must expose a non-empty key id");
  }
}

export function assertEncryptedEnvelopeShape(envelope: EncryptedCredential): void {
  if (envelope.version !== 1) {
    throw new InvalidContractInputError("unsupported credential envelope version");
  }
  if (envelope.algorithm !== "AES-256-GCM") {
    throw new InvalidContractInputError("unsupported credential envelope algorithm");
  }
  if (envelope.keyId.length === 0 || envelope.iv.length === 0 || envelope.ciphertext.length === 0) {
    throw new InvalidContractInputError("credential envelope is incomplete");
  }
}
