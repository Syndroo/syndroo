/**
 * Native workerd evidence for the bounded inbound HTTP body reader.
 *
 * Every request below is a real workerd `Request` with a real
 * `ReadableStream` body. The project's outbound service is fail-closed, so a
 * stray egress attempt can never leave the machine. The file is named
 * `*.native.ts` on purpose: it only runs under
 * `test/http-body-v050.vitest.config.ts`, which owns that fail-closed service,
 * so general discovery can never pick it up without it.
 *
 * The reader starts no mutation of any kind; these tests only prove how one
 * inbound body is bounded, cancelled, decoded and reported.
 */
import { describe, expect, it } from "vitest";

import { ApiError, readJsonBody, readOptionalJsonBody } from "../src/http.js";

const URL_ = "https://worker.example/v1/posts";
const JSON_TYPE = { "content-type": "application/json" };
const SENTINEL = "SENTINEL-BODY-DO-NOT-ECHO";
const CAUSE_SENTINEL = "SENTINEL-CAUSE-DO-NOT-ECHO";
const encoder = new TextEncoder();

type Body = string | Uint8Array | ReadableStream<Uint8Array>;

function requestWith(
  body?: Body | null,
  headers: Record<string, string> = JSON_TYPE,
  signal?: AbortSignal,
): Request {
  return new Request(URL_, {
    method: "POST",
    headers,
    ...(body === undefined || body === null ? {} : { body }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });
}

/** Never enqueues and never closes: a read that stays pending. */
function heldOpenStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start() {
      // Intentionally empty.
    },
  });
}

/** One small chunk per interval, never closing: a slow trickle. */
function trickleStream(intervalMs: number, chunk: Uint8Array): ReadableStream<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (): void => {
        try {
          controller.enqueue(chunk);
        } catch {
          return;
        }

        timer = setTimeout(push, intervalMs);
      };

      timer = setTimeout(push, intervalMs);
    },
    cancel() {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  });
}

/**
 * Always has a chunk ready, so every read resolves in a microtask and the
 * deadline timer can never win a race. Only a finite deadline can stop it, so
 * the producer is bounded as well: after `MAX_ALWAYS_READY_CHUNKS` it errors the
 * stream instead of producing without limit.
 */
const MAX_ALWAYS_READY_CHUNKS = 200_000;

function alwaysReadyStream(chunk: Uint8Array): ReadableStream<Uint8Array> {
  let produced = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced >= MAX_ALWAYS_READY_CHUNKS) {
        controller.error(new Error(CAUSE_SENTINEL));
        return;
      }

      produced += 1;
      controller.enqueue(chunk);
    },
  });
}

async function failureOf(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * External finite watchdog.
 *
 * A hot workerd read loop must never be able to hang this suite: if the read
 * does not settle, the test fails here instead of running forever.
 */
function withWatchdog<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("watchdog: body read did not settle")), timeoutMs);
    }),
  ]);
}

function expectApiError(
  error: unknown,
  expected: { readonly status: number; readonly code: string; readonly message?: string },
): ApiError {
  expect(error).toBeInstanceOf(ApiError);
  const failure = error as ApiError;
  expect(failure.status).toBe(expected.status);
  expect(failure.code).toBe(expected.code);

  if (expected.message !== undefined) {
    expect(failure.message).toBe(expected.message);
  }

  // No raw error, submitted byte, cause or provider text may travel.
  expect(JSON.stringify(failure)).not.toContain(SENTINEL);
  expect(JSON.stringify(failure)).not.toContain(CAUSE_SENTINEL);

  return failure;
}

