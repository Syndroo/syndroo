import { describe, expect, it } from "vitest";

import { validateProviderWriteOutcome } from "@syndroo/provider-sdk/testing";
import type { JsonObject, ProviderHttpResult, ProviderWriteOutcome } from "@syndroo/provider-sdk";

import plugin, { CREATE_RECORD_URL } from "../src/index.js";
import {
  BLUESKY_ACCOUNT,
  FIXED_NOW,
  FIXED_SEED,
  TOKEN_CANARY,
  containsCanary,
  contextFor,
  credentialBundle,
  freezeInput,
  rawResponse,
  response,
  scriptedTransport,
  throwingTransport,
} from "./fixtures.js";

const frozen = plugin.freeze(freezeInput());

type Published = {
  outcome: ProviderWriteOutcome;
  calls: ReturnType<typeof scriptedTransport>["calls"];
};

/** Publish once through a transport scripted with a single result. */
async function publishWith(
  result: ProviderHttpResult,
  credentials: JsonObject = credentialBundle(),
  now: string = FIXED_NOW,
): Promise<Published> {
  const scripted = scriptedTransport([result]);
  const outcome = await plugin.publish({
    frozen,
    account: BLUESKY_ACCOUNT,
    credentials,
    submissionId: FIXED_SEED,
    context: contextFor(scripted.transport, now),
  });
  validateProviderWriteOutcome(outcome);
  return { outcome, calls: scripted.calls };
}

const CREATED_URI = `at://${BLUESKY_ACCOUNT.accountId}/app.bsky.feed.post/3kfixture`;
const CREATED_CID = "bafyreifixturecid";

