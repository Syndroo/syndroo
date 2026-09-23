/**
 * Minimal Worker entry for the dedicated composition test project.
 *
 * The composition slice handles no inbound request; this stub exists so the
 * cloudflare test pool can start without pulling the legacy Worker entry graph
 * (which still carries two unrelated `Env` type errors).
 */

export default {
  fetch(): Response {
    return new Response("runtime-dependencies-v050", { status: 404 });
  },
} satisfies ExportedHandler;
