import {
  PublishError,
  type Publisher,
  type PublishRequest,
  type PublishResult,
} from "@syndroo/core";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_POST_BYTES = 3_000;
const MAX_POST_CODE_POINTS = 300;

export interface BlueskyPublisherOptions {
  identifier: string;
  password: string;
  host: string;
  timeoutMs?: number;
}

interface BlueskySession {
  accessJwt: string;
  did: string;
}

interface BlueskyRecord {
  cid: string;
  uri: string;
}

class BlueskyRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly stage: "session" | "publish",
  ) {
    super(message);
    this.name = "BlueskyRequestError";
  }
}

export class BlueskyPublisher implements Publisher {
  readonly name = "bluesky-native";

  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: BlueskyPublisherOptions) {
    if (!options.identifier || !options.password) {
      throw new TypeError("Bluesky identifier and password are required");
    }

    this.baseUrl = normalizeHost(options.host);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    if (request.platform !== "bluesky") {
      throw new PublishError(
        `Bluesky publisher does not support platform: ${request.platform}`,
        "INVALID_CONTENT",
      );
    }

    if (!request.content) {
      throw new PublishError("Bluesky content must not be empty", "INVALID_CONTENT");
    }

    if (
      new TextEncoder().encode(request.content).byteLength > MAX_POST_BYTES ||
      [...request.content].length > MAX_POST_CODE_POINTS
    ) {
      throw new PublishError("Bluesky content exceeds post limits", "INVALID_CONTENT");
    }

    try {
      const session = await this.createSession();
      const response = await this.createRecord(session, request.content);
      const recordKey = response.uri.split("/").at(-1);

      if (!recordKey) {
        throw new PublishError(
          "Bluesky response did not include a record key",
          "UNKNOWN",
          true,
        );
      }

      return {
        externalId: response.cid,
        externalUrl: `https://bsky.app/profile/${encodeURIComponent(session.did)}/post/${encodeURIComponent(recordKey)}`,
      };
    } catch (error) {
      throw normalizeError(error);
    }
  }

  private async createSession(): Promise<BlueskySession> {
    const response = await this.request(
      "/xrpc/com.atproto.server.createSession",
      { identifier: this.options.identifier, password: this.options.password },
      "session",
    );

    if (!isRecord(response) || !isString(response.accessJwt) || !isString(response.did)) {
      throw new PublishError("Invalid Bluesky session response", "UNKNOWN");
    }

    return { accessJwt: response.accessJwt, did: response.did };
  }

  private async createRecord(
    session: BlueskySession,
    content: string,
  ): Promise<BlueskyRecord> {
    const response = await this.request(
      "/xrpc/com.atproto.repo.createRecord",
      {
        repo: session.did,
        collection: "app.bsky.feed.post",
        record: {
          $type: "app.bsky.feed.post",
          text: content,
          createdAt: new Date().toISOString(),
        },
      },
      "publish",
      session.accessJwt,
    );

    if (!isRecord(response) || !isString(response.cid) || !isString(response.uri)) {
      throw new PublishError("Invalid Bluesky publish response", "UNKNOWN", true);
    }

    return { cid: response.cid, uri: response.uri };
  }

  private async request(
    path: string,
    body: object,
    stage: "session" | "publish",
    accessToken?: string,
  ): Promise<unknown> {
    const headers = new Headers({ "content-type": "application/json" });

    if (accessToken) {
      headers.set("authorization", `Bearer ${accessToken}`);
    }

    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new PublishError(
        error instanceof Error ? error.message : "Bluesky network failure",
        "NETWORK",
        stage === "publish",
        error instanceof Error ? { cause: error } : undefined,
      );
    }

    const responseBody = await readJson(response, stage);

    if (!response.ok) {
      const detail = errorDetail(responseBody);
      throw new BlueskyRequestError(
        `${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
        response.status,
        stage,
      );
    }

    return responseBody;
  }
}

function normalizeHost(host: string): string {
  if (!host || host.includes("/") || host.includes("@")) {
    throw new TypeError("Bluesky host must be a hostname without protocol or path");
  }

  const url = new URL(`https://${host}`);

  if (!url.hostname || url.username || url.password || url.pathname !== "/") {
    throw new TypeError("Invalid Bluesky host");
  }

  return url.origin;
}

async function readJson(
  response: Response,
  stage: "session" | "publish",
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);

  if (declaredLength > MAX_RESPONSE_BYTES) {
    throw responseError("Bluesky response exceeded size limit", stage);
  }

  if (!response.body) {
    return undefined;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      length += value.byteLength;

      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel("Response exceeded size limit");
        throw responseError("Bluesky response exceeded size limit", stage);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (bytes.byteLength === 0) {
    return undefined;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new PublishError(
      "Bluesky returned invalid JSON",
      "UNKNOWN",
      stage === "publish",
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function responseError(message: string, stage: "session" | "publish"): PublishError {
  return new PublishError(message, "UNKNOWN", stage === "publish");
}

function normalizeError(error: unknown): PublishError {
  if (error instanceof PublishError) {
    return error;
  }

  if (!(error instanceof BlueskyRequestError)) {
    return new PublishError(
      error instanceof Error ? error.message : "Unknown Bluesky publishing failure",
      "UNKNOWN",
      true,
      error instanceof Error ? { cause: error } : undefined,
    );
  }

  const ambiguous = error.stage === "publish" && error.status >= 500;

  if (error.status === 401 || error.status === 403) {
    return new PublishError(error.message, "AUTH", false, { cause: error });
  }

  if (error.status === 429) {
    return new PublishError(error.message, "RATE_LIMIT", false, { cause: error });
  }

  if (error.status === 400 || error.status === 413 || error.status === 422) {
    return new PublishError(error.message, "INVALID_CONTENT", false, { cause: error });
  }

  if (error.status >= 500) {
    return new PublishError(error.message, "PROVIDER_UNAVAILABLE", ambiguous, {
      cause: error,
    });
  }

  return new PublishError(error.message, "UNKNOWN", error.stage === "publish", {
    cause: error,
  });
}

function errorDetail(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const error = isString(value.error) ? value.error : undefined;
  const message = isString(value.message) ? value.message : undefined;
  return [error, message].filter(isString).join(" - ") || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