describe("bluesky publish classification", () => {
  it("reports a 2xx createRecord as succeeded with the record URI and a web URL", async () => {
    const { outcome, calls } = await publishWith(
      response(200, { uri: CREATED_URI, cid: CREATED_CID, commit: { cid: CREATED_CID } }),
    );

    expect(outcome).toEqual({
      status: "succeeded",
      remoteId: CREATED_URI,
      url: `https://bsky.app/profile/${BLUESKY_ACCOUNT.accountId}/post/3kfixture`,
    });

    // One request, and the exact frozen bytes are what was sent.
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(CREATE_RECORD_URL);
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN_CANARY}`);
    expect(call.body).toBe(JSON.stringify(frozen.payload));
  });

  it("still succeeds on a 2xx without a parseable body, carrying no remoteId", async () => {
    const { outcome } = await publishWith(rawResponse(200, "not json"));
    expect(outcome).toEqual({ status: "succeeded" });
  });

  it("classifies a definite 4xx rejection as failed and never retried", async () => {
    const cases: readonly { result: ProviderHttpResult; reason: string }[] = [
      { result: response(400, { error: "InvalidRequest" }), reason: "validation" },
      { result: response(401, { error: "ExpiredToken" }), reason: "auth" },
      { result: response(403, { error: "Forbidden" }), reason: "permission" },
      { result: response(422, { error: "InvalidSwap" }), reason: "validation" },
    ];

    for (const { result, reason } of cases) {
      const { outcome, calls } = await publishWith(result);
      expect(outcome).toEqual({
        status: "failed",
        disposition: "not_applied",
        retryable: false,
        reason,
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("classifies 429 as retryable and carries retry-after when present", async () => {
    const withSeconds = await publishWith(response(429, { error: "RateLimitExceeded" }, { "Retry-After": "30" }));
    expect(withSeconds.outcome).toEqual({
      status: "failed",
      disposition: "not_applied",
      retryable: true,
      reason: "rate_limited",
      retryAfter: new Date(Date.parse(FIXED_NOW) + 30_000).toISOString(),
    });
    expect(withSeconds.calls).toHaveLength(1);

    const httpDate = "Wed, 21 Oct 2026 07:28:00 GMT";
    const withDate = await publishWith(response(429, { error: "RateLimitExceeded" }, { "retry-after": httpDate }));
    expect(withDate.outcome).toEqual({
      status: "failed",
      disposition: "not_applied",
      retryable: true,
      reason: "rate_limited",
      retryAfter: new Date(Date.parse(httpDate)).toISOString(),
    });

    const without = await publishWith(response(429, { error: "RateLimitExceeded" }));
    expect(without.outcome).toEqual({
      status: "failed",
      disposition: "not_applied",
      retryable: true,
      reason: "rate_limited",
    });
    expect(Object.hasOwn(without.outcome, "retryAfter")).toBe(false);
  });

  it("classifies a possibly_sent transport error as unknown, never not_applied", async () => {
    const { outcome, calls } = await publishWith({
      type: "transport_error",
      stage: "possibly_sent",
      code: "socket_hangup",
    });
    expect(outcome).toEqual({ status: "unknown", disposition: "unknown", reason: "network" });
    expect(calls).toHaveLength(1);
  });

  it("classifies a before_request transport error as a retryable non-applied failure", async () => {
    const { outcome } = await publishWith({
      type: "transport_error",
      stage: "before_request",
      code: "dns_failure",
    });
    expect(outcome).toEqual({
      status: "failed",
      disposition: "not_applied",
      retryable: true,
      reason: "network",
    });
  });

  it("classifies 5xx and unexpected statuses as unknown rather than not_applied", async () => {
    const server = await publishWith(response(503, { error: "UpstreamFailure" }));
    expect(server.outcome).toEqual({
      status: "unknown",
      disposition: "unknown",
      reason: "provider_unavailable",
    });

    const redirect = await publishWith(response(302, { error: "Moved" }, { location: "https://elsewhere" }));
    expect(redirect.outcome).toEqual({ status: "unknown", disposition: "unknown", reason: "unknown" });
  });

  it("treats a transport that throws as an ambiguous unknown outcome", async () => {
    const scripted = throwingTransport();
    const outcome = await plugin.publish({
      frozen,
      account: BLUESKY_ACCOUNT,
      credentials: credentialBundle(),
      submissionId: FIXED_SEED,
      context: contextFor(scripted.transport),
    });
    expect(outcome).toEqual({ status: "unknown", disposition: "unknown", reason: "network" });
    expect(scripted.calls).toHaveLength(1);
  });

  it("fails as auth without sending anything when the bundle has no token", async () => {
    const { outcome, calls } = await publishWith(response(200, { uri: CREATED_URI, cid: CREATED_CID }), {
      identifier: "someone.test",
      password: "app-password",
    });
    expect(outcome).toEqual({
      status: "failed",
      disposition: "not_applied",
      retryable: false,
      reason: "auth",
    });
    expect(calls).toHaveLength(0);
  });

  it("never mutates the frozen payload it publishes", async () => {
    const snapshot = structuredClone(frozen);
    await publishWith(response(200, { uri: CREATED_URI, cid: CREATED_CID }));
    expect(frozen).toEqual(snapshot);
  });
});

describe("bluesky publish canary", () => {
  it("never lets a credential or token reach an outcome", async () => {
    const results: readonly ProviderHttpResult[] = [
      response(200, { uri: CREATED_URI, cid: CREATED_CID }),
      response(400, { error: "InvalidRequest", message: TOKEN_CANARY }),
      response(401, { error: "ExpiredToken" }),
      response(429, { error: "RateLimitExceeded" }, { "retry-after": "30" }),
      response(503, { error: "UpstreamFailure" }),
      { type: "transport_error", stage: "possibly_sent", code: "socket_hangup" },
    ];

    for (const result of results) {
      const { outcome } = await publishWith(result);
      expect(containsCanary(outcome)).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain(TOKEN_CANARY);
    }
  });

  it("never lets a credential or token reach a frozen payload or preview", () => {
    const published = plugin.freeze(freezeInput());
    expect(containsCanary(published)).toBe(false);
    expect(containsCanary(published.preview)).toBe(false);
  });
});
