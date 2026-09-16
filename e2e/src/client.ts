import {
  parsePostDetail,
  parsePostList,
  type PostDetail,
  type PostSummary,
} from "./api-types.js";
import type { Harness } from "./harness.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const INITIAL_INTERVAL_MS = 10;
const MAX_INTERVAL_MS = 250;

export interface CreatePostBody {
  content: string;
  platforms: string[];
  overrides?: Record<string, { content?: string }>;
  scheduledAt?: string;
}

export interface ApiResult<T> {
  status: number;
  body: T;
}

export interface WaitOptions {
  /** Bound on total polling time. */
  timeoutMs?: number;
  /** Human-readable description of the awaited state, used in failures. */
  description?: string;
}

/**
 * Thin client for the public HTTP contract. Every read goes through the same
 * Worker entrypoint the tests under test use.
 */
export class SyndrooApi {
  constructor(private readonly harness: Harness) {}

  /**
   * Raw creation result. Callers parse a success body with
   * `parseCreatePostResponse` and can still inspect rejection bodies such as
   * the HTTP 409 idempotency conflict.
   */
  async createPost(
    body: CreatePostBody,
    options: { idempotencyKey?: string } = {},
  ): Promise<ApiResult<unknown>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.harness.apiKey}`,
      "content-type": "application/json",
    };

    if (options.idempotencyKey !== undefined) {
      headers["idempotency-key"] = options.idempotencyKey;
    }

    const response = await this.harness.fetch("/v1/posts", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    return { status: response.status, body: await readJson(response) };
  }

  async getPost(id: string): Promise<ApiResult<PostDetail>> {
    const response = await this.harness.fetch(`/v1/posts/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${this.harness.apiKey}` },
    });
    const body = await readJson(response);

    if (response.status !== 200) {
      throw new Error(
        `Expected HTTP 200 for post ${id}, received ${response.status}: ${JSON.stringify(body)}`,
      );
    }

    return { status: response.status, body: parsePostDetail(body) };
  }

  async listPosts(): Promise<PostSummary[]> {
    const response = await this.harness.fetch("/v1/posts", {
      headers: { authorization: `Bearer ${this.harness.apiKey}` },
    });
    const body = await readJson(response);

    if (response.status !== 200) {
      throw new Error(
        `Expected HTTP 200 for the post list, received ${response.status}: ${JSON.stringify(body)}`,
      );
    }

    return parsePostList(body);
  }

  async getHealth(): Promise<number> {
    const response = await this.harness.fetch("/health");
    return response.status;
  }

  /**
   * Bounded polling helper. It never sleeps for a fixed duration and always
   * reports the observed state plus harness diagnostics on timeout.
   */
  async waitForPost(
    id: string,
    predicate: (post: PostDetail) => boolean,
    options: WaitOptions = {},
  ): Promise<PostDetail> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const description = options.description ?? "the expected post state";
    const deadline = Date.now() + timeoutMs;
    let interval = INITIAL_INTERVAL_MS;
    let last: PostDetail | undefined;

    while (Date.now() < deadline) {
      const result = await this.getPost(id);

      if (result.status === 200) {
        last = result.body;

        if (predicate(result.body)) {
          return result.body;
        }
      }

      await sleep(Math.min(interval, Math.max(1, deadline - Date.now())));
      interval = Math.min(interval * 2, MAX_INTERVAL_MS);
    }

    throw new Error(
      [
        `Timed out after ${timeoutMs}ms waiting for ${description} on post ${id}.`,
        `Last observed post: ${JSON.stringify(last ?? null)}`,
        "Harness diagnostics:",
        this.harness.diagnostics(),
      ].join("\n"),
    );
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();

  try {
    return text === "" ? null : JSON.parse(text);
  } catch {
    throw new Error(
      `Expected JSON from ${response.url || "the Worker"}, received: ${text.slice(0, 200)}`,
    );
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}
