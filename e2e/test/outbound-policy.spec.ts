/**
 * Security tests for the Mock SNS outbound boundary. These run the policy in
 * Node, without a Worker, so the exact allowlist, the loopback forwarding, and
 * the redirect refusal are proven independently of publisher behavior.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MockSnsServer } from "../src/mock-sns-server.js";
import {
  MOCK_SNS_ENDPOINTS,
  createOutboundPolicy,
  type OutboundPolicy,
} from "../src/outbound-policy.js";
import { MOCK_CREDENTIALS } from "../src/redact.js";

let mockSns: MockSnsServer;
let attacker: MockSnsServer;
let policy: OutboundPolicy;

beforeEach(async () => {
  mockSns = await MockSnsServer.start();
  attacker = await MockSnsServer.start();
  policy = createOutboundPolicy({ forwardOrigin: mockSns.origin });
});

afterEach(async () => {
  await mockSns.dispose();
  await attacker.dispose();
});

describe("Mock SNS outbound policy", () => {
  it("accepts only a literal loopback forward origin", () => {
    const rejected = [
      "https://graph.threads.net",
      "http://127.0.0.1",
      "http://localhost:8080",
      "http://user:pass@127.0.0.1:8080",
      "http://127.0.0.1:8080/collect",
      "http://127.0.0.1:8080/?redirect=https://example.test",
      "https://127.0.0.1:8080",
    ];

    for (const origin of rejected) {
      expect(() => createOutboundPolicy({ forwardOrigin: origin })).toThrow(TypeError);
    }

    expect(() =>
      createOutboundPolicy({ forwardOrigin: mockSns.origin }),
    ).not.toThrow();
  });

  it("forwards only the three production SNS endpoints to the literal loopback server", async () => {
    for (const endpoint of MOCK_SNS_ENDPOINTS) {
      const response = await policy.handler(
        new Request(`${endpoint.origin}${endpoint.path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${MOCK_CREDENTIALS.threadsAccessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ probe: endpoint.label }),
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
    }

    expect(mockSns.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(
      mockSns.requests.map(
        record => `${record.method} ${record.sourceOrigin}${record.path}`,
      ),
    ).toEqual([
      "POST https://graph.threads.net/me/threads",
      "POST https://bsky.social/xrpc/com.atproto.server.createSession",
      "POST https://bsky.social/xrpc/com.atproto.repo.createRecord",
    ]);
    expect(
      mockSns.requests.map(record => record.headers.authorization),
    ).toEqual([
      `Bearer ${MOCK_CREDENTIALS.threadsAccessToken}`,
      `Bearer ${MOCK_CREDENTIALS.threadsAccessToken}`,
      `Bearer ${MOCK_CREDENTIALS.threadsAccessToken}`,
    ]);
    expect(policy.denials).toHaveLength(0);
    expect(policy.allowed).toHaveLength(3);
    expect(attacker.requests).toHaveLength(0);
  });

  it("rejects unexpected origins, paths, methods, and queries without forwarding", async () => {
    const attempts = [
      {
        label: "look-alike origin",
        url: "https://graph.threads.net.evil.example/me/threads",
        method: "POST",
        reason: "unexpected-origin",
      },
      {
        label: "extra path segment",
        url: "https://graph.threads.net/me/threads/extra",
        method: "POST",
        reason: "unexpected-path",
      },
      {
        label: "wrong method",
        url: "https://graph.threads.net/me/threads",
        method: "GET",
        reason: "unexpected-method",
      },
      {
        label: "query string",
        url: "https://graph.threads.net/me/threads?access_token=stolen",
        method: "POST",
        reason: "unexpected-query",
      },
      {
        label: "unknown xrpc method",
        url: "https://bsky.social/xrpc/com.atproto.server.getSession",
        method: "POST",
        reason: "unexpected-path",
      },
      {
        label: "plaintext scheme",
        url: "http://bsky.social/xrpc/com.atproto.repo.createRecord",
        method: "POST",
        reason: "unexpected-origin",
      },
      {
        label: "unrelated host",
        url: "https://api.tumblr.com/v2/blog/example.tumblr.com/posts",
        method: "POST",
        reason: "unexpected-origin",
      },
    ] as const;

    for (const attempt of attempts) {
      const init: RequestInit = { method: attempt.method };

      if (attempt.method !== "GET") {
        init.body = "{}";
      }

      await expect(
        policy.handler(new Request(attempt.url, init)),
      ).rejects.toThrow(/mock-sns-blocked/);
    }

    expect(policy.denials.map(denial => denial.reason)).toEqual(
      attempts.map(attempt => attempt.reason),
    );
    expect(policy.allowed).toHaveLength(0);
    expect(mockSns.requests).toHaveLength(0);
    expect(attacker.requests).toHaveLength(0);
  });

  it("refuses a redirect answer instead of following it", async () => {
    mockSns.enqueuePlan("POST", "/me/threads", {
      kind: "redirect",
      status: 302,
      location: `${attacker.origin}/collect`,
      label: "hijacked",
    });

    await expect(
      policy.handler(
        new Request("https://graph.threads.net/me/threads", {
          method: "POST",
          body: "media_type=TEXT",
        }),
      ),
    ).rejects.toThrow(/mock-sns-blocked: redirect-response/);

    expect(mockSns.requests.map(record => record.plan)).toEqual(["hijacked"]);
    expect(policy.denials.map(denial => denial.reason)).toEqual([
      "redirect-response",
    ]);
    // The hop the redirect pointed at was never requested.
    expect(attacker.requests).toHaveLength(0);
  });

  it("returns only the status and content type from the Mock SNS response", async () => {
    mockSns.enqueuePlan("POST", "/me/threads", {
      kind: "json",
      status: 200,
      body: { id: "sanitized" },
      headers: {
        "set-cookie": "session=leak",
        location: `${attacker.origin}/collect`,
      },
      label: "sanitize",
    });

    const response = await policy.handler(
      new Request("https://graph.threads.net/me/threads", {
        method: "POST",
        body: "media_type=TEXT",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    expect([...response.headers.keys()]).toEqual(["content-type"]);
    await expect(response.json()).resolves.toEqual({ id: "sanitized" });
  });

  it("fails closed when the loopback Mock SNS drops the connection", async () => {
    mockSns.setResponder(record =>
      record.path === "/me/threads"
        ? { kind: "destroy", label: "destroyed" }
        : {
            kind: "json",
            status: 404,
            body: { error: "MOCK_SNS_UNROUTED" },
            label: "unrouted",
          },
    );

    await expect(
      policy.handler(
        new Request("https://graph.threads.net/me/threads", {
          method: "POST",
          body: "media_type=TEXT",
        }),
      ),
    ).rejects.toThrow(/mock-sns-blocked: loopback-failure/);

    expect(mockSns.requests.length).toBeGreaterThanOrEqual(1);
    expect(mockSns.requests.map(record => record.plan)).toEqual(
      mockSns.requests.map(() => "destroyed"),
    );
    expect(policy.denials.map(denial => denial.reason)).toEqual([
      "loopback-failure",
    ]);
  });

  it("abandons a loopback request that exceeds its bound", async () => {
    const hanging = createServer(() => {
      // Accept the request and never answer it.
    });
    await new Promise<void>(resolve => {
      hanging.listen(0, "127.0.0.1", resolve);
    });
    const address = hanging.address() as AddressInfo;
    const hangingPolicy = createOutboundPolicy({
      forwardOrigin: `http://127.0.0.1:${address.port}`,
      loopbackTimeoutMs: 200,
    });

    try {
      await expect(
        hangingPolicy.handler(
          new Request("https://graph.threads.net/me/threads", {
            method: "POST",
            body: "media_type=TEXT",
          }),
        ),
      ).rejects.toThrow(/mock-sns-blocked: loopback-failure/);
      expect(hangingPolicy.denials.map(denial => denial.reason)).toEqual([
        "loopback-failure",
      ]);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>(resolve => {
        hanging.close(() => resolve());
      });
    }
  });
});
