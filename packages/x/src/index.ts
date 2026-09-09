import { Client, HttpClient, OAuth1, type HttpClientRequestOptions } from "@xdevplatform/xdk";
import twitterText from "twitter-text";
import { PublishError, type Publisher, type PublishRequest, type PublishResult } from "@syndroo/core";

export interface XPublisherOptions {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
  timeoutMs?: number;
}

// The SDK shares its default transport and create() does not forward request
// options. Override only the transport, per instance, to bound the entire body
// read and avoid mutating the SDK singleton or global fetch.
class PublishingTransport extends HttpClient {
  failure?: PublishError;
  started = false;

  constructor(private readonly timeoutMs: number) {
    super();
  }

  override async request(url: string, options: HttpClientRequestOptions = {}): Promise<Response> {
    if (typeof options.body !== "string") {
      throw new PublishError("X publishing requires a JSON request body", "UNKNOWN");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      this.started = true;
      const response = await fetch(url, {
        method: options.method ?? "POST",
        headers: options.headers ?? {},
        body: options.body,
        signal: controller.signal,
        redirect: "error",
      });
      const limit = 64 * 1024;
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        if (Number(response.headers.get("content-length")) > limit) {
          throw new PublishError("X response exceeded size limit", "UNKNOWN", true);
        }
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > limit) {
              throw new PublishError("X response exceeded size limit", "UNKNOWN", true);
            }
            chunks.push(value);
          }
        }
      } catch (error) {
        await reader?.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader?.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? "AUTH"
          : response.status === 429 ? "RATE_LIMIT"
          : [400, 413, 422].includes(response.status) ? "INVALID_CONTENT"
          : response.status >= 500 ? "PROVIDER_UNAVAILABLE" : "UNKNOWN";
        throw new PublishError(`X request failed (HTTP ${response.status})`, code,
          response.status >= 500 || code === "UNKNOWN");
      }
      // Preserve a malformed success as UNKNOWN/ambiguous, not SDK NETWORK.
      try {
        JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new PublishError("X returned invalid JSON", "UNKNOWN", true);
      }
      return new Response(bytes, { status: response.status, headers: { "content-type": "application/json" } });
    } catch (error) {
      this.failure = error instanceof PublishError ? error
        : new PublishError("X request or response was interrupted", "NETWORK", true);
      throw this.failure;
    } finally {
      clearTimeout(timer);
    }
  }
}

class PublishingClient extends Client {
  override readonly httpClient: PublishingTransport;

  constructor(options: XPublisherOptions) {
    // No OAuth negotiation occurs here; credentials have already been issued.
    super({ oauth1: new OAuth1({ ...options, callback: "oob" }), retry: false });
    this.httpClient = new PublishingTransport(options.timeoutMs ?? 15_000);
  }
}

export class XPublisher implements Publisher {
  readonly name = "x-sdk";

  constructor(private readonly options: XPublisherOptions) {
    if (![options.apiKey, options.apiSecret, options.accessToken, options.accessTokenSecret]
      .every(value => typeof value === "string" && value.trim().length > 0)) {
      throw new TypeError("All four X OAuth 1.0a credentials are required");
    }
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new TypeError("X timeout must be positive");
    }
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const text = request.content.normalize("NFC");
    if (request.platform !== "x" || !text.trim() || !twitterText.parseTweet(text).valid) {
      throw new PublishError("X requires valid text within the 280 weighted-character limit", "INVALID_CONTENT");
    }
    const client = new PublishingClient(this.options);
    try {
      const result = await client.posts.create({ text });
      const id = result?.data?.id;
      if (typeof id !== "string" || !/^\d+$/.test(id)) {
        throw new PublishError("X response did not include a valid post ID", "UNKNOWN", true);
      }
      return { externalId: id, externalUrl: `https://x.com/i/web/status/${id}` };
    } catch (error) {
      if (client.httpClient.failure) throw client.httpClient.failure;
      if (error instanceof PublishError) throw error;
      // SDK response parsing errors may follow an accepted write. Do not expose
      // SDK error details, which can contain request data or credentials.
      throw new PublishError("X SDK publishing failed", "UNKNOWN", client.httpClient.started);
    }
  }
}
