import { describe, expect, it, vi } from "vitest";
import { LocalProviderError, type FrozenDelivery, type LocalCredentials, type TargetBinding } from "@syndroo/core";
import * as linkedin from "../src/index.js";

const credentials = { provider: "linkedin", accessToken: "fixture-token", author: "urn:li:person:alice", apiVersion: "202604" } as LocalCredentials;
const target = { provider: "linkedin", targetId: "urn:li:person:alice", connectionId: "conn_fixture", bindingRevision: 1 } as TargetBinding;
const signal = () => new AbortController().signal;
function provider(transport: (url: unknown, init?: RequestInit) => Promise<Response> = vi.fn(async () => new Response(JSON.stringify({ sub: "alice" }), { status: 200 })), timeoutMs = 100) {
  const Constructor = (linkedin as unknown as { LinkedInLocalProvider: new (options: { fetch: typeof fetch; timeoutMs: number }) => import("@syndroo/core").LocalProvider }).LinkedInLocalProvider;
  expect(Constructor).toBeTypeOf("function");
  return new Constructor({ fetch: transport as typeof fetch, timeoutMs });
}
function delivery(p: import("@syndroo/core").LocalProvider, content = "hello"): FrozenDelivery {
  return { deliveryId: "a".repeat(64), key: "fixture", namespace: "default", target, content, payloadHash: "b".repeat(64), ...p.freeze(content, "2026-10-01T00:00:00.000Z") };
}
describe("LinkedIn local contract", () => {
  it("constructs and freezes without network; escapes plain commentary", () => {
    const transport = vi.fn(); const p = provider(transport);
    expect(p.describe().maturity).toBe("fixture-tested");
    expect(p.freeze("@hello #tag", "now").payload.commentary).toBe("\\@hello \\#tag");
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(["a".repeat(3000), "@".repeat(1500)])("accepts boundary content", content => { provider().freeze(content, "now"); });
  it.each(["a".repeat(3001), "@".repeat(1501), "", "\u0000"])("rejects invalid content", content => {
    expect(() => provider().freeze(content, "now")).toThrow(LocalProviderError);
  });
  it("refuses organization credentials before network", async () => {
    const transport = vi.fn(); const p = provider(transport);
    await expect(p.verifyIdentity({ ...credentials, author: "urn:li:organization:1" } as LocalCredentials, signal())).rejects.toMatchObject({ code: "AUTH" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("refuses identity mismatch without exposing response or token", async () => {
    const p = provider(vi.fn(async () => new Response(JSON.stringify({ sub: "other", secret: "fixture-token" }))));
    await expect(p.verifyIdentity(credentials, signal())).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  });
  it.each([[201, "urn:li:share:12", "succeeded"], [201, null, "unknown"], [201, "bad", "unknown"], [200, "urn:li:share:12", "unknown"], [302, null, "unknown"], [500, null, "unknown"], [401, null, "failed"], [403, null, "failed"], [429, null, "failed"]] as const)("classifies status %s and id %s", async (status, id, kind) => {
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "POST"
      ? new Response(null, { status, headers: id ? { "x-restli-id": id } : {} })
      : new Response(JSON.stringify({ sub: "alice" })));
    const p = provider(transport); const prepared = await p.prepare(credentials, target, signal());
    const outcome = await prepared.publish(delivery(p), signal());
    expect(outcome.kind).toBe(kind);
    if (outcome.kind === "succeeded") expect(outcome.url).toBeNull();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]?.[1]?.redirect).toBe("manual");
    expect(JSON.stringify(outcome)).not.toContain("fixture-token");
  });
  it("checks frozen target revision and payload before dispatch", async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ sub: "alice" })));
    const p = provider(transport); const prepared = await p.prepare(credentials, target, signal()); const d = delivery(p);
    expect((await prepared.publish({ ...d, target: { ...target, bindingRevision: 2 } }, signal())).kind).toBe("failed");
    expect((await prepared.publish({ ...d, payload: { ...d.payload, commentary: "changed" } }, signal())).kind).toBe("failed");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("pre-cancelled requests never dispatch", async () => {
    const transport = vi.fn(); const p = provider(transport); const controller = new AbortController(); controller.abort();
    await expect(p.verifyIdentity(credentials, controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("bounds stalled transport even when transport ignores abort", async () => {
    const p = provider(vi.fn(() => new Promise<Response>(() => {})), 10);
    await expect(p.verifyIdentity(credentials, signal())).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
  it("bounds oversized and stalled identity bodies", async () => {
    for (const body of ["a".repeat(65537), new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); } })]) {
      const p = provider(vi.fn(async () => new Response(body)), 10);
      await expect(p.verifyIdentity(credentials, signal())).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    }
  });
  it("lost response after dispatch remains unknown", async () => {
    const p = provider(vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") throw new TypeError("fixture-token");
      return new Response(JSON.stringify({ sub: "alice" }));
    }));
    const prepared = await p.prepare(credentials, target, signal());
    expect(await prepared.publish(delivery(p), signal())).toMatchObject({ kind: "unknown", writeDisposition: "unknown" });
  });
});
