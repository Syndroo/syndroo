import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Loopback Syndroo stand-in.
 *
 * The CLI tests never mock `fetch`: they run a real HTTP server on 127.0.0.1 so
 * status codes, headers, aborted connections, and timeouts behave the way a
 * deployed instance would make them behave. Every request is recorded, so a
 * test can assert how many writes actually happened.
 */

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

export interface FixtureServer {
  /** Origin such as `http://127.0.0.1:53124`. */
  readonly url: string;
  readonly requests: RecordedRequest[];
  /** Every request the server saw, including ones with no completed body. */
  readonly requestCount: () => number;
  /** Requests that could create a post. This is the number that must stay 0. */
  readonly createCount: () => number;
  readonly close: () => Promise<void>;
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
  let creates = 0;

  const server = createServer((incoming, response) => {
    dispatched += 1;

    void collectBody(incoming)
      .then(body => {
        const request: RecordedRequest = {
          method: incoming.method ?? "",
          url: incoming.url ?? "",
          headers: incoming.headers,
          body,
        };

        if (request.method === "POST" && request.url === "/v1/posts") {
          creates += 1;
        }

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
    url: `http://127.0.0.1:${address.port}`,
    requests,
    requestCount: () => dispatched,
    createCount: () => creates,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
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

function collectBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", chunk => {
      chunks.push(Buffer.from(chunk as Uint8Array));
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("content-length", String(Buffer.byteLength(text)));
  response.end(text);
}
