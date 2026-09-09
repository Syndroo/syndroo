import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    miniflare: {
      compatibilityDate: "2026-09-03",
      compatibilityFlags: ["nodejs_compat"],
      // Intercept every outbound request; this experiment never reaches Tumblr.
      outboundService: async request => {
        const url = new URL(request.url);
        if (url.origin !== "https://api.tumblr.com" || request.method !== "POST") {
          throw new Error("Unexpected outbound request");
        }
        const authorization = request.headers.get("authorization") ?? "";
        const body = await request.json();
        if (url.pathname.includes("/unavailable/")) {
          return Response.json({ meta: { status: 503, msg: "Unavailable" } }, { status: 503 });
        }
        if (url.pathname.includes("/delayed/")) await new Promise(resolve => setTimeout(resolve, 100));
        return Response.json({ meta: { status: 201 }, response: {
          id: "123", body, signed: authorization.startsWith("OAuth ") && authorization.includes("oauth_signature="),
          padding: url.pathname.includes("/large/") ? "x".repeat(65_537) : "",
        } }, { status: 201 });
      },
    },
  })],
});
