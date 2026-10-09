import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer as createTcpServer } from "node:net";

import type * as T from "@syndroo/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseEnvelope,
  runCli,
  sandbox,
  type RunResult,
  type Sandbox,
} from "./support/harness.js";

/**
 * The local OAuth loop, end to end, in a real process boundary.
 *
 * The provider is a purpose-built fake that returns `open_url`, and the
 * authorization server is a real HTTP server whose `302` is the redirect a
 * browser would follow into the listener this CLI binds. Only two seams are
 * injected, both test-only: the provider registry and the (never-used)
 * transport. Everything else — the parser, the filesystem state, Core's step
 * protocol — is the shipped code.
 */

const ACCOUNT: T.AccountIdentity = {
  provider: "oauthfake",
  accountId: "acct_oauthfake",
  origin: "https://oauth.example",
};
const VERSION = "1.0.0";
const CODE = "OAUTH_LOOP_TEST_CODE";
const IMPLEMENTATION: T.Implementation = {
  provider: "oauthfake",
  packageName: "@syndroo/provider-oauthfake",
  version: VERSION,
  apiVersion: 1,
  artifactFingerprint: "c".repeat(64),
  schemaFingerprint: "d".repeat(64),
};

const boxes: Sandbox[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(boxes.splice(0).map((box) => box.cleanup()));
});

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));

  return (server.address() as AddressInfo).port;
}

/** A port nothing holds yet, so the CLI's default loopback redirect is usable. */
async function freePort(): Promise<number> {
  const probe = createTcpServer();

  // A restricted sandbox refuses `listen` with EPERM; surface that instead of
  // hanging, so a blocked run says exactly which assertion could not execute.
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });

  const { port } = probe.address() as AddressInfo;

  await new Promise<void>((resolve) => probe.close(() => resolve()));

  return port;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();

    if (value !== undefined) {
      return value;
    }

    await delay(25);
  }

  throw new Error(`timed out waiting for ${what}`);
}

/** A fake provider whose connect is an OAuth redirect, and nothing else. */
function oauthProvider(onAuthorize: (url: string) => void): T.ProviderPlugin {
  return {
    manifest: {
      id: "oauthfake",
      name: "OAuth Fake",
      version: VERSION,
      apiVersion: 1,
      declaredCapabilities: ["text"],
      egress: { fixedOrigins: ["https://oauth.example"] },
      schemas: {
        connectOptions: {
          type: "object",
          additionalProperties: false,
          required: ["redirectUri"],
          properties: { redirectUri: { type: "string", minLength: 1 } },
        },
        credentialInput: {
          type: "object",
          additionalProperties: false,
          required: ["canary"],
          properties: { canary: { type: "string", minLength: 1 } },
        },
        content: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
        publishOptions: { type: "object", additionalProperties: false },
      },
    },
    connect: {
      async run(input: T.ProviderConnectInput, context: T.ProviderContext): Promise<T.ProviderConnectResult> {
        if (input.type === "start") {
          const state = context.oauth?.state;
          const redirectUri = context.oauth?.redirectUri;

          if (state === undefined || redirectUri === undefined) {
            throw new Error("the connect step was not armed with OAuth material");
          }

          const url =
            `https://authorize.test/oauth/authorize?client_id=oauthfake&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(context.oauth?.codeChallenge ?? "")}`;

          onAuthorize(url);

          return {
            status: "action_required",
            action: { type: "open_url", url },
            privateState: { state, redirectUri },
          };
        }

        if (input.input.type !== "callback") {
          throw new Error("this provider only completes a callback exchange");
        }

        const expected = input.privateState as { state?: unknown; redirectUri?: unknown };

        if (input.input.evidence.state !== expected.state || input.input.evidence.redirectUri !== expected.redirectUri) {
          throw new Error("callback evidence does not match the pending authorization");
        }

        return {
          status: "done",
          credentials: { accessToken: "oauth-fixture-token" },
          identity: {
            account: ACCOUNT,
            evidence: [
              { capability: "identity", value: "supported", source: "oauth.example", verifiedAt: context.now },
            ],
          },
        };
      },
      async verify(_credentials: T.JsonObject, context: T.ProviderContext): Promise<T.VerifiedIdentity> {
        return {
          account: ACCOUNT,
          evidence: [
            { capability: "identity", value: "supported", source: "oauth.example", verifiedAt: context.now },
          ],
        };
      },
    },
    freeze(input: T.FreezeInput): T.FrozenProviderPayload {
      return {
        payloadVersion: 1,
        payload: {},
        effectiveContent: { text: input.content.text ?? "" },
        effectiveOptions: {},
        preview: { content: { text: input.content.text ?? "" }, fields: [] },
      };
    },
    async publish(): Promise<T.ProviderWriteOutcome> {
      return { status: "succeeded" };
    },
  };
}

