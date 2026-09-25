import {
  PublishError,
  type PlatformAdapter,
  type Publisher,
  type PublishRequest,
  type PublishResult,
} from "@syndroo/core";

const DEFAULT_API_BASE_URL = "https://graph.threads.net";
const MAX_POST_CODE_POINTS = 500;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface ThreadsPublisherOptions {
  accessToken: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
}

class ThreadsRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ThreadsRequestError";
  }
}

export class ThreadsPublisher implements Publisher {
  readonly name = "threads-native";

  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: ThreadsPublisherOptions) {
    if (!options.accessToken.trim()) {
      throw new TypeError("Threads access token is required");
    }

    this.apiBaseUrl = normalizeApiBaseUrl(
      options.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    );
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    if (request.platform !== "threads") {
      throw new PublishError(
        `Threads publisher does not support platform: ${request.platform}`,
        "INVALID_CONTENT",
      );
    }

    if (!request.content.trim()) {
      throw new PublishError("Threads content must not be empty", "INVALID_CONTENT");
    }

    if ([...request.content].length > MAX_POST_CODE_POINTS) {
      throw new PublishError("Threads content exceeds post limits", "INVALID_CONTENT");
    }

    try {
      const body = new URLSearchParams({
        media_type: "TEXT",
        text: request.content,
        auto_publish_text: "true",
      });
      let response: Response;

      try {
        response = await fetch(`${this.apiBaseUrl}/me/threads`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.accessToken}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        throw new PublishError(
          error instanceof Error ? error.message : "Threads network failure",
          "NETWORK",
          true,
          error instanceof Error ? { cause: error } : undefined,
        );
      }

      const responseBody = await readJson(response);

      if (!response.ok) {
        const detail = errorDetail(responseBody);
        throw new ThreadsRequestError(
          `${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
          response.status,
        );
      }

      if (!isRecord(responseBody) || typeof responseBody.id !== "string") {
        throw new PublishError(
          "Threads response did not include a post ID",
          "UNKNOWN",
          true,
        );
      }

      return { externalId: responseBody.id };
    } catch (error) {
      throw normalizeError(error);
    }
  }
}

function normalizeApiBaseUrl(value: string): string {
  const url = new URL(value);

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Threads API base URL must be a clean HTTPS URL");
  }

  return url.toString().replace(/\/$/, "");
}

async function readJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);

  if (declaredLength > MAX_RESPONSE_BYTES) {
    throw new PublishError("Threads response exceeded size limit", "UNKNOWN", true);
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
        throw new PublishError(
          "Threads response exceeded size limit",
          "UNKNOWN",
          true,
        );
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
      "Threads returned invalid JSON",
      "UNKNOWN",
      true,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function errorDetail(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const error = value.error;

  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  return typeof value.message === "string" ? value.message : undefined;
}

function normalizeError(error: unknown): PublishError {
  if (error instanceof PublishError) {
    return error;
  }

  if (!(error instanceof ThreadsRequestError)) {
    return new PublishError(
      error instanceof Error ? error.message : "Unknown Threads publishing failure",
      "UNKNOWN",
      true,
      error instanceof Error ? { cause: error } : undefined,
    );
  }

  if (error.status === 401 || error.status === 403) {
    return new PublishError(error.message, "AUTH", false, { cause: error });
  }

  if (error.status === 429) {
    return new PublishError(error.message, "RATE_LIMIT", false, { cause: error });
  }

  if (error.status === 400 || error.status === 413 || error.status === 422) {
    return new PublishError(error.message, "INVALID_CONTENT", false, {
      cause: error,
    });
  }

  if (error.status >= 500) {
    return new PublishError(error.message, "PROVIDER_UNAVAILABLE", true, {
      cause: error,
    });
  }

  return new PublishError(error.message, "UNKNOWN", true, { cause: error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Platform adapter
// ---------------------------------------------------------------------------


export const threadsAdapter: PlatformAdapter = {
  providerName: "threads-native",

  buildPublisher: (cred) => {
    if (!cred.access_token?.trim()) {
      throw new PublishError("Threads credential is incomplete (access_token)", "AUTH");
    }
    return new ThreadsPublisher({ accessToken: cred.access_token });
  },
};

// ---------------------------------------------------------------------------
// Local (CLI-first) provider
// ---------------------------------------------------------------------------

export { ThreadsLocalProvider } from "./local.js";
export type { ThreadsLocalProviderOptions } from "./local.js";
