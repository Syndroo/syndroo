import { expect, it } from "vitest";
import { createClient } from "tumblr.js";

const client = () => createClient({
  consumer_key: "test-key", consumer_secret: "test-secret",
  token: "test-token", token_secret: "test-token-secret",
});
const post = { state: "published" as const, content: [{ type: "text" as const, text: "Hello 中文 👋" }] };

it("signs and sends an NPF text post through the unmodified SDK in workerd", async () => {
  await expect(client().createPost("example.tumblr.com", post)).resolves.toMatchObject({
    id: "123", signed: true, body: post,
  });
});

it("surfaces a provider 503", async () => {
  await expect(client().createPost("unavailable", post)).rejects.toThrow("503");
});

it("documents the missing response bound: SDK accepts more than 64 KiB", async () => {
  await expect(client().createPost("large", post)).resolves.toMatchObject({
    id: "123", padding: "x".repeat(65_537),
  });
});

it("documents that racing a deadline does not cancel the SDK write", async () => {
  const pending = client().createPost("delayed", post)!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<string>(resolve => { timer = setTimeout(() => resolve("deadline"), 10); });
    await expect(Promise.race([pending, deadline])).resolves.toBe("deadline");
    await expect(pending).resolves.toMatchObject({ id: "123" });
  } finally {
    clearTimeout(timer);
  }
});
