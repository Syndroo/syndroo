/**
 * A scripted `fetch` double for the SDK tests.
 *
 * Nothing here opens a socket. Each test declares the exact responses it wants;
 * a request beyond the script is a failure, so an unexpected retry or an
 * unexpected extra call cannot pass silently. Every request is recorded with the
 * headers and body the transport actually sent.
 */

import type { FetchLike } from "../../src/index.js";

export type Responder =
  | { readonly kind: "json"; readonly status: number; readonly body: unknown }
  | {
      readonly kind: "bytes";
      readonly status: number;
      readonly bytes: Uint8Array;
      readonly headers?: Record<string, string>;
    }
  | {
      readonly kind: "stream";
      readonly status: number;
      readonly chunks: readonly Uint8Array[];
      readonly headers?: Record<string, string>;
    }
  | {
      /**
       * A body that never ends: `pull` never enqueues and never closes. Aborts
       * and cancellations are recorded on the `FakeHttp` instance.
       */
      readonly kind: "endless";
      readonly status: number;
      readonly headers?: Record<string, string>;
    }
  | {
      /** A response that arrives late, and never arrives if aborted first. */
      readonly kind: "slow";
      readonly status: number;
      readonly body: unknown;
      readonly delayMs: number;
    }
  | { readonly kind: "empty"; readonly status: number }
  | { readonly kind: "hang" }
  | { readonly kind: "throw"; readonly error: unknown };

export type RecordedRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly redirect: string | undefined;
  readonly signal: AbortSignal | undefined;
};

function normalizeHeaders(init: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  const source = init.headers;
  if (source === undefined) {
    return headers;
  }
  if (source instanceof Headers) {
    source.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return headers;
  }
  if (Array.isArray(source)) {
    for (const [key, value] of source) {
      headers[key.toLowerCase()] = value;
    }
    return headers;
  }
  for (const [key, value] of Object.entries(source)) {
    headers[key.toLowerCase()] = value;
  }
  return headers;
}

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  const queue = [...chunks];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(next);
    },
  });
}

/**
 * Node's DOM typings narrow `BufferSource` to `ArrayBufferView<ArrayBuffer>`,
 * which rejects the generic `Uint8Array<ArrayBufferLike>` the tests build. The
 * runtime accepts any view, so copy into a plain `ArrayBuffer`.
 */
function bodyInitOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function responseInit(status: number, headers?: Record<string, string>): ResponseInit {
  const init: ResponseInit = { status };
  if (headers !== undefined) {
    init.headers = headers;
  }
  return init;
}

function materialize(
  responder: Responder,
  signal: AbortSignal | undefined,
  onCancel: () => void,
): Promise<Response> {
  switch (responder.kind) {
    case "json":
      return Promise.resolve(
        new Response(JSON.stringify(responder.body), {
          status: responder.status,
          headers: { "content-type": "application/json" },
        }),
      );
    case "bytes":
      return Promise.resolve(
        new Response(bodyInitOf(responder.bytes), responseInit(responder.status, responder.headers)),
      );
    case "stream":
      return Promise.resolve(
        new Response(streamOf(responder.chunks), responseInit(responder.status, responder.headers)),
      );
    case "endless":
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              // Never enqueue and never close: only cancellation ends this body.
            },
            cancel() {
              onCancel();
            },
          }),
          responseInit(responder.status, responder.headers),
        ),
      );
    case "slow": {
      return new Promise<Response>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = (): void => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve(
            new Response(JSON.stringify(responder.body), {
              status: responder.status,
              headers: { "content-type": "application/json" },
            }),
          );
        }, responder.delayMs);
        if (signal?.aborted === true) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    case "empty":
      return Promise.resolve(new Response(null, { status: responder.status }));
    case "throw":
      return Promise.reject(responder.error);
    case "hang":
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        if (signal?.aborted === true) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
  }
}

export class FakeHttp {
  readonly requests: RecordedRequest[] = [];
  /** Bodies the SDK released instead of reading to the end. */
  readonly cancelled: string[] = [];
  private readonly script: Responder[];

  constructor(script: readonly Responder[]) {
    this.script = [...script];
  }

  /** The injected transport. Consumes one responder per call, in order. */
  get fetch(): FetchLike {
    return async (input: string, init: RequestInit): Promise<Response> => {
      const headers = normalizeHeaders(init);
      this.requests.push({
        url: input,
        method: init.method ?? "GET",
        headers,
        body: typeof init.body === "string" ? init.body : "",
        redirect: init.redirect,
        signal: init.signal ?? undefined,
      });
      const responder = this.script.shift();
      if (responder === undefined) {
        throw new Error(`unexpected extra request: ${init.method ?? "GET"} ${input}`);
      }
      return materialize(responder, init.signal ?? undefined, () => {
        this.cancelled.push(input);
      });
    };
  }

  /** Number of requests seen so far. */
  get callCount(): number {
    return this.requests.length;
  }
}

/** Encode text the way a server would, for malformed-body cases. */
export function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A response body larger than the SDK's 1 MiB response cap. */
export function oversizedChunks(): Uint8Array[] {
  const chunk = new Uint8Array(65536).fill(0x61);
  return Array.from({ length: 17 }, () => chunk);
}
