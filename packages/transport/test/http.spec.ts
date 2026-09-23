/**
 * Failure fixtures for the bounded request lifecycle (acceptance NET-03/NET-04).
 *
 * Every fixture asserts a bound: either an error code with no response, or a
 * result that arrives within the deadline. They must fail before the
 * implementation exists and pass afterwards without being relaxed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TransportError,
  boundedRequest,
  type TransportRequest,
} from "../src/index.js";

const encoder = new TextEncoder();

afterEach(() => {
  vi.restoreAllMocks();
});

function okResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init });
}

function request(overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    url: "https://provider.example/v1/write",
    method: "POST",
    body: "payload",
    ...overrides,
  };
}

describe("boundedRequest target policy", () => {
  it("rejects non-HTTPS targets without dispatching a request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      boundedRequest(request({ url: "http://provider.example/v1/write" })),
    ).rejects.toMatchObject({
      name: "TransportError",
      code: "invalid_target",
      requestDispatched: false,
    } satisfies Partial<TransportError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects URL userinfo and fragment instead of forwarding credentials", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    for (const url of [
      "https://user:secret@provider.example/v1/write",
      "https://provider.example/v1/write#fragment",
    ]) {
      await expect(boundedRequest(request({ url }))).rejects.toMatchObject({
        code: "invalid_target",
      } satisfies Partial<TransportError>);
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("boundedRequest redirect policy", () => {
  it.each([301, 302, 303, 307, 308])(
    "refuses HTTP %i without following the hop",
    async status => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, {
          status,
          headers: { location: "https://attacker.example/collect" },
        }),
      );

      await expect(boundedRequest(request())).rejects.toMatchObject({
        name: "TransportError",
        code: "redirect",
        requestDispatched: true,
      } satisfies Partial<TransportError>);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
    },
  );

  it("sends exactly one underlying request per call even on failure", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 503 }));

    await boundedRequest(request());

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("boundedRequest response cap", () => {
  it("refuses a declared body above the cap without buffering it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse("ignored", { headers: { "content-length": "200000" } }),
    );

    await expect(
      boundedRequest(request({ maxResponseBytes: 1024 })),
    ).rejects.toMatchObject({
      code: "response_too_large",
      requestDispatched: true,
    } satisfies Partial<TransportError>);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stops a streamed body that grows past the cap", async () => {
    const chunks = Array.from({ length: 8 }, () => encoder.encode("x".repeat(512)));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream));

    await expect(
      boundedRequest(request({ maxResponseBytes: 1024 })),
    ).rejects.toMatchObject({
      code: "response_too_large",
    } satisfies Partial<TransportError>);
  });

  it("returns a body exactly at the cap", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse("x".repeat(1024)));

    const response = await boundedRequest(request({ maxResponseBytes: 1024 }));

    expect(response.status).toBe(200);
    expect(response.body.byteLength).toBe(1024);
  });
});

describe("boundedRequest deadline", () => {
  it("bounds a request whose headers never arrive", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    const startedAt = Date.now();

    await expect(
      boundedRequest(request({ timeoutMs: 50 })),
    ).rejects.toMatchObject({
      code: "timeout",
      requestDispatched: true,
    } satisfies Partial<TransportError>);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("bounds the body read after headers already arrived", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("{"));
      },
      cancel() {
        return new Promise<void>(() => {});
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream));
    const startedAt = Date.now();

    await expect(
      boundedRequest(request({ timeoutMs: 50 })),
    ).rejects.toMatchObject({
      code: "timeout",
    } satisfies Partial<TransportError>);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("does not wait for a hanging reader.cancel() before returning", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("y".repeat(64)));
      },
      cancel() {
        return new Promise<void>(() => {});
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream));
    const startedAt = Date.now();

    await expect(
      boundedRequest(request({ timeoutMs: 50, maxResponseBytes: 32 })),
    ).rejects.toMatchObject({ code: "response_too_large" } satisfies Partial<TransportError>);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("maps a caller abort to its own code", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const controller = new AbortController();
    const promise = boundedRequest(request({ timeoutMs: 60_000, signal: controller.signal }));
    controller.abort();

    await expect(promise).rejects.toMatchObject({
      code: "aborted",
    } satisfies Partial<TransportError>);
  });
});

describe("boundedRequest success path", () => {
  it("returns bounded status, headers and bytes without interpreting them", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "teapot" }), {
        status: 418,
        headers: { "content-type": "application/json", "x-restli-id": "urn:li:share:1" },
      }),
    );

    const response = await boundedRequest(request());

    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(response.status).toBe(418);
    expect(response.ok).toBe(false);
    expect(response.headers.get("x-restli-id")).toBe("urn:li:share:1");
    expect(response.text()).toBe('{"error":"teapot"}');
    expect(response.toResponse().status).toBe(418);
  });

  it("returns an empty body when the provider sends none", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:2" } }),
    );

    const response = await boundedRequest(request());

    expect(response.status).toBe(201);
    expect(response.body.byteLength).toBe(0);
    expect(response.headers.get("x-restli-id")).toBe("urn:li:share:2");
  });

  it("discards a stalled body on request and still returns headers promptly", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("ignored"));
      },
      cancel,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, {
        status: 201,
        headers: { "x-restli-id": "urn:li:share:3" },
      }),
    );
    const startedAt = Date.now();

    const response = await boundedRequest(
      request({ bodyPolicy: "discard", timeoutMs: 60_000 }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("x-restli-id")).toBe("urn:li:share:3");
    expect(response.body.byteLength).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("boundedRequest abort and teardown accounting", () => {
  it("never dispatches when the caller signal already aborted", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    controller.abort();

    await expect(
      boundedRequest(request({ signal: controller.signal })),
    ).rejects.toMatchObject({
      code: "aborted",
      requestDispatched: false,
    } satisfies Partial<TransportError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports requestDispatched only once fetch actually started", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const controller = new AbortController();
    const promise = boundedRequest(request({ signal: controller.signal }));
    controller.abort();

    await expect(promise).rejects.toMatchObject({
      code: "aborted",
      requestDispatched: true,
    } satisfies Partial<TransportError>);
  });

  it("rejects out-of-range bounds before dispatching anything", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      boundedRequest(request({ maxResponseBytes: 65_537 })),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(boundedRequest(request({ timeoutMs: 0 }))).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      boundedRequest(request({ maxResponseBytes: 1.5 })),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts the underlying request on the redirect failure path", async () => {
    let signal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      signal = init?.signal;
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://a.example/" } }),
      );
    });

    await expect(boundedRequest(request())).rejects.toMatchObject({ code: "redirect" });
    expect(signal?.aborted).toBe(true);
  });

  it("aborts the underlying request on the overflow failure path", async () => {
    let signal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      signal = init?.signal;
      return Promise.resolve(
        new Response("ignored", {
          headers: { "content-length": "999999" },
        }),
      );
    });

    await expect(
      boundedRequest(request({ maxResponseBytes: 1024 })),
    ).rejects.toMatchObject({ code: "response_too_large" });
    expect(signal?.aborted).toBe(true);
  });

  it("keeps error status and headers readable when the body is discarded", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("rate limited"));
      },
      cancel,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, { status: 429, headers: { "retry-after": "120" } }),
    );

    const response = await boundedRequest(
      request({ bodyPolicy: "discard", timeoutMs: 60_000 }),
    );

    // Classification inputs survive the discard: status, headers, empty body.
    expect(response.status).toBe(429);
    expect(response.ok).toBe(false);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(response.body.byteLength).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
