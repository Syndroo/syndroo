/// <reference types="node" />

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Minimal loopback HTTP fixture.
 *
 * The provider tests never mock `fetch` for transport behavior: they run a real
 * server on 127.0.0.1 and inject a transport that rewrites the one trusted
 * origin to it. Status codes, headers, redirects, aborts, deadlines, and
 * dropped connections are therefore exercised the way a consumer would.
 */

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

export interface FixtureServer {
  /** Loopback origin such as `http://127.0.0.1:53124`. */
  readonly origin: string;
  readonly requests: RecordedRequest[];
  /** Counts every request the server saw, including ones with no completed body. */
  requestCount(): number;
  close(): Promise<void>;
}

export type FixtureHandler = (
  request: RecordedRequest,
  response: ServerResponse,
  index: number,
) => void | Promise<void>;

export async function startFixtureServer(
  handler: FixtureHandler,
): Promise<FixtureServer> {
  const requests: RecordedRequest[] = [];
  let dispatched = 0;

  const server = createServer((incoming, response) => {
    dispatched += 1;

    void collectBody(incoming)
      .then((body) => {
        const request: RecordedRequest = {
          method: incoming.method ?? "",
          url: incoming.url ?? "",
          headers: incoming.headers,
          body,
        };
        requests.push(request);

        return handler(request, response, requests.length - 1);
      })
      .catch(() => {
        if (!response.headersSent) {
          response.statusCode = 500;
        }

        response.end();
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    requestCount: () => dispatched,
    close: async () => {
      server.closeAllConnections();

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

/**
 * Maps the single trusted origin onto the loopback fixture. Any other target is
 * a test bug: the provider must never call anywhere else.
 */
export function loopbackTransport(
  trustedOrigin: string,
  loopbackOrigin: string,
): typeof fetch {
  return (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (!url.startsWith(`${trustedOrigin}/`)) {
      throw new Error(`Unexpected transport target: ${url}`);
    }

    return fetch(`${loopbackOrigin}${url.slice(trustedOrigin.length)}`, init);
  };
}

export function jsonResponse(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

export function rawResponse(
  response: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

export function redirectResponse(
  response: ServerResponse,
  status: number,
  location: string,
): void {
  response.writeHead(status, { location });
  response.end();
}

/** Never answers: used for deadline and abort tests. */
export function hold(): Promise<void> {
  return new Promise<void>(() => undefined);
}

export function headerOf(
  request: RecordedRequest,
  name: string,
): string | undefined {
  const value = request.headers[name];

  return Array.isArray(value) ? value[0] : value;
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Condition was not met within ${timeoutMs}ms.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function collectBody(incoming: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    incoming.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    incoming.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    incoming.on("error", reject);
  });
}
