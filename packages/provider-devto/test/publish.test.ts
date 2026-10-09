import { describe, expect, it } from "vitest";

import { validateProviderWriteOutcome } from "@syndroo/provider-sdk/testing";
import type { JsonObject, ProviderHttpResult, ProviderWriteOutcome } from "@syndroo/provider-sdk";

import plugin, {
  API_KEY_HEADER,
  CREATE_ARTICLE_URL,
  DEVTO_USER_AGENT,
  USER_AGENT_HEADER,
} from "../src/index.js";
import {
  API_KEY_CANARY,
  DEVTO_ACCOUNT,
  FIXED_NOW,
  FIXED_SEED,
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

const ARTICLE_ID = 424242;
const ARTICLE_URL = "https://dev.to/syndroo/introducing-syndroo-1abc";

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
    account: DEVTO_ACCOUNT,
    credentials,
    submissionId: FIXED_SEED,
    context: contextFor(scripted.transport, now),
  });
  validateProviderWriteOutcome(outcome);
  return { outcome, calls: scripted.calls };
}

describe("devto publish classification", () => {
  it("reports a 2xx create as succeeded with the article id and url", async () => {
    const { outcome, calls } = await publishWith(
      response(201, { id: ARTICLE_ID, url: ARTICLE_URL, slug: "introducing-syndroo-1abc" }),
    );

    expect(outcome).toEqual({ status: "succeeded", remoteId: String(ARTICLE_ID), url: ARTICLE_URL });

    // One request, the API key in the api-key header, and the exact frozen bytes.
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(CREATE_ARTICLE_URL);
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers[API_KEY_HEADER]).toBe(API_KEY_CANARY);
    expect(call.headers[USER_AGENT_HEADER]).toBe(DEVTO_USER_AGENT);
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body).toBe(JSON.stringify(frozen.payload));
  });

  it("builds the article url from the path when the response has no url", async () => {
    const { outcome } = await publishWith(
      response(200, { id: ARTICLE_ID, path: "/syndroo/introducing-syndroo-1abc" }),
    );
    expect(outcome).toEqual({
      status: "succeeded",
      remoteId: String(ARTICLE_ID),
      url: `https://dev.to/syndroo/introducing-syndroo-1abc`,
    });
  });

  it("still succeeds on a 2xx without a parseable body, carrying no remoteId", async () => {
    const { outcome } = await publishWith(rawResponse(201, "not json"));
    expect(outcome).toEqual({ status: "succeeded" });
  });

  it("classifies a definite 4xx rejection as failed and never retried", async () => {
    const cases: readonly { result: ProviderHttpResult; reason: string }[] = [
      { result: response(400, { error: "Bad Request" }), reason: "validation" },
      { result: response(401, { error: "Unauthorized" }), reason: "auth" },
      { result: response(403, { error: "Forbidden" }), reason: "permission" },
      { result: response(404, { error: "Not Found" }), reason: "validation" },
      { result: response(422, { error: "Unprocessable Entity", status: 422 }), reason: "validation" },
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
    const withSeconds = await publishWith(response(429, { error: "Too Many Requests" }, { "Retry-After": "30" }));
    expect(withSeconds.outcome).toEqual({
      status: "failed",
      disposition: "not_applied",
      retryable: true,
      reason: "rate_limited",
      retryAfter: new Date(Date.parse(FIXED_NOW) + 30_000).toISOString(),
    });
    expect(withSeconds.calls).toHaveLength(1);

    const without = await publishWith(response(429, { error: "Too Many Requests" }));
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

  it("classifies any 5xx and unexpected statuses as unknown rather than not_applied", async () => {
    for (const status of [500, 502, 503]) {
      const { outcome, calls } = await publishWith(response(status, { error: "Server Error" }));
      expect(outcome).toEqual({
        status: "unknown",
        disposition: "unknown",
        reason: "provider_unavailable",
      });
      expect(calls).toHaveLength(1);
    }

    const redirect = await publishWith(response(302, { error: "Moved" }, { location: "https://elsewhere" }));
    expect(redirect.outcome).toEqual({ status: "unknown", disposition: "unknown", reason: "unknown" });
  });

  it("treats a transport that throws as an ambiguous unknown outcome", async () => {
    const scripted = throwingTransport();
    const outcome = await plugin.publish({
      frozen,
      account: DEVTO_ACCOUNT,
      credentials: credentialBundle(),
      submissionId: FIXED_SEED,
      context: contextFor(scripted.transport),
    });
    expect(outcome).toEqual({ status: "unknown", disposition: "unknown", reason: "network" });
    expect(scripted.calls).toHaveLength(1);
  });

  it("fails as auth without sending anything when the bundle has no key", async () => {
    const { outcome, calls } = await publishWith(response(201, { id: ARTICLE_ID }), {
      somethingElse: "value",
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
    await publishWith(response(201, { id: ARTICLE_ID, url: ARTICLE_URL }));
    expect(frozen).toEqual(snapshot);
  });
});

describe("devto publish canary", () => {
  it("never lets the API key reach an outcome", async () => {
    const results: readonly ProviderHttpResult[] = [
      response(201, { id: ARTICLE_ID, url: ARTICLE_URL }),
      response(422, { error: API_KEY_CANARY, status: 422 }),
      response(401, { error: "Unauthorized" }),
      response(429, { error: "Too Many Requests" }, { "retry-after": "30" }),
      response(503, { error: "Server Error" }),
      { type: "transport_error", stage: "possibly_sent", code: "socket_hangup" },
    ];

    for (const result of results) {
      const { outcome } = await publishWith(result);
      expect(containsCanary(outcome)).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain(API_KEY_CANARY);
    }
  });

  it("never lets the API key reach a frozen payload or preview", () => {
    const published = plugin.freeze(freezeInput());
    expect(containsCanary(published)).toBe(false);
    expect(containsCanary(published.preview)).toBe(false);
    expect(JSON.stringify(published.effectiveOptions)).not.toContain(API_KEY_CANARY);
  });
});
