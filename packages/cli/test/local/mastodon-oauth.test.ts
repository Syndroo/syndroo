import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { Server as NetServer, connect as netConnect } from "node:net";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MastodonOAuthError,
  authorizeMastodon,
  type MastodonOAuthPreview,
  type MastodonOAuthResult,
} from "../../src/local/mastodon-oauth.js";
import { SafeInstanceTransportError } from "../../src/local/http/safe-instance-transport.js";

const INSTANCE = "https://instance.test";
const SCOPES = ["read:accounts", "write:statuses"];
const CANARY = "SECRET_CANARY_VALUE_123";
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SIGNAL_CHILD_ENTRY = fileURLToPath(new URL("../fixtures/oauth-signal-child.ts", import.meta.url));
const ENGINE_ENTRY = fileURLToPath(new URL("../../src/local/mastodon-oauth.ts", import.meta.url));

const BASE_METADATA = {
  issuer: INSTANCE,
  authorization_endpoint: `${INSTANCE}/oauth/authorize`,
  token_endpoint: `${INSTANCE}/oauth/token`,
  code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code", "client_credentials"],
  response_types_supported: ["code"],
};

const BASE_INSTANCE = {
  configuration: { statuses: { max_characters: 500, characters_reserved_per_url: 23 } },
};

// ---------------------------------------------------------------------------
// Instance stub
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}

type Handler = (call: RecordedCall) => Response;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createInstanceStub(options: {
  metadata?: Handler;
  instance?: Handler;
  apps?: Handler;
  token?: Handler;
} = {}): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  const metadataHandler: Handler = () => json(BASE_METADATA);
  const instanceHandler: Handler = () => json(BASE_INSTANCE);
  const appsHandler: Handler = call => {
    const body = JSON.parse(call.body) as { redirect_uris: string };
    return json({ client_id: "client-id-1", client_secret: "client-secret-1", redirect_uri: body.redirect_uris });
  };
  const tokenHandler: Handler = () =>
    json({ access_token: "user-token-1", token_type: "Bearer", scope: "read:accounts write:statuses" });

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : "";
    const call: RecordedCall = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: parsed.pathname,
      url,
      body,
      headers: Object.fromEntries(headers.entries()),
    };

    calls.push(call);

    const handler =
      parsed.pathname === "/.well-known/oauth-authorization-server"
        ? (options.metadata ?? metadataHandler)
        : parsed.pathname === "/api/v2/instance"
          ? (options.instance ?? instanceHandler)
          : parsed.pathname === "/api/v1/apps"
            ? (options.apps ?? appsHandler)
            : parsed.pathname === "/oauth/token"
              ? (options.token ?? tokenHandler)
              : null;

    if (handler === null) {
      return new Response("not found", { status: 404 });
    }

    return handler(call);
  };

  return { fetch: fetchImpl as typeof fetch, calls };
}

// ---------------------------------------------------------------------------
// Flow harness
// ---------------------------------------------------------------------------

interface FlowOptions {
  readonly fetch: typeof fetch;
  readonly instance?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly confirm?: (preview: MastodonOAuthPreview) => Promise<boolean>;
  readonly openBrowser?: (url: string) => Promise<void>;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly now?: () => number;
}

interface FlowHarness {
  /** Resolves when the engine reaches the browser step; never rejects. */
  readonly authorizeUrl: Promise<string>;
  readonly result: Promise<MastodonOAuthResult>;
  readonly previews: MastodonOAuthPreview[];
}

