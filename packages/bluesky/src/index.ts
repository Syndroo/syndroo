import { Agent } from "@atproto/api";

import {
  PublishError,
  type PlatformAdapter,
  type Publisher,
  type PublishRequest,
  type PublishResult,
} from "@syndroo/core";

import { createLinkFacets } from "./facets.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_POST_BYTES = 3_000;
const MAX_POST_CODE_POINTS = 300;

export interface BlueskyPublisherOptions {
  identifier: string;
  password: string;
  host: string;
  timeoutMs?: number;
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

    let stage: "session" | "publish" = "session";
    let transportError: unknown;
    // A fresh, stateless SDK client avoids token-refresh retries of a write.
    const agent = new Agent(async (path, init) => {
      try {
        return await this.request(path, init, stage);
      } catch (error) {
        transportError = error;
        throw error;
      }
    });

    try {
      const session = (await agent.com.atproto.server.createSession({
        identifier: this.options.identifier,
        password: this.options.password,
      })).data;
      if (!session.accessJwt || !session.did) {
        throw new PublishError("Invalid Bluesky session response", "UNKNOWN");
      }
      stage = "publish";
      const facets = createLinkFacets(request.content);
      const response = (await agent.com.atproto.repo.createRecord({
        repo: session.did,
        collection: "app.bsky.feed.post",
        record: {
          $type: "app.bsky.feed.post",
          text: request.content,
          createdAt: new Date().toISOString(),
          ...(facets.length > 0 ? { facets } : {}),
        },
      }, { headers: { authorization: `Bearer ${session.accessJwt}` } })).data;
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
      throw normalizeError(transportError ?? error, stage);
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    stage: "session" | "publish",
  ): Promise<Response> {
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        // workerd rejects `redirect: "error"` before dispatching the request.
        // "manual" keeps the same guarantee: the response is inspected and a
        // 3xx is a failure, never a followed hop.
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new PublishError(
        "Bluesky network failure",
        "NETWORK",
        stage === "publish",
        error instanceof Error ? { cause: error } : undefined,
      );
    }

    let responseBody: unknown;
    try {
      responseBody = await readJson(response, stage);
    } catch (error) {
      if (error instanceof PublishError) {
        throw error;
      }
      throw new PublishError(
        "Bluesky response was interrupted", "NETWORK", stage === "publish",
      );
    }

    if (!response.ok) {
      throw new BlueskyRequestError(
        `Bluesky request failed (HTTP ${response.status})`,
        response.status,
        stage,
      );
    }

    return Response.json(responseBody ?? null);
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
    await response.body?.cancel("Response exceeded size limit");
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

function normalizeError(error: unknown, stage: "session" | "publish"): PublishError {
  if (error instanceof PublishError) {
    return error;
  }

  if (!(error instanceof BlueskyRequestError)) {
    return new PublishError(
      "Invalid Bluesky SDK response",
      "UNKNOWN",
      stage === "publish",
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

// ---------------------------------------------------------------------------
// Platform adapter
// ---------------------------------------------------------------------------


export const blueskyAdapter: PlatformAdapter = {
  providerName: "bluesky-native",

  buildPublisher: (cred) => {
    if (!cred.identifier?.trim() || !cred.password?.trim()) {
      throw new PublishError("Bluesky credential is incomplete (identifier, password)", "AUTH");
    }
    return new BlueskyPublisher({
      identifier: cred.identifier,
      password: cred.password,
      host: cred.host?.trim() || "bsky.social",
    });
  },
};

// ---------------------------------------------------------------------------
// Local (CLI-first) provider
// ---------------------------------------------------------------------------

export { BlueskyLocalProvider } from "./local.js";
export type { BlueskyLocalProviderOptions } from "./local.js";
