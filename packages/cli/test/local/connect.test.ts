import {mkdtempSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable,Writable} from "node:stream";
import {afterEach,describe,expect,it,vi} from "vitest";
import {type LocalProviderId,type LocalProvider,LocalProviderError} from "@syndroo/core";
import {run} from "../../src/main.js";
import {stateSnapshot} from "./support/plan-fixture.js";
const roots:string[]=[];
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
function harness(){
 const root=mkdtempSync(join(tmpdir(),"syndroo-connect-"));roots.push(root);
 const calls={verify:0,publish:0};let reject=false;
 const make=(provider:LocalProviderId):LocalProvider=>({
  provider,describe:()=>({provider,maturity:"fixture-tested",localPublish:true,unavailableReason:null}),
  freeze:(content)=>({payloadVersion:1,payload:{text:content}}),
  verifyIdentity:async()=>{calls.verify++;if(reject)throw new LocalProviderError("AUTH");return {targetId:provider==="linkedin"?"urn:li:person:alice":provider+"-alice",displayName:"Verified Alice"};},
  prepare:async(_credentials,target)=>({target,publish:async()=>{calls.publish++;return {kind:"succeeded",remoteId:"fixture",url:null};}})
 });
 const providers={bluesky:make("bluesky"),threads:make("threads"),linkedin:make("linkedin")};
 const env:NodeJS.ProcessEnv={HOME:root,XDG_CONFIG_HOME:join(root,"config"),XDG_STATE_HOME:join(root,"state"),THREADS_ACCESS_TOKEN:"fake",LINKEDIN_ACCESS_TOKEN:"fake",LINKEDIN_AUTHOR:"urn:li:person:alice",LINKEDIN_API_VERSION:"202604"};
 return {root,calls,env,reject:()=>{reject=true;},state:join(root,"state","syndroo"),async command(argv:string[]){
  const output:string[]=[];const errors:string[]=[];
  const sink=(data:string[])=>new Writable({write(chunk,_encoding,done){data.push(String(chunk));done();}});
  const code=await run([...argv,"--json"],{stdin:Readable.from([]),stdout:sink(output),stderr:sink(errors),env,cwd:root,stdinIsTty:false,stdoutIsTty:false,hasTty:()=>false,readTtyLine:()=>undefined,signal:new AbortController().signal},{providers,clock:()=>new Date("2026-10-01T00:00:00.000Z")});
  const lines=output.join("").trim().split("\n");expect(lines).toHaveLength(1);
  return {code,envelope:JSON.parse(lines[0]!) as {ok:boolean;command:string;mode:string;result:Record<string,any>;error:{code:string;details?:Record<string,unknown>}},errors:errors.join("")};
 }};
}
/** Count forbidden reads without introducing real credentials or network access. */
function observeEnvironmentReads(env: NodeJS.ProcessEnv, names: readonly string[]) {
  const reads: string[] = [];
  for (const name of names) {
    Object.defineProperty(env, name, {
      configurable: true,
      enumerable: true,
      get() {
        reads.push(name);
        return "DO_NOT_READ_THIS_SECRET_CANARY";
      },
    });
  }
  return reads;
}

