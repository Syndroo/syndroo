/**
 * Local-D1 harness for the shared port contract suite.
 *
 * It exposes exactly the surface the shared scenarios need, including the
 * residual-secret fixture, so the same scenarios run here as on the in-memory
 * fake. Nothing here touches real accounts, `.dev.vars` or remote resources:
 * everything runs against the isolated workerd D1 binding.
 */

import { env } from "cloudflare:workers";
import type { StoreHarness } from "@syndroo/application/testing";

import { D1Repository, type D1MetricsEvent } from "../../src/infrastructure/d1/repository.js";

export interface D1Harness extends StoreHarness {
  readonly repository: D1Repository;
  /** Mutable array behind a readonly property so tests can reset counters. */
  readonly metrics: D1MetricsEvent[];
  readonly db: D1Database;
}

export async function clearV050Tables(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM outbox_jobs"),
    env.DB.prepare("DELETE FROM publications"),
    env.DB.prepare("DELETE FROM posts"),
    env.DB.prepare("DELETE FROM credentials"),
    env.DB.prepare("DELETE FROM oauth_state"),
  ]);
}

export function createD1Harness(): D1Harness {
  const metrics: D1MetricsEvent[] = [];
  const repository = new D1Repository(env.DB, {
    metrics: {
      observe(event) {
        metrics.push(event);
      },
    },
  });
  return {
    repository,
    metrics,
    db: env.DB,
    publishing: repository,
    outbox: repository,
    credentials: repository,
    diagnostics: repository,
    async reset() {
      await clearV050Tables();
    },
    async placeResidualSecrets(input) {
      await env.DB.prepare(
        `UPDATE oauth_state
         SET request_secret_envelope = ?, candidate_envelope = ?, updated_at = ?
         WHERE operation_id = ?`,
      )
        .bind(
          JSON.stringify(input.requestSecret),
          JSON.stringify(input.candidateSecret),
          input.now,
          input.operationId,
        )
        .run();
    },
  };
}
