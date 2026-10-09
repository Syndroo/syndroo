import { describe, expect, it } from "vitest";

import type { CallbackEvidence, JsonObject, ProviderConnectInput } from "@syndroo/provider-sdk";

import plugin, {
  THREADS_ACCESS_TOKEN_PATH,
  THREADS_AUTHORIZE_PATH,
  THREADS_LONG_LIVED_TOKEN_PATH,
  THREADS_ME_FIELDS,
  THREADS_ME_PATH,
  type ThreadsProviderError,
} from "../src/index.js";
import {
  ACCOUNT_ID,
  API_HOST,
  AUTHORIZATION_HOST,
  CLIENT_ID,
  CLIENT_SECRET_CANARY,
  CODE_CANARY,
  LONG_TOKEN_CANARY,
  REDIRECT_URI,
  SCOPES,
  SHORT_TOKEN_CANARY,
  THREADS_CANARIES,
  USERNAME,
  clientCredentials,
  containsCanary,
  contextFor,
  credentialBundle,
  meBody,
  response,
  scriptedTransport,
  startOptions,
  tokenBody,
} from "./fixtures.js";

async function errorFrom(promise: Promise<unknown>): Promise<ThreadsProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as ThreadsProviderError;
  }
  throw new Error("expected the call to reject");
}

type OpenUrl = {
  action: { type: "open_url"; url: string };
  privateState: JsonObject;
  calls: ReturnType<typeof scriptedTransport>["calls"];
};

/** Step one with the app client supplied, which builds the action immediately. */
async function openUrlFromStart(options: JsonObject = startOptions()): Promise<OpenUrl> {
  const scripted = scriptedTransport([]);
  const result = await plugin.connect.run(
    {
      type: "start",
      options: {
        ...options,
        clientId: options.clientId ?? CLIENT_ID,
        clientSecret: options.clientSecret ?? CLIENT_SECRET_CANARY,
      },
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
        issuer: overrides.issuer ?? AUTHORIZATION_HOST,
        redirectUri: overrides.redirectUri ?? REDIRECT_URI,
      },
    },
  };
}

