/**
 * RFC 5849 signing vectors (acceptance AUT-07).
 *
 * The percent-encoding table is the normative example from RFC 5849 §3.6. The
 * signature vector uses the canonical OAuth 1.0a example inputs; its expected
 * base string is written out in full below and the expected HMAC-SHA1 value is
 * cross-checked in-test against Node's independent `node:crypto` implementation
 * and, for the recorded constant, against `openssl dgst -sha1 -hmac`.
 */
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  oauth1AuthorizationHeader,
  oauth1Signature,
  oauth1SignatureBaseString,
  percentEncode,
  type OAuth1SigningInput,
} from "../src/index.js";

const canonical: OAuth1SigningInput = {
  method: "POST",
  url: "https://api.twitter.com/1.1/statuses/update.json",
  parameters: [
    ["status", "Hello Ladies + Gentlemen, a signed OAuth request!"],
    ["include_entities", "true"],
  ],
  consumerKey: "xvz1evFS4wEEPTGEFPHBog",
  consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
  token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
  tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
  nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
  timestamp: "1318622958",
};

const expectedBaseString =
  "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&" +
  "include_entities%3Dtrue%26" +
  "oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26" +
  "oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26" +
  "oauth_signature_method%3DHMAC-SHA1%26" +
  "oauth_timestamp%3D1318622958%26" +
  "oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26" +
  "status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521";

/** Recorded from `openssl dgst -sha1 -hmac "<signing key>" -binary | base64`. */
const expectedSignatureFromOpenssl = "PDAgbKh4/K8/Iq0aD2RCV8xh8zc=";

/** The published RFC 5849 `example.com/request` vector (no oauth_version). */
const rfcExample: OAuth1SigningInput = {
  method: "POST",
  url: "http://example.com/request",
  parameters: [
    ["b5", "=%3D"],
    ["a3", "a"],
    ["c@", ""],
    ["a2", "r b"],
    ["a3", "2 q"],
    ["c2", ""],
  ],
  consumerKey: "9djdj82h48djs9d2",
  consumerSecret: "j49sk3j29djd",
  token: "kkk9d7dh3k39sjv7",
  tokenSecret: "dh893hdasih9",
  nonce: "7d8f3e4a",
  timestamp: "137131201",
};

const rfcExampleBaseString =
  "POST&http%3A%2F%2Fexample.com%2Frequest&" +
  "a2%3Dr%2520b%26" +
  "a3%3D2%2520q%26" +
  "a3%3Da%26" +
  "b5%3D%253D%25253D%26" +
  "c%2540%3D%26" +
  "c2%3D%26" +
  "oauth_consumer_key%3D9djdj82h48djs9d2%26" +
  "oauth_nonce%3D7d8f3e4a%26" +
  "oauth_signature_method%3DHMAC-SHA1%26" +
  "oauth_timestamp%3D137131201%26" +
  "oauth_token%3Dkkk9d7dh3k39sjv7";

describe("percentEncode (RFC 5849 §3.6)", () => {
  it.each([
    ["abcABC123", "abcABC123"],
    ["-._~", "-._~"],
    ["%", "%25"],
    ["+", "%2B"],
    ["&=*", "%26%3D%2A"],
    ["\n", "%0A"],
    [" ", "%20"],
    ["!", "%21"],
    ['"', "%22"],
    ["#", "%23"],
    ["$", "%24"],
    ["'", "%27"],
    ["(", "%28"],
    [")", "%29"],
    [",", "%2C"],
    ["/", "%2F"],
    [":", "%3A"],
    [";", "%3B"],
    ["<", "%3C"],
    ["=", "%3D"],
    [">", "%3E"],
    ["?", "%3F"],
    ["@", "%40"],
    ["[", "%5B"],
    ["]", "%5D"],
    ["☃", "%E2%98%83"],
    ["Ladies + Gentlemen", "Ladies%20%2B%20Gentlemen"],
    ["An encoded string!", "An%20encoded%20string%21"],
    ["Dogs, Cats & Mice", "Dogs%2C%20Cats%20%26%20Mice"],
  ])("encodes %j as %s", (input, expected) => {
    expect(percentEncode(input)).toBe(expected);
  });
});

describe("oauth1SignatureBaseString", () => {
  it("builds the canonical example base string", () => {
    expect(oauth1SignatureBaseString(canonical)).toBe(expectedBaseString);
  });

  it("sorts by encoded name then value and double-encodes each pair", () => {
    const base = oauth1SignatureBaseString({
      ...canonical,
      url: "https://example.com/request",
      parameters: [
        ["b", "2 q"],
        ["A", "a"],
        ["c@", ""],
        ["a", "r b"],
      ],
    });
    const parameterSection = base.split("&")[2] ?? "";

    expect(base.startsWith("POST&https%3A%2F%2Fexample.com%2Frequest&")).toBe(true);
    expect(parameterSection.startsWith(
      "A%3Da%26a%3Dr%2520b%26b%3D2%2520q%26c%2540%3D%26",
    )).toBe(true);
    expect(parameterSection).toContain("oauth_signature_method%3DHMAC-SHA1");
    expect(parameterSection).toContain(
      "oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog",
    );
  });

  it("collects URL query parameters, keeping duplicates and empty values", () => {
    const base = oauth1SignatureBaseString({
      ...canonical,
      url: "https://example.com/request?a=1&a=2&b=",
      parameters: [],
    });
    const parameterSection = base.split("&")[2] ?? "";

    expect(parameterSection.startsWith("a%3D1%26a%3D2%26b%3D%26")).toBe(true);
  });

  it("excludes an oauth_signature that arrives as a query or form parameter", () => {
    const base = oauth1SignatureBaseString({
      ...canonical,
      url: "https://example.com/request?oauth_signature=stale-query",
      parameters: [["oauth_signature", "stale-form"]],
    });

    expect(base).not.toContain("stale-query");
    expect(base).not.toContain("stale-form");
  });

  it("refuses an oauth_signature passed as an extra protocol parameter", () => {
    expect(() =>
      oauth1SignatureBaseString({
        ...canonical,
        oauthParameters: [["oauth_signature", "must-not-be-signed"]],
      }),
    ).toThrow(TypeError);
  });
});

