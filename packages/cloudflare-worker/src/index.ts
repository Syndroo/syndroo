import type { PublicationJob } from "@syndroo/core";

import { routeApi } from "./api.js";
import { ApiError, json } from "./http.js";
import { consumePublications } from "./jobs.js";
import { schedulePublications } from "./scheduler.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await routeApi(request, env);
    } catch (error) {
      if (error instanceof ApiError) {
        return json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      }

      console.error(
        JSON.stringify({
          event: "request_failed",
          method: request.method,
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );

      return json(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "Internal server error",
          },
        },
        500,
      );
    }
  },

  async queue(
    batch: MessageBatch<PublicationJob>,
    env: Env,
  ): Promise<void> {
    await consumePublications(batch, env);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await schedulePublications(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env, PublicationJob>;
