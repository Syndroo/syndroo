import { redact } from "./redact.js";

/** Upper bound on a single loopback Mock SNS round trip. */
const LOOPBACK_TIMEOUT_MS = 10_000;

/**
 * The complete set of outbound requests the production publishers are allowed
 * to make in these tests. Anything else is a harness bug or an attempted
 * escape, and is blocked before it can leave the process.
 */
export interface AllowedEndpoint {
  readonly label: string;
  readonly origin: string;
  readonly method: string;
  readonly path: string;
}

export const MOCK_SNS_ENDPOINTS: readonly AllowedEndpoint[] = [
  {
    label: "threads-create",
    origin: "https://graph.threads.net",
    method: "POST",
    path: "/me/threads",
  },
  {
    label: "bluesky-session",
    origin: "https://bsky.social",
    method: "POST",
    path: "/xrpc/com.atproto.server.createSession",
  },
  {
    label: "bluesky-record",
    origin: "https://bsky.social",
    method: "POST",
    path: "/xrpc/com.atproto.repo.createRecord",
  },
];

export type OutboundDecision = "allow" | "deny";

export type OutboundDenialReason =
  | "unexpected-origin"
  | "unexpected-path"
  | "unexpected-method"
  | "unexpected-query"
  | "redirect-response"
  | "loopback-failure";

/** One decision the policy made, in order. */
export interface OutboundAttempt {
  readonly sequence: number;
  readonly at: string;
  readonly method: string;
  readonly origin: string;
  readonly path: string;
  readonly decision: OutboundDecision;
  readonly reason: string;
}

export interface OutboundPolicyOptions {
  /** Literal loopback origin of the Mock SNS server, e.g. `http://127.0.0.1:1234`. */
  readonly forwardOrigin: string;
  readonly allowlist?: readonly AllowedEndpoint[];
  /** Upper bound for one loopback round trip. Defaults to 10 seconds. */
  readonly loopbackTimeoutMs?: number;
}

export interface OutboundPolicy {
  readonly attempts: readonly OutboundAttempt[];
  readonly allowed: readonly OutboundAttempt[];
  readonly denials: readonly OutboundAttempt[];
  reset(): void;
  handler(request: Request): Promise<Response>;
}

/**
 * Fail-closed replacement for the Worker's internet access:
 *
 * 1. Only the exact production SNS endpoints may be requested.
 * 2. Allowed requests are forwarded to a literal loopback Mock SNS server.
 * 3. The loopback hop never follows redirects, and a redirect answer is turned
 *    into a hard failure so a hijacked Mock SNS cannot bounce the Worker (or
 *    the harness) to a real host.
 * 4. Only the response status and content type travel back into the Worker.
 */
export function createOutboundPolicy(
  options: OutboundPolicyOptions,
): OutboundPolicy {
  const allowlist = options.allowlist ?? MOCK_SNS_ENDPOINTS;
  const forwarded = requireLoopbackOrigin(options.forwardOrigin);
  const loopbackTimeoutMs = options.loopbackTimeoutMs ?? LOOPBACK_TIMEOUT_MS;
  const attempts: OutboundAttempt[] = [];
  let sequence = 0;

  function record(
    request: Request,
    url: URL,
    decision: OutboundDecision,
    reason: string,
  ): void {
    sequence += 1;
    attempts.push({
      sequence,
      at: new Date().toISOString(),
      method: request.method,
      origin: url.origin,
      path: url.pathname,
      decision,
      reason,
    });
  }

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const endpoint = allowlist.find(
      candidate =>
        candidate.origin === url.origin && candidate.path === url.pathname,
    );

    if (!endpoint) {
      const reason = allowlist.some(candidate => candidate.origin === url.origin)
        ? "unexpected-path"
        : "unexpected-origin";
      record(request, url, "deny", reason);
      throw new Error(
        `mock-sns-blocked: ${reason} ${url.origin}${url.pathname}`,
      );
    }

    if (endpoint.method !== request.method) {
      record(request, url, "deny", "unexpected-method");
      throw new Error(
        `mock-sns-blocked: unexpected-method ${request.method} ${url.pathname}`,
      );
    }

    if (url.search !== "") {
      record(request, url, "deny", "unexpected-query");
      throw new Error(
        `mock-sns-blocked: unexpected-query ${url.origin}${url.pathname}`,
      );
    }

    const forwardUrl = new URL(url.pathname, forwarded);
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.set("x-mock-sns-origin", url.origin);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    let response: Response;

    try {
      const init: RequestInit = {
        method: request.method,
        headers,
        redirect: "manual",
      };

      if (body !== undefined) {
        init.body = body;
      }

      response = await fetch(forwardUrl, {
        ...init,
        signal: AbortSignal.timeout(loopbackTimeoutMs),
      });
    } catch (error) {
      record(request, url, "deny", "loopback-failure");
      throw new Error(
        `mock-sns-blocked: loopback-failure ${url.origin}${url.pathname} (${redact(
          error instanceof Error ? error.message : String(error),
        )})`,
      );
    }

    if (isRedirect(response)) {
      record(request, url, "deny", "redirect-response");
      // Release the redirect before failing: the body must not be read, and
      // the connection should not stay open.
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `mock-sns-blocked: redirect-response ${url.origin}${url.pathname}`,
      );
    }

    record(request, url, "allow", endpoint.label);
    return sanitize(response);
  }

  return {
    attempts,
    get allowed(): readonly OutboundAttempt[] {
      return attempts.filter(attempt => attempt.decision === "allow");
    },
    get denials(): readonly OutboundAttempt[] {
      return attempts.filter(attempt => attempt.decision === "deny");
    },
    reset(): void {
      attempts.length = 0;
      sequence = 0;
    },
    handler,
  };
}

/**
 * The Mock SNS forward target must be a literal loopback HTTP origin. It may
 * not carry credentials, a path, a query, or a fragment, so no configuration
 * can point the harness at a real host.
 */
function requireLoopbackOrigin(value: string): string {
  const url = new URL(value);
  const isLoopback =
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.port !== "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";

  if (!isLoopback || url.username || url.password) {
    throw new TypeError(
      `Mock SNS forward origin must be a literal http://127.0.0.1:<port> origin, received ${JSON.stringify(
        value,
      )}`,
    );
  }

  return url.origin;
}

/**
 * `redirect: "manual"` returns the redirect itself instead of following it.
 * Treat both a 3xx status and an opaque redirect as a policy violation.
 */
function isRedirect(response: Response): boolean {
  return (
    response.type === "opaqueredirect" ||
    response.status === 0 ||
    (response.status >= 300 && response.status < 400)
  );
}

/** Rebuild the response so no header from the mock (cookies, location) escapes. */
function sanitize(response: Response): Response {
  const contentType =
    response.headers.get("content-type") ?? "application/json; charset=utf-8";

  if (
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304
  ) {
    return new Response(null, { status: response.status });
  }

  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": contentType },
  });
}
