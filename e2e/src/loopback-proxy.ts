/**
 * A loopback HTTP front for one in-process Mock SNS harness.
 *
 * `Harness.fetch` dispatches straight into the Miniflare instance, which an
 * external process such as an installed CLI cannot use. This proxy binds
 * 127.0.0.1 only and forwards each request into the same Worker entrypoint, so
 * the installed packages under test speak real HTTP to the real bundle without
 * exposing anything beyond loopback.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Harness } from "./harness.js";

const HOST = "127.0.0.1";

export interface LoopbackProxy {
  /** Origin the SDK or CLI under test should be pointed at. */
  readonly origin: string;
  /** Number of requests forwarded into the Worker. */
  readonly requests: number;
  dispose(): Promise<void>;
}

export async function startLoopbackProxy(harness: Harness): Promise<LoopbackProxy> {
  let requests = 0;

  const server = createServer((request, response) => {
    requests += 1;
    void handle(harness, request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain" });
      }

      response.end(
        `loopback proxy failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };

    server.once("error", onError);
    server.listen(0, HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    origin: `http://${HOST}:${String(address.port)}`,
    get requests() {
      return requests;
    },
    async dispose() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

async function handle(
  harness: Harness,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }

  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }

    for (const entry of Array.isArray(value) ? value : [value]) {
      headers.append(name, entry);
    }
  }

  const target = new URL(request.url ?? "/", "http://worker.invalid");
  const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
  const forwarded = await harness.fetch(`${target.pathname}${target.search}`, {
    method: request.method ?? "GET",
    headers,
    ...(body === undefined ? {} : { body }),
  });

  const responseHeaders: Record<string, string> = {};

  forwarded.headers.forEach((value, name) => {
    if (name === "content-length" || name === "content-encoding") {
      return;
    }

    responseHeaders[name] = value;
  });

  const buffer = Buffer.from(await forwarded.arrayBuffer());

  response.writeHead(forwarded.status, responseHeaders);
  response.end(buffer);
}
