import { describe, expect, it } from "vitest";

import type { CallbackEvidence, JsonObject, ProviderConnectInput } from "@syndroo/provider-sdk";

import plugin, {
  LINKEDIN_AUTHORIZE_URL,
  LINKEDIN_MEMBER_URL,
  LINKEDIN_TOKEN_URL,
  type LinkedinProviderError,
} from "../src/index.js";
import {
  CALLBACK_CANARIES,
  CLIENT_ID,
  CLIENT_SECRET_CANARY,
  CODE_CANARY,
  MEMBER_ID,
  REDIRECT_URI,
  SCOPES,
  TOKEN_CANARY,
  clientCredentials,
  containsCanary,
  contextFor,
  credentialBundle,
  memberBody,
  response,
  scriptedTransport,
  startOptions,
  subOnlyBody,
  tokenBody,
} from "./fixtures.js";

async function errorFrom(promise: Promise<unknown>): Promise<LinkedinProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as LinkedinProviderError;
  }
  throw new Error("expected the call to reject");
}

type OpenUrl = {
  action: { type: "open_url"; url: string };
  privateState: JsonObject;
  calls: ReturnType<typeof scriptedTransport>["calls"];
};

/** Step one with the app client supplied, which builds the action immediately. */
async function openUrlFromStart(): Promise<OpenUrl> {
  const scripted = scriptedTransport([]);
  const result = await plugin.connect.run(
    {
      type: "start",
      options: startOptions({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET_CANARY }),
    },
    contextFor(scripted.transport),
  );
  if (result.status !== "action_required" || result.action.type !== "open_url") {
    throw new Error("expected an open_url action");
  }
  return { action: result.action, privateState: result.privateState, calls: scripted.calls };
}

/** Resume step two with a callback whose code and state the caller chooses. */
function callbackInput(privateState: JsonObject, overrides: Partial<CallbackEvidence> = {}): ProviderConnectInput {
  return {
    type: "resume",
    privateState,
    input: {
      type: "callback",
      evidence: {
        code: overrides.code ?? CODE_CANARY,
        state: overrides.state ?? String(privateState.state),
        issuer: overrides.issuer ?? "https://www.linkedin.com",
        redirectUri: overrides.redirectUri ?? REDIRECT_URI,
      },
    },
  };
}

describe("linkedin connect: authorization step", () => {
  it("builds the authorization action with the client supplied, hiding the secret", async () => {
    const { action, privateState, calls } = await openUrlFromStart();

    // No I/O: registering the app is the developer's own out-of-band step.
    expect(calls).toHaveLength(0);

    const url = new URL(action.url);
    expect(`${url.origin}${url.pathname}`).toBe(LINKEDIN_AUTHORIZE_URL);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe(SCOPES.join(" "));
    expect(url.searchParams.get("state")).toBe(String(privateState.state));
    expect(String(privateState.state).length).toBeGreaterThan(20);

    // PKCE is an assumption upstream, so no challenge is ever sent.
    expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(url.searchParams.has("code_challenge_method")).toBe(false);
    expect(url.searchParams.has("code_verifier")).toBe(false);

    // The private state hides the secret; the action does not.
    expect(privateState.clientSecret).toBe(CLIENT_SECRET_CANARY);
    expect(containsCanary(action)).toBe(false);
    expect(action.url).not.toContain(CLIENT_SECRET_CANARY);
  });

  it("asks for the app client with a secret field when it was not supplied", async () => {
    const scripted = scriptedTransport([]);
    const result = await plugin.connect.run(
      { type: "start", options: startOptions() },
      contextFor(scripted.transport),
    );

    expect(result).toEqual({
      status: "action_required",
      action: {
        type: "credential_input",
        fields: [
          { name: "client_id", label: "LinkedIn client id", secret: false },
          { name: "client_secret", label: "LinkedIn client secret", secret: true },
        ],
      },
      privateState: { redirectUri: REDIRECT_URI, scopes: [...SCOPES] },
    });
    expect(scripted.calls).toHaveLength(0);
  });

  it("turns the collected client into the authorization action without I/O", async () => {
    const start = await plugin.connect.run(
      { type: "start", options: startOptions() },
      contextFor(scriptedTransport([]).transport),
    );
    if (start.status !== "action_required") {
      throw new Error("expected an action");
    }

    const scripted = scriptedTransport([]);
    const resumed = await plugin.connect.run(
      {
        type: "resume",
        privateState: start.privateState,
        input: { type: "credentials", credentials: clientCredentials() },
      },
      contextFor(scripted.transport),
    );
    expect(scripted.calls).toHaveLength(0);
    expect(resumed.status).toBe("action_required");
    if (resumed.status !== "action_required" || resumed.action.type !== "open_url") {
      throw new Error("expected an open_url action");
    }
    const url = new URL(resumed.action.url);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("state")).toBe(String(resumed.privateState.state));
    expect(resumed.privateState.clientSecret).toBe(CLIENT_SECRET_CANARY);
    expect(containsCanary(resumed.action)).toBe(false);
  });

  it("rejects a bad redirect, a half-supplied client and an incomplete resume before I/O", async () => {
    const badRedirect = scriptedTransport([]);
    const redirectError = await errorFrom(
      plugin.connect.run({ type: "start", options: { redirectUri: "not a uri" } }, contextFor(badRedirect.transport)),
    );
    expect(redirectError.code).toBe("redirect_invalid");
    expect(badRedirect.calls).toHaveLength(0);

    const halfClient = scriptedTransport([]);
    const halfError = await errorFrom(
      plugin.connect.run(
        { type: "start", options: startOptions({ clientId: CLIENT_ID }) },
        contextFor(halfClient.transport),
      ),
    );
    expect(halfError.code).toBe("input_invalid");
    expect(halfClient.calls).toHaveLength(0);

    const incomplete = scriptedTransport([]);
    const incompleteError = await errorFrom(
      plugin.connect.run(
        { type: "resume", privateState: {}, input: { type: "credentials", credentials: clientCredentials() } },
        contextFor(incomplete.transport),
      ),
    );
    expect(incompleteError.code).toBe("oauth_material_invalid");
    expect(incomplete.calls).toHaveLength(0);
  });
});

