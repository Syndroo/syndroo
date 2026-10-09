import type { ProviderHttpResult, ProviderTransport } from "@syndroo/provider-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { parseEnvelope, runCli, sandbox, type RunResult, type Sandbox } from "./support/harness.js";

/**
 * The local OAuth callback adapter driving the **real** LinkedIn provider.
 *
 * `oauth-loop.test.ts` uses a purpose-built fake provider to isolate the
 * callback plumbing. This file closes the other half of the question: does the
 * shipped `@syndroo/provider-linkedin` package reach `done` through the same
 * adapter, with the real trust loader, the real schemas, the real state store
 * and Core's step protocol?
 *
 * Only the transport is injected, and only because a sandbox has no route to
 * LinkedIn: the callback step exchanges the authorization code over a real
 * HTTPS `POST`, so an offline transport turns that exchange into
 * `CONNECT_STEP_UNKNOWN` (exit 2), which the second case pins down. The redirect
 * URI is non-loopback, so the paste path is used and no listener is bound; the
 * case therefore runs without `listen` privileges.
 */

const boxes: Sandbox[] = [];

afterEach(async () => {
  await Promise.all(boxes.splice(0).map((box) => box.cleanup()));
});

/** The redirect URI registered with the (fake) LinkedIn app. */
const REDIRECT_URI = "https://oauth.example/callback/linkedin";

/** One LinkedIn start request that already carries the app client, so it skips the prompt. */
function startRequest(): string {
  return JSON.stringify({
    type: "start",
    provider: "linkedin",
    options: { redirectUri: REDIRECT_URI, clientId: "fixture-client", clientSecret: "fixture-secret" },
  });
}

/** The two LinkedIn endpoints the callback step reaches, plus nothing else. */
function linkedinTransport(): ProviderTransport {
  return {
    async request(request): Promise<ProviderHttpResult> {
      if (request.url === "https://www.linkedin.com/oauth/v2/accessToken") {
        return {
          type: "response",
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ access_token: "fixture-access-token", expires_in: 3600 }),
        };
      }

      if (request.url === "https://api.linkedin.com/v2/me") {
        return {
          type: "response",
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "member_fixture_1" }),
        };
      }

      return { type: "transport_error", stage: "before_request", code: "UNEXPECTED_URL" };
    },
  };
}

type Arrangement = {
  readonly run: (argv: readonly string[], stdin?: string) => Promise<RunResult>;
};

async function arrange(transport: ProviderTransport): Promise<Arrangement> {
  const box = await sandbox("syndroo-cli-linkedin-");

  boxes.push(box);

  const overrides = { transport };

  return {
    run: (argv, stdin) =>
      runCli(argv, {
        env: box.env,
        cwd: box.root,
        overrides,
        ...(stdin === undefined ? {} : { stdin }),
      }),
  };
}

/** Start a LinkedIn connect and return the state of the authorization URL. */
async function startLinkedIn(arrangement: Arrangement): Promise<string> {
  const started = await arrangement.run(["connect", "--input", "-", "--json"], startRequest());
  const result = parseEnvelope(started)["result"];

  expect(started.exit).toBe(0);
  expect(result.status).toBe("action_required");
  expect(result.action.type).toBe("open_url");

  return new URL(result.action.url).searchParams.get("state") as string;
}

describe("the real LinkedIn provider through the local callback adapter", () => {
  it("reaches done and commits a connection once the callback is verified and the exchange succeeds", async () => {
    const arrangement = await arrange(linkedinTransport());
    const state = await startLinkedIn(arrangement);
    const pasted = `${REDIRECT_URI}?code=fixture-code&state=${encodeURIComponent(state)}`;
    const completed = await arrangement.run(
      ["connect", "linkedin", "--callback-url", "-", "--json"],
      `${pasted}\n`,
    );
    const envelope = parseEnvelope(completed);

    expect(completed.exit).toBe(0);
    expect(envelope["result"].status).toBe("done");
    expect(envelope["result"].connection.account).toEqual({
      provider: "linkedin",
      accountId: "member_fixture_1",
      origin: "https://www.linkedin.com",
    });
    // Neither the authorization code nor the access token appears anywhere.
    expect(`${completed.stdout}${completed.stderr}`).not.toContain("fixture-code");
    expect(`${completed.stdout}${completed.stderr}`).not.toContain("fixture-access-token");
    // The app client secret the provider keeps as connect-session private state
    // never reaches the envelope either.
    expect(`${completed.stdout}${completed.stderr}`).not.toContain("fixture-secret");

    const status = await arrangement.run(["status", "--connections", "--json"]);
    const connections = parseEnvelope(status)["result"].connections;

    expect(status.exit).toBe(0);
    expect(connections).toHaveLength(1);
    expect(connections[0].account.accountId).toBe("member_fixture_1");
    expect(status.stdout).not.toContain("fixture-access-token");
    expect(status.stdout).not.toContain("fixture-secret");
  });

  it("reports CONNECT_STEP_UNKNOWN when the token exchange cannot reach LinkedIn", async () => {
    const offline: ProviderTransport = {
      async request(): Promise<ProviderHttpResult> {
        return { type: "transport_error", stage: "before_request", code: "OFFLINE" };
      },
    };
    const arrangement = await arrange(offline);
    const state = await startLinkedIn(arrangement);
    const pasted = `${REDIRECT_URI}?code=fixture-code&state=${encodeURIComponent(state)}`;
    const completed = await arrangement.run(
      ["connect", "linkedin", "--callback-url", "-", "--json"],
      `${pasted}\n`,
    );

    // The callback was verified, so the failure is the provider exchange, not
    // the adapter: Core maps any provider `connect.run` throw to this code.
    expect(completed.exit).toBe(2);
    expect(parseEnvelope(completed)["error"].code).toBe("CONNECT_STEP_UNKNOWN");
  });
});