describe("threads connect: authorization step", () => {
  it("builds the authorization action on the default .net pair, hiding the secret", async () => {
    const { action, privateState, calls } = await openUrlFromStart();

    expect(calls).toHaveLength(0);

    const url = new URL(action.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${AUTHORIZATION_HOST}${THREADS_AUTHORIZE_PATH}`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe(SCOPES.join(","));
    expect(url.searchParams.get("state")).toBe(String(privateState.state));
    expect(String(privateState.state).length).toBeGreaterThan(20);

    expect(privateState.apiHost).toBe(API_HOST);
    expect(privateState.authorizationHost).toBe(AUTHORIZATION_HOST);
    expect(privateState.clientSecret).toBe(CLIENT_SECRET_CANARY);
    expect(containsCanary(action)).toBe(false);
    expect(action.url).not.toContain(CLIENT_SECRET_CANARY);
  });

  it("uses caller-supplied hosts without mixing the two", async () => {
    const { action, privateState } = await openUrlFromStart(
      startOptions({ apiHost: "https://graph.threads.com", authorizationHost: "https://www.threads.com" }),
    );
    expect(privateState.apiHost).toBe("https://graph.threads.com");
    expect(privateState.authorizationHost).toBe("https://www.threads.com");
    expect(action.url.startsWith("https://www.threads.com/oauth/authorize?")).toBe(true);
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
          { name: "client_id", label: "Threads client id", secret: false },
          { name: "client_secret", label: "Threads client secret", secret: true },
        ],
      },
      privateState: {
        redirectUri: REDIRECT_URI,
        apiHost: API_HOST,
        authorizationHost: AUTHORIZATION_HOST,
        scopes: [...SCOPES],
      },
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
    if (resumed.status !== "action_required" || resumed.action.type !== "open_url") {
      throw new Error("expected an open_url action");
    }
    expect(new URL(resumed.action.url).searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(resumed.privateState.clientSecret).toBe(CLIENT_SECRET_CANARY);
    expect(containsCanary(resumed.action)).toBe(false);
  });

  it("rejects a bad redirect, a bad host and a half-supplied client before I/O", async () => {
    const badRedirect = scriptedTransport([]);
    const redirectError = await errorFrom(
      plugin.connect.run({ type: "start", options: { redirectUri: "not a uri" } }, contextFor(badRedirect.transport)),
    );
    expect(redirectError.code).toBe("redirect_invalid");
    expect(badRedirect.calls).toHaveLength(0);

    const badHost = scriptedTransport([]);
    const hostError = await errorFrom(
      plugin.connect.run(
        { type: "start", options: startOptions({ apiHost: "http://insecure.test" }) },
        contextFor(badHost.transport),
      ),
    );
    expect(hostError.code).toBe("host_invalid");
    expect(badHost.calls).toHaveLength(0);

    const halfClient = scriptedTransport([]);
    const halfError = await errorFrom(
      plugin.connect.run(
        { type: "start", options: startOptions({ clientId: CLIENT_ID }) },
        contextFor(halfClient.transport),
      ),
    );
    expect(halfError.code).toBe("input_invalid");
    expect(halfClient.calls).toHaveLength(0);
  });
});

describe("threads connect: callback step", () => {
  it("exchanges the code, trades for the long-lived token, and resolves the account", async () => {
    const { privateState } = await openUrlFromStart();
    const scripted = scriptedTransport([
      response(200, tokenBody(SHORT_TOKEN_CANARY)),
      response(200, tokenBody(LONG_TOKEN_CANARY)),
      response(200, meBody()),
    ]);

    const done = await plugin.connect.run(callbackInput(privateState), contextFor(scripted.transport));
    expect(done.status).toBe("done");
    if (done.status !== "done") {
      throw new Error("expected connect to finish");
    }

    expect(done.credentials).toEqual({
      apiHost: API_HOST,
      accessToken: LONG_TOKEN_CANARY,
      username: USERNAME,
    });
    expect(done.identity.account).toEqual({
      provider: "threads",
      accountId: ACCOUNT_ID,
      origin: "https://www.threads.net",
    });

    expect(scripted.calls).toHaveLength(3);
    const exchange = new URL(scripted.calls[0]!.url);
    expect(scripted.calls[0]!.method).toBe("POST");
    expect(`${exchange.origin}${exchange.pathname}`).toBe(`${API_HOST}${THREADS_ACCESS_TOKEN_PATH}`);
    expect(exchange.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(exchange.searchParams.get("client_secret")).toBe(CLIENT_SECRET_CANARY);
    expect(exchange.searchParams.get("code")).toBe(CODE_CANARY);
    expect(exchange.searchParams.get("grant_type")).toBe("authorization_code");
    expect(exchange.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);

    const trade = new URL(scripted.calls[1]!.url);
    expect(scripted.calls[1]!.method).toBe("GET");
    expect(`${trade.origin}${trade.pathname}`).toBe(`${API_HOST}${THREADS_LONG_LIVED_TOKEN_PATH}`);
    expect(trade.searchParams.get("grant_type")).toBe("th_exchange_token");
    expect(trade.searchParams.get("client_secret")).toBe(CLIENT_SECRET_CANARY);
    expect(trade.searchParams.get("access_token")).toBe(SHORT_TOKEN_CANARY);

    const me = new URL(scripted.calls[2]!.url);
    expect(`${me.origin}${me.pathname}`).toBe(`${API_HOST}${THREADS_ME_PATH}`);
    expect(me.searchParams.get("fields")).toBe(THREADS_ME_FIELDS);
    expect(scripted.calls[2]!.headers.authorization).toBe(`Bearer ${LONG_TOKEN_CANARY}`);

    expect(containsCanary(done.identity)).toBe(false);
  });

  it("fails closed when /me reports no account id", async () => {
    const { privateState } = await openUrlFromStart();
    const scripted = scriptedTransport([
      response(200, tokenBody(SHORT_TOKEN_CANARY)),
      response(200, tokenBody(LONG_TOKEN_CANARY)),
      response(200, { username: USERNAME }),
    ]);

    const error = await errorFrom(
      plugin.connect.run(callbackInput(privateState), contextFor(scripted.transport)),
    );
    expect(error.code).toBe("identity_unavailable");
    expect(containsCanary(error.message)).toBe(false);
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
        callbackInput(privateState, { redirectUri: "https://127.0.0.1:9999/other" }),
        contextFor(badRedirect.transport),
      ),
    );
    expect(redirectError.code).toBe("redirect_mismatch");
    expect(badRedirect.calls).toHaveLength(0);
  });

  it("rejects a replayed callback: the burned code fails the exchange stably", async () => {
    const { privateState } = await openUrlFromStart();

    const first = scriptedTransport([
      response(200, tokenBody(SHORT_TOKEN_CANARY)),
      response(200, tokenBody(LONG_TOKEN_CANARY)),
      response(200, meBody()),
    ]);
    const done = await plugin.connect.run(callbackInput(privateState), contextFor(first.transport));
    expect(done.status).toBe("done");

    const replay = scriptedTransport([response(400, { error: "invalid_grant" })]);
    const error = await errorFrom(
      plugin.connect.run(callbackInput(privateState), contextFor(replay.transport)),
    );
    expect(error.code).toBe("callback_rejected");
    expect(replay.calls).toHaveLength(1);
    expect(replay.calls[0]!.url.startsWith(`${API_HOST}${THREADS_ACCESS_TOKEN_PATH}?`)).toBe(true);
  });

  it("fails closed when the long-lived trade is rejected", async () => {
    const { privateState } = await openUrlFromStart();
    const scripted = scriptedTransport([
      response(200, tokenBody(SHORT_TOKEN_CANARY)),
      response(400, { error: "invalid_token" }),
    ]);
    const error = await errorFrom(
      plugin.connect.run(callbackInput(privateState), contextFor(scripted.transport)),
    );
    expect(error.code).toBe("token_exchange_rejected");
    expect(scripted.calls).toHaveLength(2);
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

describe("threads connect: verify a stored bundle", () => {
  it("re-resolves the account through /me", async () => {
    const scripted = scriptedTransport([response(200, meBody())]);
    const identity = await plugin.connect.verify(credentialBundle(), contextFor(scripted.transport));

    expect(identity.account.accountId).toBe(ACCOUNT_ID);
    expect(identity.account.origin).toBe("https://www.threads.net");
    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0]!.headers.authorization).toBe(`Bearer ${LONG_TOKEN_CANARY}`);
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

describe("threads connect canary", () => {
  it("never lets the secret or code reach an error while the request carries them", async () => {
    const { privateState } = await openUrlFromStart();
    const scripted = scriptedTransport([
      response(400, { error: "invalid_grant", detail: `${CLIENT_SECRET_CANARY} ${CODE_CANARY}` }),
    ]);
    const error = await errorFrom(
      plugin.connect.run(callbackInput(privateState), contextFor(scripted.transport)),
    );

    expect(error.code).toBe("callback_rejected");
    for (const canary of THREADS_CANARIES) {
      expect(error.message).not.toContain(canary);
      expect(error.stack ?? "").not.toContain(canary);
    }
    const url = scripted.calls[0]!.url;
    expect(url).toContain(encodeURIComponent(CLIENT_SECRET_CANARY));
    expect(url).toContain(encodeURIComponent(CODE_CANARY));
  });

  it("never lets a token reach an error while the requests carry them", async () => {
    const { privateState } = await openUrlFromStart();
    const scripted = scriptedTransport([
      response(200, tokenBody(SHORT_TOKEN_CANARY)),
      response(500, { error: "Server Error", message: `${SHORT_TOKEN_CANARY} ${LONG_TOKEN_CANARY}` }),
    ]);
    const error = await errorFrom(
      plugin.connect.run(callbackInput(privateState), contextFor(scripted.transport)),
    );

    expect(error.code).toBe("token_exchange_rejected");
    expect(error.message).not.toContain(SHORT_TOKEN_CANARY);
    expect(error.stack ?? "").not.toContain(LONG_TOKEN_CANARY);
    expect(scripted.calls[1]!.url).toContain(encodeURIComponent(SHORT_TOKEN_CANARY));
  });
});
