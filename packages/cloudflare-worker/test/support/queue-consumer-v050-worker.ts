/**
 * Minimal Worker entry for the dedicated queue-consumer test project.
 *
 * The mapping slice handles no inbound request; this stub exists so the
 * cloudflare test pool can start without pulling the legacy Worker entry graph
 * (and its unrelated `Env` type errors).
 */

export default {
  fetch(): Response {
    return new Response("queue-consumer-v050", { status: 404 });
  },
} satisfies ExportedHandler;
