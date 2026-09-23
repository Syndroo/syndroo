/**
 * Independent R2 blob adapter.
 *
 * 0.5.0 implements and tests this port without exposing any media product API.
 *
 * Reference-adapter resource policy (not an R2 or product limit): streamed
 * input is read through a bounded buffer with a total read deadline, because
 * buffering inside a Worker shares the isolate's memory budget. Both bounds are
 * configurable downward only. The port still accepts a standard
 * unknown-length `ReadableStream`.
 */
import {
  CorruptStoreRecordError,
  InvalidContractInputError,
  StoreUnavailable,
  isSafeBlobKey,
  type BinaryBody,
  type BlobKey,
  type BlobMetadata,
  type BlobRead,
  type BlobStore,
  type StoredBlob,
} from "@syndroo/application";

/** Reference-adapter default; callers may only configure a smaller bound. */
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;
/** Reference-adapter total read deadline for one streamed body. */
export const DEFAULT_STREAM_READ_DEADLINE_MS = 15_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface R2BlobStoreOptions {
  readonly bucket: R2Bucket;
  /** Optional smaller byte bound; values above the default are rejected. */
  readonly maxBytes?: number;
  /** Optional smaller read deadline; values above the default are rejected. */
  readonly streamReadDeadlineMs?: number;
}

export function createR2BlobStore(options: R2BlobStoreOptions): BlobStore {
  const { bucket } = options;
  const maxBytes = boundedDownward(options.maxBytes ?? MAX_BLOB_BYTES, MAX_BLOB_BYTES, "blob size bound");
  const deadlineMs = boundedDownward(
    options.streamReadDeadlineMs ?? DEFAULT_STREAM_READ_DEADLINE_MS,
    DEFAULT_STREAM_READ_DEADLINE_MS,
    "blob stream deadline",
  );

  return {
    async put(key: BlobKey, body: BinaryBody, metadata: BlobMetadata): Promise<StoredBlob> {
      requireBlobKey(key);
      // Snapshot the metadata before awaiting: the description we validate and
      // store must be the caller's original operation even if the caller
      // mutates its own object while the body is being read.
      const contentType = requireContentType(metadata.contentType);
      const declaredLength = snapshotLength(metadata.byteLength);
      const declaredChecksum = snapshotChecksum(metadata.checksum);

      const bytes = await readBounded(body, maxBytes, deadlineMs);

      if (declaredLength !== null && declaredLength !== bytes.byteLength) {
        throw new InvalidContractInputError("blob metadata length does not match the body");
      }

      const checksum = await sha256Hex(bytes);

      if (declaredChecksum !== null && declaredChecksum !== checksum) {
        throw new InvalidContractInputError("blob metadata checksum does not match the body");
      }

      const written = await guardBucket("blob write failed", () =>
        bucket.put(key, bytes, { httpMetadata: { contentType } }),
      );

      if (written === null) {
        // The binding returned no object: never report a successful write.
        throw new StoreUnavailable("blob write did not commit");
      }

      return { key, size: bytes.byteLength, contentType, checksum };
    },

    async get(key: BlobKey): Promise<BlobRead | null> {
      requireBlobKey(key);

      const object = await guardBucket("blob read failed", () => bucket.get(key));

      if (object === null) {
        return null;
      }

      // Check the recorded size before materialising anything.
      if (object.size > maxBytes) {
        throw new InvalidContractInputError("stored blob exceeds the configured bound");
      }

      const bytes = await guardBucket("blob read failed", async () =>
        new Uint8Array(await object.arrayBuffer()),
      );

      if (bytes.byteLength > maxBytes) {
        throw new InvalidContractInputError("stored blob exceeds the configured bound");
      }

      if (object.size !== bytes.byteLength) {
        throw new CorruptStoreRecordError("stored blob length does not match its contents");
      }

      const recordedSha256 = object.checksums?.sha256;

      if (recordedSha256 !== undefined) {
        const digest = await sha256Hex(bytes);
        const recorded = [...new Uint8Array(recordedSha256)]
          .map(byte => byte.toString(16).padStart(2, "0"))
          .join("");

        if (recorded !== digest) {
          throw new CorruptStoreRecordError("stored blob checksum does not match its contents");
        }
      }

      return {
        key,
        body: bytes,
        contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
        size: bytes.byteLength,
      };
    },

    async delete(key: BlobKey): Promise<void> {
      requireBlobKey(key);
      await guardBucket("blob delete failed", () => bucket.delete(key));
    },

    async exists(key: BlobKey): Promise<boolean> {
      requireBlobKey(key);
      return (await guardBucket("blob head failed", () => bucket.head(key))) !== null;
    },
  };
}

function boundedDownward(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new InvalidContractInputError(`${label} must be a positive integer no greater than ${maximum}`);
  }

  return value;
}

function requireBlobKey(key: unknown): BlobKey {
  if (!isSafeBlobKey(key)) {
    throw new InvalidContractInputError("blob key must be a bounded logical key");
  }

  return key;
}

function requireContentType(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new InvalidContractInputError("blob content type must be a bounded string");
  }

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;

    if (codePoint < 0x20 || codePoint === 0x7f) {
      throw new InvalidContractInputError("blob content type must not contain control characters");
    }
  }

  return value;
}

function snapshotLength(value: unknown): number | null {
  if (value === null) {
    return null;
  }

  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidContractInputError("blob byteLength must be null or a non-negative integer");
  }

  return value as number;
}

function snapshotChecksum(value: unknown): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new InvalidContractInputError("blob checksum must be null or a lowercase SHA-256 hex digest");
  }

  return value;
}

/** Fixed safe error text; the bucket's own message and cause never escape. */
async function guardBucket<T>(message: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new StoreUnavailable(message);
  }
}

async function readBounded(
  body: BinaryBody,
  maxBytes: number,
  deadlineMs: number,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) {
      throw new InvalidContractInputError("blob body exceeds the configured bound");
    }

    return Uint8Array.from(body);
  }

  if (typeof body !== "object" || body === null || typeof body.getReader !== "function") {
    throw new InvalidContractInputError("blob body must be bytes or a byte stream");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let expired = false;

  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => undefined);
  }, deadlineMs);

  try {
    while (true) {
      const step = await reader.read();

      if (step.done) {
        break;
      }

      if (!(step.value instanceof Uint8Array)) {
        throw new InvalidContractInputError("blob stream chunks must be byte arrays");
      }

      total += step.value.byteLength;

      if (total > maxBytes) {
        throw new InvalidContractInputError("blob stream exceeds the configured bound");
      }

      // Copy immediately: the producer may reuse its chunk buffer.
      chunks.push(Uint8Array.from(step.value));
    }

    if (expired) {
      throw new StoreUnavailable("blob stream read timed out");
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);

    if (error instanceof InvalidContractInputError) {
      throw error;
    }

    if (expired) {
      throw new StoreUnavailable("blob stream read timed out");
    }

    throw new StoreUnavailable("blob stream could not be read");
  } finally {
    clearTimeout(timer);

    try {
      reader.releaseLock();
    } catch {
      // A read was still pending; the lock dies with the stream.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
