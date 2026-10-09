import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import type * as T from "@syndroo/core";
import { afterEach, describe, expect, it } from "vitest";

import { LocalOAuthCallback, type ArmedDraft } from "../../../src/runtime/oauth/callback.js";
import {
  FIXED_NOW,
  fixtureAt,
  makeRoot,
  startConnect,
  tree,
  type Fixture,
} from "../filesystem/support.js";

/**
 * The verification matrix of the local callback adapter.
 *
 * Every case drives `handleRedirect` directly, so the assertion is about the
 * adapter's own decision and not about a listener or a provider. The session is
 * a real reserved connect session in the filesystem state store, at the same
 * step the CLI's own flow leaves it in (`awaiting`, revision 1), so the checks
 * run against the real records rather than stand-ins.
 */

const PROVIDER = "fake";
const OTHER_PROVIDER = "linkedin";
const SESSION = "cs_one";
const PRINCIPAL = "owner";
const REDIRECT_URI = "http://127.0.0.1:8765/oauth/callback/fake";
const AUTHORIZE_URL = "https://authorize.test/oauth/authorize?client_id=fake&state=issued";
const SESSION_EXPIRY = "2026-10-08T00:15:00.000Z";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

type Arrangement = {
  readonly root: string;
  readonly fixture: Fixture;
  readonly oauth: LocalOAuthCallback;
  readonly clock: { value: string };
  readonly signal: AbortSignal;
  /** A second live session, for the cross-session cases. */
  readonly secondSession: string;
};

async function arrange(): Promise<Arrangement> {
  const root = await makeRoot();

  roots.push(root);

  const fixture = fixtureAt(root);
  const clock = { value: FIXED_NOW };
  let counter = 0;
  const oauth = new LocalOAuthCallback({
    stateRoot: root,
    state: fixture.state,
    credentials: fixture.credentials,
    clock: { now: () => clock.value },
    entropy: {
      id: (prefix: string) => `${prefix}_${(counter += 1)}`,
      token: () => `token_${(counter += 1)}`,
    },
    principalId: PRINCIPAL,
    providers: [PROVIDER, OTHER_PROVIDER],
  });

  await awaiting(fixture, SESSION, "one");
  await awaiting(fixture, "cs_two", "two");

  return {
    root,
    fixture,
    oauth,
    clock,
    signal: new AbortController().signal,
    secondSession: "cs_two",
  };
}

/** Leave one session `awaiting` at step revision 1, as a live start would. */
async function awaiting(fixture: Fixture, sessionId: string, suffix: string): Promise<void> {
  const started = await startConnect(fixture, suffix);
  const stage = await fixture.credentials.put({
    creationId: `blob_${suffix}`,
    owner: { kind: "connect_state", ownerId: sessionId, version: 1 },
    value: { providerState: {} },
  });
  const saved = await fixture.state.saveConnectAction({
    claim: started.claim,
    action: { type: "open_url", url: AUTHORIZE_URL },
    privateState: stage,
    now: FIXED_NOW,
  });

  if (saved.type !== "applied") {
    throw new Error("expected the session to reach an awaiting action");
  }
}

/** Arm and record one attempt, exactly as the CLI does around an `open_url`. */
async function record(
  arrangement: Arrangement,
  overrides: Partial<{ sessionId: string; stepRevision: number; authorizeUrl: string }> = {},
): Promise<ArmedDraft> {
  const draft = arrangement.oauth.arm({
    provider: PROVIDER,
    redirectUri: REDIRECT_URI,
    signal: arrangement.signal,
  });

  await arrangement.oauth.recordIfOpenUrl(draft, {
    status: "action_required",
    connectSessionId: overrides.sessionId ?? SESSION,
    stepRevision: overrides.stepRevision ?? 1,
    expiresAt: SESSION_EXPIRY,
    action: { type: "open_url", url: overrides.authorizeUrl ?? AUTHORIZE_URL },
  });

  return draft;
}

function callbackUrl(state: string, code = "CODE_1", extra = ""): string {
  return `${REDIRECT_URI}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}${extra}`;
}

async function stagedEvidence(arrangement: Arrangement, sessionId = SESSION): Promise<T.JsonObject> {
  const session = await arrangement.fixture.state.getConnectSession(sessionId, PRINCIPAL);

  if (session?.callbackRef === undefined) {
    throw new Error("expected a staged callback reference");
  }

  return await arrangement.fixture.credentials.get({
    ref: session.callbackRef,
    owner: { kind: "callback", ownerId: sessionId, version: session.stepRevision },
  });
}

