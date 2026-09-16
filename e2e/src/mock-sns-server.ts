import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { MOCK_CREDENTIALS } from "./redact.js";

/**
 * `at://` record identifier used by the fake Bluesky session. It satisfies the
 * atproto DID syntax because the official SDK validates the response.
 */
export const MOCK_BLUESKY_DID = "did:plc:e2emocksns";

/**
 * CID the fake PDS returns for `com.atproto.repo.createRecord`. The value is a
 * valid CIDv1 string so the SDK's lexicon validation accepts it.
 */
export const MOCK_BLUESKY_CID =
  "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

/** One request the Worker sent to a real SNS origin and the harness forwarded. */
export interface SnsRequestRecord {
  readonly sequence: number;
  readonly method: string;
  /** Origin the Worker addressed, e.g. `https://graph.threads.net`. */
  readonly sourceOrigin: string;
  readonly path: string;
  readonly search: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly receivedAt: string;
  /** Which canned response plan answered this request. */
  plan: string;
}

/** Canned response the loopback Mock SNS server returns for a request. */
export type SnsPlan =
  | {
      readonly kind: "json";
      readonly status: number;
      readonly body: unknown;
      readonly headers?: Readonly<Record<string, string>>;
      readonly label?: string;
    }
  | {
      /**
       * Records the request and then destroys the socket without a response.
       * The Worker observes a transport failure after the remote side has
       * already accepted the request: the ambiguous-outcome case.
       */
      readonly kind: "destroy";
      readonly label?: string;
    }
  | {
      /** Redirects the caller. The harness never follows this hop. */
      readonly kind: "redirect";
      readonly status: number;
      readonly location: string;
      readonly label?: string;
    };

export type SnsResponder = (request: SnsRequestRecord) => SnsPlan;

/**
 * Minimal HTTP stand-in for the Threads and Bluesky APIs. It binds a literal
 * loopback port inside the test process. The Worker can only reach it through
 * the outbound policy, which enforces the exact endpoint allowlist.
 */
export class MockSnsServer {
  private readonly records: SnsRequestRecord[] = [];
  private readonly server: Server;
  private plans = new Map<string, SnsPlan[]>();
  private threadsSequence = 0;
  private recordSequence = 0;
  private sequence = 0;
  private responder: SnsResponder | undefined;
  private originValue = "";

  private constructor() {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on("clientError", (_error, socket) => {
      socket.destroy();
    });
  }

  static async start(): Promise<MockSnsServer> {
    const mock = new MockSnsServer();
    await mock.listen();
    return mock;
  }

  get origin(): string {
    return this.originValue;
  }

  get requests(): readonly SnsRequestRecord[] {
    return this.records;
  }

  requestsFor(path: string): readonly SnsRequestRecord[] {
    return this.records.filter(record => record.path === path);
  }

  countFor(path: string): number {
    return this.requestsFor(path).length;
  }

  /** Queue a canned response for the next matching request. */
  enqueuePlan(method: string, path: string, plan: SnsPlan): void {
    const key = requestKey(method, path);
    const queued = this.plans.get(key) ?? [];
    queued.push(plan);
    this.plans.set(key, queued);
  }

  /** Replace the default routing entirely, for tests that need full control. */
  setResponder(responder: SnsResponder | undefined): void {
    this.responder = responder;
  }

  reset(): void {
    this.records.length = 0;
    this.plans = new Map();
    this.threadsSequence = 0;
    this.recordSequence = 0;
    this.sequence = 0;
    this.responder = undefined;
  }

  async dispose(): Promise<void> {
    this.server.closeAllConnections?.();

    await new Promise<void>(resolve => {
      this.server.close(() => resolve());
    });
  }

  private async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        reject(new Error(`Mock SNS server failed to start: ${error.message}`));
      };

      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", onError);
        const address = this.server.address() as AddressInfo | null;

        if (!address) {
          reject(new Error("Mock SNS server did not report a bound port"));
          return;
        }

        this.originValue = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  private nextPlan(record: SnsRequestRecord): SnsPlan {
    const queued = this.plans.get(requestKey(record.method, record.path));
    const plan = queued?.shift();

    if (plan) {
      return plan;
    }

    return this.responder?.(record) ?? this.defaultPlan(record);
  }

  private defaultPlan(record: SnsRequestRecord): SnsPlan {
    if (record.method === "POST" && record.path === "/me/threads") {
      this.threadsSequence += 1;

      return {
        kind: "json",
        status: 200,
        body: { id: `threads-e2e-${this.threadsSequence}` },
        label: "threads-success",
      };
    }

    if (
      record.method === "POST" &&
      record.path === "/xrpc/com.atproto.server.createSession"
    ) {
      return {
        kind: "json",
        status: 200,
        body: {
          accessJwt: "e2e-access-jwt-not-a-real-secret",
          refreshJwt: "e2e-refresh-jwt-not-a-real-secret",
          handle: MOCK_CREDENTIALS.blueskyIdentifier,
          did: MOCK_BLUESKY_DID,
          active: true,
        },
        label: "bluesky-session",
      };
    }

    if (
      record.method === "POST" &&
      record.path === "/xrpc/com.atproto.repo.createRecord"
    ) {
      this.recordSequence += 1;

      return {
        kind: "json",
        status: 200,
        body: {
          uri: `at://${MOCK_BLUESKY_DID}/app.bsky.feed.post/e2emock${this.recordSequence}`,
          cid: MOCK_BLUESKY_CID,
        },
        label: "bluesky-record",
      };
    }

    return {
      kind: "json",
      status: 404,
      body: { error: "MOCK_SNS_UNROUTED", method: record.method, path: record.path },
      label: "unrouted",
    };
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", this.origin);
    const body = await readBody(request);
    this.sequence += 1;
    const record: SnsRequestRecord = {
      sequence: this.sequence,
      method: request.method ?? "GET",
      sourceOrigin: headerValue(request, "x-mock-sns-origin") ?? "unknown",
      path: url.pathname,
      search: url.search,
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(", ") : (value ?? ""),
        ]),
      ),
      body,
      receivedAt: new Date().toISOString(),
      plan: "pending",
    };

    this.records.push(record);

    const plan = this.nextPlan(record);
    record.plan = plan.label ?? plan.kind;

    if (plan.kind === "destroy") {
      request.socket.destroy();
      return;
    }

    if (plan.kind === "redirect") {
      response.writeHead(plan.status, {
        location: plan.location,
        "content-type": "application/json; charset=utf-8",
        "set-cookie": "mock-sns-session=not-a-real-cookie",
      });
      response.end(JSON.stringify({ redirect: plan.location }));
      return;
    }

    response.writeHead(plan.status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...plan.headers,
    });
    response.end(typeof plan.body === "string" ? plan.body : JSON.stringify(plan.body));
  }
}

function requestKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
