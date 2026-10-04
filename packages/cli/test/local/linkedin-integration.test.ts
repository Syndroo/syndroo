import { afterEach, describe, expect, it } from "vitest";
import { parseLocalPublishDocument } from "../../src/local/document.js";
import { resolveCredentialSource, credentialFingerprint } from "../../src/local/credentials.js";
import { executeLocalPlan } from "../../src/local/execute.js";
import { openExecution, succeeded, unknownOutcome, scriptedProvider } from "./support/execute-fixture.js";
import { seedConnection } from "./support/plan-fixture.js";
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(run => run()); });
const env = { LINKEDIN_ACCESS_TOKEN: "fixture-token", LINKEDIN_AUTHOR: "urn:li:person:alice", LINKEDIN_API_VERSION: "202604" };
describe("LinkedIn local integration", () => {
  it("accepts selected LinkedIn and overrides; X and Tumblr stay remote-only", () => {
    const value = parseLocalPublishDocument(JSON.stringify({ key: "fixture", content: "base", platforms: ["bluesky","threads","linkedin"], overrides: { linkedin: { content: "professional" } } }));
    expect(value.overrides?.linkedin?.content).toBe("professional");
    for (const name of ["x","tumblr"]) expect(() => parseLocalPublishDocument(JSON.stringify({key:"fixture",content:"base",platforms:[name]}))).toThrow();
  });
  it("reads a complete LinkedIn group and fingerprints author/version too", async () => {
    const reference = { kind: "env", provider: "linkedin" } as const;
    const credentials = await resolveCredentialSource(reference, { env });
    expect(credentials).toEqual({ provider:"linkedin",accessToken:"fixture-token",author:env.LINKEDIN_AUTHOR,apiVersion:"202604" });
    for (const field of Object.keys(env)) await expect(resolveCredentialSource(reference, { env: { ...env, [field]: undefined } })).rejects.toMatchObject({ code: "AUTH_SOURCE_UNAVAILABLE" });
    await expect(resolveCredentialSource(reference, { env: { ...env, LINKEDIN_AUTHOR:"urn:li:organization:1" } })).rejects.toMatchObject({code:"AUTH_SOURCE_UNAVAILABLE"});
    const store = { authenticate: async (text: string) => text };
    expect(await credentialFingerprint(credentials, store)).not.toBe(await credentialFingerprint({...credentials, author:"urn:li:person:bob"} as typeof credentials,store));
  });
  it("three-target replay preserves successful delivery without sending again", async () => {
    const state = await openExecution(); cleanup.push(state.cleanup);
    await seedConnection(state.store, { provider: "linkedin", targetId: "urn:li:person:alice" });
    const linkedin = scriptedProvider("linkedin",state.events); linkedin.queue(succeeded("urn:li:share:1"));
    const providers = {...state.providers,linkedin:linkedin.provider};
    state.bluesky.queue(succeeded()); state.threads.queue(succeeded());
    const { planLocalPublish } = await import("../../src/local/plan.js");
    const doc = parseLocalPublishDocument(JSON.stringify({key:"three",content:"hello",platforms:["bluesky","threads","linkedin"]}));
    const options = {store:state.store,providers,namespace:"default",now:state.clock.now};
    const plan = await planLocalPublish(doc,options);
    const execute = {store:state.instrumented,providers,resolveCredentials: async (connection: import("../../src/local/ports/local-store.js").ConnectionRecord) => connection.target.provider === "linkedin" ? await resolveCredentialSource({kind:"env",provider:"linkedin"},{env}) : state.resolveCredentials(connection),signal:new AbortController().signal,kind:"publish" as const,now:state.clock.now};
    expect((await executeLocalPlan(plan.planId,execute)).status).toBe("succeeded");
    const replay = await planLocalPublish(doc,options); await executeLocalPlan(replay.planId,execute);
    expect([state.bluesky.calls.publish,state.threads.calls.publish,linkedin.calls.publish]).toEqual([1,1,1]);
    const conflict = await planLocalPublish({...doc,content:"changed"},options);
    expect(conflict.items.every(item => item.action === "blocked")).toBe(true);
    expect(conflict.items.every(item => item.delivery.content === "hello")).toBe(true);
    await expect(executeLocalPlan(conflict.planId,execute)).rejects.toMatchObject({code:"INVALID_DOCUMENT"});
  });
  it("LinkedIn unknown receipt remains blocked", async () => {
    const state = await openExecution(); cleanup.push(state.cleanup);
    await seedConnection(state.store,{provider:"linkedin",targetId:"urn:li:person:alice"});
    const linkedin = scriptedProvider("linkedin"); linkedin.queue(unknownOutcome());
    const providers = {...state.providers,linkedin:linkedin.provider};
    const { planLocalPublish } = await import("../../src/local/plan.js");
    const doc = parseLocalPublishDocument(JSON.stringify({key:"unknown",content:"hello",platforms:["linkedin"]}));
    const plan = await planLocalPublish(doc,{store:state.store,providers,namespace:"default",now:state.clock.now});
    const result = await executeLocalPlan(plan.planId,{store:state.instrumented,providers,resolveCredentials:()=>resolveCredentialSource({kind:"env",provider:"linkedin"},{env}),signal:new AbortController().signal,kind:"publish",now:state.clock.now});
    expect(result.results[0]?.status).toBe("unknown"); expect(result.results[0]?.retry.eligible).toBe(false);
    const replay=await planLocalPublish(doc,{store:state.store,providers,namespace:"default",now:state.clock.now});
    expect(replay.items[0]?.action).toBe("blocked"); expect(linkedin.calls.publish).toBe(1);
  });
});
