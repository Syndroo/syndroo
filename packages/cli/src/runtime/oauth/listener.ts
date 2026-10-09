import { createServer, type Server } from "node:http";

/**
 * The loopback half of the local OAuth transport.
 *
 * It binds exactly one loopback host and port — the ones named by the redirect
 * URI the caller registered — and answers exactly one matching `GET` on the
 * registered path. Every other request is refused with a constant page and does
 * not consume the single redirect.
 *
 * The listener never decides whether a callback is good: it hands the request
 * URL to the caller's verifier and turns that verdict into a status code. No
 * query parameter is ever echoed back, so an authorization code cannot leak
 * through the response or the process's own output.
 */

export type ListenerVerdict = { readonly ok: boolean; readonly message: string };

export type ListenerOutcome = {
  readonly ok: boolean;
  /** Stable, non-secret code for the caller's error mapping. */
  readonly code: string;
};

export type LoopbackListener = {
  readonly uri: string;
  /** Resolves with the first handling verdict, or on timeout. */
  wait(): Promise<ListenerOutcome>;
  close(): Promise<void>;
};

export type LoopbackListenerOptions = {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly uri: string;
  readonly timeoutMs: number;
  /** The command's abort signal; an abort ends the wait like a timeout. */
  readonly signal?: AbortSignal;
  readonly onRedirect: (url: string) => Promise<ListenerVerdict>;
};

const HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'",
  "Referrer-Policy": "no-referrer",
};

/** A constant page: no diagnostic detail, no request data. */
function page(status: number, message: string, allow?: string): { status: number; body: string; headers: Record<string, string> } {
  return {
    status,
    body: `${message}\n`,
    headers: allow === undefined ? HEADERS : { ...HEADERS, Allow: allow },
  };
}

/**
 * Bind one loopback listener and wait for one verified redirect.
 *
 * Rejects (a thrown error, not a resolved outcome) when the host or port cannot
 * be bound at all — the callback could never arrive there, so continuing would
 * be a false promise rather than a slow one.
 */
export async function startLoopbackListener(
  options: LoopbackListenerOptions,
): Promise<LoopbackListener> {
  let settle: (outcome: ListenerOutcome) => void = () => undefined;
  let settled = false;
  let inFlight: Promise<void> | undefined;

  const outcome = new Promise<ListenerOutcome>((resolve) => {
    settle = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    };
  });

  const server: Server = createServer((request, response) => {
    if (settled) {
      const refusal = page(409, "Callback already received.");

      response.writeHead(refusal.status, refusal.headers);
      response.end(refusal.body);

      return;
    }

    if (request.method !== "GET") {
      const refusal = page(405, "Callback rejected.", "GET");

      response.writeHead(refusal.status, refusal.headers);
      response.end(refusal.body);

      return;
    }

    let pathname: string;

    try {
      pathname = new URL(request.url ?? "/", options.uri).pathname;
    } catch {
      const refusal = page(400, "Callback rejected.");

      response.writeHead(refusal.status, refusal.headers);
      response.end(refusal.body);

      return;
    }

    // A different path is not this redirect: refuse it and keep waiting.
    if (pathname !== options.path) {
      const refusal = page(404, "Callback rejected.");

      response.writeHead(refusal.status, refusal.headers);
      response.end(refusal.body);

      return;
    }

    const target = new URL(request.url ?? "/", options.uri).toString();

    inFlight = options
      .onRedirect(target)
      .then(
        (verdict) => {
          const accepted = page(verdict.ok ? 200 : 400, verdict.ok ? "Syndroo authorization completed. You can return to the client." : "Callback rejected.");

          response.writeHead(accepted.status, accepted.headers);
          response.end(accepted.body);

          settle({ ok: verdict.ok, code: verdict.ok ? "OAUTH_CALLBACK_ACCEPTED" : "OAUTH_CALLBACK_REJECTED" });
        },
        () => {
          const failure = page(400, "Callback rejected.");

          response.writeHead(failure.status, failure.headers);
          response.end(failure.body);

          settle({ ok: false, code: "OAUTH_CALLBACK_REJECTED" });
        },
      )
      .catch(() => undefined);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);

    server.once("error", onError);
    // The host is a loopback literal from the parsed redirect URI; the port is
    // fixed by that URI. No backlog is exposed on any other interface.
    server.listen({ host: options.host, port: options.port, exclusive: true }, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const timer = setTimeout(() => {
    settle({ ok: false, code: "OAUTH_CALLBACK_TIMEOUT" });
  }, options.timeoutMs);
  // A pending authorization must not hold the event loop open by itself.
  timer.unref?.();

  const signal = options.signal;
  const onAbort = (): void => settle({ ok: false, code: "OAUTH_CALLBACK_CANCELLED" });

  if (signal !== undefined) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const close = async (): Promise<void> => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);

    await inFlight?.catch(() => undefined);

    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  };

  return { uri: options.uri, wait: () => outcome, close };
}
