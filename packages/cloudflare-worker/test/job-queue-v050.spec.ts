/**
 * Narrow Cloudflare Queues producer adapter (Task 5b2).
 *
 * The adapter is tested against a structural recorder, not a fake runtime: it
 * must validate and encode the frozen envelope before touching the binding,
 * perform exactly one `send` with the JSON content type and no broker delay,
 * and translate every binding failure into one fixed, cause-free
 * `JobQueueError` with `unknown` certainty. Queue consumption, acknowledgement,
 * redelivery and DLQ movement remain runtime integration scope.
 */

import { describe, expect, it } from "vitest";

import {
  JobQueueError,
  decodeQueueEnvelopeV1,
  encodeQueueEnvelopeV1,
  type QueueEnvelopeV1,
} from "@syndroo/application";

import {
  createCloudflareJobQueue,
  type QueueProducerBinding,
} from "../src/infrastructure/queue/job-queue.js";

interface SendCall {
  readonly body: unknown;
  readonly options: { readonly contentType?: "json" } | undefined;
}

interface Recorder {
  readonly binding: QueueProducerBinding;
  readonly calls: SendCall[];
}

function recorder(failure?: unknown): Recorder {
  const calls: SendCall[] = [];
  return {
    calls,
    binding: {
      async send(body: unknown, options?: { readonly contentType?: "json" }): Promise<void> {
        calls.push({ body, options });
        if (failure !== undefined) {
          throw failure;
        }
      },
    },
  };
}

