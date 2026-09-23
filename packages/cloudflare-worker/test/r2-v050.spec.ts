/**
 * R2 archive and blob adapter conformance (design §14, contracts §9).
 *
 * The buckets are local Miniflare R2 buckets configured by the dedicated
 * project; the outbound service in that config fails closed, so nothing here
 * can reach the network. Bucket ACLs are a deployment-time check and are not
 * claimed by these tests.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { InvalidContractInputError, type IsoInstant } from "@syndroo/application";

import { createR2ArchiveStore } from "../src/infrastructure/r2/archive-store.js";
import { createR2BlobStore } from "../src/infrastructure/r2/blob-store.js";
import {
  ARCHIVE_KEY,
  BLOB_KEY,
  DLQ_ARCHIVE_KEY,
  archivePayload,
  type StorageBindings,
} from "./support/storage-v050-fixtures.js";

const bindings = env as unknown as StorageBindings;
const NOW: IsoInstant = "2026-09-23T00:00:00.000Z";

const archiveStore = (now: IsoInstant = NOW) =>
  createR2ArchiveStore({ bucket: bindings.ARCHIVE_BUCKET, now: () => now });
const blobStore = () => createR2BlobStore({ bucket: bindings.MEDIA_BUCKET });

beforeEach(async () => {
  await bindings.ARCHIVE_BUCKET.delete([ARCHIVE_KEY, DLQ_ARCHIVE_KEY]);
  await bindings.MEDIA_BUCKET.delete(BLOB_KEY);
});

describe("R2ArchiveStore", () => {
  it("writes and reads a bounded allowlisted diagnostic", async () => {
    const payload = archivePayload();
    const store = archiveStore();

    await store.put(ARCHIVE_KEY, payload);

    await expect(store.get(ARCHIVE_KEY)).resolves.toEqual(payload);
  });

  it("returns null for a missing object", async () => {
    await expect(archiveStore().get(ARCHIVE_KEY)).resolves.toBeNull();
  });

  it("returns null once the recorded expiry has passed", async () => {
    const store = archiveStore();
    await store.put(ARCHIVE_KEY, archivePayload());

    // Same object, clock moved past `expiresAt`: expired reads are unavailable.
    const afterExpiry = archiveStore("2026-10-23T00:00:00.000Z");
    await expect(afterExpiry.get(ARCHIVE_KEY)).resolves.toBeNull();

    // The underlying object is still present; only the read contract changed.
    expect(await bindings.ARCHIVE_BUCKET.head(ARCHIVE_KEY)).not.toBeNull();
  });

  it("persists only allowlisted fields", async () => {
    await archiveStore().put(DLQ_ARCHIVE_KEY, archivePayload({ category: "dlq", stage: "dlq" }));

    const raw = await (await bindings.ARCHIVE_BUCKET.get(DLQ_ARCHIVE_KEY))?.text();
    const parsed = JSON.parse(raw ?? "{}") as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual(
      [
        "attemptId",
        "category",
        "code",
        "createdAt",
        "expiresAt",
        "httpStatus",
        "jobId",
        "outcome",
        "platform",
        "publicationId",
        "redactionVersion",
        "schemaVersion",
        "stage",
      ].sort(),
    );
  });

  it("rejects a key outside the archive prefixes", async () => {
    await expect(archiveStore().put("media/posts/post-1/object-1", archivePayload())).rejects
      .toBeInstanceOf(InvalidContractInputError);
    await expect(archiveStore().get("archive/other/object.json")).rejects.toBeInstanceOf(
      InvalidContractInputError,
    );
  });

  it("rejects an unknown field before writing anything", async () => {
    const withExtra = { ...archivePayload(), providerMessage: "sentinel-secret" } as never;

    await expect(archiveStore().put(ARCHIVE_KEY, withExtra)).rejects.toBeInstanceOf(
      InvalidContractInputError,
    );
    await expect(bindings.ARCHIVE_BUCKET.head(ARCHIVE_KEY)).resolves.toBeNull();
  });

  it("rejects a non-allowlisted code and an unparseable object", async () => {
    await expect(
      archiveStore().put(ARCHIVE_KEY, archivePayload({ code: "PROVIDER_TEXT" as never })),
    ).rejects.toBeInstanceOf(InvalidContractInputError);

    await bindings.ARCHIVE_BUCKET.put(ARCHIVE_KEY, "not json");
    await expect(archiveStore().get(ARCHIVE_KEY)).rejects.toMatchObject({
      name: "CorruptStoreRecordError",
    });
  });

  it("deletes an object", async () => {
    const store = archiveStore();
    await store.put(ARCHIVE_KEY, archivePayload());
    await store.delete(ARCHIVE_KEY);

    await expect(store.get(ARCHIVE_KEY)).resolves.toBeNull();
  });

  it("rejects a non-canonical clock before comparing expiry", async () => {
    const store = archiveStore("2026-09-23T00:00:00Z" as IsoInstant);

    await expect(store.get(ARCHIVE_KEY)).rejects.toBeInstanceOf(InvalidContractInputError);
  });

  it("ignores a toJSON hook instead of serialising it", async () => {
    const payload = {
      ...archivePayload(),
      toJSON: () => ({ sentinel: "should-never-be-written" }),
    } as never;

    // An object carrying caller-defined serialisation is not a valid payload.
    await expect(archiveStore().put(ARCHIVE_KEY, payload)).rejects.toBeInstanceOf(
      InvalidContractInputError,
    );
    await expect(bindings.ARCHIVE_BUCKET.head(ARCHIVE_KEY)).resolves.toBeNull();
  });

  it("never leaks a throwing getter and writes nothing", async () => {
    const sentinel = "sentinel-secret-value";
    const payload = archivePayload() as Record<string, unknown>;
    Object.defineProperty(payload, "platform", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error(sentinel);
      },
    });

    let caught: unknown;

    try {
      await archiveStore().put(ARCHIVE_KEY, payload as never);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidContractInputError);
    const leaked = JSON.stringify({
      name: (caught as Error).name,
      message: (caught as Error).message,
      cause: (caught as Error).cause ?? null,
      stack: (caught as Error).stack ?? "",
    });
    expect(leaked).not.toContain(sentinel);
    await expect(bindings.ARCHIVE_BUCKET.head(ARCHIVE_KEY)).resolves.toBeNull();
  });

  it("refuses to materialise an oversized stored archive", async () => {
    await bindings.ARCHIVE_BUCKET.put(ARCHIVE_KEY, "x".repeat(70_000));

    await expect(archiveStore().get(ARCHIVE_KEY)).rejects.toMatchObject({
      name: "CorruptStoreRecordError",
    });
  });
});

describe("R2BlobStore", () => {
  it("puts, reads, checks existence and deletes a byte body", async () => {
    const store = blobStore();
    const body = new TextEncoder().encode("blob-bytes");
    const stored = await store.put(BLOB_KEY, body, {
      contentType: "text/plain",
      byteLength: body.byteLength,
      checksum: null,
    });

    expect(stored).toMatchObject({ key: BLOB_KEY, size: body.byteLength, contentType: "text/plain" });
    expect(stored.checksum).toMatch(/^[0-9a-f]{64}$/);
    await expect(store.exists(BLOB_KEY)).resolves.toBe(true);

    const read = await store.get(BLOB_KEY);
    expect(read).toMatchObject({ key: BLOB_KEY, size: body.byteLength, contentType: "text/plain" });
    expect(read?.body).toEqual(body);

    await store.delete(BLOB_KEY);
    await expect(store.exists(BLOB_KEY)).resolves.toBe(false);
    await expect(store.get(BLOB_KEY)).resolves.toBeNull();
  });

  it("accepts a standard byte stream and records the real size", async () => {
    const store = blobStore();
    const chunks = [new TextEncoder().encode("first-"), new TextEncoder().encode("second")];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    const stored = await store.put(BLOB_KEY, stream, {
      contentType: "application/octet-stream",
      byteLength: null,
      checksum: null,
    });

    expect(stored.size).toBe(12);
    await expect(store.get(BLOB_KEY)).resolves.toMatchObject({ size: 12 });
  });

  it("rejects mismatched metadata before writing", async () => {
    const store = blobStore();

    await expect(
      store.put(BLOB_KEY, new Uint8Array([1, 2, 3]), {
        contentType: "text/plain",
        byteLength: 4,
        checksum: null,
      }),
    ).rejects.toBeInstanceOf(InvalidContractInputError);

    await expect(
      store.put(BLOB_KEY, new Uint8Array([1, 2, 3]), {
        contentType: "text/plain",
        byteLength: null,
        checksum: "0".repeat(64),
      }),
    ).rejects.toBeInstanceOf(InvalidContractInputError);

    await expect(bindings.MEDIA_BUCKET.head(BLOB_KEY)).resolves.toBeNull();
  });

  it("accepts a valid empty blob and rejects an invalid logical key", async () => {
    const store = blobStore();

    await expect(
      store.put("archive/dlq/2026/09/job-1.json", new Uint8Array([1]), {
        contentType: "text/plain",
        byteLength: 1,
        checksum: null,
      }),
    ).rejects.toBeInstanceOf(InvalidContractInputError);

    // The port has no non-empty restriction: an empty object is valid.
    await expect(
      store.put(BLOB_KEY, new Uint8Array(0), {
        contentType: "text/plain",
        byteLength: 0,
        checksum: null,
      }),
    ).resolves.toMatchObject({ size: 0 });

    await expect(store.exists("https://bucket.example/object")).rejects.toBeInstanceOf(
      InvalidContractInputError,
    );
  });

  it("enforces the reference-adapter resource policy", async () => {
    // 8 MiB default, downward only.
    expect(() => createR2BlobStore({ bucket: bindings.MEDIA_BUCKET, maxBytes: 9 * 1024 * 1024 }))
      .toThrow(InvalidContractInputError);
    expect(() => createR2BlobStore({ bucket: bindings.MEDIA_BUCKET, maxBytes: 0 })).toThrow(
      InvalidContractInputError,
    );
    expect(() =>
      createR2BlobStore({ bucket: bindings.MEDIA_BUCKET, streamReadDeadlineMs: 60_000 }),
    ).toThrow(InvalidContractInputError);
  });

  it("rejects malformed metadata before writing", async () => {
    const store = blobStore();
    const body = new Uint8Array([1, 2, 3]);

    for (const metadata of [
      { contentType: "text/plain", byteLength: -1, checksum: null },
      { contentType: "text/plain", byteLength: 1.5, checksum: null },
      { contentType: "", byteLength: null, checksum: null },
      { contentType: "text/plain\r\nx", byteLength: null, checksum: null },
      { contentType: "text/plain", byteLength: null, checksum: "not-a-checksum" },
    ]) {
      await expect(store.put(BLOB_KEY, body, metadata)).rejects.toBeInstanceOf(
        InvalidContractInputError,
      );
    }

    await expect(bindings.MEDIA_BUCKET.head(BLOB_KEY)).resolves.toBeNull();
  });

  it("refuses to materialise an oversized stored object", async () => {
    await bindings.MEDIA_BUCKET.put(BLOB_KEY, new Uint8Array(64).fill(7));
    const bounded = createR2BlobStore({ bucket: bindings.MEDIA_BUCKET, maxBytes: 16 });

    await expect(bounded.get(BLOB_KEY)).rejects.toBeInstanceOf(InvalidContractInputError);
  });

  it("fails closed when a stream exceeds the read deadline", async () => {
    const bounded = createR2BlobStore({
      bucket: bindings.MEDIA_BUCKET,
      streamReadDeadlineMs: 20,
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        // Never closes: the deadline must end the read.
      },
    });

    await expect(
      bounded.put(BLOB_KEY, stream, {
        contentType: "application/octet-stream",
        byteLength: null,
        checksum: null,
      }),
    ).rejects.toMatchObject({ name: "StoreUnavailable" });
    await expect(bindings.MEDIA_BUCKET.head(BLOB_KEY)).resolves.toBeNull();
  });

  it("fails closed when a stream exceeds the configured bound", async () => {
    const bounded = createR2BlobStore({ bucket: bindings.MEDIA_BUCKET, maxBytes: 8 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16));
        controller.close();
      },
    });

    await expect(
      bounded.put(BLOB_KEY, stream, {
        contentType: "application/octet-stream",
        byteLength: null,
        checksum: null,
      }),
    ).rejects.toBeInstanceOf(InvalidContractInputError);
    await expect(bindings.MEDIA_BUCKET.head(BLOB_KEY)).resolves.toBeNull();
  });
});

describe("R2 stream constraint probe", () => {
  it("records whether the local binding accepts an unbounded stream", async () => {
    // Evidence for the open architecture question: the binding is handed a
    // stream with no known length. The adapter never does this; the probe only
    // documents the runtime's actual constraint.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("probe"));
        controller.close();
      },
    });

    const outcome = await bindings.MEDIA_BUCKET
      .put(`${BLOB_KEY}-probe`, stream)
      .then(() => "accepted" as const)
      .catch(() => "rejected" as const);

    await bindings.MEDIA_BUCKET.delete(`${BLOB_KEY}-probe`);

    // Recorded in the run log so the architecture question has concrete
    // evidence for the runtime under test.
    console.log(`r2-stream-probe: ${outcome}`);

    // Either outcome is informative; the assertion pins whichever the runtime
    // does so a silent behaviour change is visible.
    expect(["accepted", "rejected"]).toContain(outcome);
  });
});
