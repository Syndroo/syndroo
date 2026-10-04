import {expect,it} from "vitest";
import {ThreadsLocalProvider} from "../src/index.js";
it("reads verified username from the same identity response",async()=>{
 const p=new ThreadsLocalProvider({fetch:async()=>new Response(JSON.stringify({id:"123",username:"alice"}))});
 expect(await p.verifyIdentity({provider:"threads",accessToken:"fake"},new AbortController().signal)).toEqual({targetId:"123",displayName:"alice"});
});
