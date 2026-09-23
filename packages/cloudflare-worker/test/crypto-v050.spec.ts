/**
 * Credential cipher and binding signer conformance (design §14, contracts §10).
 *
 * Interoperability is checked in both directions against `node:crypto`, an
 * independent AES-GCM/HMAC implementation available inside workerd through
 * `nodejs_compat`. No test reads a real secret.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CipherUnavailableError,
  InvalidContractInputError,
  computeCredentialBinding,
  encodeBindingMaterial,
  encodeCipherAad,
  type EncryptedCredential,
} from "@syndroo/application";

import { createAesGcmCipher } from "../src/infrastructure/crypto/aes-gcm-cipher.js";
import { createHmacBindingSigner } from "../src/infrastructure/crypto/hmac-binding-signer.js";
import {
  TEST_BINDING_KEY,
  TEST_CIPHER_KEY,
  TEST_CIPHER_KEY_ID,
  TEST_CONTEXT,
  TEST_OTHER_KEY,
  contextWith,
} from "./support/storage-v050-fixtures.js";

const cipher = () => createAesGcmCipher({ key: TEST_CIPHER_KEY, keyId: TEST_CIPHER_KEY_ID });

describe("AES-256-GCM credential cipher", () => {
  it("round trips a payload with the exact AAD tuple", async () => {
    const instance = cipher();
    const payload = new TextEncoder().encode('{"access_token":"sentinel-token"}');

    const envelope = await instance.encrypt(payload, TEST_CONTEXT);

    expect(envelope.algorithm).toBe("AES-256-GCM");
    expect(envelope.version).toBe(1);
    expect(envelope.keyId).toBe(TEST_CIPHER_KEY_ID);
    await expect(instance.decrypt(envelope, TEST_CONTEXT)).resolves.toEqual(payload);
  });

  it("uses a fresh random IV per envelope", async () => {
    const instance = cipher();
    const payload = new TextEncoder().encode("same payload");

    const first = await instance.encrypt(payload, TEST_CONTEXT);
    const second = await instance.encrypt(payload, TEST_CONTEXT);

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("fails closed for a wrong key", async () => {
    const envelope = await cipher().encrypt(new TextEncoder().encode("secret"), TEST_CONTEXT);
    const other = createAesGcmCipher({ key: TEST_OTHER_KEY, keyId: TEST_CIPHER_KEY_ID });

    await expect(other.decrypt(envelope, TEST_CONTEXT)).rejects.toBeInstanceOf(
      CipherUnavailableError,
    );
  });

  it("fails closed for an unknown key id", async () => {
    const envelope = await cipher().encrypt(new TextEncoder().encode("secret"), TEST_CONTEXT);

    await expect(
      cipher().decrypt({ ...envelope, keyId: "k9" }, TEST_CONTEXT),
    ).rejects.toBeInstanceOf(CipherUnavailableError);
  });

  it("fails closed for a corrupted tag", async () => {
    const instance = cipher();
    const envelope = await instance.encrypt(new TextEncoder().encode("secret"), TEST_CONTEXT);
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    const lastIndex = bytes.length - 1;
    bytes[lastIndex] = (bytes[lastIndex] ?? 0) ^ 0x01;

    await expect(
      instance.decrypt({ ...envelope, ciphertext: bytes.toString("base64") }, TEST_CONTEXT),
    ).rejects.toBeInstanceOf(CipherUnavailableError);
  });

  it.each([
    ["purpose", contextWith({ purpose: "oauth_candidate" })],
    ["recordId", contextWith({ recordId: "slot-threads" })],
    ["platform", contextWith({ platform: "threads" })],
    ["payloadSchemaVersion", contextWith({ payloadSchemaVersion: 2 })],
    ["payloadRevision", contextWith({ payloadRevision: 7 })],
  ])("rejects a changed %s in the AAD", async (_field, changed) => {
    const instance = cipher();
    const envelope = await instance.encrypt(new TextEncoder().encode("secret"), TEST_CONTEXT);

    await expect(instance.decrypt(envelope, changed as typeof TEST_CONTEXT)).rejects.toBeInstanceOf(
      CipherUnavailableError,
    );
  });

  it.each([
    ["empty IV", { iv: "" }],
    ["malformed IV", { iv: "not base64!!" }],
    ["16-byte IV", { iv: Buffer.from(randomBytes(16)).toString("base64") }],
    ["empty ciphertext", { ciphertext: "" }],
    ["short ciphertext", { ciphertext: Buffer.alloc(8).toString("base64") }],
    ["unknown version", { version: 2 }],
    ["unknown algorithm", { algorithm: "AES-128-GCM" }],
  ])("rejects a malformed envelope (%s)", async (_label, patch) => {
    const instance = cipher();
    const envelope = await instance.encrypt(new TextEncoder().encode("secret"), TEST_CONTEXT);

    await expect(
      instance.decrypt({ ...envelope, ...patch } as EncryptedCredential, TEST_CONTEXT),
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects empty and oversized payloads before encrypting", async () => {
    const instance = cipher();

    await expect(instance.encrypt(new Uint8Array(0), TEST_CONTEXT)).rejects.toBeInstanceOf(
      InvalidContractInputError,
    );
    await expect(
      instance.encrypt(new Uint8Array(64 * 1024 + 1), TEST_CONTEXT),
    ).rejects.toBeInstanceOf(InvalidContractInputError);
  });

  it("copies the caller buffer before awaiting", async () => {
    const instance = cipher();
    const payload = new TextEncoder().encode("original-payload");
    const pending = instance.encrypt(payload, TEST_CONTEXT);

    payload.fill(0);

    await expect(instance.decrypt(await pending, TEST_CONTEXT)).resolves.toEqual(
      new TextEncoder().encode("original-payload"),
    );
  });

  it.each([
    ["purpose", contextWith({ purpose: "not_a_purpose" as never })],
    ["platform", contextWith({ platform: "instagram" as never })],
    ["recordId", contextWith({ recordId: "" })],
    ["recordId length", contextWith({ recordId: "x".repeat(129) })],
    ["payloadSchemaVersion", contextWith({ payloadSchemaVersion: 0 })],
    ["payloadRevision", contextWith({ payloadRevision: -1 })],
    ["payloadRevision fraction", contextWith({ payloadRevision: 1.5 })],
  ])("rejects an invalid context %s before encrypting", async (_label, bad) => {
    await expect(
      cipher().encrypt(new TextEncoder().encode("secret"), bad as typeof TEST_CONTEXT),
    ).rejects.toBeInstanceOf(InvalidContractInputError);

    const envelope = await cipher().encrypt(new TextEncoder().encode("secret"), TEST_CONTEXT);
    await expect(cipher().decrypt(envelope, bad as typeof TEST_CONTEXT)).rejects.toBeInstanceOf(
      InvalidContractInputError,
    );
  });

  it("rejects an envelope carrying an unknown field", async () => {
    const instance = cipher();
    const envelope = await instance.encrypt(new TextEncoder().encode("secret"), TEST_CONTEXT);
    const withExtra = { ...envelope, plaintext: "leak" } as EncryptedCredential;

    await expect(instance.decrypt(withExtra, TEST_CONTEXT)).rejects.toBeInstanceOf(
      InvalidContractInputError,
    );
  });

  it("rejects an oversized encoded ciphertext before decoding it", async () => {
    const instance = cipher();
    const envelope = await instance.encrypt(new TextEncoder().encode("secret"), TEST_CONTEXT);
    const huge = { ...envelope, ciphertext: "A".repeat(200_000) } as EncryptedCredential;

    await expect(instance.decrypt(huge, TEST_CONTEXT)).rejects.toBeInstanceOf(
      InvalidContractInputError,
    );
  });

  it("decrypts an envelope produced by independent node:crypto", async () => {
    const iv = randomBytes(12);
    const key = Buffer.from(TEST_CIPHER_KEY, "base64");
    const nodeCipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    nodeCipher.setAAD(encodeCipherAad(TEST_CONTEXT));
    const plaintext = new TextEncoder().encode('{"access_token":"node-produced"}');
    const body = Buffer.concat([nodeCipher.update(plaintext), nodeCipher.final()]);
    const envelope: EncryptedCredential = {
      version: 1,
      algorithm: "AES-256-GCM",
      keyId: TEST_CIPHER_KEY_ID,
      iv: iv.toString("base64"),
      ciphertext: Buffer.concat([body, nodeCipher.getAuthTag()]).toString("base64"),
    };

    await expect(cipher().decrypt(envelope, TEST_CONTEXT)).resolves.toEqual(plaintext);
  });

  it("produces an envelope that independent node:crypto can decrypt", async () => {
    const envelope = await cipher().encrypt(
      new TextEncoder().encode('{"access_token":"workerd-produced"}'),
      TEST_CONTEXT,
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(TEST_CIPHER_KEY, "base64"),
      Buffer.from(envelope.iv, "base64"),
      { authTagLength: 16 },
    );
    decipher.setAAD(encodeCipherAad(TEST_CONTEXT));
    const raw = Buffer.from(envelope.ciphertext, "base64");
    const body = raw.subarray(0, raw.length - 16);
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const opened = Buffer.concat([decipher.update(body), decipher.final()]);

    expect(opened.toString("utf8")).toBe('{"access_token":"workerd-produced"}');
  });
});

describe("HMAC-SHA-256 binding signer", () => {
  const signer = () => createHmacBindingSigner({ key: TEST_BINDING_KEY });
  const material = (token: string | null) =>
    encodeBindingMaterial({
      platform: "bluesky",
      source: "credential",
      fields: [
        ["binding_id", "binding-1"],
        ["user_token", token],
      ],
    });

  it("returns a lowercase hex digest and a versioned binding", async () => {
    const digest = await signer().sign(material("token-a"));

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    await expect(computeCredentialBinding(material("token-a"), signer())).resolves.toBe(
      `v1:${digest}`,
    );
  });

  it("is stable across unrelated cipher operations and changes with material or key", async () => {
    const instance = cipher();
    const before = await signer().sign(material("token-a"));

    await instance.encrypt(new TextEncoder().encode("unrelated"), TEST_CONTEXT);

    expect(await signer().sign(material("token-a"))).toBe(before);
    expect(await signer().sign(material("token-b"))).not.toBe(before);
    expect(
      await createHmacBindingSigner({ key: TEST_OTHER_KEY }).sign(material("token-a")),
    ).not.toBe(before);
  });

  it("rejects a short binding key at construction", () => {
    expect(() =>
      createHmacBindingSigner({ key: Buffer.alloc(16).toString("base64") }),
    ).toThrow();
  });

  it("rejects an unsupported binding material version", async () => {
    const material = encodeBindingMaterial({
      platform: "bluesky",
      source: "credential",
      fields: [["binding_id", "binding-1"]],
    });

    await expect(
      signer().sign({ ...material, version: 2 } as typeof material),
    ).rejects.toBeInstanceOf(InvalidContractInputError);
  });
});
