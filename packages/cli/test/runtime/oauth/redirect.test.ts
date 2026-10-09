import { describe, expect, it } from "vitest";

import { OAuthError } from "../../../src/runtime/oauth/errors.js";
import {
  defaultRedirectUri,
  parseCallbackUrl,
  parseRedirectUri,
} from "../../../src/runtime/oauth/redirect.js";

/**
 * Redirect-URI classification, asserted directly.
 *
 * Every check here is the *only* place a redirect shape is accepted, so a case
 * that must be refused is proved refused rather than assumed.
 */

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OAuthError);

    return (error as OAuthError).code;
  }

  throw new Error("expected the call to refuse");
}

describe("defaultRedirectUri", () => {
  it("is the pre-registerable loopback redirect for exactly one provider", () => {
    expect(defaultRedirectUri("linkedin")).toBe(
      "http://127.0.0.1:8765/oauth/callback/linkedin",
    );
    expect(defaultRedirectUri("mastodon", 9000)).toBe(
      "http://127.0.0.1:9000/oauth/callback/mastodon",
    );
  });

  it("refuses a provider id the path could not carry", () => {
    expect(codeOf(() => defaultRedirectUri("LinkedIn"))).toBe("PROVIDER_ID_INVALID");
  });
});

describe("parseRedirectUri", () => {
  it("classifies a loopback URI with its exact host, port and path", () => {
    expect(parseRedirectUri("http://127.0.0.1:8765/oauth/callback/linkedin")).toEqual({
      kind: "loopback",
      uri: "http://127.0.0.1:8765/oauth/callback/linkedin",
      host: "127.0.0.1",
      port: 8765,
      path: "/oauth/callback/linkedin",
    });
    expect(parseRedirectUri("http://[::1]:8765/cb")).toMatchObject({ kind: "loopback", host: "::1" });
    expect(parseRedirectUri("http://localhost:8765/cb")).toMatchObject({
      kind: "loopback",
      host: "localhost",
    });
    expect(parseRedirectUri("https://127.0.0.1:8080/callback")).toMatchObject({
      kind: "loopback",
      port: 8080,
      path: "/callback",
    });
  });

  it("classifies a non-loopback HTTPS URI as remote and binds nothing for it", () => {
    expect(parseRedirectUri("https://app.example/oauth/callback")).toEqual({
      kind: "remote",
      uri: "https://app.example/oauth/callback",
      hostname: "app.example",
    });
  });

  it("refuses a remote plaintext redirect, which would carry the code in the clear", () => {
    expect(codeOf(() => parseRedirectUri("http://app.example/cb"))).toBe("REDIRECT_URI_INVALID");
  });

  it("refuses every wildcard address: only a loopback literal may be bound", () => {
    expect(codeOf(() => parseRedirectUri("http://0.0.0.0:8765/cb"))).toBe("REDIRECT_URI_INVALID");
    expect(codeOf(() => parseRedirectUri("http://[::]:8765/cb"))).toBe("REDIRECT_URI_INVALID");
  });

  it("refuses a loopback URI without an explicit, pre-registerable port", () => {
    expect(codeOf(() => parseRedirectUri("http://127.0.0.1/cb"))).toBe("REDIRECT_URI_INVALID");
    expect(codeOf(() => parseRedirectUri("http://127.0.0.1:0/cb"))).toBe("REDIRECT_URI_INVALID");
  });

  it("refuses userinfo, a query, a fragment and a root-only path", () => {
    expect(codeOf(() => parseRedirectUri("https://user@app.example/cb"))).toBe("REDIRECT_URI_INVALID");
    expect(codeOf(() => parseRedirectUri("https://app.example/cb?x=1"))).toBe("REDIRECT_URI_INVALID");
    expect(codeOf(() => parseRedirectUri("https://app.example/cb#f"))).toBe("REDIRECT_URI_INVALID");
    expect(codeOf(() => parseRedirectUri("https://app.example/"))).toBe("REDIRECT_URI_INVALID");
    expect(codeOf(() => parseRedirectUri("not a url"))).toBe("REDIRECT_URI_INVALID");
  });
});

describe("parseCallbackUrl", () => {
  it("accepts one absolute URL and nothing looser", () => {
    expect(parseCallbackUrl("http://127.0.0.1:8765/cb?code=x&state=y").searchParams.get("code")).toBe("x");
  });

  it("refuses empty, whitespace-bearing and non-URL values", () => {
    expect(codeOf(() => parseCallbackUrl(""))).toBe("CALLBACK_URL_INVALID");
    expect(codeOf(() => parseCallbackUrl("http://x/cb?code=a b"))).toBe("CALLBACK_URL_INVALID");
    expect(codeOf(() => parseCallbackUrl("code=abc&state=def"))).toBe("CALLBACK_URL_INVALID");
    expect(codeOf(() => parseCallbackUrl(`http://x/${"a".repeat(9000)}`))).toBe("CALLBACK_URL_INVALID");
  });
});