function startFlow(options: FlowOptions): FlowHarness {
  const previews: MastodonOAuthPreview[] = [];
  let resolveAuthorize: (url: string) => void = () => undefined;
  const authorizeUrl = new Promise<string>(resolve => {
    resolveAuthorize = resolve;
  });

  const result = authorizeMastodon({
    instance: options.instance ?? INSTANCE,
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: options.timeoutMs ?? 5_000,
    fetch: options.fetch,
    confirmRegistration: async preview => {
      previews.push(preview);
      return options.confirm === undefined ? true : options.confirm(preview);
    },
    openBrowser: async url => {
      resolveAuthorize(url);

      if (options.openBrowser !== undefined) {
        await options.openBrowser(url);
      }
    },
    ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  // Tests attach their own assertions; this keeps an early rejection from
  // surfacing as an unhandled rejection before the test awaits it.
  void result.catch(() => undefined);

  return { authorizeUrl, result, previews };
}

async function expectFailure(promise: Promise<unknown>, code: string): Promise<MastodonOAuthError> {
  let caught: unknown;

  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(MastodonOAuthError);
  const error = caught as MastodonOAuthError;
  expect(error.code).toBe(code);
  return error;
}

// ---------------------------------------------------------------------------
// Callback helpers
// ---------------------------------------------------------------------------

interface RawResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function rawRequest(
  url: string,
  options: { method?: string; host?: string; path?: string } = {},
): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(target.port),
        path: options.path ?? `${target.pathname}${target.search}`,
        method: options.method ?? "GET",
        agent: false,
        headers: options.host === undefined ? {} : { host: options.host },
      },
      response => {
        const chunks: Buffer[] = [];

        response.on("data", chunk => chunks.push(Buffer.from(chunk as Buffer)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );

    request.on("error", reject);
    request.end();
  });
}

function callbackTarget(authorizeUrl: string, options: { state?: string | null; code?: string | null } = {}): URL {
  const authorize = new URL(authorizeUrl);
  const target = new URL(authorize.searchParams.get("redirect_uri")!);
  const state = options.state === undefined ? authorize.searchParams.get("state") : options.state;
  const code = options.code === undefined ? "auth-code-1" : options.code;

  if (state !== null) {
    target.searchParams.set("state", state);
  }

  if (code !== null) {
    target.searchParams.set("code", code);
  }

  return target;
}

function callbackPort(authorizeUrl: string): number {
  const authorize = new URL(authorizeUrl);
  return Number(new URL(authorize.searchParams.get("redirect_uri")!).port);
}

function portOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = netConnect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function portFromAppsCall(calls: readonly RecordedCall[]): number {
  const call = calls.find(entry => entry.path === "/api/v1/apps");
  const body = JSON.parse(call!.body) as { redirect_uris: string };
  return Number(new URL(body.redirect_uris).port);
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

const children: ChildProcess[] = [];

afterEach(async () => {
  vi.restoreAllMocks();

  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

function waitForPort(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("child did not report a port")), 30_000);

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", chunk => {
      buffer += chunk as string;
      const match = /PORT=(\d+)/.exec(buffer);

      if (match !== null) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("child exited before reporting a port"));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Metadata and origin validation
// ---------------------------------------------------------------------------

describe("instance origin and metadata", () => {
  it.each([
    "http://instance.test",
    "https://instance.test:8443",
    "https://127.0.0.1",
    "https://user@instance.test",
    "https://instance.test/path",
    "not a url",
  ])("refuses %s before any request", async instance => {
    const { fetch, calls } = createInstanceStub();
    const harness = startFlow({ fetch, instance });

    await expectFailure(harness.result, "invalid_instance");
    expect(calls).toHaveLength(0);
  });

  it.each([
    { label: "does not advertise S256", override: { code_challenge_methods_supported: ["plain"] } },
    { label: "advertises a mismatched issuer", override: { issuer: "https://other.test" } },
    {
      label: "advertises an authorization endpoint on another origin",
      override: { authorization_endpoint: "https://other.test/oauth/authorize" },
    },
    {
      label: "advertises a token endpoint on another origin",
      override: { token_endpoint: "https://other.test/oauth/token" },
    },
    {
      label: "advertises a non-HTTPS authorization endpoint",
      override: { authorization_endpoint: "http://instance.test/oauth/authorize" },
    },
    {
      label: "advertises a token endpoint with a fragment",
      override: { token_endpoint: "https://instance.test/oauth/token#frag" },
    },
    { label: "omits the authorization_code grant", override: { grant_types_supported: ["client_credentials"] } },
    { label: "omits the code response type", override: { response_types_supported: ["token"] } },
  ])("refuses metadata that $label", async ({ override }) => {
    const { fetch, calls } = createInstanceStub({
      metadata: () => json({ ...BASE_METADATA, ...override }),
    });
    const harness = startFlow({ fetch });

    await expectFailure(harness.result, "unsupported_instance");
    expect(calls.map(call => call.path)).toEqual(["/.well-known/oauth-authorization-server"]);
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("maps a transport failure to a static error", async () => {
    const fetchImpl = (async () => {
      throw new SafeInstanceTransportError("non_public_address");
    }) as unknown as typeof fetch;
    const harness = startFlow({ fetch: fetchImpl });

    const error = await expectFailure(harness.result, "unsupported_instance");
    expect(error.message).not.toContain("instance.test");
  });

  it.each([
    { label: "a missing configuration", body: {} },
    { label: "a missing statuses block", body: { configuration: {} } },
    {
      label: "a string max_characters",
      body: { configuration: { statuses: { max_characters: "500", characters_reserved_per_url: 23 } } },
    },
    {
      label: "a zero max_characters",
      body: { configuration: { statuses: { max_characters: 0, characters_reserved_per_url: 23 } } },
    },
    {
      label: "a fractional reserved length",
      body: { configuration: { statuses: { max_characters: 500, characters_reserved_per_url: 22.5 } } },
    },
    {
      label: "a missing reserved length",
      body: { configuration: { statuses: { max_characters: 500 } } },
    },
  ])("refuses an instance with $label before any app registration", async ({ body }) => {
    const { fetch, calls } = createInstanceStub({ instance: () => json(body) });
    const harness = startFlow({ fetch });

    await expectFailure(harness.result, "unsupported_instance");
    expect(calls.map(call => call.path)).toEqual([
      "/.well-known/oauth-authorization-server",
      "/api/v2/instance",
    ]);
    // The capability gate runs before the confirmation, so no app record can
    // have been created on an unsupported instance.
    expect(harness.previews).toHaveLength(0);
  });

  it("sanitizes an unexpected injected fetch throw", async () => {
    const fetchImpl = (async () => {
      throw new Error(`boom ${CANARY}`);
    }) as unknown as typeof fetch;
    const harness = startFlow({ fetch: fetchImpl });

    const error = await expectFailure(harness.result, "protocol_error");
    const serialized = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;
    expect(serialized).not.toContain(CANARY);
  });
});

// ---------------------------------------------------------------------------
// Confirmation and happy path
// ---------------------------------------------------------------------------

describe("confirmation and registration", () => {
  it("previews the exact instance and scopes and does not register when denied", async () => {
    const { fetch, calls } = createInstanceStub();
    const harness = startFlow({ fetch, confirm: async () => false });

    await expectFailure(harness.result, "denied");
    expect(harness.previews).toEqual([{ instance: INSTANCE, scopes: SCOPES }]);
    expect(calls.map(call => call.path)).toEqual([
      "/.well-known/oauth-authorization-server",
      "/api/v2/instance",
    ]);
  });

  it("does not leave an unhandled rejection when confirmation aborts and rejects", async () => {
    const controller = new AbortController();
    const { fetch, calls } = createInstanceStub();
    const harness = startFlow({
      fetch,
      signal: controller.signal,
      confirm: async () => {
        controller.abort();
        throw new Error(`confirmation failed ${CANARY}`);
      },
    });

    const error = await expectFailure(harness.result, "aborted");
    const serialized = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;

    expect(serialized).not.toContain(CANARY);
    expect(calls.some(call => call.path === "/api/v1/apps")).toBe(false);
  });

  it("completes the loopback flow with one registration and one exchange", async () => {
    const { fetch, calls } = createInstanceStub();
    const harness = startFlow({ fetch });
    const authorizeUrl = await harness.authorizeUrl;
    const authorize = new URL(authorizeUrl);
    const redirectUri = authorize.searchParams.get("redirect_uri")!;
    const state = authorize.searchParams.get("state")!;
    const challenge = authorize.searchParams.get("code_challenge")!;

    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("scope")).toBe("read:accounts write:statuses");
    expect(authorize.searchParams.get("client_id")).toBe("client-id-1");
    expect(new URL(redirectUri).hostname).toBe("127.0.0.1");
    expect(state.length).toBeGreaterThanOrEqual(43);

    const response = await rawRequest(callbackTarget(authorizeUrl).href);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).not.toContain(state);
    expect(response.body).not.toContain("auth-code-1");
    expect(response.body).not.toContain("client-secret-1");
    expect(response.body).not.toContain("127.0.0.1");
    expect(response.body).not.toContain("<script");

    const result = await harness.result;

    expect(result.credentials).toEqual({
      provider: "mastodon",
      instance: INSTANCE,
      accessToken: "user-token-1",
    });
    expect(result.scopes).toEqual(SCOPES);
    expect(harness.previews).toEqual([{ instance: INSTANCE, scopes: SCOPES }]);
    expect(calls.map(call => call.path)).toEqual([
      "/.well-known/oauth-authorization-server",
      "/api/v2/instance",
      "/api/v1/apps",
      "/oauth/token",
    ]);

    const instanceCall = calls.find(call => call.path === "/api/v2/instance")!;

    // Public instance metadata: the user token is not sent before registration.
    expect(instanceCall.headers.authorization).toBeUndefined();

    const appsCall = calls.find(call => call.path === "/api/v1/apps")!;
    const appsBody = JSON.parse(appsCall.body) as { redirect_uris: string; scopes: string; client_name: string };

    expect(appsBody.redirect_uris).toBe(redirectUri);
    expect(appsBody.scopes).toBe("read:accounts write:statuses");
    expect(appsBody.client_name).toBe("Syndroo CLI (local)");

    const tokenCall = calls.find(call => call.path === "/oauth/token")!;
    const tokenBody = new URLSearchParams(tokenCall.body);
    const verifier = tokenBody.get("code_verifier")!;

    expect(tokenCall.headers["content-type"]).toContain("application/x-www-form-urlencoded");
    expect(tokenBody.get("grant_type")).toBe("authorization_code");
    expect(tokenBody.get("code")).toBe("auth-code-1");
    expect(tokenBody.get("client_id")).toBe("client-id-1");
    expect(tokenBody.get("client_secret")).toBe("client-secret-1");
    expect(tokenBody.get("redirect_uri")).toBe(redirectUri);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(createHash("sha256").update(verifier, "ascii").digest("base64url")).toBe(challenge);
    expect(await portOpen(callbackPort(authorizeUrl))).toBe(false);
  });

  it("fails registration when client credentials are missing", async () => {
    const { fetch, calls } = createInstanceStub({ apps: () => json({ redirect_uri: "x" }) });
    const harness = startFlow({ fetch });

    await expectFailure(harness.result, "registration_failed");
    expect(await portOpen(portFromAppsCall(calls))).toBe(false);
    expect(calls.some(call => call.path === "/oauth/token")).toBe(false);
  });

  it("fails registration when the returned redirect URI differs", async () => {
    const { fetch, calls } = createInstanceStub({
      apps: () => json({ client_id: "c", client_secret: "s", redirect_uri: "http://127.0.0.1:1/other" }),
    });
    const harness = startFlow({ fetch });

    await expectFailure(harness.result, "registration_failed");
    expect(await portOpen(portFromAppsCall(calls))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Callback strictness
// ---------------------------------------------------------------------------

describe("callback strictness", () => {
  it.each([
    { label: "a wrong path", override: { path: "/not-the-callback" }, status: 400 },
    { label: "a wrong Host header", override: { host: "evil.test" }, status: 400 },
    { label: "a non-GET method", override: { method: "POST" }, status: 405 },
    { label: "an absolute-form target", override: { path: "http://evil.test/steal" }, status: 400 },
    { label: "a scheme-relative target", override: { path: "//evil.test/steal" }, status: 400 },
    { label: "a backslash target", override: { path: "/\\evil.test/steal" }, status: 400 },
  ])("rejects $label and keeps waiting", async ({ override, status }) => {
    const { fetch, calls } = createInstanceStub();
    const harness = startFlow({ fetch });
    const authorizeUrl = await harness.authorizeUrl;
    const target = callbackTarget(authorizeUrl);

    const bad = await rawRequest(target.href, override);

    expect(bad.status).toBe(status);
    expect(bad.body).not.toContain("auth-code-1");
    expect(calls.some(call => call.path === "/oauth/token")).toBe(false);

    const good = await rawRequest(target.href);

    expect(good.status).toBe(200);
    expect((await harness.result).credentials.accessToken).toBe("user-token-1");
  });

  it("rejects a wrong state without exchanging or cancelling", async () => {
    const { fetch, calls } = createInstanceStub();
    const harness = startFlow({ fetch });
    const authorizeUrl = await harness.authorizeUrl;

    const bad = await rawRequest(callbackTarget(authorizeUrl, { state: "wrong-state" }).href);

    expect(bad.status).toBe(400);
    expect(calls.some(call => call.path === "/oauth/token")).toBe(false);

    const good = await rawRequest(callbackTarget(authorizeUrl).href);

    expect(good.status).toBe(200);
    expect((await harness.result).credentials.accessToken).toBe("user-token-1");
  });

  it("rejects a duplicate code parameter without exchanging", async () => {
    const { fetch, calls } = createInstanceStub();
    const harness = startFlow({ fetch });
    const authorizeUrl = await harness.authorizeUrl;
    const target = callbackTarget(authorizeUrl);

    const bad = await rawRequest(`${target.href}&code=second-code`);

    expect(bad.status).toBe(400);
    expect(calls.some(call => call.path === "/oauth/token")).toBe(false);

    const good = await rawRequest(target.href);

    expect(good.status).toBe(200);
    expect((await harness.result).credentials.accessToken).toBe("user-token-1");
  });

  it("rejects a duplicate state parameter without exchanging", async () => {
    const { fetch, calls } = createInstanceStub();
    const harness = startFlow({ fetch });
    const authorizeUrl = await harness.authorizeUrl;
    const target = callbackTarget(authorizeUrl);

    const bad = await rawRequest(`${target.href}&state=second-state`);

    expect(bad.status).toBe(400);
    expect(calls.some(call => call.path === "/oauth/token")).toBe(false);
  });

  it("treats an OAuth error with a mismatched state as a protocol error, not a denial", async () => {
    const { fetch, calls } = createInstanceStub();
    const harness = startFlow({ fetch });
    const authorizeUrl = await harness.authorizeUrl;
    const target = callbackTarget(authorizeUrl, { state: "wrong-state", code: null });
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("error_description", CANARY);

    const bad = await rawRequest(target.href);

    expect(bad.status).toBe(400);
    expect(bad.body).not.toContain(CANARY);
    expect(calls.some(call => call.path === "/oauth/token")).toBe(false);

    const good = await rawRequest(callbackTarget(authorizeUrl).href);

    expect(good.status).toBe(200);
    expect((await harness.result).credentials.accessToken).toBe("user-token-1");
  });

  it("reports denial for a matching OAuth error without echoing the description", async () => {
    const { fetch, calls } = createInstanceStub();
    const harness = startFlow({ fetch });
    const authorizeUrl = await harness.authorizeUrl;
    const target = callbackTarget(authorizeUrl, { code: null });
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("error_description", CANARY);

    const response = await rawRequest(target.href);

    expect(response.status).toBe(200);
    expect(response.body).not.toContain(CANARY);
    await expectFailure(harness.result, "denied");
    expect(calls.some(call => call.path === "/oauth/token")).toBe(false);
  });

  it("rejects a callback that carries both code and error without consuming", async () => {
    const { fetch, calls } = createInstanceStub();
    const harness = startFlow({ fetch });
    const authorizeUrl = await harness.authorizeUrl;
    const target = callbackTarget(authorizeUrl);

    target.searchParams.set("error", "access_denied");

    const bad = await rawRequest(target.href);

    expect(bad.status).toBe(400);
    expect(calls.some(call => call.path === "/oauth/token")).toBe(false);

    const good = await rawRequest(callbackTarget(authorizeUrl).href);

    expect(good.status).toBe(200);
    expect((await harness.result).credentials.accessToken).toBe("user-token-1");
  });

  it("rejects hostile raw callback targets and keeps waiting", async () => {
    const { fetch, calls } = createInstanceStub();
    const harness = startFlow({ fetch });
    const authorizeUrl = await harness.authorizeUrl;
    const target = callbackTarget(authorizeUrl);
    const parsed = new URL(target.href);
    const callbackPath = parsed.pathname;
    const search = parsed.search;

    const hostile = [
      `/x/..${callbackPath}${search}`,
      `${callbackPath}#fragment${search}`,
      `${callbackPath.replace("/", "/\\")}${search}`,
      `//evil.test${callbackPath}${search}`,
      `http://evil.test${callbackPath}${search}`,
    ];

    for (const path of hostile) {
      const response = await rawRequest(target.href, { path });
      expect(response.status).toBe(400);
    }

    expect(calls.some(call => call.path === "/oauth/token")).toBe(false);

    const good = await rawRequest(target.href);

    expect(good.status).toBe(200);
    expect((await harness.result).credentials.accessToken).toBe("user-token-1");
  });

  it("refuses a replayed callback and never exchanges twice", async () => {
    const { fetch, calls } = createInstanceStub();
    const harness = startFlow({ fetch });
    const authorizeUrl = await harness.authorizeUrl;
    const target = callbackTarget(authorizeUrl);

    const first = await rawRequest(target.href);

    expect(first.status).toBe(200);
    expect((await harness.result).credentials.accessToken).toBe("user-token-1");
    expect(calls.filter(call => call.path === "/oauth/token")).toHaveLength(1);

    await expect(rawRequest(target.href)).rejects.toThrow();
    expect(calls.filter(call => call.path === "/oauth/token")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

describe("token exchange", () => {
  it.each([
    { label: "a non-Bearer token type", document: { access_token: "t", token_type: "mac", scope: "read:accounts write:statuses" } },
    { label: "an empty access token", document: { access_token: "", token_type: "Bearer", scope: "read:accounts write:statuses" } },
    { label: "a token missing the write scope", document: { access_token: "t", token_type: "Bearer", scope: "read:accounts" } },
    { label: "a response without a token type", document: { access_token: "t", scope: "read:accounts write:statuses" } },
  ])("fails on $label", async ({ document }) => {
    const { fetch, calls } = createInstanceStub({ token: () => json(document) });
    const harness = startFlow({ fetch });
    const authorizeUrl = await harness.authorizeUrl;

    await rawRequest(callbackTarget(authorizeUrl).href);
    await expectFailure(harness.result, "token_exchange_failed");
    expect(calls.filter(call => call.path === "/oauth/token")).toHaveLength(1);
    expect(await portOpen(callbackPort(authorizeUrl))).toBe(false);
  });

  it("fails when the token endpoint rejects the exchange", async () => {
    const { fetch, calls } = createInstanceStub({ token: () => new Response("denied", { status: 400 }) });
    const harness = startFlow({ fetch });
    const authorizeUrl = await harness.authorizeUrl;

    await rawRequest(callbackTarget(authorizeUrl).href);
    await expectFailure(harness.result, "token_exchange_failed");
    expect(calls.filter(call => call.path === "/oauth/token")).toHaveLength(1);
  });

  it("accepts a token response without an explicit scope", async () => {
    const { fetch } = createInstanceStub({ token: () => json({ access_token: "user-token-1", token_type: "Bearer" }) });
    const harness = startFlow({ fetch });
    const authorizeUrl = await harness.authorizeUrl;

    await rawRequest(callbackTarget(authorizeUrl).href);
    const result = await harness.result;

    expect(result.credentials.accessToken).toBe("user-token-1");
    expect(result.scopes).toEqual(SCOPES);
  });
});

// ---------------------------------------------------------------------------
// Deadline, abort, browser failure, and output hygiene
// ---------------------------------------------------------------------------

describe("lifecycle", () => {
  it("expires the flow on the injected short timeout and closes the listener", async () => {
    const { fetch } = createInstanceStub();
    const harness = startFlow({ fetch, timeoutMs: 120 });
    const authorizeUrl = await harness.authorizeUrl;
    const started = Date.now();

    await expectFailure(harness.result, "timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await portOpen(callbackPort(authorizeUrl))).toBe(false);
  });

  it("expires a callback explicitly against the deadline, not the timer order", async () => {
    const { fetch, calls } = createInstanceStub();
    const start = 1_000_000;
    let clock = start;
    const harness = startFlow({ fetch, timeoutMs: 300_000, now: () => clock });
    const authorizeUrl = await harness.authorizeUrl;

    // Move past the deadline without letting the real timer fire.
    clock = start + 300_001;

    const response = await rawRequest(callbackTarget(authorizeUrl).href);

    expect(response.status).toBe(410);
    await expectFailure(harness.result, "timeout");
    expect(calls.some(call => call.path === "/oauth/token")).toBe(false);
    expect(await portOpen(callbackPort(authorizeUrl))).toBe(false);
  });

  it("closes a listener that finishes binding after the flow aborts", async () => {
    const controller = new AbortController();
    const ports: number[] = [];
    const originalListen = NetServer.prototype.listen;

    NetServer.prototype.listen = function (this: NetServer, ...args: unknown[]): NetServer {
      // Defer the real bind so the flow is aborted while initialization is
      // still pending, then let the bind complete afterwards.
      process.nextTick(() => {
        (originalListen as (...inner: unknown[]) => NetServer).apply(this, args);
      });
      this.prependOnceListener("listening", () => {
        const value = this.address();

        if (value !== null && typeof value === "object") {
          ports.push(value.port);
        }
      });
      controller.abort();
      return this;
    } as unknown as typeof NetServer.prototype.listen;

    try {
      const { fetch } = createInstanceStub();
      const harness = startFlow({ fetch, signal: controller.signal });

      await expectFailure(harness.result, "aborted");

      for (let attempt = 0; attempt < 200 && ports.length === 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      expect(ports.length).toBeGreaterThan(0);

      for (const port of ports) {
        let open = true;

        for (let attempt = 0; attempt < 100 && open; attempt += 1) {
          open = await portOpen(port);

          if (open) {
            await new Promise(resolve => setTimeout(resolve, 5));
          }
        }

        expect(open).toBe(false);
      }
    } finally {
      NetServer.prototype.listen = originalListen;
    }
  });

  it("aborts on the caller signal and closes the listener", async () => {
    const { fetch } = createInstanceStub();
    const controller = new AbortController();
    const harness = startFlow({ fetch, signal: controller.signal });
    const authorizeUrl = await harness.authorizeUrl;

    controller.abort();
    await expectFailure(harness.result, "aborted");
    expect(await portOpen(callbackPort(authorizeUrl))).toBe(false);
  });

  it("rejects a pre-aborted signal before any request", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, calls } = createInstanceStub();
    const harness = startFlow({ fetch, signal: controller.signal });

    await expectFailure(harness.result, "aborted");
    expect(calls).toHaveLength(0);
  });

  it("sanitizes a browser failure and closes the listener", async () => {
    const { fetch, calls } = createInstanceStub();
    const harness = startFlow({
      fetch,
      openBrowser: async () => {
        throw new Error(`cannot open ${CANARY}`);
      },
    });
    const authorizeUrl = await harness.authorizeUrl;

    const error = await expectFailure(harness.result, "browser_unavailable");
    const serialized = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;

    expect(serialized).not.toContain(CANARY);
    expect(await portOpen(callbackPort(authorizeUrl))).toBe(false);
    expect(calls.some(call => call.path === "/oauth/token")).toBe(false);
  });

  it("kills the default browser helper when the flow aborts", async () => {
    const spawned: ChildProcess[] = [];
    const kills: string[] = [];

    vi.doMock("node:child_process", async importOriginal => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      const spawnMock = (): ChildProcess => {
        const child = new EventEmitter() as unknown as ChildProcess;

        (child as unknown as { kill: (signal?: NodeJS.Signals) => boolean }).kill = signal => {
          kills.push(signal ?? "SIGTERM");
          child.emit("exit", null, signal ?? "SIGTERM");
          return true;
        };

        spawned.push(child);
        return child;
      };

      return { ...actual, spawn: spawnMock as unknown as typeof actual.spawn };
    });

    vi.resetModules();

    try {
      const engine = await import("../../src/local/mastodon-oauth.js");
      const controller = new AbortController();
      const { fetch } = createInstanceStub();
      const result = engine.authorizeMastodon({
        instance: INSTANCE,
        signal: controller.signal,
        timeoutMs: 5_000,
        fetch,
        confirmRegistration: async () => true,
      });

      void result.catch(() => undefined);

      for (let attempt = 0; attempt < 200 && spawned.length === 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      expect(spawned).toHaveLength(1);

      controller.abort();

      const caught = await result.then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(caught).toBeInstanceOf(engine.MastodonOAuthError);
      expect((caught as { readonly code?: string }).code).toBe("aborted");
      expect(kills).toContain("SIGTERM");
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("never prints state, code, verifier, token, or client secret", async () => {
    const { fetch } = createInstanceStub({
      apps: call =>
        json({
          client_id: "client-id-1",
          client_secret: CANARY,
          redirect_uri: (JSON.parse(call.body) as { redirect_uris: string }).redirect_uris,
        }),
      token: () => json({ access_token: CANARY, token_type: "Bearer", scope: "read:accounts write:statuses" }),
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const harness = startFlow({ fetch });
      const authorizeUrl = await harness.authorizeUrl;
      const state = new URL(authorizeUrl).searchParams.get("state")!;
      const response = await rawRequest(callbackTarget(authorizeUrl).href);
      const result = await harness.result;

      expect(result.credentials.accessToken).toBe(CANARY);
      expect(response.body).not.toContain(CANARY);
      expect(response.body).not.toContain(state);
      expect(response.body).not.toContain("auth-code-1");
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Real subprocess signal
// ---------------------------------------------------------------------------

describe("engine independence", () => {
  it("does not import state, store, lock, credential, or file modules", () => {
    const source = readFileSync(ENGINE_ENTRY, "utf8");

    expect(source).not.toMatch(/from "\.\/(state|credentials|composition|ports|config)/);
    expect(source).not.toMatch(/node:fs/);
    expect(source).not.toMatch(/withLocalWriteLock|writeFileSync|appendFileSync|mkdirSync/);
  });
});

describe("process signal", () => {
  it("closes the listener when a real child process receives SIGINT", async () => {
    const child = spawn(process.execPath, [SIGNAL_CHILD_ENTRY], {
      cwd: PACKAGE_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    children.push(child);

    const exitPromise = waitForExit(child);
    const port = await waitForPort(child);

    expect(port).toBeGreaterThan(0);
    expect(await portOpen(port)).toBe(true);

    child.kill("SIGINT");

    const exit = await exitPromise;

    expect(exit.code).toBe(130);
    expect(await portOpen(port)).toBe(false);
  });
});
