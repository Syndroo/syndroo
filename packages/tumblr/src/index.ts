import { PublishError, type Publisher, type PublishRequest, type PublishResult } from "@syndroo/core";

export interface TumblrPublisherOptions {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
  blog: string;
  timeoutMs?: number;
}

// Accept a Tumblr blog name or its tumblr.com hostname, never an arbitrary URL.
export function normalizeTumblrBlog(value: string): string {
  const name = value.trim().toLowerCase().replace(/\.tumblr\.com$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new TypeError("Tumblr blog must be a blog name or tumblr.com hostname");
  }
  return name;
}

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g,
  char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

// This signer is deliberately limited to our fixed POST endpoint with JSON,
// no query parameters. JSON body fields are not OAuth 1.0 signature parameters.
async function authorization(url: string, options: TumblrPublisherOptions): Promise<string> {
  const params: Record<string, string> = {
    oauth_consumer_key: options.consumerKey,
    oauth_nonce: crypto.randomUUID().replaceAll("-", ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: options.token,
    oauth_version: "1.0",
  };
  const normalized = Object.keys(params).sort().map(key => `${encode(key)}=${encode(params[key]!)}`).join("&");
  const base = `POST&${encode(url)}&${encode(normalized)}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw",
    encoder.encode(`${encode(options.consumerSecret)}&${encode(options.tokenSecret)}`),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(base));
  params.oauth_signature = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return "OAuth " + Object.keys(params).sort().map(key => `${encode(key)}="${encode(params[key]!)}"`).join(", ");
}

export class TumblrPublisher implements Publisher {
  readonly name = "tumblr-native";
  private readonly blog: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: TumblrPublisherOptions) {
    if (![options.consumerKey, options.consumerSecret, options.token, options.tokenSecret]
      .every(value => typeof value === "string" && value.trim())) {
      throw new TypeError("All four Tumblr OAuth credentials are required");
    }
    this.blog = normalizeTumblrBlog(options.blog);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new TypeError("Tumblr timeout must be positive");
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    // v0.1 intentionally uses one NPF text block, not HTML or Markdown.
    if (request.platform !== "tumblr" || !request.content.trim() || [...request.content].length > 4096) {
      throw new PublishError("Tumblr requires text within 4096 Unicode code points", "INVALID_CONTENT");
    }
    const url = `https://api.tumblr.com/v2/blog/${this.blog}.tumblr.com/posts`;
    let auth: string;
    try {
      auth = await authorization(url, this.options);
    } catch {
      throw new PublishError("Tumblr request signing failed", "UNKNOWN");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { authorization: auth, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ state: "published", send_to_twitter: false,
          content: [{ type: "text", text: request.content }] }),
      });
      // Classify explicit HTTP failures without retaining provider error text.
      if (!response.ok) {
        await response.body?.cancel();
        const status = response.status;
        const code = status === 401 || status === 403 || status === 404 ? "AUTH"
          : status === 429 ? "RATE_LIMIT"
          : [400, 413, 422].includes(status) ? "INVALID_CONTENT"
          : status >= 500 ? "PROVIDER_UNAVAILABLE" : "UNKNOWN";
        throw new PublishError(`Tumblr request failed (HTTP ${status})`, code,
          status >= 500 || code === "UNKNOWN");
      }
      const body = await readJson(response, controller.signal);
      if (!isRecord(body) || !isRecord(body.meta) || body.meta.status !== 201 ||
        response.status !== 201 || !isRecord(body.response) ||
        typeof body.response.id !== "string" || !/^\d+$/.test(body.response.id)) {
        throw new PublishError("Tumblr response did not confirm a created post", "UNKNOWN", true);
      }
      return { externalId: body.response.id, externalUrl: `https://${this.blog}.tumblr.com/post/${body.response.id}` };
    } catch (error) {
      if (error instanceof PublishError) throw error;
      throw new PublishError("Tumblr request or response was interrupted", "NETWORK", true);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const limit = 64 * 1024;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new PublishError("Tumblr response exceeded size limit", "UNKNOWN", true);
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  // Also cancel mocked/custom streams that do not inherit fetch's signal.
  const abort = () => { void reader?.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (reader) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new PublishError("Tumblr response exceeded size limit", "UNKNOWN", true);
      chunks.push(value);
    }
  } catch (error) {
    await reader?.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader?.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new PublishError("Tumblr returned invalid JSON", "UNKNOWN", true); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
