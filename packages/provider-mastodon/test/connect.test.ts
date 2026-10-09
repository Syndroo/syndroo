import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { CallbackEvidence, JsonObject, ProviderConnectInput } from "@syndroo/provider-sdk";

import plugin, {
  APP_REGISTRATION_PATH,
  AUTHORIZE_PATH,
  INSTANCE_PATH,
  TOKEN_PATH,
  VERIFY_CREDENTIALS_PATH,
  type MastodonProviderError,
} from "../src/index.js";
import {
  ACCOUNT_ID,
  CLIENT_ID,
  CLIENT_SECRET_CANARY,
  CODE_CANARY,
  CONNECT_CANARIES,
  REDIRECT_URI,
  SCOPES,
  TEST_INSTANCE,
  TOKEN_CANARY,
  VERIFIER_CANARY,
  appRegistrationBody,
  containsCanary,
  contextFor,
  instanceLimitBody,
  response,
  scriptedTransport,
  startOptions,
  verifyBody,
} from "./fixtures.js";

/** The S256 PKCE challenge, recomputed here to prove the plugin's derivation. */
function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

async function errorFrom(promise: Promise<unknown>): Promise<MastodonProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as MastodonProviderError;
  }
  throw new Error("expected the call to reject");
}

/** Run step one (app registration + authorization action) through a script. */
async function startSession(
  results = [response(200, appRegistrationBody())],
): Promise<{ result: { action: { type: string; url: string }; privateState: JsonObject }; calls: ReturnType<typeof scriptedTransport>["calls"] }> {
  const scripted = scriptedTransport(results);
  const result = await plugin.connect.run(
    { type: "start", options: startOptions() },
    contextFor(scripted.transport),
  );
  if (result.status !== "action_required" || result.action.type !== "open_url") {
    throw new Error("expected an open_url action");
  }
  return { result: { action: result.action, privateState: result.privateState }, calls: scripted.calls };
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
        issuer: overrides.issuer ?? TEST_INSTANCE,
        redirectUri: overrides.redirectUri ?? REDIRECT_URI,
      },
    },
  };
}

describe("mastodon connect: step one", () => {
  it("registers the app and returns a PKCE authorization action, hiding the secret", async () => {
    const { result, calls } = await startSession();

    // Step one registered the app with the verified /api/v1/apps body.
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${TEST_INSTANCE}${APP_REGISTRATION_PATH}`);
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call.body ?? "null")).toEqual({
      client_name: "Syndroo",
      redirect_uris: REDIRECT_URI,
      scopes: SCOPES.join(" "),
    });

    // The action is an authorize URL carrying the PKCE challenge, not the verifier.
    const url = new URL(result.action.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${TEST_INSTANCE}${AUTHORIZE_PATH}`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe(SCOPES.join(" "));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(String(result.privateState.state));

    // The private state hides the client secret and the verifier; the action does not.
    expect(result.privateState.clientSecret).toBe(CLIENT_SECRET_CANARY);
    const verifier = String(result.privateState.codeVerifier);
    expect(verifier.length).toBeGreaterThan(20);
    expect(result.privateState.codeChallenge).toBe(challengeFor(verifier));
    expect(url.searchParams.get("code_challenge")).toBe(String(result.privateState.codeChallenge));

    expect(containsCanary(result.action)).toBe(false);
    expect(result.action.url).not.toContain(CLIENT_SECRET_CANARY);
    expect(result.action.url).not.toContain(verifier);
  });

  it("accepts a pre-registered client without calling /api/v1/apps", async () => {
    const scripted = scriptedTransport([]);
    const result = await plugin.connect.run(
      {
        type: "start",
        options: startOptions({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET_CANARY }),
      },
      contextFor(scripted.transport),
    );

    expect(result.status).toBe("action_required");
    expect(scripted.calls).toHaveLength(0);
    if (result.status === "action_required") {
      expect(result.action.type).toBe("open_url");
      if (result.action.type === "open_url") {
        expect(new URL(result.action.url).searchParams.get("client_id")).toBe(CLIENT_ID);
      }
    }
  });

  it("rejects a bad instance, a bad redirect and a half-supplied client before any I/O", async () => {
    const cases: readonly JsonObject[] = [
      startOptions({ instance: "http://insecure.test" }),
      startOptions({ redirectUri: "not a uri" }),
      startOptions({ clientId: CLIENT_ID }),
      startOptions({ clientSecret: CLIENT_SECRET_CANARY }),
      startOptions({ scopes: [] }),
    ];
    for (const options of cases) {
      const scripted = scriptedTransport([]);
      const error = await errorFrom(
        plugin.connect.run({ type: "start", options }, contextFor(scripted.transport)),
      );
      expect(error.name).toBe("MastodonProviderError");
      expect(scripted.calls).toHaveLength(0);
    }
  });
});