describe("linkedin connect: callback step", () => {
  it("exchanges the code, resolves the member id, and carries secrets only in requests", async () => {
    const { privateState } = await openUrlFromStart();
    const scripted = scriptedTransport([response(200, tokenBody()), response(200, memberBody())]);

    const done = await plugin.connect.run(callbackInput(privateState), contextFor(scripted.transport));
    expect(done.status).toBe("done");
    if (done.status !== "done") {
      throw new Error("expected connect to finish");
    }

    expect(done.credentials).toEqual({ accessToken: TOKEN_CANARY });
    expect(done.identity.account).toEqual({
      provider: "linkedin",
      accountId: MEMBER_ID,
      origin: "https://www.linkedin.com",
    });
    expect(done.identity.evidence[0]).toMatchObject({ capability: "identity", value: "supported" });

    // The token exchange is a form POST with no PKCE parameter.
    expect(scripted.calls).toHaveLength(2);
    const token = scripted.calls[0]!;
    expect(token.url).toBe(LINKEDIN_TOKEN_URL);
    expect(token.method).toBe("POST");
    expect(token.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(token.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe(CODE_CANARY);
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET_CANARY);
    expect(form.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(form.has("code_verifier")).toBe(false);
    expect(form.has("code_challenge")).toBe(false);

    // The member id comes from /v2/me, never from userinfo.sub.
    const me = scripted.calls[1]!;
    expect(me.url).toBe(LINKEDIN_MEMBER_URL);
    expect(me.method).toBe("GET");
    expect(me.headers.authorization).toBe(`Bearer ${TOKEN_CANARY}`);

    expect(containsCanary(done.identity)).toBe(false);
  });

  it("fails closed when /v2/me reports only the app-scoped OIDC subject", async () => {
    const { privateState } = await openUrlFromStart();
    const scripted = scriptedTransport([response(200, tokenBody()), response(200, subOnlyBody())]);

    const error = await errorFrom(
      plugin.connect.run(callbackInput(privateState), contextFor(scripted.transport)),
    );
    expect(error.code).toBe("member_id_unavailable");
    expect(containsCanary(error.message)).toBe(false);
    expect(scripted.calls).toHaveLength(2);
  });

  it("fails closed when /v2/me is unavailable", async () => {
    const { privateState } = await openUrlFromStart();
    const scripted = scriptedTransport([response(200, tokenBody()), response(404, { error: "Not Found" })]);

    const error = await errorFrom(
      plugin.connect.run(callbackInput(privateState), contextFor(scripted.transport)),
    );
    expect(error.code).toBe("member_id_unavailable");
  });

  it("rejects a mismatched state and a mismatched redirect before any I/O", async () => {
    const { privateState } = await openUrlFromStart();

    const badState = scriptedTransport([]);
    const stateError = await errorFrom(
      plugin.connect.run(callbackInput(privateState, { state: "not-the-state" }), contextFor(badState.transport)),
    );
    expect(stateError.code).toBe("state_mismatch");
    expect(badState.calls).toHaveLength(0);

    const badRedirect = scriptedTransport([]);
    const redirectError = await errorFrom(
      plugin.connect.run(
        callbackInput(privateState, { redirectUri: "http://127.0.0.1:9999/other" }),
        contextFor(badRedirect.transport),
      ),
    );
    expect(redirectError.code).toBe("redirect_mismatch");
    expect(badRedirect.calls).toHaveLength(0);
  });

  it("rejects a replayed callback: the burned code fails the exchange stably", async () => {
    const { privateState } = await openUrlFromStart();

    const first = scriptedTransport([response(200, tokenBody()), response(200, memberBody())]);
    const done = await plugin.connect.run(callbackInput(privateState), contextFor(first.transport));
    expect(done.status).toBe("done");

    const replay = scriptedTransport([response(400, { error: "invalid_grant" })]);
    const error = await errorFrom(
      plugin.connect.run(callbackInput(privateState), contextFor(replay.transport)),
    );
    expect(error.code).toBe("callback_rejected");
    expect(replay.calls).toHaveLength(1);
    expect(replay.calls[0]!.url).toBe(LINKEDIN_TOKEN_URL);
  });

  it("rejects an empty callback code before any I/O", async () => {
    const { privateState } = await openUrlFromStart();
    const scripted = scriptedTransport([]);
    const error = await errorFrom(
      plugin.connect.run(callbackInput(privateState, { code: "" }), contextFor(scripted.transport)),
    );
    expect(error.code).toBe("callback_rejected");
    expect(scripted.calls).toHaveLength(0);
  });
});

describe("linkedin connect: verify a stored bundle", () => {
  it("re-resolves the member id through the deprecated endpoint", async () => {
    const scripted = scriptedTransport([response(200, memberBody())]);
    const identity = await plugin.connect.verify(credentialBundle(), contextFor(scripted.transport));

    expect(identity.account.accountId).toBe(MEMBER_ID);
    expect(identity.account.origin).toBe("https://www.linkedin.com");
    expect(identity.evidence[0]!.source).toContain("deprecated");
    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN_CANARY}`);
  });

  it("maps a rejected token and a missing bundle to stable failures", async () => {
    for (const status of [401, 403]) {
      const scripted = scriptedTransport([response(status, { error: "Unauthorized" })]);
      const error = await errorFrom(plugin.connect.verify(credentialBundle(), contextFor(scripted.transport)));
      expect(error.code).toBe("credential_rejected");
    }

    const missing = scriptedTransport([]);
    const missingError = await errorFrom(plugin.connect.verify({}, contextFor(missing.transport)));
    expect(missingError.code).toBe("credential_rejected");
    expect(missing.calls).toHaveLength(0);
  });
});

describe("linkedin connect canary", () => {
  it("never lets the client secret or code reach an error while the request carries them", async () => {
    const { privateState } = await openUrlFromStart();
    const scripted = scriptedTransport([
      response(400, { error: "invalid_grant", detail: `${CLIENT_SECRET_CANARY} ${CODE_CANARY}` }),
    ]);
    const error = await errorFrom(
      plugin.connect.run(callbackInput(privateState), contextFor(scripted.transport)),
    );

    expect(error.code).toBe("callback_rejected");
    for (const canary of CALLBACK_CANARIES) {
      expect(error.message).not.toContain(canary);
      expect(error.stack ?? "").not.toContain(canary);
    }
    const body = scripted.calls[0]!.body ?? "";
    expect(body).toContain(CLIENT_SECRET_CANARY);
    expect(body).toContain(CODE_CANARY);
  });

  it("never lets the access token reach an error while the request carries it", async () => {
    const scripted = scriptedTransport([response(401, { error: "Invalid token", message: TOKEN_CANARY })]);
    const error = await errorFrom(plugin.connect.verify(credentialBundle(), contextFor(scripted.transport)));

    expect(error.message).not.toContain(TOKEN_CANARY);
    expect(error.stack ?? "").not.toContain(TOKEN_CANARY);
    expect(scripted.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN_CANARY}`);
  });
});
