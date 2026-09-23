/**
 * Fail-closed outbound fixture for the transport's native-workerd project.
 *
 * Every outbound request from workerd passes through this handler. Listed
 * destinations get deterministic responses; anything else throws, so a test can
 * never reach the real internet and an accidental egress attempt fails loudly.
 *
 * Counters live in this closure (the pool worker's process) and are readable
 * from inside workerd through the `stats.invalid/_stats` control route, which is
 * why the tests can assert "second hop received zero requests" without any
 * production-code fixture special case.
 */
export interface OutboundStats {
  total: number;
  secondHop: number;
  secondHopWithAuthOrBody: number;
  unexpected: number;
  providerHits: Record<string, number>;
}

const CID = "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

export function createOutboundFixture(): {
  handler: (request: Request) => Promise<Response>;
  reset: () => void;
} {
  let stats = emptyStats();

  function reset(): void {
    stats = emptyStats();
  }

  function hit(host: string): void {
    stats.providerHits[host] = (stats.providerHits[host] ?? 0) + 1;
  }

  function fail(message: string): never {
    throw new Error(message);
  }

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    stats.total += 1;

    if (url.origin === "https://stats.invalid") {
      if (url.pathname === "/_reset") {
        reset();
        return Response.json({ ok: true });
      }

      if (url.pathname === "/_stats") {
        return Response.json(stats);
      }

      return fail(`Unexpected control path: ${url.pathname}`);
    }

    if (url.origin === "https://second-hop.invalid") {
      stats.secondHop += 1;
      const authorization = request.headers.get("authorization");
      const body = await request.clone().text().catch(() => "");

      if (authorization !== null || body.length > 0) {
        stats.secondHopWithAuthOrBody += 1;
      }

      return Response.json({ reachedSecondHop: true });
    }

    if (url.origin === "https://provider.example") {
      hit("provider.example");

      if (url.pathname === "/ok") {
        return Response.json({ ok: true });
      }

      const redirect = /^\/redirect\/(\d{3})$/.exec(url.pathname);

      if (redirect?.[1] !== undefined) {
        return new Response(null, {
          status: Number(redirect[1]),
          headers: { location: "https://second-hop.invalid/steal?token=secret" },
        });
      }

      if (url.pathname === "/overflow") {
        return new Response("x".repeat(70_000), { status: 200 });
      }

      if (url.pathname === "/slow") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
              // Never closes: the transport deadline must end the call.
            },
            cancel() {
              return new Promise<void>(() => {});
            },
          }),
          { status: 200 },
        );
      }

      return fail(`Unexpected fixture path: ${url.pathname}`);
    }

    // Provider endpoints used by the five migrated adapters.
    if (url.origin === "https://graph.threads.net") {
      hit("graph.threads.net");
      return Response.json({ id: "threads-native-1" });
    }

    if (url.origin === "https://api.linkedin.com" && url.pathname === "/rest/posts") {
      hit("api.linkedin.com");
      return new Response(null, {
        status: 201,
        headers: { "x-restli-id": "urn:li:share:123456789123456789" },
      });
    }

    if (url.origin === "https://api.tumblr.com") {
      hit("api.tumblr.com");
      return Response.json(
        { meta: { status: 201 }, response: { id: "123456789123456789" } },
        { status: 201 },
      );
    }

    if (url.origin === "https://api.x.com" && url.pathname === "/2/tweets") {
      hit("api.x.com");
      return Response.json({ data: { id: "123456789" } }, { status: 201 });
    }

    if (url.origin === "https://bsky.social") {
      hit("bsky.social");

      if (url.pathname === "/xrpc/com.atproto.server.createSession") {
        return Response.json({
          accessJwt: "native-access-token",
          refreshJwt: "native-refresh-token",
          handle: "alice.test",
          did: "did:plc:alice",
        });
      }

      if (url.pathname === "/xrpc/com.atproto.repo.createRecord") {
        return Response.json({
          cid: CID,
          uri: "at://did:plc:alice/app.bsky.feed.post/3kfixture",
        });
      }

      return fail(`Unexpected Bluesky path: ${url.pathname}`);
    }

    stats.unexpected += 1;
    return fail(`Unlisted outbound destination: ${request.method} ${url.origin}${url.pathname}`);
  }

  return { handler, reset };
}

function emptyStats(): OutboundStats {
  return {
    total: 0,
    secondHop: 0,
    secondHopWithAuthOrBody: 0,
    unexpected: 0,
    providerHits: {},
  };
}
