/**
 * Real loopback TLS fixture for the L1 harness.
 *
 * It exists only while a case runs, is closed by the runner, and serves
 * synthetic responses for the provider endpoints the installed CLI may call.
 * The preload redirects allowed destinations here while keeping the original
 * SNI, so the CLI still performs real TLS validation against the synthetic CA.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";

export type FixtureMode =
  | "success"
  | "hold"
  | "timeout"
  | "rate-limit"
  | "auth"
  | "disconnect"
  | "missing-id";

export interface FixtureRequest {
  readonly method: string;
  readonly path: string;
  readonly host: string;
  readonly authorized: boolean;
}

export interface FixtureServer {
  readonly host: string;
  readonly port: number;
  readonly requests: FixtureRequest[];
  /** Requests that can create content, across every provider. */
  contentPosts(): number;
  setMode(mode: FixtureMode): void;
  release(): void;
  close(): Promise<void>;
}

const CONTENT_PATHS: ReadonlySet<string> = new Set([
  "/api/v1/statuses",
  "/api/articles",
  "/me/threads",
  "/rest/posts",
  "/xrpc/com.atproto.repo.createRecord",
]);

const MASTODON_ACCOUNT = { id: "109412345678901234", username: "alice", display_name: "Alice" };
const MASTODON_INSTANCE = {
  configuration: { statuses: { max_characters: 500, characters_reserved_per_url: 23 } },
};
const DEVTO_USER = { id: 1234567, username: "alice", name: "Alice" };
const BLUESKY_SESSION = {
  did: "did:plc:l1fixtureaccount000000",
  accessJwt: "l1-fixture-access-jwt",
  refreshJwt: "l1-fixture-refresh-jwt",
  handle: "alice.test",
};
const THREADS_IDENTITY = { id: "1234567890", username: "alice" };
const LINKEDIN_IDENTITY = { sub: "l1fixture", name: "Alice" };

export async function startFixture(input: {
  readonly cert: string;
  readonly key: string;
}): Promise<FixtureServer> {
  const requests: FixtureRequest[] = [];
  let mode: FixtureMode = "success";
  let held: ServerResponse | null = null;

  const server: Server = createTlsServer({ cert: input.cert, key: input.key }, (request, response) => {
    const path = (request.url ?? "/").split("?")[0]!;
    const host = String(request.headers.host ?? "").split(":")[0]!;

    requests.push({
      method: request.method ?? "",
      path,
      host,
      authorized: request.headers["authorization"] !== undefined || request.headers["api-key"] !== undefined,
    });

    if (CONTENT_PATHS.has(path)) {
      applyContentMode(response, mode, () => {
        held = response;
      });
      return;
    }

    route(request, response, path, host);
  });

  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;

  return {
    host: "127.0.0.1",
    port: address.port,
    requests,
    contentPosts: () => requests.filter(entry => CONTENT_PATHS.has(entry.path)).length,
    setMode: next => {
      mode = next;
    },
    release: () => {
      if (held !== null) {
        const response = held;
        held = null;
        send(response, 200, { id: "115000000000000001" });
      }
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function applyContentMode(response: ServerResponse, mode: FixtureMode, hold: () => void): void {
  switch (mode) {
    case "hold":
    case "timeout":
      hold();
      return;
    case "disconnect":
      response.destroy();
      return;
    case "rate-limit":
      send(response, 429, { error: "Too many requests" }, { "retry-after": "120" });
      return;
    case "auth":
      send(response, 401, { error: "The access token is invalid" });
      return;
    case "missing-id":
      send(response, 201, { url: "https://dev.to/alice/example" });
      return;
    default:
      send(response, 201, { id: 987654, url: "https://dev.to/alice/example-987654" });
  }
}

function route(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  host: string,
): void {
  if (path === "/api/v1/accounts/verify_credentials") {
    send(response, 200, MASTODON_ACCOUNT);
    return;
  }

  if (path === "/api/v2/instance") {
    send(response, 200, MASTODON_INSTANCE);
    return;
  }

  if (path === "/api/users/me") {
    send(response, 200, DEVTO_USER);
    return;
  }

  if (path === "/xrpc/com.atproto.server.createSession") {
    send(response, 200, BLUESKY_SESSION);
    return;
  }

  if (path === "/xrpc/com.atproto.repo.getRecord") {
    send(response, 200, { uri: "at://did:plc:l1fixtureaccount000000/app.bsky.feed.post/1", value: {} });
    return;
  }

  if (path === "/me" || path === "/v2/userinfo") {
    send(response, 200, host === "graph.threads.net" ? THREADS_IDENTITY : LINKEDIN_IDENTITY);
    return;
  }

  if (path === "/v1.0/me") {
    send(response, 200, { id: "l1-threads-user" });
    return;
  }

  if (path === "/.well-known/oauth-authorization-server") {
    send(response, 200, {
      issuer: `https://${host}`,
      authorization_endpoint: `https://${host}/oauth/authorize`,
      token_endpoint: `https://${host}/oauth/token`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code"],
      response_types_supported: ["code"],
    });
    return;
  }

  if (path === "/api/v1/apps") {
    send(response, 200, { client_id: "l1-client", client_secret: "l1-secret", redirect_uri: "http://127.0.0.1/x" });
    return;
  }

  if (path === "/oauth/token") {
    send(response, 200, { access_token: "l1-user-token", token_type: "Bearer", scope: "read:accounts write:statuses" });
    return;
  }

  void request;
  response.statusCode = 404;
  response.end("{}");
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}