describe("oauth1Signature", () => {
  it("reproduces the published RFC 5849 signature vector", async () => {
    expect(oauth1SignatureBaseString(rfcExample)).toBe(rfcExampleBaseString);
    await expect(oauth1Signature(rfcExample)).resolves.toBe(
      "r6/TJjbCOr97/+UU0NsvSne7s5g=",
    );
  });

  it("matches the recorded HMAC-SHA1 vector", async () => {
    await expect(oauth1Signature(canonical)).resolves.toBe(
      expectedSignatureFromOpenssl,
    );
  });

  it("matches an independent node:crypto HMAC over the same base string", async () => {
    const key = `${percentEncode(canonical.consumerSecret)}&${percentEncode(canonical.tokenSecret!)}`;
    const independent = createHmac("sha1", key)
      .update(oauth1SignatureBaseString(canonical))
      .digest("base64");

    await expect(oauth1Signature(canonical)).resolves.toBe(independent);
  });

  it("changes when a parameter changes", async () => {
    const other = oauth1SignatureBaseString({
      ...canonical,
      parameters: [["status", "different"]],
    });

    expect(other).not.toBe(expectedBaseString);
    await expect(oauth1Signature(canonical)).resolves.not.toBe(
      await oauth1Signature({
        ...canonical,
        parameters: [["status", "different"]],
      }),
    );
  });
});

describe("oauth1AuthorizationHeader", () => {
  it("emits a sorted OAuth header with percent-encoded values", async () => {
    const header = await oauth1AuthorizationHeader(canonical);

    expect(header.startsWith("OAuth ")).toBe(true);
    expect(header).toContain('oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog"');
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(header).toContain(
      `oauth_signature="${percentEncode(expectedSignatureFromOpenssl)}"`,
    );
    expect(header).not.toContain("status=");
    expect(header).not.toContain(canonical.consumerSecret);

    const keys = [...header.matchAll(/(oauth_[a-z_]+)=/g)].map(match => match[1] ?? "");
    expect(keys).toEqual([
      "oauth_consumer_key",
      "oauth_nonce",
      "oauth_signature",
      "oauth_signature_method",
      "oauth_timestamp",
      "oauth_token",
    ]);
  });

  it("signs and emits extra OAuth protocol parameters", async () => {
    const input: OAuth1SigningInput = {
      ...canonical,
      oauthParameters: [
        ["oauth_callback", "https://cb.example/hook"],
        ["oauth_verifier", "v1"],
      ],
    };

    expect(oauth1SignatureBaseString(input)).toContain(
      "oauth_callback%3Dhttps%253A%252F%252Fcb.example%252Fhook",
    );

    const header = await oauth1AuthorizationHeader(input);
    expect(header).toContain('oauth_callback="https%3A%2F%2Fcb.example%2Fhook"');
    expect(header).toContain('oauth_verifier="v1"');
  });

  it("does not claim an oauth_version that was never sent", async () => {
    const header = await oauth1AuthorizationHeader(canonical);

    expect(header).not.toContain("oauth_version");
  });

  it("omits a token when none was issued yet", async () => {
    const { token: _token, tokenSecret: _tokenSecret, ...withoutToken } = canonical;
    const header = await oauth1AuthorizationHeader(withoutToken);

    expect(header).not.toContain("oauth_token=");
    await expect(oauth1Signature(withoutToken)).resolves.not.toBe(
      expectedSignatureFromOpenssl,
    );
  });
});

describe("oauth1 extra protocol parameters", () => {
  it("rejects parameters that would override a core OAuth parameter", () => {
    for (const name of [
      "oauth_consumer_key",
      "oauth_nonce",
      "oauth_signature",
      "oauth_signature_method",
      "oauth_timestamp",
      "oauth_token",
      "realm",
    ]) {
      expect(() =>
        oauth1SignatureBaseString({
          ...canonical,
          oauthParameters: [[name, "override"]],
        }),
      ).toThrow(TypeError);
    }
  });

  it("rejects unsupported or duplicated extra OAuth parameters", () => {
    expect(() =>
      oauth1SignatureBaseString({
        ...canonical,
        oauthParameters: [["oauth_body_hash", "x"]],
      }),
    ).toThrow(TypeError);

    expect(() =>
      oauth1SignatureBaseString({
        ...canonical,
        oauthParameters: [
          ["oauth_verifier", "a"],
          ["oauth_verifier", "b"],
        ],
      }),
    ).toThrow(TypeError);
  });
});

describe("oauth1 realm handling", () => {
  it("signs an ordinary realm query parameter", () => {
    const base = oauth1SignatureBaseString({
      ...canonical,
      url: "https://example.com/request?realm=photos",
      parameters: [],
    });

    expect(base).toContain("realm%3Dphotos");
  });

  it("signs an ordinary realm form parameter", () => {
    const base = oauth1SignatureBaseString({
      ...canonical,
      parameters: [["realm", "photos"]],
    });

    expect(base).toContain("realm%3Dphotos");
  });

  it("never emits a realm protocol parameter in the header", async () => {
    const header = await oauth1AuthorizationHeader(canonical);

    expect(header).not.toContain("realm=");
  });
});