function envelope(overrides: Partial<QueueEnvelopeV1> = {}): QueueEnvelopeV1 {
  return {
    version: 1,
    jobId: "job_0001",
    kind: "delivery.execute",
    entityId: "pub_0001",
    enqueuedAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("createCloudflareJobQueue", () => {
  it("sends exactly one validated JSON envelope with no broker delay", async () => {
    const record = recorder();
    const queue = createCloudflareJobQueue({ binding: record.binding });
    const message = envelope({ traceId: "trace_0001" });

    await queue.send(message);

    expect(record.calls).toHaveLength(1);
    const call = record.calls[0];
    expect(call?.options).toEqual({ contentType: "json" });
    expect(Object.keys(call?.options ?? {})).toEqual(["contentType"]);
    // The delivered bytes are exactly the frozen encoding, not a reshaped DTO.
    expect(JSON.stringify(call?.body)).toBe(encodeQueueEnvelopeV1(message));
    expect(decodeQueueEnvelopeV1(call?.body).kind).toBe("ok");
  });

  it("delivers identical bytes when the same persisted job is sent again", async () => {
    const record = recorder();
    const queue = createCloudflareJobQueue({ binding: record.binding });
    const message = envelope();

    await queue.send(message);
    await queue.send(message);

    expect(record.calls).toHaveLength(2);
    const first = JSON.stringify(record.calls[0]?.body);
    const second = JSON.stringify(record.calls[1]?.body);
    expect(first).toBe(second);
    expect(first).toBe(encodeQueueEnvelopeV1(message));
  });

  it("accepts a bounded trace id and keeps the envelope inside the 2KiB bound", async () => {
    const record = recorder();
    const queue = createCloudflareJobQueue({ binding: record.binding });
    const message = envelope({ traceId: "t".repeat(64) });

    await queue.send(message);

    expect(record.calls).toHaveLength(1);
    expect(encodeQueueEnvelopeV1(message).length).toBeLessThanOrEqual(2048);
  });

  it("rejects an unsendable envelope before the binding is touched", async () => {
    const sentinel = "SENTINEL-envelope-2f61";
    const unsendable: readonly unknown[] = [
      "not-an-envelope",
      null,
      {},
      { ...envelope(), version: 2 },
      { ...envelope(), kind: "delivery.other" },
      { entityId: "pub_0001", jobId: "job_0001" },
      { ...envelope(), extra: sentinel },
      // A malformed id that still carries the sentinel text.
      { ...envelope(), jobId: `job_${sentinel}/x` },
      { ...envelope(), big: "x".repeat(4000) },
    ];

    for (const message of unsendable) {
      const record = recorder();
      const queue = createCloudflareJobQueue({ binding: record.binding });
      let caught: unknown;
      await queue.send(message as QueueEnvelopeV1).catch((error: unknown) => {
        caught = error;
      });
      expect(caught).toBeInstanceOf(JobQueueError);
      const error = caught as JobQueueError;
      expect(error.certainty).toBe("failed");
      expect(error.code).toBe("INVALID_ENVELOPE");
      expect(error.message).toBe("queue envelope is not sendable");
      expect(error.cause).toBeUndefined();
      expect(record.calls).toHaveLength(0);
      expect(JSON.stringify(error.message)).not.toContain(sentinel);
    }
  });

  it("fails closed on hostile inputs that throw after serialisation", async () => {
    const sentinel = "SENTINEL-hostile-input-4d18";

    // A proxy whose descriptor trap only fails on the second pass: JSON passes,
    // then `Object.keys`/property reads throw.
    const descriptorCalls: number[] = [];
    const base = {
      version: 1,
      jobId: "job_0001",
      kind: "delivery.execute",
      entityId: "pub_0001",
      enqueuedAt: "2026-09-23T00:00:00.000Z",
    };
    const proxy = new Proxy(base, {
      getOwnPropertyDescriptor(target, key) {
        descriptorCalls.push(1);
        if (descriptorCalls.length > 5) {
          throw new Error(`proxy trap ${sentinel}`);
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    // A non-enumerable throwing getter on a required field: JSON skips it, the
    // later property read throws.
    const getter = { ...base };
    Object.defineProperty(getter, "version", {
      configurable: true,
      enumerable: false,
      get(): never {
        throw new Error(`getter ${sentinel}`);
      },
    });

    for (const hostile of [proxy, getter] as unknown as QueueEnvelopeV1[]) {
      const record = recorder();
      const queue = createCloudflareJobQueue({ binding: record.binding });
      let caught: unknown;
      await queue.send(hostile).catch((error: unknown) => {
        caught = error;
      });
      expect(caught).toBeInstanceOf(JobQueueError);
      const error = caught as JobQueueError;
      expect(error.certainty).toBe("failed");
      expect(error.code).toBe("INVALID_ENVELOPE");
      expect(error.message).toBe("queue envelope is not sendable");
      expect(error.cause).toBeUndefined();
      expect(String(error.stack)).not.toContain(sentinel);
      expect(record.calls).toHaveLength(0);
    }
  });

  it("translates every binding failure into one fixed, cause-free unknown error", async () => {
    const sentinel = "SENTINEL-binding-9d37";
    const failures: readonly unknown[] = [
      new Error(`raw broker failure ${sentinel}`),
      `thrown string ${sentinel}`,
      new JobQueueError(`forged ${sentinel}`, "failed", sentinel),
    ];

    for (const failure of failures) {
      const record = recorder(failure);
      const queue = createCloudflareJobQueue({ binding: record.binding });
      let caught: unknown;
      await queue.send(envelope()).catch((error: unknown) => {
        caught = error;
      });
      expect(caught).toBeInstanceOf(JobQueueError);
      const error = caught as JobQueueError;
      // Conservative: a throw does not prove the broker refused the message, so
      // the port reports `unknown` and a fixed code.
      expect(error.certainty).toBe("unknown");
      expect(error.code).toBe("QUEUE_SEND_UNKNOWN");
      expect(error.message).toBe("queue send did not confirm acceptance");
      expect(error.cause).toBeUndefined();
      expect(record.calls).toHaveLength(1);
      expect(JSON.stringify({ message: error.message, code: error.code })).not.toContain(sentinel);
      expect(String(error.stack)).not.toContain(sentinel);
    }
  });
});
