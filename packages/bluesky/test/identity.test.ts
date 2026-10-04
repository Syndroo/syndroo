import {expect,it} from "vitest";
import {BlueskyLocalProvider} from "../src/index.js";
it("reads verified handle from session response",async()=>{
 const p=new BlueskyLocalProvider({fetch:async()=>new Response(JSON.stringify({did:"did:plc:fixturealice",handle:"alice.bsky.social",accessJwt:"fake",refreshJwt:"fake",active:true}),{headers:{"content-type":"application/json"}})});
 expect(await p.verifyIdentity({provider:"bluesky",identifier:"user-input",password:"fake",host:"bsky.social"},new AbortController().signal)).toEqual({targetId:"did:plc:fixturealice",displayName:"alice.bsky.social"});
});
