/**
 * Shared trace protocol between the L1 preload and the runner.
 *
 * The preload appends one JSON object per line; the runner reads the file after
 * each child exits. Only destination host, port, method, and a coarse path class
 * are recorded: never a query, header, credential, code, or state value.
 */

export type TraceEvent =
  | { readonly kind: "bootstrap" }
  | { readonly kind: "end" }
  | { readonly kind: "dns"; readonly host: string }
  | { readonly kind: "pinned-lookup"; readonly host: string; readonly addresses: readonly string[] }
  | { readonly kind: "connect"; readonly host: string; readonly port: number; readonly allowed: boolean }
  | { readonly kind: "http"; readonly host: string; readonly port: number; readonly method: string; readonly pathClass: string }
  | { readonly kind: "tls"; readonly host: string; readonly servername: string | null }
  | { readonly kind: "child"; readonly command: string }
  | { readonly kind: "env"; readonly name: string; readonly credential: boolean }
  | { readonly kind: "fswrite"; readonly path: string }
  | { readonly kind: "fsread"; readonly path: string }
  | { readonly kind: "reject"; readonly what: string; readonly detail: string };

export type TraceKind = TraceEvent["kind"];

/** First three path segments only; the query is dropped entirely. */
export function pathClassOf(pathname: string): string {
  const parts = pathname.split("?")[0]!.split("/").filter(part => part.length > 0);

  return `/${parts.slice(0, 3).join("/")}`;
}

export function countKinds(events: readonly TraceEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const event of events) {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  }

  return counts;
}

/** Events that prove a network attempt of any kind. */
export const NETWORK_KINDS: readonly TraceKind[] = ["dns", "connect", "http", "tls", "reject"];

export function networkEvents(events: readonly TraceEvent[]): readonly TraceEvent[] {
  return events.filter(event => NETWORK_KINDS.includes(event.kind));
}