describe("LocalOAuthCallback.handleRedirect", () => {
  it("accepts one verified redirect and stages evidence the session references", async () => {
    const arrangement = await arrange();
    const draft = await record(arrangement);
    const outcome = await arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(draft.state));

    expect(outcome).toEqual({
      ok: true,
      code: "OAUTH_CALLBACK_ACCEPTED",
      session: { sessionId: SESSION, stepRevision: 1 },
    });

    // The issuer is the origin the browser was actually sent to, never the host
    // the callback arrived on.
    expect(await stagedEvidence(arrangement)).toEqual({
      code: "CODE_1",
      state: draft.state,
      issuer: "https://authorize.test",
      redirectUri: REDIRECT_URI,
    });
  });

  it("admits at most once when the same redirect is delivered concurrently", async () => {
    const arrangement = await arrange();
    const draft = await record(arrangement);
    const [left, right] = await Promise.all([
      arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(draft.state)),
      arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(draft.state)),
    ]);

    expect([left.ok, right.ok].filter(Boolean)).toHaveLength(1);
    expect([left.code, right.code].filter((code) => code === "OAUTH_CALLBACK_ACCEPTED")).toHaveLength(1);
  });

  it("refuses a replayed callback after one was accepted", async () => {
    const arrangement = await arrange();
    const draft = await record(arrangement);

    expect((await arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(draft.state))).ok).toBe(true);

    const replay = await arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(draft.state, "CODE_2"));

    expect(replay).toEqual({ ok: false, code: "OAUTH_CALLBACK_REJECTED" });
  });

  it("refuses a forged state without consuming the real attempt", async () => {
    const arrangement = await arrange();
    const draft = await record(arrangement);

    expect((await arrangement.oauth.handleRedirect(PROVIDER, callbackUrl("forged-state-0123456789"))).ok).toBe(false);

    const session = await arrangement.fixture.state.getConnectSession(SESSION, PRINCIPAL);

    expect(session?.callbackRef).toBeUndefined();
    expect((await arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(draft.state))).ok).toBe(true);
  });

  it("refuses a redirect addressed to another provider without consuming it", async () => {
    const arrangement = await arrange();
    const draft = await record(arrangement);

    expect((await arrangement.oauth.handleRedirect(OTHER_PROVIDER, callbackUrl(draft.state))).ok).toBe(false);
    expect((await arrangement.oauth.handleRedirect("unknown", callbackUrl(draft.state))).ok).toBe(false);
    expect((await arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(draft.state))).ok).toBe(true);
  });

  it("refuses a redirect that does not match the registered path, port or host", async () => {
    const arrangement = await arrange();
    const draft = await record(arrangement);

    const wrongPath = `http://127.0.0.1:8765/oauth/callback/other?code=C&state=${draft.state}`;
    const wrongPort = `http://127.0.0.1:9999/oauth/callback/fake?code=C&state=${draft.state}`;
    const wrongHost = `http://127.0.0.1.nip.io:8765/oauth/callback/fake?code=C&state=${draft.state}`;

    for (const url of [wrongPath, wrongPort, wrongHost]) {
      expect((await arrangement.oauth.handleRedirect(PROVIDER, url)).ok).toBe(false);
    }

    expect((await arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(draft.state))).ok).toBe(true);
  });

  it("refuses an expired attempt even when the state and redirect match", async () => {
    const arrangement = await arrange();
    const draft = await record(arrangement);

    arrangement.clock.value = "2026-10-08T00:20:00.000Z";

    expect((await arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(draft.state))).ok).toBe(false);
  });

  it("refuses a callback whose step revision is not the session's current step", async () => {
    const arrangement = await arrange();
    const draft = await record(arrangement);

    // The session moves on: revision 1 is claimed and a new action is saved.
    const claimed = await arrangement.fixture.state.claimConnectStep({
      sessionId: SESSION,
      principalId: PRINCIPAL,
      stepRevision: 1,
      inputDigest: "second",
      claimId: "step_two",
      now: FIXED_NOW,
    });

    if (claimed.type !== "claimed") {
      throw new Error("expected the second step to be claimable");
    }

    const stage = await arrangement.fixture.credentials.put({
      creationId: "blob_next",
      owner: { kind: "connect_state", ownerId: SESSION, version: 2 },
      value: { providerState: {} },
    });

    await arrangement.fixture.state.saveConnectAction({
      claim: claimed.claim,
      action: { type: "open_url", url: AUTHORIZE_URL },
      privateState: stage,
      now: FIXED_NOW,
    });

    expect((await arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(draft.state))).ok).toBe(false);
  });

  it("binds a state to the one session that issued it", async () => {
    const arrangement = await arrange();
    const first = await record(arrangement);
    const second = await arrangement.oauth.arm({
      provider: PROVIDER,
      redirectUri: REDIRECT_URI,
      signal: arrangement.signal,
    });

    await arrangement.oauth.recordIfOpenUrl(second, {
      status: "action_required",
      connectSessionId: arrangement.secondSession,
      stepRevision: 1,
      expiresAt: SESSION_EXPIRY,
      action: { type: "open_url", url: AUTHORIZE_URL },
    });

    const outcome = await arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(second.state));

    expect(outcome.session?.sessionId).toBe(arrangement.secondSession);
    expect(
      (await arrangement.fixture.state.getConnectSession(SESSION, PRINCIPAL))?.callbackRef,
    ).toBeUndefined();
    expect(await stagedEvidence(arrangement, arrangement.secondSession)).toMatchObject({
      state: second.state,
    });
    // The first session's own state is still unused and still works.
    expect((await arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(first.state))).ok).toBe(true);
  });

  it("shapes the callback: no unknown, duplicate or error parameters, printable code only", async () => {
    const arrangement = await arrange();
    const draft = await record(arrangement);
    const bad = [
      `${REDIRECT_URI}?code=C&state=${draft.state}&next=https://evil.example`,
      `${REDIRECT_URI}?code=C&code=D&state=${draft.state}`,
      `${REDIRECT_URI}?code=C&state=${draft.state}&state=${draft.state}`,
      `${REDIRECT_URI}?error=access_denied&state=${draft.state}`,
      `${REDIRECT_URI}?code=${encodeURIComponent("line\nbreak")}&state=${draft.state}`,
      `${REDIRECT_URI}?code=C&state=short`,
      `${REDIRECT_URI}?state=${draft.state}`,
      `${REDIRECT_URI}?code=C`,
      "not a url",
    ];

    for (const url of bad) {
      expect((await arrangement.oauth.handleRedirect(PROVIDER, url)).ok, url).toBe(false);
    }

    expect((await arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(draft.state))).ok).toBe(true);
  });

  it("refuses a callback pinned to a different session without consuming it", async () => {
    const arrangement = await arrange();
    const draft = await record(arrangement);
    const pinned = { sessionId: arrangement.secondSession, stepRevision: 1 };

    expect(
      (await arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(draft.state), pinned)).ok,
    ).toBe(false);
    expect(
      (await arrangement.fixture.state.getConnectSession(SESSION, PRINCIPAL))?.callbackRef,
    ).toBeUndefined();
    // The owner of the attempt can still accept it.
    expect(
      (
        await arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(draft.state), {
          sessionId: SESSION,
          stepRevision: 1,
        })
      ).ok,
    ).toBe(true);
  });

  it("refuses a callback pinned to a stale step revision", async () => {
    const arrangement = await arrange();
    const draft = await record(arrangement);

    expect(
      (
        await arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(draft.state), {
          sessionId: SESSION,
          stepRevision: 0,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(draft.state), {
          sessionId: SESSION,
          stepRevision: 1,
        })
      ).ok,
    ).toBe(true);
  });

  it("keeps the raw state and the authorization code out of the attempt store", async () => {
    const arrangement = await arrange();
    const draft = await record(arrangement);

    await arrangement.oauth.handleRedirect(PROVIDER, callbackUrl(draft.state, "CODE_LEAK_CHECK"));

    const files = await tree(path.join(arrangement.root, "oauth-attempts"));
    const text = files.map((file) => `${file.path}\n${file.text}`).join("\n");

    expect(files.some((file) => file.path.endsWith(".json"))).toBe(true);
    expect(text).not.toContain(draft.state);
    expect(text).not.toContain("CODE_LEAK_CHECK");
    expect(text).not.toContain(draft.codeVerifier);
  });

  it("records nothing for a step that yields no authorization URL", async () => {
    const arrangement = await arrange();
    const draft = arrangement.oauth.arm({
      provider: PROVIDER,
      redirectUri: REDIRECT_URI,
      signal: arrangement.signal,
    });

    await arrangement.oauth.recordIfOpenUrl(draft, {
      status: "action_required",
      connectSessionId: SESSION,
      stepRevision: 1,
      expiresAt: SESSION_EXPIRY,
      action: { type: "wait_for_callback" },
    });

    expect(existsSync(path.join(arrangement.root, "oauth-attempts"))).toBe(false);
  });

  it("refuses a redirect URI it cannot verify exactly", async () => {
    const arrangement = await arrange();

    expect(() => arrangement.oauth.redirectTarget(PROVIDER, "http://0.0.0.0:8765/cb")).toThrow(
      "REDIRECT_URI_INVALID",
    );
    expect(() => arrangement.oauth.redirectTarget("unsupported", undefined)).toThrow(
      "OAUTH_PROVIDER_UNSUPPORTED",
    );
  });
});
