import {expect,it} from "vitest";
import {LinkedInLocalProvider} from "../src/index.js";
it("uses only safe UserInfo display name",async()=>{
  for(const [name,expected] of [["Alice","Alice"],["\u001b[31mAlice",undefined],["a".repeat(257),undefined]]){
    const provider=new LinkedInLocalProvider({fetch:async()=>new Response(JSON.stringify({sub:"alice",name}))});
    const result=await provider.verifyIdentity({provider:"linkedin",accessToken:"fake",author:"urn:li:person:alice",apiVersion:"202604"},new AbortController().signal);
    expect(result).toEqual({targetId:"urn:li:person:alice",...(expected?{displayName:expected}:{})});
  }
});
