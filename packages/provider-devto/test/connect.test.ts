import { describe, expect, it } from "vitest";

import type { JsonObject, ProviderConnectInput } from "@syndroo/provider-sdk";

import plugin, {
  API_KEY_HEADER,
  DEVTO_USER_AGENT,
  DevtoProviderError,
  USERS_ME_URL,
  USER_AGENT_HEADER,
} from "../src/index.js";
import {
  API_KEY_CANARY,
  USER_ID,
  containsCanary,
  contextFor,
  credentialBundle,
  response,
  scriptedTransport,
} from "./fixtures.js";

const USER_BODY = { id: USER_ID, username: "syndroo", name: "Syndroo" };

async function errorFrom(promise: Promise<unknown>): Promise<DevtoProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DevtoProviderError);
    return error as DevtoProviderError;
  }
  throw new Error("expected the call to reject");
}

describe("devto connect", () => {
  it("asks for a single secret API key on start, without I/O", async () => {
    const scripted = scriptedTransport([]);
    const result = await plugin.connect.run(
      { type: "start", options: {} },
      contextFor(scripted.transport),
    );

    expect(result).toEqual({
      status: "action_required",
      action: {
        type: "credential_input",
        fields: [{ name: "apiKey", label: "DEV.to API key", secret: true }],
      },
      privateState: {},
    });
    expect(scripted.calls).toHaveLength(0);
  });

  it("checks the key with GET /api/users/me and returns a dev.to identity", async () => {
    const scripted = scriptedTransport([response(200, USER_BODY)]);
    const input: ProviderConnectInput = {
      type: "resume",
      privateState: {},
      input: { type: "credentials", credentials: { apiKey: API_KEY_CANARY } },
    };

    const result = await plugin.connect.run(input, contextFor(scripted.transport));
    expect(result.status).toBe("done");
    if (result.status !== "done") {
      throw new Error("expected connect to finish");
    }

    expect(result.credentials).toEqual({ apiKey: API_KEY_CANARY });
    expect(result.identity.account).toEqual({
      provider: "devto",
      accountId: String(USER_ID),
      origin: "https://dev.to",
    });
    expect(result.identity.evidence[0]).toMatchObject({
      capability: "identity",
      value: "supported",
    });

    // The key travels in the api-key header, not as a bearer token or a body.
    expect(scripted.calls).toHaveLength(1);
    const call = scripted.calls[0]!;
    expect(call.url).toBe(USERS_ME_URL);
    expect(call.method).toBe("GET");
    expect(call.headers[API_KEY_HEADER]).toBe(API_KEY_CANARY);
    expect(call.headers[USER_AGENT_HEADER]).toBe(DEVTO_USER_AGENT);
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body).toBeUndefined();

    // The identity result carries no credential material.
    expect(containsCanary(result.identity)).toBe(false);
  });

  it("verifies a stored bundle by re-checking the key", async () => {
    const scripted = scriptedTransport([response(200, USER_BODY)]);
    const identity = await plugin.connect.verify(credentialBundle(), contextFor(scripted.transport));

    expect(identity.account.accountId).toBe(String(USER_ID));
    expect(identity.account.origin).toBe("https://dev.to");
    expect(scripted.calls).toHaveLength(1);
  });

  it("falls back to the username when the response has no id", async () => {
    const scripted = scriptedTransport([response(200, { username: "someone" })]);
    const identity = await plugin.connect.verify(credentialBundle(), contextFor(scripted.transport));
    expect(identity.account.accountId).toBe("someone");
  });

  it("maps 401 and 403 to a stable credential failure", async () => {
    for (const status of [401, 403]) {
      const scripted = scriptedTransport([response(status, { error: "Unauthorized" })]);
      const error = await errorFrom(
        plugin.connect.verify(credentialBundle(), contextFor(scripted.transport)),
      );
      expect(error.code).toBe("credential_rejected");
      expect(error.message).toContain("rejected");
      expect(containsCanary(error.message)).toBe(false);
      expect(containsCanary(error.stack)).toBe(false);
    }
  });

  it("maps a resume rejection to the same credential failure", async () => {
    const scripted = scriptedTransport([response(401, { error: "Unauthorized" })]);
    const error = await errorFrom(
      plugin.connect.run(
        { type: "resume", privateState: {}, input: { type: "credentials", credentials: { apiKey: API_KEY_CANARY } } },
        contextFor(scripted.transport),
      ),
    );
    expect(error.code).toBe("credential_rejected");
    expect(containsCanary(error.message)).toBe(false);
  });

  it("rejects a missing key before any I/O", async () => {
    const scripted = scriptedTransport([response(200, USER_BODY)]);
    const error = await errorFrom(
      plugin.connect.run(
        { type: "resume", privateState: {}, input: { type: "credentials", credentials: {} as JsonObject } },
        contextFor(scripted.transport),
      ),
    );
    expect(error.code).toBe("credential_rejected");
    expect(scripted.calls).toHaveLength(0);
  });

  it("maps an ambiguous transport error and an incomplete user to unavailable", async () => {
    const ambiguous = scriptedTransport([{ type: "transport_error", stage: "possibly_sent", code: "timeout" }]);
    const ambiguousError = await errorFrom(
      plugin.connect.verify(credentialBundle(), contextFor(ambiguous.transport)),
    );
    expect(ambiguousError.code).toBe("provider_unavailable");

    const incomplete = scriptedTransport([response(200, { name: "No id or username" })]);
    const incompleteError = await errorFrom(
      plugin.connect.verify(credentialBundle(), contextFor(incomplete.transport)),
    );
    expect(incompleteError.code).toBe("provider_unavailable");
  });

  it("never lets the API key reach an error while the sent request carries it", async () => {
    const scripted = scriptedTransport([response(401, { error: API_KEY_CANARY })]);
    const error = await errorFrom(
      plugin.connect.verify(credentialBundle(), contextFor(scripted.transport)),
    );

    expect(error.message).not.toContain(API_KEY_CANARY);
    expect(error.stack ?? "").not.toContain(API_KEY_CANARY);
    expect(scripted.calls[0]!.headers[API_KEY_HEADER]).toBe(API_KEY_CANARY);
  });
});