describe("connect thin local entry",()=>{
  it.each(["bluesky", "threads", "linkedin"])("refuses a missing %s source without environment, network, or state effects", async provider => {
    const h = harness();
    const reads = observeEnvironmentReads(h.env, [
      "SYNDROO_BASE_URL", "SYNDROO_API_KEY", "BLUESKY_PASSWORD",
      "THREADS_ACCESS_TOKEN", "LINKEDIN_ACCESS_TOKEN",
    ]);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    const result = await h.command(["connect", provider]);
    // A non-interactive run never guesses a source; it fails with an
    // actionable usage error before any effect.
    expect(result.code).toBe(2);
    expect(result.envelope).toMatchObject({ command: "connect", mode: "local", ok: false, error: { code: "USAGE" } });
    expect(JSON.stringify(result.envelope.error)).toContain("--from-env");
    expect(reads).toEqual([]);
    expect(network).not.toHaveBeenCalled();
    expect(h.calls).toEqual({ verify: 0, publish: 0 });
    expect(existsSync(h.state)).toBe(false);
    expect(JSON.stringify(result)).not.toContain("DO_NOT_READ_THIS_SECRET_CANARY");
  });

  it.each([
    ["threads", "threads-alice"],
    ["linkedin", "urn:li:person:alice"],
  ])("binds %s through the same local auth store without --local", async (provider, targetId) => {
    const h = harness();
    const reads = observeEnvironmentReads(h.env, ["SYNDROO_BASE_URL", "SYNDROO_API_KEY"]);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected remote request"));
    expect((await h.command(["init"])).code).toBe(0);
    const bound = await h.command([
      "connect", provider!, "--from-env", "--yes", "--no-input", "--expect-account", targetId!,
    ]);
    expect(bound.code).toBe(0);
    expect(bound.envelope).toMatchObject({ mode: "local", ok: true });
    expect(bound.envelope.result).toMatchObject({ targetId, bindingChanged: true, bindingRevision: 1 });
    const status = await h.command(["auth", "status", "--local"]);
    expect(status.envelope.result.bindings).toEqual([
      expect.objectContaining({ connectionId: bound.envelope.result.connectionId, targetId, mode: "local" }),
    ]);
    expect(reads).toEqual([]);
    expect(network).not.toHaveBeenCalled();
    expect(h.calls).toEqual({ verify: 1, publish: 0 });
  });

  it("rejects --managed before reading credentials, using the network, or writing state", async () => {
    const h = harness();
    const reads = observeEnvironmentReads(h.env, ["SYNDROO_BASE_URL", "SYNDROO_API_KEY", "THREADS_ACCESS_TOKEN"]);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    const result = await h.command(["connect", "threads", "--managed", "--from-env", "--yes", "--no-input", "--expect-account", "threads-alice"]);
    expect(result.code).toBe(2);
    expect(result.envelope).toMatchObject({ mode: "local", ok: false, error: { code: "USAGE" } });
    expect(reads).toEqual([]);
    expect(network).not.toHaveBeenCalled();
    expect(h.calls).toEqual({ verify: 0, publish: 0 });
    expect(existsSync(h.state)).toBe(false);
  });

  it("shows --local as optional in connect help", async () => {
    const h = harness();
    const result = await h.command(["connect", "threads", "--help"]);
    expect(result.code).toBe(0);
    expect(result.envelope.result.help).toContain("connect <provider> [--local]");
    expect(existsSync(h.state)).toBe(false);
  });

  it("preserves the explicit mode requirement for the existing auth command", async () => {
    const h = harness();
    const result = await h.command(["auth", "set", "threads", "--from-env", "--yes", "--no-input", "--expect-account", "threads-alice"]);
    expect(result.code).toBe(2);
    expect(h.calls).toEqual({ verify: 0, publish: 0 });
    expect(existsSync(h.state)).toBe(false);
  });

  it("rejects a remote endpoint override without exposing its value", async () => {
    const h = harness();
    const result = await h.command(["connect", "threads", "--base-url", "https://unexpected-endpoint.invalid"]);
    expect(result.code).toBe(2);
    expect(h.calls).toEqual({ verify: 0, publish: 0 });
    expect(existsSync(h.state)).toBe(false);
    expect(JSON.stringify(result)).not.toContain("unexpected-endpoint.invalid");
  });

 it("guide only is offline and writes nothing",async()=>{
  const h=harness();const result=await h.command(["connect","linkedin","--local"]);
  expect(result.code).toBe(2);expect(result.envelope.command).toBe("connect");
  expect(result.envelope.error.code).toBe("USAGE");
  expect(h.calls.verify).toBe(0);expect(existsSync(h.state)).toBe(false);
 });
 it.each([["connect","linkedin","--managed"],["connect","linkedin","--local","--managed"],["connect","linkedin","--local","--local"],["connect","linkedin","--local","--from-env","--credential-file","secret-path"]].map(argv => [argv] as const))("rejects unavailable or conflicting mode/source before effects",async argv=>{
  const h=harness();const result=await h.command(argv);expect(result.code).toBe(2);
  expect(h.calls.verify).toBe(0);expect(existsSync(h.state)).toBe(false);
  expect(JSON.stringify(result.envelope)).not.toContain("secret-path");
 });
 it("noninteractive bind requires expected account",async()=>{
  const h=harness();await h.command(["init"]);
  const before=stateSnapshot(h.state);
  const result=await h.command(["connect","linkedin","--local","--from-env","--yes","--no-input"]);
  expect(result.code).toBe(2);expect(h.calls.verify).toBe(0);expect(stateSnapshot(h.state)).toEqual(before);
 });
 it("bind reuses auth set and status stays read-only and honest",async()=>{
  const h=harness();await h.command(["init"]);
  const result=await h.command(["connect","linkedin","--local","--from-env","--yes","--no-input","--expect-account","urn:li:person:alice"]);
  expect(result.code).toBe(0);expect(result.envelope.result).toMatchObject({bindingChanged:true,targetId:"urn:li:person:alice",bindingRevision:1,displayName:"Verified Alice"});
  const before=stateSnapshot(h.state);const calls=h.calls.verify;
  const offline=await h.command(["auth","status","--local"]);
  expect(offline.envelope.result.bindings[0]).toMatchObject({configured:true,mode:"local",readiness:"unchecked",verificationSource:"cached",displayName:"Verified Alice",lastVerifiedAt:"2026-10-01T00:00:00.000Z"});
  expect(offline.envelope.result.unconfiguredProviders).toEqual(["bluesky","threads","mastodon","devto"]);
  expect(h.calls.verify).toBe(calls);
  const online=await h.command(["auth","status","linkedin","--local","--verify"]);
  expect(online.envelope.result.bindings[0]).toMatchObject({verified:true,readiness:"unchecked",verificationSource:"online"});
  expect(stateSnapshot(h.state)).toEqual(before);expect(h.calls.publish).toBe(0);
 });
 it("wrong expected account leaves binding unchanged",async()=>{
  const h=harness();await h.command(["init"]);const before=stateSnapshot(h.state);
  const result=await h.command(["connect","linkedin","--local","--from-env","--yes","--no-input","--expect-account","urn:li:person:bob"]);
  expect(result.code).toBe(2);expect(result.envelope.error.code).toBe("ACCOUNT_MISMATCH");expect(stateSnapshot(h.state)).toEqual(before);
 });
 it("verified credential rejection includes reconnect action and keeps failure exit",async()=>{
  const h=harness();await h.command(["init"]);await h.command(["auth","set","linkedin","--local","--from-env","--yes","--no-input","--expect-account","urn:li:person:alice"]);h.reject();
  const result=await h.command(["auth","status","linkedin","--local","--verify"]);
  expect(result.code).toBe(2);expect(result.envelope.error.details).toMatchObject({readiness:"reconnect_required",nextAction:"reconnect"});
 });
});
