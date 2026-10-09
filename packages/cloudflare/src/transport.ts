import type { ProviderHttpRequest, ProviderHttpResult, ProviderTransport } from '@syndroo/core';

const MAX_BODY = 1_048_576;
function allowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      && !parsed.hash && (!parsed.port || parsed.port === '443')
      && host.includes('.') && !host.endsWith('.')
      && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && !host.includes(':')
      && !/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host)
      && host.length <= 253;
  } catch { return false; }
}

/** Relies on the deployment's global_fetch_strictly_public flag for DNS egress. */
export function createWorkerTransport(fetcher: typeof fetch = fetch): ProviderTransport {
  return {
    async request(input: ProviderHttpRequest): Promise<ProviderHttpResult> {
      if (!allowed(input.url) || (input.body && new TextEncoder().encode(input.body).length > MAX_BODY)) {
        return { type: 'transport_error', stage: 'before_request', code: 'EGRESS_REJECTED' };
      }
      let response: Response;
      try {
        response = await fetcher(input.url, {
          method: input.method, ...(input.headers ? { headers: input.headers } : {}),
          ...(input.body === undefined ? {} : { body: input.body }),
          signal: input.signal, redirect: 'manual',
        });
      } catch {
        return { type: 'transport_error', stage: 'possibly_sent', code: 'NETWORK_UNKNOWN' };
      }
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel();
        return { type: 'transport_error', stage: 'possibly_sent', code: 'REDIRECT_BLOCKED' };
      }
      const reader = response.body?.getReader();
      if (!reader) return { type: 'response', status: response.status, headers: {}, body: '' };
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_BODY) throw new Error('large');
          chunks.push(next.value);
        }
        const data = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        const headers: Record<string, string> = {};
        for (const name of ['content-type', 'retry-after']) {
          const value = response.headers.get(name);
          if (value) headers[name] = value;
        }
        return { type: 'response', status: response.status, headers,
          body: new TextDecoder('utf-8', { fatal: true }).decode(data) };
      } catch {
        void reader.cancel().catch(() => undefined);
        return { type: 'transport_error', stage: 'possibly_sent', code: 'RESPONSE_UNAVAILABLE' };
      } finally { reader.releaseLock(); }
    },
  };
}
