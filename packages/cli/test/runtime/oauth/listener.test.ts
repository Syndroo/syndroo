import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer as createTcpServer } from "node:net";

import { describe, expect, it } from "vitest";

import { startLoopbackListener } from "../../../src/runtime/oauth/listener.js";

/**
 * The loopback listener, driven over real HTTP.
 *
 * Every case binds `127.0.0.1` on a port this test chose, so the assertions are
 * about the same code path a browser would reach. Binding needs a real socket,
 * which a restricted sandbox refuses with `listen EPERM`.
 */

async function freePort(): Promise<number> {
  const probe = createTcpServer();

  // A restricted sandbox refuses `listen` with EPERM; surface that instead of
  // hanging, so a blocked run says exactly which assertion could not execute.
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });

  const { port } = probe.address() as AddressInfo;

  await new Promise<void>((resolve) => probe.close(() => resolve()));

  return port;
}

async function listening(): Promise<{
  readonly port: number;
  readonly path: string;
  readonly uri: string;
  readonly redirects: string[];
  accept: boolean;
}> {
  const port = await freePort();

  return {
    port,
    path: "/oauth/callback/fake",
    uri: `http://127.0.0.1:${port}/oauth/callback/fake`,
    redirects: [],
    accept: true,
  };
}

describe("startLoopbackListener", () => {
  it("answers exactly one matching redirect and refuses everything else", async () => {
    const target = await listening();
    const listener = await startLoopbackListener({
      host: "127.0.0.1",
      port: target.port,
      path: target.path,
      uri: target.uri,
      timeoutMs: 5_000,
      onRedirect: async (url) => {
        target.redirects.push(url);

        return { ok: true, message: "OAUTH_CALLBACK_ACCEPTED" };
      },
    });

    try {
      const wrongPath = await fetch(`http://127.0.0.1:${target.port}/nope`);
      const wrongMethod = await fetch(`http://127.0.0.1:${target.port}${target.path}`, {
        method: "POST",
      });

      expect(wrongPath.status).toBe(404);
      expect(wrongMethod.status).toBe(405);
      expect(target.redirects).toHaveLength(0);

      const accepted = await fetch(
        `http://127.0.0.1:${target.port}${target.path}?code=abc&state=def`,
      );

      expect(accepted.status).toBe(200);
      expect(await listener.wait()).toEqual({ ok: true, code: "OAUTH_CALLBACK_ACCEPTED" });
      // The request target is handed over whole; no parameter is echoed back.
      expect(target.redirects).toHaveLength(1);
      expect(target.redirects[0]).toBe(
        `http://127.0.0.1:${target.port}${target.path}?code=abc&state=def`,
      );
      expect(await accepted.text()).not.toContain("abc");

      const replay = await fetch(
        `http://127.0.0.1:${target.port}${target.path}?code=abc&state=def`,
      );

      expect(replay.status).toBe(409);
      expect(target.redirects).toHaveLength(1);
    } finally {
      await listener.close();
    }
  });

  it("turns a refused verdict into a 400 and a failure code", async () => {
    const target = await listening();
    const listener = await startLoopbackListener({
      host: "127.0.0.1",
      port: target.port,
      path: target.path,
      uri: target.uri,
      timeoutMs: 5_000,
      onRedirect: async () => ({ ok: false, message: "OAUTH_CALLBACK_REJECTED" }),
    });

    try {
      const response = await fetch(`http://127.0.0.1:${target.port}${target.path}?code=a&state=b`);

      expect(response.status).toBe(400);
      expect(await listener.wait()).toEqual({ ok: false, code: "OAUTH_CALLBACK_REJECTED" });
    } finally {
      await listener.close();
    }
  });

  it("times out on its own budget and closes", async () => {
    const target = await listening();
    const listener = await startLoopbackListener({
      host: "127.0.0.1",
      port: target.port,
      path: target.path,
      uri: target.uri,
      timeoutMs: 50,
      onRedirect: async () => ({ ok: true, message: "OAUTH_CALLBACK_ACCEPTED" }),
    });

    try {
      expect(await listener.wait()).toEqual({ ok: false, code: "OAUTH_CALLBACK_TIMEOUT" });
    } finally {
      await listener.close();
    }

    await expect(fetch(`http://127.0.0.1:${target.port}${target.path}`)).rejects.toThrow();
  });

  it("releases a wait that is cancelled", async () => {
    const target = await listening();
    const controller = new AbortController();
    const listener = await startLoopbackListener({
      host: "127.0.0.1",
      port: target.port,
      path: target.path,
      uri: target.uri,
      timeoutMs: 5_000,
      signal: controller.signal,
      onRedirect: async () => ({ ok: true, message: "OAUTH_CALLBACK_ACCEPTED" }),
    });

    try {
      controller.abort();
      expect(await listener.wait()).toEqual({ ok: false, code: "OAUTH_CALLBACK_CANCELLED" });
    } finally {
      await listener.close();
    }
  });

  it("rejects when the port is already held instead of pretending to wait", async () => {
    const target = await listening();
    const holder = createServer();

    await new Promise<void>((resolve) =>
      holder.listen({ host: "127.0.0.1", port: target.port }, resolve),
    );

    try {
      await expect(
        startLoopbackListener({
          host: "127.0.0.1",
          port: target.port,
          path: target.path,
          uri: target.uri,
          timeoutMs: 5_000,
          onRedirect: async () => ({ ok: true, message: "OAUTH_CALLBACK_ACCEPTED" }),
        }),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});
