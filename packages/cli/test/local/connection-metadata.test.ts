import { afterEach, describe, expect, it } from "vitest";
import { bindLocalAccount, verifyLocalAccount } from "../../src/local/auth.js";
import { openState, seedConnection, stateSnapshot, staticProvider } from "./support/plan-fixture.js";
const cleanup: (()=>void)[]=[];
afterEach(()=>cleanup.splice(0).forEach(run=>run()));
describe("verified connection metadata",()=>{
  it("persists provider display name and verification time, not user input",async()=>{
    const state=await openState(); cleanup.push(state.cleanup);
    const p={...staticProvider("threads").provider,verifyIdentity:async()=>({targetId:"123",displayName:"Verified Alice"})};
    const result=await bindLocalAccount({kind:"env",provider:"threads"},{store:state.store,provider:p,env:{THREADS_ACCESS_TOKEN:"fake"},signal:new AbortController().signal,expectedTargetId:"123",confirm:async()=>true,clock:state.clock.now});
    expect(result).toMatchObject({displayName:"Verified Alice",lastVerifiedAt:state.clock.now().toISOString()});
    expect((await state.store.getConnection("threads"))?.verification).toEqual({displayName:"Verified Alice",lastVerifiedAt:state.clock.now().toISOString()});
  });
  it("reads legacy signed record without rewriting bytes",async()=>{
    const state=await openState(); cleanup.push(state.cleanup); await seedConnection(state.store,{provider:"threads"});
    const before=stateSnapshot(state.stateHome);
    expect((await state.store.getConnection("threads"))?.verification).toBeUndefined();
    expect(stateSnapshot(state.stateHome)).toEqual(before);
  });
  it.each(["\u001b[31mAlice","a".repeat(257)])("unsafe provider names become null",async displayName=>{
    const state=await openState();cleanup.push(state.cleanup);
    await bindLocalAccount({kind:"env",provider:"threads"},{store:state.store,provider:{...staticProvider("threads").provider,verifyIdentity:async()=>({targetId:"123",displayName})},env:{THREADS_ACCESS_TOKEN:"fake"},signal:new AbortController().signal,confirm:async()=>true,clock:state.clock.now});
    expect((await state.store.getConnection("threads"))?.verification?.displayName).toBeNull();
  });
  it("online verify reports current identity/time without writing or revising",async()=>{
    const state=await openState();cleanup.push(state.cleanup);
    const p={...staticProvider("threads").provider,verifyIdentity:async()=>({targetId:"123",displayName:"Alice"})};
    const deps={store:state.store,provider:p,env:{THREADS_ACCESS_TOKEN:"fake"},signal:new AbortController().signal,clock:state.clock.now};
    await bindLocalAccount({kind:"env",provider:"threads"},{...deps,confirm:async()=>true});
    const current=await state.store.getConnection("threads");if(!current)throw new Error("missing fixture");
    const before=stateSnapshot(state.stateHome);state.clock.advance(1000);
    const checked=await verifyLocalAccount(current,deps);
    expect(checked.lastVerifiedAt).toBe(state.clock.now().toISOString());
    expect(checked.bindingRevision).toBe(current.target.bindingRevision);
    expect(stateSnapshot(state.stateHome)).toEqual(before);
  });
});