describe("body presence", () => {
  it("requires a body for readJsonBody", async () => {
    const missing = await failureOf(readJsonBody(requestWith(null)));
    expectApiError(missing, {
      status: 400,
      code: "INVALID_JSON",
      message: "Request body is required",
    });

    const empty = await failureOf(readJsonBody(requestWith("")));
    expectApiError(empty, {
      status: 400,
      code: "INVALID_JSON",
      message: "Request body contains invalid JSON",
    });
  });

  it("distinguishes no body, empty body and a null document", async () => {
    expect(await readOptionalJsonBody(requestWith(null))).toBeUndefined();
    expect(await readOptionalJsonBody(requestWith(""))).toBeUndefined();
    expect(await readOptionalJsonBody(requestWith(""))).not.toBeNull();

    // A zero-byte body carries nothing to decode, so it needs no media type.
    expect(
      await readOptionalJsonBody(requestWith("", { "content-type": "text/plain" })),
    ).toBeUndefined();

    // A present `null` document is parsed, not treated as an absent body.
    expect(await readOptionalJsonBody(requestWith("null"))).toBeNull();
    expect(await readOptionalJsonBody(requestWith("0"))).toBe(0);
    expect(await readOptionalJsonBody(requestWith('{"a":1}'))).toEqual({ a: 1 });
  });

  it("keeps a malformed nonempty optional body an error", async () => {
    const malformed = await failureOf(readOptionalJsonBody(requestWith("{")));
    expectApiError(malformed, {
      status: 400,
      code: "INVALID_JSON",
      message: "Request body contains invalid JSON",
    });

    const wrongType = await failureOf(
      readOptionalJsonBody(requestWith("{}", { "content-type": "text/plain" })),
    );
    expectApiError(wrongType, { status: 415, code: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("consumes the request without starting any other work", async () => {
    const request = requestWith('{"a":1}');

    expect(await readJsonBody(request)).toEqual({ a: 1 });
    expect(request.bodyUsed).toBe(true);
    expect(request.body?.locked).toBe(false);
  });

  it("rejects a body the caller already consumed instead of reading it as empty", async () => {
    const optional = requestWith('{"a":1}');
    expect(await optional.text()).toBe('{"a":1}');
    expect(optional.bodyUsed).toBe(true);

    expectApiError(await failureOf(readOptionalJsonBody(optional)), {
      status: 400,
      code: "INVALID_REQUEST",
      message: "Request body could not be read",
    });

    const required = requestWith('{"a":1}');
    expect(await required.text()).toBe('{"a":1}');

    expectApiError(await failureOf(readJsonBody(required)), {
      status: 400,
      code: "INVALID_REQUEST",
      message: "Request body could not be read",
    });
  });
});

describe("media type", () => {
  it("accepts exactly application/json, case-insensitively, with parameters", async () => {
    const accepted = [
      "application/json",
      "APPLICATION/JSON",
      "Application/Json; charset=utf-8",
      "application/json;charset=utf-8",
      "application/json ; charset=utf-8",
    ];

    for (const contentType of accepted) {
      expect(
        await readJsonBody(requestWith('{"ok":true}', { "content-type": contentType })),
        contentType,
      ).toEqual({ ok: true });
    }
  });

  it("rejects a prefix match, a suffix and a missing media type", async () => {
    const rejected = [
      "application/jsonp",
      "application/json-seq",
      "application/json-patch+json",
      "text/json",
      "text/plain",
      "multipart/form-data",
    ];

    for (const contentType of rejected) {
      const error = await failureOf(
        readJsonBody(requestWith('{"ok":true}', { "content-type": contentType })),
      );
      expectApiError(error, { status: 415, code: "UNSUPPORTED_MEDIA_TYPE" });
    }

    const missing = await failureOf(readJsonBody(requestWith('{"ok":true}', {})));
    expectApiError(missing, { status: 415, code: "UNSUPPORTED_MEDIA_TYPE" });
  });
});

describe("size cap", () => {
  function paddedJson(padding: number): string {
    return `{"pad":"${"x".repeat(padding)}"}`;
  }

  it("accepts exactly 64 KiB, in one chunk and in two", async () => {
    const exact = paddedJson(65_536 - 10);
    expect(encoder.encode(exact).byteLength).toBe(65_536);

    expect(await readJsonBody(requestWith(exact))).toEqual({ pad: "x".repeat(65_526) });

    const bytes = encoder.encode(exact);
    expect(
      await readJsonBody(requestWith(streamOf([bytes.subarray(0, 32_768), bytes.subarray(32_768)]))),
    ).toEqual({ pad: "x".repeat(65_526) });
  });

  it("rejects one byte over the cap, in one chunk and in two", async () => {
    const over = paddedJson(65_536 - 10 + 1);
    expect(encoder.encode(over).byteLength).toBe(65_537);

    expectApiError(await failureOf(readJsonBody(requestWith(over))), {
      status: 413,
      code: "BODY_TOO_LARGE",
      message: "Request body is too large",
    });

    const bytes = encoder.encode(over);
    expectApiError(
      await failureOf(
        readJsonBody(requestWith(streamOf([bytes.subarray(0, 32_768), bytes.subarray(32_768)]))),
      ),
      { status: 413, code: "BODY_TOO_LARGE" },
    );
  });

  it("rejects an oversized chunk before copying it and releases the lock", async () => {
    const request = requestWith(streamOf([new Uint8Array(65_537)]));

    expectApiError(await failureOf(readJsonBody(request)), {
      status: 413,
      code: "BODY_TOO_LARGE",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(request.body?.locked).toBe(false);
  });

  it("rejects a declared oversized length without reading or waiting", async () => {
    let pulls = 0;
    let cancels = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(encoder.encode('{"ok":true}'));
      },
      cancel() {
        cancels += 1;
        // A hung cancellation must not delay the response.
        return new Promise<void>(() => {});
      },
    }, { highWaterMark: 0 });
    const request = requestWith(stream, {
      "content-type": "application/json",
      "content-length": "99999999",
    });
    const started = Date.now();

    expectApiError(await failureOf(readJsonBody(request)), {
      status: 413,
      code: "BODY_TOO_LARGE",
    });

    // `highWaterMark: 0` means the stream itself does not prefetch, so a zero
    // pull count proves the body was never read before the 413.
    expect(pulls).toBe(0);
    expect(cancels).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("rejects an oversized stream that is still open and whose cancel hangs", async () => {
    let cancels = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4_096));
      },
      cancel() {
        cancels += 1;
        return new Promise<void>(() => {});
      },
    });
    const started = Date.now();

    expectApiError(await failureOf(readJsonBody(requestWith(stream))), {
      status: 413,
      code: "BODY_TOO_LARGE",
    });

    expect(cancels).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("observes a rejecting cancellation and still fails closed", async () => {
    let cancels = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4_096));
      },
      cancel() {
        cancels += 1;
        return Promise.reject(new Error(CAUSE_SENTINEL));
      },
    });

    expectApiError(await failureOf(readJsonBody(requestWith(stream))), {
      status: 413,
      code: "BODY_TOO_LARGE",
    });

    expect(cancels).toBe(1);
    // Give the rejected cancellation a chance to surface as an unhandled
    // rejection, which would fail this suite.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("bounds the reader options downward only", async () => {
    expect(await readJsonBody(requestWith('{"a":1}'), { maxBytes: 65_536, deadlineMs: 15_000 })).toEqual(
      { a: 1 },
    );
    expect(await readJsonBody(requestWith('{"a":1}'), { maxBytes: 8 })).toEqual({ a: 1 });

    const refused = [
      { maxBytes: 65_537 },
      { maxBytes: 0 },
      { maxBytes: -1 },
      { maxBytes: 1.5 },
      { deadlineMs: 15_001 },
      { deadlineMs: 0 },
      { deadlineMs: Number.NaN },
    ];

    for (const options of refused) {
      await expect(readJsonBody(requestWith('{"a":1}'), options)).rejects.toBeInstanceOf(RangeError);
    }

    expectApiError(await failureOf(readJsonBody(requestWith('{"a":12345}'), { maxBytes: 4 })), {
      status: 413,
      code: "BODY_TOO_LARGE",
    });
  });
});