describe("mastodon connect: step two", () => {
  it("exchanges the callback and verifies the account, carrying secrets only in requests", async () => {
    const { result } = await startSession();
    const scripted = scriptedTransport([
      response(200, { access_token: TOKEN_CANARY, token_type: "Bearer", scope: SCOPES.join(" ") }),
      response(200, verifyBody()),
      response(200, instanceLimitBody()),
    ]);

    const done = await plugin.connect.run(callbackInput(result.privateState), contextFor(scripted.transport));
    expect(done.status).toBe("done");
    if (done.status !== "done") {
      throw new Error("expected connect to finish");
    }

    expect(done.credentials).toEqual({ instance: TEST_INSTANCE, accessToken: TOKEN_CANARY });
    expect(done.identity.account).toEqual({
      provider: "mastodon",
      accountId: ACCOUNT_ID,
      origin: TEST_INSTANCE,
    });
    expect(done.identity.evidence[0]).toMatchObject({ capability: "identity", value: "supported" });

    // The token exchange is a form POST carrying the secret, the code and the verifier.
    expect(scripted.calls).toHaveLength(3);
    const token = scripted.calls[0]!;
    expect(token.url).toBe(`${TEST_INSTANCE}${TOKEN_PATH}`);
    expect(token.method).toBe("POST");
    expect(token.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(token.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe(CODE_CANARY);
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET_CANARY);
    expect(form.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(form.get("scope")).toBe(SCOPES.join(" "));
    expect(form.get("code_verifier")).toBe(String(result.privateState.codeVerifier));

    // The identity check carries the access token as a Bearer header.
    const verify = scripted.calls[1]!;
    expect(verify.url).toBe(`${TEST_INSTANCE}${VERIFY_CREDENTIALS_PATH}`);
    expect(verify.method).toBe("GET");
    expect(verify.headers.authorization).toBe(`Bearer ${TOKEN_CANARY}`);

    // The instance limit is read for freeze, never hardcoded.
    const instance = scripted.calls[2]!;
    expect(instance.url).toBe(`${TEST_INSTANCE}${INSTANCE_PATH}`);
    expect(instance.method).toBe("GET");

    // Nothing rendered leaks a secret.
    expect(containsCanary(done.identity)).toBe(false);
    expect(containsCanary(done.credentials)).toBe(true); // the bundle is the secret store
  });

  it("rejects a mismatched state before any I/O", async () => {
    const { result } = await startSession();
    const scripted = scriptedTransport([]);
    const error = await errorFrom(
      plugin.connect.run(callbackInput(result.privateState, { state: "not-the-state" }), contextFor(scripted.transport)),
    );
    expect(error.code).toBe("state_mismatch");
    expect(scripted.calls).toHaveLength(0);
  });

  it("rejects a mismatched redirect before any I/O", async () => {
    const { result } = await startSession();
    const scripted = scriptedTransport([]);
    const error = await errorFrom(
      plugin.connect.run(
        callbackInput(result.privateState, { redirectUri: "http://127.0.0.1:9999/other" }),
        contextFor(scripted.transport),
      ),
    );
    expect(error.code).toBe("redirect_mismatch");
    expect(scripted.calls).toHaveLength(0);
  });

  it("rejects a replayed callback: the burned code fails the exchange stably", async () => {
    const { result } = await startSession();

    const first = scriptedTransport([
      response(200, { access_token: TOKEN_CANARY }),
      response(200, verifyBody()),
      response(200, instanceLimitBody()),
    ]);
    const done = await plugin.connect.run(callbackInput(result.privateState), contextFor(first.transport));
    expect(done.status).toBe("done");

    // Replaying the same callback: the server has already burned the code.
    const replay = scriptedTransport([response(400, { error: "invalid_grant" })]);
    const error = await errorFrom(
      plugin.connect.run(callbackInput(result.privateState), contextFor(replay.transport)),
    );
    expect(error.code).toBe("callback_rejected");
    expect(replay.calls).toHaveLength(1);
    expect(replay.calls[0]!.url).toBe(`${TEST_INSTANCE}${TOKEN_PATH}`);
  });

  it("rejects an empty callback code before any I/O", async () => {
    const { result } = await startSession();
    const scripted = scriptedTransport([]);
    const error = await errorFrom(
      plugin.connect.run(callbackInput(result.privateState, { code: "" }), contextFor(scripted.transport)),
    );
    expect(error.code).toBe("callback_rejected");
    expect(scripted.calls).toHaveLength(0);
  });

  it("asks for the callback again when resumed with credentials, without I/O", async () => {
    const { result } = await startSession();
    const scripted = scriptedTransport([]);
    const resumed = await plugin.connect.run(
      {
        type: "resume",
        privateState: result.privateState,
        input: { type: "credentials", credentials: { nothing: "here" } },
      },
      contextFor(scripted.transport),
    );
    expect(resumed).toEqual({
      status: "action_required",
      action: { type: "wait_for_callback" },
      privateState: result.privateState,
    });
    expect(scripted.calls).toHaveLength(0);
  });

  it("rejects a resume whose private state is missing its OAuth material", async () => {
    const scripted = scriptedTransport([]);
    const error = await errorFrom(
      plugin.connect.run(callbackInput({}), contextFor(scripted.transport)),
    );
    expect(error.code).toBe("oauth_material_invalid");
    expect(scripted.calls).toHaveLength(0);
  });
});

describe("mastodon connect: verify a stored bundle", () => {
  it("re-checks the token and re-reads the instance limit", async () => {
    const scripted = scriptedTransport([
      response(200, verifyBody()),
      response(200, instanceLimitBody()),
    ]);
    const identity = await plugin.connect.verify(
      { instance: TEST_INSTANCE, accessToken: TOKEN_CANARY },
      contextFor(scripted.transport),
    );

    expect(identity.account.accountId).toBe(ACCOUNT_ID);
    expect(identity.account.origin).toBe(TEST_INSTANCE);
    expect(scripted.calls).toHaveLength(2);
    expect(scripted.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN_CANARY}`);
  });

  it("maps a rejected token and a missing bundle to stable failures", async () => {
    const rejected = scriptedTransport([response(401, { error: "The access token is invalid" })]);
    const rejectedError = await errorFrom(
      plugin.connect.verify({ instance: TEST_INSTANCE, accessToken: TOKEN_CANARY }, contextFor(rejected.transport)),
    );
    expect(rejectedError.code).toBe("credential_rejected");

    const missing = scriptedTransport([]);
    const missingError = await errorFrom(
      plugin.connect.verify({}, contextFor(missing.transport)),
    );
    expect(missingError.code).toBe("input_invalid");
    expect(missing.calls).toHaveLength(0);
  });

  it("fails closed when the instance does not report a character limit", async () => {
    const scripted = scriptedTransport([
      response(200, verifyBody()),
      response(200, { configuration: {} }),
    ]);
    const error = await errorFrom(
      plugin.connect.verify({ instance: TEST_INSTANCE, accessToken: TOKEN_CANARY }, contextFor(scripted.transport)),
    );
    expect(error.code).toBe("limit_unavailable");
  });
});

describe("mastodon connect canary", () => {
  it("never lets the client secret or verifier reach an error while the request carries them", async () => {
    const { result } = await startSession();
    const scripted = scriptedTransport([
      response(400, { error: "invalid_grant", detail: `${CLIENT_SECRET_CANARY} ${VERIFIER_CANARY}` }),
    ]);
    const error = await errorFrom(
      plugin.connect.run(callbackInput(result.privateState), contextFor(scripted.transport)),
    );

    expect(error.code).toBe("callback_rejected");
    for (const canary of CONNECT_CANARIES) {
      expect(error.message).not.toContain(canary);
      expect(error.stack ?? "").not.toContain(canary);
    }
    // The token request is where the secret, the code and the verifier must appear.
    const body = scripted.calls[0]!.body ?? "";
    expect(body).toContain(CLIENT_SECRET_CANARY);
    expect(body).toContain(CODE_CANARY);
    expect(body).toContain(String(result.privateState.codeVerifier));
  });

  it("never lets the access token reach an error while the request carries it", async () => {
    const scripted = scriptedTransport([response(401, { error: "Invalid token", message: TOKEN_CANARY })]);
    const error = await errorFrom(
      plugin.connect.verify({ instance: TEST_INSTANCE, accessToken: TOKEN_CANARY }, contextFor(scripted.transport)),
    );

    expect(error.message).not.toContain(TOKEN_CANARY);
    expect(error.stack ?? "").not.toContain(TOKEN_CANARY);
    expect(scripted.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN_CANARY}`);
  });
});
