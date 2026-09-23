/**
 * Minimal Worker entry for the dedicated scheduled-maintenance test project.
 *
 * The deadline wrapper handles no inbound request; this stub exists so the
 * cloudflare test pool can start without loading the legacy Worker entry graph
 * (and its unrelated `Env` type errors).
 */

export default {
  fetch(): Response {
    return new Response("scheduled-maintenance-v050", { status: 404 });
  },
} satisfies ExportedHandler;
