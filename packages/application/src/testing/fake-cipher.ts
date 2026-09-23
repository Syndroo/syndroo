/**
 * Test-only credential cipher.
 *
 * It performs a deterministic, reversible obfuscation plus an integrity check
 * over the AAD tuple, IV and ciphertext. That is enough to exercise wrong
 * purpose/record/platform/revision, tampered tag and wrong-key paths without
 * pretending to be production cryptography: `kind` is `test-double` and
 * `assertProductionCipher` refuses it.
 */

import { cipherAadTuple, type CipherContext, type EncryptedCredential } from "../contracts/credentials.js";
import { CipherUnavailableError, type CredentialCipher } from "../ports/credential-cipher.js";

export function createTestCipher(keyId = "test-key-1"): CredentialCipher {
  return Object.freeze({
    kind: "test-double" as const,
    keyId,
    async encrypt(payload: Uint8Array, context: CipherContext): Promise<EncryptedCredential> {
      const body = bytesToHex(payload);
      const iv = `${keyId}-iv`;
      return Object.freeze({
        version: 1 as const,
        algorithm: "AES-256-GCM" as const,
        keyId,
        iv,
        ciphertext: `${body}.${checksum(keyId, iv, context)}`,
      });
    },
    async decrypt(envelope: EncryptedCredential, context: CipherContext): Promise<Uint8Array> {
      if (envelope.keyId !== keyId) {
        throw new CipherUnavailableError("credential envelope key id does not match");
      }
      if (envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM") {
        throw new CipherUnavailableError("credential envelope version is not supported");
      }
      const separator = envelope.ciphertext.lastIndexOf(".");
      if (separator <= 0) {
        throw new CipherUnavailableError("credential envelope is malformed");
      }
      const body = envelope.ciphertext.slice(0, separator);
      const tag = envelope.ciphertext.slice(separator + 1);
      if (tag !== checksum(keyId, envelope.iv, context)) {
        throw new CipherUnavailableError("credential envelope failed authentication");
      }
      return hexToBytes(body);
    },
  });
}

function checksum(keyId: string, iv: string, context: CipherContext): string {
  const material = `${keyId}|${iv}|${JSON.stringify(cipherAadTuple(context))}`;
  let hash = 0x811c9dc5;
  for (const char of material) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new CipherUnavailableError("credential envelope payload is malformed");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
