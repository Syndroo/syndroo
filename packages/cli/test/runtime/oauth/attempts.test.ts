import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FilesystemOAuthAttempts } from "../../../src/runtime/oauth/attempts.js";
import { makeRoot, tree } from "../filesystem/support.js";

/**
 * The attempt store is the only durable half of the adapter.
 *
 * These cases prove the two properties the design leans on: a reader of these
 * files cannot recover the state, and one attempt admits at most once.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function store(): Promise<{ root: string; attempts: FilesystemOAuthAttempts }> {
  const root = await makeRoot();

  roots.push(root);

  return { root, attempts: new FilesystemOAuthAttempts({ stateRoot: root }) };
}

const ATTEMPT = {
  provider: "fake",
  sessionId: "cs_one",
  stepRevision: 0,
  redirectUri: "http://127.0.0.1:8765/oauth/callback/fake",
  issuer: "https://authorize.test",
  createdAt: "2026-10-08T00:00:00.000Z",
  expiresAt: "2026-10-08T00:15:00.000Z",
};

describe("FilesystemOAuthAttempts", () => {
  it("keys an attempt by a 64-hex digest and never writes the state or a code", async () => {
    const { root, attempts } = await store();
    const state = "S3cr3t-State-Value-0123456789";
    const digest = await attempts.digest(state);

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    await attempts.create(digest, ATTEMPT);

    const files = await tree(root);
    const record = files.find((file) => file.path.endsWith(`${digest}.json`));

    expect(record).toBeDefined();
    expect(record?.mode).toBe(0o600);
    expect(files.some((file) => file.text.includes(state))).toBe(false);
    expect(await attempts.read(digest)).toEqual(ATTEMPT);
  });

  it("derives the same digest twice and a different one for a different state", async () => {
    const { attempts } = await store();

    expect(await attempts.digest("a")).toBe(await attempts.digest("a"));
    expect(await attempts.digest("a")).not.toBe(await attempts.digest("b"));
  });

  it("keeps the digest key owner-only and refuses to overwrite a record", async () => {
    const { root, attempts } = await store();
    const digest = await attempts.digest("state");

    await attempts.create(digest, ATTEMPT);

    await expect(
      attempts.create(digest, { ...ATTEMPT, sessionId: "cs_two" }),
    ).rejects.toThrow();
    expect((await attempts.read(digest))?.sessionId).toBe("cs_one");

    const key = await fs.stat(path.join(root, "oauth-attempts", "digest-key"));

    expect(key.mode & 0o777).toBe(0o600);
  });

  it("admits exactly one claim per attempt", async () => {
    const { attempts } = await store();
    const digest = await attempts.digest("state");

    await attempts.create(digest, ATTEMPT);

    expect(await attempts.claim(digest)).toBe("claimed");
    expect(await attempts.claim(digest)).toBe("used");
  });

  it("lets a released attempt be claimed again, and an unrecorded one never", async () => {
    const { attempts } = await store();
    const digest = await attempts.digest("state");

    await attempts.create(digest, ATTEMPT);
    expect(await attempts.claim(digest)).toBe("claimed");
    await attempts.release(digest);
    expect(await attempts.claim(digest)).toBe("claimed");

    const unknown = await attempts.digest("never-recorded");

    expect(await attempts.read(unknown)).toBeNull();
    expect(await attempts.claim(unknown)).toBe("claimed");
  });

  it("sweeps expired records and their claims, and leaves a live one alone", async () => {
    const { root, attempts } = await store();
    const live = await attempts.digest("live");
    const dead = await attempts.digest("dead");

    await attempts.create(live, ATTEMPT);
    await attempts.create(dead, { ...ATTEMPT, expiresAt: "2026-10-08T00:05:00.000Z" });
    await attempts.claim(dead);

    await attempts.sweep("2026-10-08T00:10:00.000Z");

    const names = (await fs.readdir(path.join(root, "oauth-attempts"))).sort();

    expect(await attempts.read(live)).toEqual(ATTEMPT);
    expect(await attempts.read(dead)).toBeNull();
    // Both sides are sorted: the digest is salted per store, so its order
    // against the claim marker is not a stable property to assert.
    expect(names).toEqual([`${live}.json`, "digest-key"].sort());
  });
});