function registry(plugin: T.ProviderPlugin): T.ProviderRegistry {
  const view: T.ProviderView = {
    provider: "oauthfake",
    availability: "available",
    provenance: "third_party",
    implementation: IMPLEMENTATION,
    manifest: plugin.manifest,
  };

  return {
    async describe(provider) {
      return provider === "oauthfake"
        ? structuredClone(view)
        : { provider, availability: "unavailable", provenance: "third_party" };
    },
    async list() {
      const { manifest: _manifest, ...rest } = view;

      return [rest];
    },
    async load(provider) {
      if (provider !== "oauthfake") {
        throw new Error("PROVIDER_UNAVAILABLE");
      }

      return {
        plugin,
        implementation: IMPLEMENTATION,
        validators: {
          connectOptions: (value) => typeof (value as Record<string, unknown>)["redirectUri"] === "string",
          credentialInput: (value) => typeof (value as Record<string, unknown>)["canary"] === "string",
          content: () => true,
          publishOptions: () => true,
        },
      };
    },
  };
}

const transport: T.ProviderTransport = {
  async request() {
    return { type: "transport_error", stage: "before_request", code: "TEST_TRANSPORT" };
  },
};

type Arrangement = {
  readonly box: Sandbox;
  readonly credential: string;
  readonly authorizeUrls: string[];
  readonly callbackPort: number;
  readonly run: (argv: readonly string[], stdin?: string, tty?: boolean) => Promise<RunResult>;
};

async function arrange(): Promise<Arrangement> {
  const box = await sandbox("syndroo-cli-oauth-");

  boxes.push(box);

  const authorizeUrls: string[] = [];
  const callbackPort = await freePort();
  const overrides = {
    providers: registry(oauthProvider((url) => authorizeUrls.push(url))),
    transport,
    oauth: { providers: ["oauthfake"], loopbackPort: callbackPort },
  };
  const credential = `${box.root}/credential.json`;

  await fs.writeFile(credential, JSON.stringify({ canary: "fixture" }));

  return {
    box,
    credential,
    authorizeUrls,
    callbackPort,
    run: (argv, stdin, tty) =>
      runCli(argv, {
        env: box.env,
        cwd: box.root,
        overrides,
        ...(stdin === undefined ? {} : { stdin }),
        ...(tty === true ? { tty: { hasTty: true } } : {}),
      }),
  };
}

/** The authorization server: one request in, one `302` back to the listener. */
async function authorizationServer(): Promise<{ port: number; server: Server }> {
  const server = createServer((request, response) => {
    const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
    const target = new URL(query.get("redirect_uri") ?? "http://127.0.0.1/");

    target.searchParams.set("code", CODE);
    target.searchParams.set("state", query.get("state") ?? "");

    response.writeHead(302, { location: target.toString() });
    response.end();
  });

  return { port: await listen(server), server };
}

/**
 * Replay the authorization request against the local authorization server.
 *
 * The provider's URL names `https://authorize.test` because Core requires an
 * HTTPS authorization URL; the CLI never fetches it. The test re-issues the same
 * query to the local server, whose `302` is a real redirect into the listener.
 */
async function deliverRedirect(port: number, authorizeUrl: string): Promise<void> {
  const query = new URL(authorizeUrl).searchParams;
  const request = `http://127.0.0.1:${port}/oauth/authorize?${query.toString()}`;

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(request, { redirect: "follow" }).catch(() => undefined);

    if (response?.status === 200) {
      return;
    }

    if (response !== undefined) {
      throw new Error(`the callback was refused with ${response.status}`);
    }

    await delay(25);
  }

  throw new Error("no redirect reached the loopback listener");
}