describe("deadline and cancellation", () => {
  it("fails a held-open read at the total deadline", async () => {
    const started = Date.now();

    expectApiError(
      await failureOf(readJsonBody(requestWith(heldOpenStream()), { deadlineMs: 40 })),
      {
        status: 400,
        code: "INVALID_REQUEST",
        message: "Request body read timed out",
      },
    );

    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("applies one total deadline to a slow trickle", async () => {
    const request = requestWith(trickleStream(25, encoder.encode(" ")));
    const started = Date.now();

    expectApiError(await failureOf(readJsonBody(request, { deadlineMs: 60 })), {
      status: 400,
      code: "INVALID_REQUEST",
      message: "Request body read timed out",
    });

    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps the deadline finite when the stream is always ready", async () => {
    const request = requestWith(alwaysReadyStream(new Uint8Array(0)));
    const started = Date.now();

    // Both an external watchdog and a bounded producer keep this test finite
    // even if the deadline ever regressed: the producer errors the stream after
    // a fixed number of chunks instead of spinning in workerd forever.
    expectApiError(
      await withWatchdog(failureOf(readJsonBody(request, { deadlineMs: 50 })), 5_000),
      {
        status: 400,
        code: "INVALID_REQUEST",
        message: "Request body read timed out",
      },
    );

    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps the deadline finite after one nonempty chunk and endless empty chunks", async () => {
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= MAX_ALWAYS_READY_CHUNKS) {
          controller.error(new Error(CAUSE_SENTINEL));
          return;
        }

        produced += 1;
        // Only the first chunk carries a byte: the stored-chunk count stays at
        // one, so a yield cadence keyed on stored chunks would never fire.
        controller.enqueue(produced === 1 ? new Uint8Array([0x20]) : new Uint8Array(0));
      },
    });
    const request = requestWith(stream);
    const started = Date.now();

    expectApiError(
      await withWatchdog(failureOf(readJsonBody(request, { deadlineMs: 50 })), 5_000),
      {
        status: 400,
        code: "INVALID_REQUEST",
        message: "Request body read timed out",
      },
    );

    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("fails when the request is cancelled in the same step as its final chunk", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        streamController.enqueue(encoder.encode('{"ok":true}'));
        streamController.close();
        // Cancellation lands in the same step as the last chunk and the close,
        // so a race the read wins must still not become a success.
        controller.abort();
      },
    });
    const request = requestWith(stream, JSON_TYPE, controller.signal);

    const failure = await failureOf(readJsonBody(request));

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(400);
    expect((failure as ApiError).code).toBe("INVALID_REQUEST");
  });

  it("fails a pre-aborted request even when its body is already ready", async () => {
    const controller = new AbortController();
    const ready = requestWith(
      streamOf([encoder.encode('{"ok":true}')]),
      JSON_TYPE,
      controller.signal,
    );
    const empty = requestWith("", JSON_TYPE, controller.signal);
    const missing = requestWith(null, JSON_TYPE, controller.signal);
    controller.abort();

    expect(ready.signal.aborted).toBe(true);

    for (const request of [ready, empty, missing]) {
      expectApiError(await failureOf(readJsonBody(request)), {
        status: 400,
        code: "INVALID_REQUEST",
        message: "Request body read was cancelled",
      });
    }

    const optional = requestWith("", JSON_TYPE, controller.signal);
    expectApiError(await failureOf(readOptionalJsonBody(optional)), {
      status: 400,
      code: "INVALID_REQUEST",
    });
  });

  it("still parses a ready body when the request is not cancelled", async () => {
    const controller = new AbortController();
    const ready = requestWith(
      streamOf([encoder.encode('{"ok":true}')]),
      JSON_TYPE,
      controller.signal,
    );

    expect(await readJsonBody(ready, { deadlineMs: 5_000 })).toEqual({ ok: true });
  });

  it("stops promptly when the request is cancelled mid-read", async () => {
    const controller = new AbortController();
    const request = requestWith(heldOpenStream(), JSON_TYPE, controller.signal);
    const started = Date.now();
    const pending = readJsonBody(request);

    setTimeout(() => controller.abort(), 10);

    const failure = await failureOf(pending);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(400);
    expect((failure as ApiError).code).toBe("INVALID_REQUEST");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("bytes and decoding", () => {
  it("copies each chunk before the next read", async () => {
    const head = encoder.encode('{"value":"');
    const tail = encoder.encode('BBBB"}');
    const buffer = new Uint8Array(head.byteLength);
    buffer.set(head);
    const parts = [head.byteLength, tail.byteLength];
    let index = 0;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= parts.length) {
          controller.close();
          return;
        }

        const size = parts[index] as number;

        if (index > 0) {
          // Reuse the same buffer for the second chunk: without a copy the
          // first chunk would be corrupted by this write.
          buffer.fill(0x21);
          buffer.set(tail.subarray(0, size));
        }

        index += 1;
        controller.enqueue(buffer.subarray(0, size));
      },
    });

    expect(await readJsonBody(requestWith(stream))).toEqual({ value: "BBBB" });
  });

  it("joins split chunks, including split multi-byte characters", async () => {
    const text = '{"text":"日本語 ✓"}';
    const bytes = encoder.encode(text);
    const split = [bytes.subarray(0, 3), bytes.subarray(3, 4), bytes.subarray(4)];

    expect(await readJsonBody(requestWith(streamOf(split)))).toEqual({ text: "日本語 ✓" });

    const singleBytes = [...bytes].map((byte) => new Uint8Array([byte]));
    expect(await readJsonBody(requestWith(streamOf(singleBytes)))).toEqual({ text: "日本語 ✓" });
  });

  it("rejects malformed UTF-8 and malformed JSON with one fixed 400", async () => {
    const invalidByteInsideJson = new Uint8Array([
      ...encoder.encode('{"a":"'),
      0xff,
      ...encoder.encode('"}'),
    ]);
    const cases: readonly Uint8Array[] = [
      encoder.encode("{"),
      encoder.encode("not json"),
      encoder.encode("[1,]"),
      new Uint8Array([0xff, 0xfe]),
      invalidByteInsideJson,
    ];

    for (const bytes of cases) {
      expectApiError(await failureOf(readJsonBody(requestWith(streamOf([bytes])))), {
        status: 400,
        code: "INVALID_JSON",
        message: "Request body contains invalid JSON",
      });
    }
  });

  it("maps a stream failure to a fixed error without echoing it", async () => {
    const failed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(CAUSE_SENTINEL));
      },
    });

    expectApiError(await failureOf(readJsonBody(requestWith(failed))), {
      status: 400,
      code: "INVALID_REQUEST",
      message: "Request body could not be read",
    });
  });

  it("does not trust an ApiError raised by the stream", async () => {
    const forged = new ApiError(SENTINEL, 500, "FORGED");
    const failed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(forged);
      },
    });

    const failure = await failureOf(readJsonBody(requestWith(failed)));

    expect(failure).not.toBe(forged);
    expectApiError(failure, {
      status: 400,
      code: "INVALID_REQUEST",
      message: "Request body could not be read",
    });
  });

  it("maps a body that is already locked to a fixed error", async () => {
    const request = requestWith(streamOf([encoder.encode('{"a":1}')]));
    const body = request.body as ReadableStream<Uint8Array>;
    body.getReader();

    expectApiError(await failureOf(readJsonBody(request)), {
      status: 400,
      code: "INVALID_REQUEST",
      message: "Request body could not be read",
    });
  });
});

describe("project isolation", () => {
  it("has a fail-closed outbound service", async () => {
    const response = await fetch("https://unlisted.invalid/v1/posts");

    expect(response.status).toBe(500);
  });
});
