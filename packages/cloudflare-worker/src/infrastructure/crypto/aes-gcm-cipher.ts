/**
 * Real AES-256-GCM credential cipher (design §14 / contracts §10).
 *
 * Envelope: version, algorithm, key id, base64 12-byte IV, base64
 * ciphertext-with-128-bit-tag. The AAD is the exact versioned tuple from the
 * frozen contract, so a wrong purpose, record, platform, schema version or
 * payload revision fails authentication instead of decrypting.
 */
import {
  CIPHER_ALGORITHM,
  CIPHER_ENVELOPE_VERSION,
  CipherUnavailableError,
  InvalidContractInputError,
  assertEncryptedEnvelopeShape,
  encodeCipherAad,
  type CipherContext,
  type CredentialCipher,
  type EncryptedCredential,
} from "@syndroo/application";

import {
  AES_GCM_IV_BYTES,
  AES_GCM_TAG_BYTES,
  MAX_CREDENTIAL_PAYLOAD_BYTES,
  decodeAes256Key,
  decodeBase64,
  encodeBase64,
  maxBase64Length,
  requireCipherContext,
  requireKeyId,
} from "./keys.js";

export interface AesGcmCipherOptions {
  /** Canonical padded base64 of a 32-byte random key. */
  readonly key: string;
  /** Non-secret key identifier stored in the envelope. */
  readonly keyId: string;
}

export function createAesGcmCipher(options: AesGcmCipherOptions): CredentialCipher {
  const keyBytes = decodeAes256Key(options.key);
  const keyId = requireKeyId(options.keyId);

  return {
    kind: "aes-256-gcm",
    keyId,

    async encrypt(payload: Uint8Array, context: CipherContext): Promise<EncryptedCredential> {
      const plaintext = copyBoundedPayload(payload);
      const aad = encodeCipherAad(requireCipherContext(context));
      // Fresh CSPRNG IV per envelope; never derived from the key or payload.
      const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));

      const cryptoKey = await importKey(keyBytes);
      let ciphertext: ArrayBuffer;

      try {
        ciphertext = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
          cryptoKey,
          plaintext,
        );
      } catch {
        // No key, payload or runtime text is attached.
        throw new CipherUnavailableError("credential encryption failed");
      }

      return {
        version: CIPHER_ENVELOPE_VERSION,
        algorithm: CIPHER_ALGORITHM,
        keyId,
        iv: encodeBase64(iv),
        ciphertext: encodeBase64(new Uint8Array(ciphertext)),
      };
    },

    async decrypt(envelope: EncryptedCredential, context: CipherContext): Promise<Uint8Array> {
      const trusted = requireCipherContext(context);
      const { iv, ciphertext } = decodeEnvelope(envelope, keyId);
      const aad = encodeCipherAad(trusted);
      const cryptoKey = await importKey(keyBytes);

      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
          cryptoKey,
          ciphertext,
        );

        const bytes = new Uint8Array(plaintext);

        // A valid tag over empty plaintext is technically possible, but an
        // empty credential is never legitimate: apply the same non-empty policy
        // as encryption instead of returning empty bytes.
        if (bytes.byteLength === 0) {
          throw new InvalidContractInputError("credential payload must not be empty");
        }

        return bytes;
      } catch {
        // Wrong key, IV, tag, AAD or truncated ciphertext: one fixed error.
        throw new CipherUnavailableError("credential decryption failed");
      }
    },
  };
}

function copyBoundedPayload(payload: Uint8Array): Uint8Array {
  if (!(payload instanceof Uint8Array)) {
    throw new InvalidContractInputError("credential payload must be a Uint8Array");
  }

  if (payload.byteLength === 0) {
    throw new InvalidContractInputError("credential payload must not be empty");
  }

  if (payload.byteLength > MAX_CREDENTIAL_PAYLOAD_BYTES) {
    throw new InvalidContractInputError("credential payload exceeds the size bound");
  }

  // Copy before any await: a caller may reuse or mutate its buffer.
  return Uint8Array.from(payload);
}

function decodeEnvelope(
  envelope: EncryptedCredential,
  keyId: string,
): { iv: Uint8Array; ciphertext: Uint8Array } {
  if (envelope === null || typeof envelope !== "object") {
    throw new InvalidContractInputError("credential envelope must be an object");
  }

  for (const key of Object.keys(envelope)) {
    if (!ENVELOPE_FIELDS.includes(key)) {
      throw new InvalidContractInputError("credential envelope contains an unknown field");
    }
  }

  for (const field of ENVELOPE_FIELDS) {
    if (!(field in envelope)) {
      throw new InvalidContractInputError("credential envelope is incomplete");
    }
  }

  if (
    typeof envelope.keyId !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new InvalidContractInputError("credential envelope fields must be strings");
  }

  try {
    assertEncryptedEnvelopeShape(envelope);
  } catch {
    throw new InvalidContractInputError("credential envelope is not supported");
  }

  if (envelope.keyId !== keyId) {
    // A different key id is an unknown key: never guess, never fall back.
    throw new CipherUnavailableError("credential envelope uses an unknown key id");
  }

  // Bound the encoded input BEFORE decoding so a huge string cannot allocate.
  if (
    envelope.iv.length > maxBase64Length(AES_GCM_IV_BYTES) ||
    envelope.ciphertext.length > maxBase64Length(MAX_CREDENTIAL_PAYLOAD_BYTES + AES_GCM_TAG_BYTES)
  ) {
    throw new InvalidContractInputError("credential envelope exceeds the encoded size bound");
  }

  const iv = decodeBase64(envelope.iv);
  const ciphertext = decodeBase64(envelope.ciphertext);

  if (iv === null || iv.byteLength !== AES_GCM_IV_BYTES) {
    throw new InvalidContractInputError("credential envelope IV is not a 12-byte base64 value");
  }

  if (
    ciphertext === null ||
    ciphertext.byteLength < AES_GCM_TAG_BYTES ||
    ciphertext.byteLength > MAX_CREDENTIAL_PAYLOAD_BYTES + AES_GCM_TAG_BYTES
  ) {
    throw new InvalidContractInputError("credential envelope ciphertext is out of bounds");
  }

  return { iv, ciphertext };
}

function importKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle
    .importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
    .catch(() => {
      throw new CipherUnavailableError("credential cipher is unavailable");
    });
}

const ENVELOPE_FIELDS: readonly string[] = [
  "version",
  "algorithm",
  "keyId",
  "iv",
  "ciphertext",
];