describe("local OAuth callback loop", () => {
  it("completes a connect from a real redirect into the bound listener", async () => {
    const arrangement = await arrange();
    const { port } = await authorizationServer();
    const pending = arrangement.run(
      ["connect", "oauthfake", "--credential-file", arrangement.credential],
      undefined,
      true,
    );
    const authorizeUrl = await waitFor(() => arrangement.authorizeUrls[0], "the authorization URL");

    expect(authorizeUrl).toContain(
      `redirect_uri=${encodeURIComponent(`http://127.0.0.1:${arrangement.callbackPort}/oauth/callback/oauthfake`)}`,
    );

    await deliverRedirect(port, authorizeUrl);

    const result = await pending;

    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("Connection ready");
    expect(`${result.stdout}${result.stderr}`).not.toContain(CODE);
    expect(`${result.stdout}${result.stderr}`).not.toContain("oauth-fixture-token");

    // The connection is observed where a caller observes it: the status read.
    const status = await arrangement.run(["status", "--connections", "--json"]);
    const envelope = parseEnvelope(status);

    expect(status.exit).toBe(0);
    expect(envelope["result"].connections).toHaveLength(1);
    expect(envelope["result"].connections[0].account).toEqual(ACCOUNT);
    expect(JSON.stringify(envelope)).not.toContain("oauth-fixture-token");
  });

  it("treats a lone callback_complete as a status check that commits nothing", async () => {
    const arrangement = await arrange();
    const started = await arrangement.run([
      "connect",
      "oauthfake",
      "--credential-file",
      arrangement.credential,
      "--json",
    ]);
    const pending = parseEnvelope(started);

    expect(started.exit).toBe(0);
    expect(pending["result"].status).toBe("action_required");
    expect(pending["result"].action.type).toBe("open_url");
    expect(arrangement.authorizeUrls).toHaveLength(1);

    const statusCheck = await arrangement.run(
      ["connect", "--input", "-", "--json"],
      JSON.stringify({
        type: "resume",
        connectSessionId: pending["result"].connectSessionId,
        stepRevision: pending["result"].stepRevision,
        input: { type: "callback_complete" },
      }),
    );
    const stillPending = parseEnvelope(statusCheck);

    expect(statusCheck.exit).toBe(0);
    expect(stillPending["result"].status).toBe("action_required");
    expect(stillPending["result"].action.type).toBe("open_url");

    const connections = await arrangement.run(["status", "--connections", "--json"]);

    expect(parseEnvelope(connections)["result"].connections).toHaveLength(0);
  });

  it("refuses a callback state the adapter never issued and never commits", async () => {
    const arrangement = await arrange();
    const started = await arrangement.run([
      "connect",
      "oauthfake",
      "--credential-file",
      arrangement.credential,
      "--json",
    ]);

    expect(parseEnvelope(started)["result"].status).toBe("action_required");

    const forged = await arrangement.run(
      ["connect", "oauthfake", "--callback-url", "-", "--json"],
      `http://127.0.0.1:${arrangement.callbackPort}/oauth/callback/oauthfake` +
        `?code=${CODE}&state=forged-state-0123456789\n`,
    );
    const envelope = parseEnvelope(forged);

    expect(forged.exit).toBe(2);
    expect(envelope["ok"]).toBe(false);
    expect(envelope["error"].code).toBe("OAUTH_CALLBACK_REJECTED");
    expect(forged.stdout).not.toContain(CODE);

    const connections = await arrangement.run(["status", "--connections", "--json"]);

    expect(parseEnvelope(connections)["result"].connections).toHaveLength(0);
  });

  it("completes the paste path from the URL the browser landed on", async () => {
    const arrangement = await arrange();
    const pending = arrangement.run(
      ["connect", "oauthfake", "--credential-file", arrangement.credential, "--json"],
    );
    const authorizeUrl = await waitFor(() => arrangement.authorizeUrls[0], "the authorization URL");
    const query = new URL(authorizeUrl).searchParams;
    const pasted =
      `http://127.0.0.1:${arrangement.callbackPort}/oauth/callback/oauthfake` +
      `?code=${CODE}&state=${encodeURIComponent(query.get("state") as string)}`;

    // The redirect URI is loopback but nobody is at a terminal, so the CLI
    // reports the pending action instead of binding a listener...
    const reported = await pending;

    expect(parseEnvelope(reported)["result"].status).toBe("action_required");

    // ...and the URL the browser landed on completes the session afterwards.
    const completed = await arrangement.run(
      ["connect", "oauthfake", "--callback-url", "-", "--json"],
      `${pasted}\n`,
    );
    const envelope = parseEnvelope(completed);

    expect(completed.exit).toBe(0);
    expect(envelope["result"].status).toBe("done");
    expect(envelope["result"].connection.account).toEqual(ACCOUNT);
    expect(JSON.stringify(envelope)).not.toContain(CODE);
  });

  it("refuses another session's callback and keeps that session completable", async () => {
    const arrangement = await arrange();
    const first = await arrangement.run([
      "connect",
      "oauthfake",
      "--credential-file",
      arrangement.credential,
      "--json",
    ]);
    const firstEnvelope = parseEnvelope(first);
    const firstState = new URL(arrangement.authorizeUrls[0] as string).searchParams.get("state");
    const firstCallback =
      `http://127.0.0.1:${arrangement.callbackPort}/oauth/callback/oauthfake` +
      `?code=${CODE}&state=${encodeURIComponent(firstState as string)}`;

    expect(firstEnvelope["result"].status).toBe("action_required");

    // A second start, handed the first session's redirect, must refuse it.
    const second = await arrangement.run(
      ["connect", "oauthfake", "--credential-file", arrangement.credential, "--json"],
      `${firstCallback}\n`,
    );

    expect(second.exit).toBe(2);
    expect(parseEnvelope(second)["error"].code).toBe("OAUTH_CALLBACK_REJECTED");

    const none = await arrangement.run(["status", "--connections", "--json"]);

    expect(parseEnvelope(none)["result"].connections).toHaveLength(0);

    // The refusal consumed nothing: the owning session still completes.
    const owner = await arrangement.run(
      ["connect", "oauthfake", "--callback-url", "-", "--json"],
      `${firstCallback}\n`,
    );

    expect(owner.exit).toBe(0);
    expect(parseEnvelope(owner)["result"].status).toBe("done");

    const one = await arrangement.run(["status", "--connections", "--json"]);

    expect(parseEnvelope(one)["result"].connections).toHaveLength(1);
  });

  it("refuses a delivered callback on argv, leaks nothing, and still completes on stdin", async () => {
    const arrangement = await arrange();
    const pending = arrangement.run(
      ["connect", "oauthfake", "--credential-file", arrangement.credential, "--json"],
    );
    const authorizeUrl = await waitFor(() => arrangement.authorizeUrls[0], "the authorization URL");
    const state = new URL(authorizeUrl).searchParams.get("state") as string;
    const delivered =
      `http://127.0.0.1:${arrangement.callbackPort}/oauth/callback/oauthfake` +
      `?code=${CODE}&state=${encodeURIComponent(state)}`;

    expect(parseEnvelope(await pending)["result"].status).toBe("action_required");

    // The design forbids a secret on the argument vector (§11.1), so a value
    // that carries one is refused rather than used.
    const onArgv = await arrangement.run([
      "connect",
      "oauthfake",
      "--callback-url",
      delivered,
      "--json",
    ]);
    const envelope = parseEnvelope(onArgv);

    expect(onArgv.exit).toBe(2);
    expect(envelope["ok"]).toBe(false);
    expect(envelope["error"].code).toBe("CALLBACK_URL_INVALID");
    expect(`${onArgv.stdout}${onArgv.stderr}`).not.toContain(CODE);

    // The fragment is the other place a provider can hand back the same code.
    const inFragment = await arrangement.run([
      "connect",
      "oauthfake",
      "--callback-url",
      `${delivered.split("?")[0] as string}#code=${CODE}&state=${encodeURIComponent(state)}`,
      "--json",
    ]);

    expect(inFragment.exit).toBe(2);
    expect(parseEnvelope(inFragment)["error"].code).toBe("CALLBACK_URL_INVALID");

    const unchanged = await arrangement.run(["status", "--connections", "--json"]);

    expect(parseEnvelope(unchanged)["result"].connections).toHaveLength(0);

    // Neither refusal consumed the session: the same delivery completes on stdin.
    const onStdin = await arrangement.run(
      ["connect", "oauthfake", "--callback-url", "-", "--json"],
      `${delivered}\n`,
    );

    expect(onStdin.exit).toBe(0);
    expect(parseEnvelope(onStdin)["result"].status).toBe("done");
    expect(`${onStdin.stdout}${onStdin.stderr}`).not.toContain(CODE);
  });
});
