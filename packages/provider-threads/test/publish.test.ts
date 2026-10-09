import { describe, expect, it } from "vitest";

import { validateProviderWriteOutcome } from "@syndroo/provider-sdk/testing";
import type { JsonObject, ProviderHttpResult, ProviderWriteOutcome } from "@syndroo/provider-sdk";

import plugin, { THREADS_CREATE_PATH } from "../src/index.js";
import {
  API_HOST,
  FIXED_NOW,
  FIXED_SEED,
  LONG_TOKEN_CANARY,
  POST_ID,
  THREADS_ACCOUNT,
  USERNAME,
  containsCanary,
  contextFor,
  credentialBundle,
  freezeInput,
  response,
  scriptedTransport,
  throwingTransport,
} from "./fixtures.js";

const frozen = plugin.freeze(freezeInput());

const CREATE_URL = `${API_HOST}${THREADS_CREATE_PATH}`;
const PROFILE_URL = `https://www.threads.net/@${USERNAME}`;

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
    account: THREADS_ACCOUNT,
    credentials,
    submissionId: FIXED_SEED,
    context: contextFor(scripted.transport, now),
  });
  validateProviderWriteOutcome(outcome);
  return { outcome, calls: scripted.calls };
}

describe("threads publish classification", () => {
  it("publishes in a single auto_publish_text call and reports the post id and profile url", async () => {
    const { outcome, calls } = await publishWith(response(200, { id: POST_ID }));

    expect(outcome).toEqual({ status: "succeeded", remoteId: POST_ID, url: PROFILE_URL });

    // Exactly one request: the single-call path, no second container publish.
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const url = new URL(call.url);
    expect(`${url.origin}${url.pathname}`).toBe(CREATE_URL);
    expect(call.method).toBe("POST");
    expect(url.searchParams.get("text")).toBe("Hello from Syndroo on Threads.");
    expect(url.searchParams.get("media_type")).toBe("TEXT");
    expect(url.searchParams.get("auto_publish_text")).toBe("true");
    expect(call.headers.authorization).toBe(`Bearer ${LONG_TOKEN_CANARY}`);
    expect(call.body).toBeUndefined();
  });

  it("never makes a second request, even when the script would allow one", async () => {
    // A second scripted result exists; the provider must not consume it.
    const scripted = scriptedTransport([response(200, { id: POST_ID }), response(200, { id: "second" })]);
    const outcome = await plugin.publish({
      frozen,
      account: THREADS_ACCOUNT,
      credentials: credentialBundle(),
      submissionId: FIXED_SEED,
      context: contextFor(scripted.transport),
    });
    expect(outcome.status).toBe("succeeded");
    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0]!.url).not.toContain("threads_publish");
  });

  it("still succeeds on a 2xx without a post id: no remoteId, only the profile url", async () => {
    const { outcome } = await publishWith(response(200, {}));
    // The only evidence-backed URL is the profile URL; no post permalink is invented.
    expect(outcome).toEqual({ status: "succeeded", url: PROFILE_URL });
    expect(Object.hasOwn(outcome, "remoteId")).toBe(false);
  });

  it("omits the profile url when the bundle has no username", async () => {
    const { outcome } = await publishWith(response(200, { id: POST_ID }), {
      apiHost: API_HOST,
      accessToken: LONG_TOKEN_CANARY,
    });
    expect(outcome).toEqual({ status: "succeeded", remoteId: POST_ID });
  });

  it("classifies a definite 4xx rejection as failed and never retried", async () => {
    const cases: readonly { result: ProviderHttpResult; reason: string }[] = [
      { result: response(400, { error: "Bad Request" }), reason: "validation" },
      { result: response(401, { error: "Unauthorized" }), reason: "auth" },
      { result: response(403, { error: "Forbidden" }), reason: "permission" },
      { result: response(404, { error: "Not Found" }), reason: "validation" },
      { result: response(422, { error: "Unprocessable Entity" }), reason: "validation" },
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
      account: THREADS_ACCOUNT,
      credentials: credentialBundle(),
      submissionId: FIXED_SEED,
      context: contextFor(scripted.transport),
    });
    expect(outcome).toEqual({ status: "unknown", disposition: "unknown", reason: "network" });
    expect(scripted.calls).toHaveLength(1);
  });

  it("fails as auth without sending anything when the bundle has no token", async () => {
    const { outcome, calls } = await publishWith(response(200, { id: POST_ID }), {
      apiHost: API_HOST,
      username: USERNAME,
    });
    expect(outcome).toEqual({
      status: "failed",
      disposition: "not_applied",
      retryable: false,
      reason: "auth",
    });
    expect(calls).toHaveLength(0);
  });

  it("fails as validation without sending anything when the bundle has no api host", async () => {
    const { outcome, calls } = await publishWith(response(200, { id: POST_ID }), {
      accessToken: LONG_TOKEN_CANARY,
    });
    expect(outcome).toEqual({
      status: "failed",
      disposition: "not_applied",
      retryable: false,
      reason: "validation",
    });
    expect(calls).toHaveLength(0);
  });

  it("never mutates the frozen payload it publishes", async () => {
    const snapshot = structuredClone(frozen);
    await publishWith(response(200, { id: POST_ID }));
    expect(frozen).toEqual(snapshot);
  });
});

describe("threads publish canary", () => {
  it("never lets a token reach an outcome", async () => {
    const results: readonly ProviderHttpResult[] = [
      response(200, { id: POST_ID }),
      response(422, { error: LONG_TOKEN_CANARY }),
      response(401, { error: "Unauthorized" }),
      response(429, { error: "Too Many Requests" }, { "retry-after": "30" }),
      response(503, { error: "Server Error" }),
      { type: "transport_error", stage: "possibly_sent", code: "socket_hangup" },
    ];

    for (const result of results) {
      const { outcome } = await publishWith(result);
      expect(containsCanary(outcome)).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain(LONG_TOKEN_CANARY);
    }
  });

  it("never lets a credential reach a frozen payload or preview", () => {
    const published = plugin.freeze(freezeInput());
    expect(containsCanary(published)).toBe(false);
    expect(containsCanary(published.preview)).toBe(false);
  });
});
