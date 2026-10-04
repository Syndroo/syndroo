/**
 * Real-process entry for the OAuth signal cleanup test.
 *
 * Runs the real `authorizeMastodon` engine against an in-memory instance stub
 * and a real loopback callback listener, then reports only the bound port on
 * stdout (`PORT=<n>`). The random callback path, state, verifier, code, token,
 * and client secret are never printed.
 *
 * The parent sends SIGINT; the engine's temporary handler aborts the flow,
 * cleanup closes the listener, and this entry exits 130.
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }

      throw error;
    }
  },
});

const INSTANCE = "https://instance.test";

const stubFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url).pathname;
  const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

  if (path === "/.well-known/oauth-authorization-server") {
    return json({
      issuer: INSTANCE,
      authorization_endpoint: `${INSTANCE}/oauth/authorize`,
      token_endpoint: `${INSTANCE}/oauth/token`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code"],
      response_types_supported: ["code"],
    });
  }

  if (path === "/api/v1/apps") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { redirect_uris?: string };
    return json({ client_id: "client-id", client_secret: "client-secret", redirect_uri: body.redirect_uris });
  }

  if (path === "/api/v2/instance") {
    return json({
      configuration: { statuses: { max_characters: 500, characters_reserved_per_url: 23 } },
    });
  }

  return new Response("not found", { status: 404 });
};

try {
  const { authorizeMastodon } = await import("../../src/local/mastodon-oauth.js");

  await authorizeMastodon({
    instance: INSTANCE,
    signal: new AbortController().signal,
    timeoutMs: 300_000,
    confirmRegistration: async () => true,
    fetch: stubFetch as typeof fetch,
    openBrowser: async url => {
      const redirectUri = new URL(url).searchParams.get("redirect_uri") ?? "";
      process.stdout.write(`PORT=${new URL(redirectUri).port}\n`);
    },
  });

  process.exitCode = 0;
} catch (error) {
  const code = (error as { readonly code?: unknown }).code;
  process.exitCode = code === "interrupted" || code === "aborted" ? 130 : 1;
}
