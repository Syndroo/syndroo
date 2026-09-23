/**
 * OAuth 1.0a request signing per RFC 5849.
 *
 * Nonce and timestamp are inputs so signatures are deterministic and can be
 * checked against published vectors. This module signs requests only: it never
 * performs a request and never retries.
 */
export type OAuth1SignatureMethod = "HMAC-SHA1";

export interface OAuth1SigningInput {
  readonly method: string;
  readonly url: string;
  /**
   * Form-body parameters (`application/x-www-form-urlencoded`) or any other
   * protocol parameters the caller sends. Query parameters are read from `url`
   * and merged automatically; duplicates and empty values are preserved.
   */
  readonly parameters?: readonly (readonly [string, string])[];
  /**
   * Additional OAuth protocol parameters to sign and emit, for example
   * `oauth_callback` or `oauth_verifier`. They are part of the header, so a
   * parameter is never signed without being sent.
   */
  readonly oauthParameters?: readonly (readonly [string, string])[];
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly token?: string;
  readonly tokenSecret?: string;
  /** Seconds since the epoch, as a decimal string. */
  readonly timestamp: string;
  readonly nonce: string;
  readonly signatureMethod?: OAuth1SignatureMethod;
}

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/** Protocol parameters this module always supplies itself. */
const CORE_OAUTH_PARAMETERS = new Set([
  "oauth_consumer_key",
  "oauth_nonce",
  "oauth_signature",
  "oauth_signature_method",
  "oauth_timestamp",
  "oauth_token",
  "realm",
]);

/** Additional OAuth protocol parameters callers may supply today. */
const ALLOWED_EXTRA_OAUTH_PARAMETERS = new Set([
  "oauth_callback",
  "oauth_verifier",
  "oauth_version",
]);

function validateExtraOAuthParameters(
  parameters: readonly (readonly [string, string])[],
): void {
  const seen = new Set<string>();

  for (const [name] of parameters) {
    if (CORE_OAUTH_PARAMETERS.has(name)) {
      throw new TypeError(`oauthParameters must not override ${name}`);
    }

    if (!ALLOWED_EXTRA_OAUTH_PARAMETERS.has(name)) {
      throw new TypeError(`Unsupported OAuth protocol parameter: ${name}`);
    }

    if (seen.has(name)) {
      throw new TypeError(`Duplicate OAuth protocol parameter: ${name}`);
    }

    seen.add(name);
  }
}

/** RFC 5849 §3.6 percent-encoding over UTF-8 bytes with uppercase hex. */
export function percentEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let encoded = "";

  for (const byte of bytes) {
    const character = String.fromCharCode(byte);
    encoded += UNRESERVED.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }

  return encoded;
}

/** RFC 5849 §3.4.1.2 base string URI: lowercase scheme/host, no default port, no query. */
export function oauth1BaseStringUri(url: string): string {
  const parsed = new URL(url);
  const isDefaultPort =
    parsed.port === "" ||
    (parsed.protocol === "https:" && parsed.port === "443") ||
    (parsed.protocol === "http:" && parsed.port === "80");
  const port = isDefaultPort ? "" : `:${parsed.port}`;

  return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${port}${parsed.pathname}`;
}

/** RFC 5849 §3.4.1.1 signature base string. */
export function oauth1SignatureBaseString(input: OAuth1SigningInput): string {
  // RFC 5849 §3.4.1.3.1: query parameters, form parameters and the OAuth
  // protocol parameters are collected together, excluding oauth_signature and
  // oauth_realm. `oauth_version` is not implied: the published vector has none.
  const query = [...new URL(input.url).searchParams.entries()];
  const extraOAuthParameters = input.oauthParameters ?? [];
  validateExtraOAuthParameters(extraOAuthParameters);

  const protocolParameters: Array<readonly [string, string]> = [
    ["oauth_consumer_key", input.consumerKey],
    ["oauth_nonce", input.nonce],
    ["oauth_signature_method", input.signatureMethod ?? "HMAC-SHA1"],
    ["oauth_timestamp", input.timestamp],
    ...(input.token === undefined
      ? []
      : ([["oauth_token", input.token]] as Array<readonly [string, string]>)),
    ...extraOAuthParameters,
  ];

  // `oauth_signature` is excluded wherever it appears. `realm` is only excluded
  // as a protocol parameter (RFC 5849 §3.4.1.3.1); an ordinary query or form
  // parameter named `realm` is a normal parameter and must be signed.
  const encoded = [...query, ...(input.parameters ?? [])]
    .filter(([name]) => name !== "oauth_signature")
    .concat(protocolParameters.filter(([name]) => name !== "oauth_signature" && name !== "realm"))
    .map(([name, value]) => [percentEncode(name), percentEncode(value)] as const);

  const sorted = [...encoded].sort((left, right) => {
    if (left[0] !== right[0]) {
      return left[0] < right[0] ? -1 : 1;
    }

    if (left[1] !== right[1]) {
      return left[1] < right[1] ? -1 : 1;
    }

    return 0;
  });

  const normalized = sorted.map(([name, value]) => `${name}=${value}`).join("&");

  return [
    input.method.toUpperCase(),
    percentEncode(oauth1BaseStringUri(input.url)),
    percentEncode(normalized),
  ].join("&");
}

/** RFC 5849 §3.4.2 HMAC-SHA1 signature, base64 encoded. */
export async function oauth1Signature(input: OAuth1SigningInput): Promise<string> {
  const key = `${percentEncode(input.consumerSecret)}&${percentEncode(input.tokenSecret ?? "")}`;
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(oauth1SignatureBaseString(input)),
  );

  return base64(new Uint8Array(signature));
}

/** Authorization header carrying the protocol parameters and signature. */
export async function oauth1AuthorizationHeader(
  input: OAuth1SigningInput,
): Promise<string> {
  const signature = await oauth1Signature(input);
  const parameters: Array<readonly [string, string]> = [
    ["oauth_consumer_key", input.consumerKey],
    ["oauth_nonce", input.nonce],
    ["oauth_signature", signature],
    ["oauth_signature_method", input.signatureMethod ?? "HMAC-SHA1"],
    ["oauth_timestamp", input.timestamp],
    ...(input.token === undefined
      ? []
      : ([["oauth_token", input.token]] as Array<readonly [string, string]>)),
    ...(input.oauthParameters ?? []),
  ];
  const header = [...parameters]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([name, value]) => `${percentEncode(name)}="${percentEncode(value)}"`)
    .join(", ");

  return `OAuth ${header}`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}
