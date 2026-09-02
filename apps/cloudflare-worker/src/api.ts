import type { PublicationJob } from "@syndroo/core";

import { ApiError, json, readJsonBody, requireBearer } from "./http.js";
import { createPost, parseCreatePost } from "./posts.js";
import { D1Repository } from "./repository.js";

export async function routeApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ status: "ok" });
  }

  if (!url.pathname.startsWith("/v1/")) {
    return json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
  }

  await requireBearer(request, env.SYNDROO_API_KEY);
  const repository = new D1Repository(env.DB);

  if (request.method === "POST" && url.pathname === "/v1/posts") {
    const input = parseCreatePost(await readJsonBody(request));
    const result = await createPost(
      input,
      repository,
      env.PUBLICATION_QUEUE as Queue<PublicationJob>,
      new Date(),
    );
    return json(result, 202);
  }

  if (request.method === "GET" && url.pathname === "/v1/posts") {
    const limit = parseLimit(url.searchParams.get("limit"));
    return json({ items: await repository.listPosts(limit) });
  }

  if (request.method === "GET") {
    const match = /^\/v1\/posts\/([^/]+)$/.exec(url.pathname);

    if (match?.[1]) {
      const post = await repository.getPost(decodeURIComponent(match[1]));

      if (!post) {
        throw new ApiError("Post not found", 404, "POST_NOT_FOUND");
      }

      return json(post);
    }
  }

  return json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
}

function parseLimit(value: string | null): number {
  if (value === null) {
    return 50;
  }

  const limit = Number(value);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(
      "limit must be an integer between 1 and 100",
      400,
      "INVALID_REQUEST",
    );
  }

  return limit;
}
