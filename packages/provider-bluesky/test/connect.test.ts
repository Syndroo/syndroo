import { describe, expect, it } from "vitest";

import type { JsonObject, ProviderConnectInput } from "@syndroo/provider-sdk";

import plugin, {
  BlueskyProviderError,
  CREATE_SESSION_URL,
  type BlueskyProviderErrorCode,
} from "../src/index.js";
import {
  CREDENTIAL_CANARIES,
  IDENTIFIER_CANARY,
  PASSWORD_CANARY,
  SESSION_DID,
  TOKEN_CANARY,
  containsCanary,
  contextFor,
  response,
  scriptedTransport,
} from "./fixtures.js";

const SESSION_BODY = { accessJwt: TOKEN_CANARY, did: SESSION_DID, handle: "someone.test" };

function credentialInput(): JsonObject {
  return { identifier: IDENTIFIER_CANARY, password: PASSWORD_CANARY };
}

async function errorFrom(promise: Promise<unknown>): Promise<BlueskyProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BlueskyProviderError);
    return error as BlueskyProviderError;
  }
  throw new Error("expected the call to reject");
}

describe("bluesky connect", () => {
  it("asks for an identifier and a secret app password on start, without I/O", async () => {
    const scripted = scriptedTransport([]);
    const result = await plugin.connect.run(
      { type: "start", options: {} },
      contextFor(scripted.transport),
    );

    expect(result).toEqual({
      status: "action_required",
      action: {
        type: "credential_input",
        fields: [
          { name: "identifier", label: "Bluesky handle or email", secret: false },
          { name: "password", label: "App password", secret: true },
        ],
      },
      privateState: {},
    });
    expect(scripted.calls).toHaveLength(0);
  });

  it("exchanges a JSON body for a session and returns a DID-keyed identity", async () => {
    const scripted = scriptedTransport([response(200, SESSION_BODY)]);
    const input: ProviderConnectInput = {
      type: "resume",
      privateState: {},
      input: { type: "credentials", credentials: credentialInput() },
    };

    const result = await plugin.connect.run(input, contextFor(scripted.transport));
    expect(result.status).toBe("done");
    if (result.status !== "done") {
      throw new Error("expected connect to finish");
    }

    expect(result.credentials).toEqual({
      identifier: IDENTIFIER_CANARY,
      password: PASSWORD_CANARY,
      accessJwt: TOKEN_CANARY,
    });
    expect(result.identity.account).toEqual({
      provider: "bluesky",
      accountId: SESSION_DID,
      origin: "https://bsky.app",
    });
    expect(result.identity.evidence[0]).toMatchObject({
      capability: "identity",
      value: "supported",
    });

    // The session request is a JSON body, never HTTP basic auth.
    expect(scripted.calls).toHaveLength(1);
    const call = scripted.calls[0]!;
    expect(call.url).toBe(CREATE_SESSION_URL);
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers.authorization).toBeUndefined();
    expect(JSON.parse(call.body ?? "null")).toEqual(credentialInput());

    // The identity result carries no credential material.
    expect(containsCanary(result.identity)).toBe(false);
  });

  it("verifies a stored bundle by posting the session request", async () => {
    const scripted = scriptedTransport([response(200, SESSION_BODY)]);
    const identity = await plugin.connect.verify(
      { identifier: IDENTIFIER_CANARY, password: PASSWORD_CANARY },
      contextFor(scripted.transport),
    );

    expect(identity.account.accountId).toBe(SESSION_DID);
    expect(identity.account.origin).toBe("https://bsky.app");
    expect(scripted.calls).toHaveLength(1);
  });

  it("maps 400 and 401 to a stable credential failure", async () => {
    for (const status of [400, 401]) {
      const scripted = scriptedTransport([response(status, { error: "InvalidRequest" })]);
      const error = await errorFrom(
        plugin.connect.verify({ identifier: IDENTIFIER_CANARY, password: PASSWORD_CANARY }, contextFor(scripted.transport)),
      );
      expect(error.code).toBe<BlueskyProviderErrorCode>("credential_rejected");
      expect(error.message).toContain("rejected");
      expect(containsCanary(error.message)).toBe(false);
      expect(containsCanary(error.stack)).toBe(false);
    }
  });

  it("maps a resume rejection to the same credential failure", async () => {
    const scripted = scriptedTransport([response(401, { error: "InvalidToken" })]);
    const error = await errorFrom(
      plugin.connect.run(
        { type: "resume", privateState: {}, input: { type: "credentials", credentials: credentialInput() } },
        contextFor(scripted.transport),
      ),
    );
    expect(error.code).toBe("credential_rejected");
    expect(containsCanary(error.message)).toBe(false);
  });

  it("rejects missing credential fields before any I/O", async () => {
    const scripted = scriptedTransport([response(200, SESSION_BODY)]);
    const error = await errorFrom(
      plugin.connect.run(
        { type: "resume", privateState: {}, input: { type: "credentials", credentials: { identifier: IDENTIFIER_CANARY } } },
        contextFor(scripted.transport),
      ),
    );
    expect(error.code).toBe("credential_rejected");
    expect(scripted.calls).toHaveLength(0);
  });

  it("maps an ambiguous transport error and an incomplete session to unavailable", async () => {
    const ambiguous = scriptedTransport([{ type: "transport_error", stage: "possibly_sent", code: "timeout" }]);
    const ambiguousError = await errorFrom(
      plugin.connect.verify({ identifier: IDENTIFIER_CANARY, password: PASSWORD_CANARY }, contextFor(ambiguous.transport)),
    );
    expect(ambiguousError.code).toBe("provider_unavailable");

    const incomplete = scriptedTransport([response(200, { did: SESSION_DID })]);
    const incompleteError = await errorFrom(
      plugin.connect.verify({ identifier: IDENTIFIER_CANARY, password: PASSWORD_CANARY }, contextFor(incomplete.transport)),
    );
    expect(incompleteError.code).toBe("provider_unavailable");
  });

  it("never lets a credential or token reach an error", async () => {
    const scripted = scriptedTransport([response(400, { error: "InvalidRequest", message: TOKEN_CANARY })]);
    const error = await errorFrom(
      plugin.connect.verify({ identifier: IDENTIFIER_CANARY, password: PASSWORD_CANARY }, contextFor(scripted.transport)),
    );

    for (const canary of CREDENTIAL_CANARIES) {
      expect(error.message).not.toContain(canary);
      expect(error.stack ?? "").not.toContain(canary);
    }
    // The credential values appear only in the request body that was sent.
    expect(scripted.calls[0]!.body).toContain(IDENTIFIER_CANARY);
  });
});
