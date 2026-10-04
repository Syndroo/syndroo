import { localDisplayName, type LocalIdentity, LocalProviderError, type LocalCredentials, type LocalProvider, type TargetBinding, type FrozenDelivery, type ProviderOutcome, type PreparedTarget } from "@syndroo/core";
import { plainCommentary } from "./text.js";

const PERSON = /^urn:li:person:[A-Za-z0-9_-]+$/;
const VERSION = /^20\d{2}(?:0[1-9]|1[0-2])$/;
const ORIGIN = "https://api.linkedin.com";
const failed = (code: string, retryable = false, retryNotBefore: string | null = null): ProviderOutcome =>
  ({ kind: "failed", code, writeDisposition: "not_applied", retryable, retryNotBefore });
const unknown = (code: string): ProviderOutcome => ({ kind: "unknown", code, writeDisposition: "unknown" });

function readCredentials(value: LocalCredentials): Extract<LocalCredentials, { provider: "linkedin" }> {
  if (value.provider !== "linkedin" || !/^[\x21-\x7e]+$/.test(value.accessToken) ||
      !PERSON.test(value.author) || !VERSION.test(value.apiVersion)) throw new LocalProviderError("AUTH");
  return { ...value };
}
function commentary(content: string): string {
  if (typeof content !== "string" || !content.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)) throw new LocalProviderError("INVALID_CONTENT");
  const text = plainCommentary(content);
  if (text.length > 3000) throw new LocalProviderError("INVALID_CONTENT");
  return text;
}
function payload(content: string): Readonly<Record<string, unknown>> {
  return {
    commentary: commentary(content), visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
  };
}
function samePayload(value: unknown, expected: unknown): boolean {
  if (value === expected) return true;
  if (typeof value !== "object" || value === null || typeof expected !== "object" || expected === null) return false;
  if (Array.isArray(value) !== Array.isArray(expected)) return false;
  const a = value as Record<string, unknown>, b = expected as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && samePayload(a[key], b[key]));
}

/** Personal accounts only. No endpoint overrides or internal retries. */
export class LinkedInLocalProvider implements LocalProvider {
  readonly provider = "linkedin" as const;
  private readonly transport: typeof fetch;
  private readonly timeoutMs: number;
  constructor(options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.transport = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new TypeError("LinkedIn timeout must be positive");
  }
  describe() { return { provider: this.provider, maturity: "fixture-tested" as const, localPublish: true as const, unavailableReason: null }; }
  freeze(content: string, createdAt: string) {
    if (typeof createdAt !== "string" || !createdAt) throw new LocalProviderError("INVALID_CONTENT");
    return { payloadVersion: 1, payload: payload(content) };
  }
  async verifyIdentity(credentials: LocalCredentials, signal: AbortSignal): Promise<LocalIdentity> {
    const credential = readCredentials(credentials);
    if (signal.aborted) throw new LocalProviderError("ABORTED");
    try {
      return await this.bounded(signal, async abort => {
        const response = await this.transport(ORIGIN + "/v2/userinfo", {
          method: "GET", redirect: "manual", signal: abort,
          headers: { authorization: "Bearer " + credential.accessToken, accept: "application/json" },
        });
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => undefined);
          throw new LocalProviderError(response.status === 401 || response.status === 403 ? "AUTH" : "PROVIDER_UNAVAILABLE");
        }
        if (Number(response.headers.get("content-length")) > 65_536) {
          void response.body?.cancel().catch(() => undefined);
          throw new LocalProviderError("PROVIDER_UNAVAILABLE");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new LocalProviderError("PROVIDER_UNAVAILABLE");
        const onAbort = () => { void reader.cancel().catch(() => undefined); };
        abort.addEventListener("abort", onAbort, { once: true });
        let length = 0; const chunks: Uint8Array[] = [];
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            length += part.value.byteLength;
            if (length > 65_536) throw new LocalProviderError("PROVIDER_UNAVAILABLE");
            chunks.push(part.value);
          }
          const bytes = new Uint8Array(length); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new LocalProviderError("PROVIDER_UNAVAILABLE");
          const sub = (body as Record<string, unknown>).sub;
          if (typeof sub !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(sub)) throw new LocalProviderError("PROVIDER_UNAVAILABLE");
          const targetId = "urn:li:person:" + sub;
          if (targetId !== credential.author) throw new LocalProviderError("ACCOUNT_MISMATCH");
          const displayName = localDisplayName((body as Record<string, unknown>).name);
          return { targetId, ...(displayName === undefined ? {} : { displayName }) };
        } finally {
          abort.removeEventListener("abort", onAbort);
          void reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      });
    } catch (error) {
      if (error instanceof LocalProviderError) throw error;
      throw new LocalProviderError(signal.aborted ? "ABORTED" : "PROVIDER_UNAVAILABLE");
    }
  }
  async prepare(credentials: LocalCredentials, target: TargetBinding, signal: AbortSignal): Promise<PreparedTarget> {
    const credential = readCredentials(credentials);
    if (target.provider !== "linkedin" || !PERSON.test(target.targetId)) throw new LocalProviderError("ACCOUNT_MISMATCH");
    const identity = await this.verifyIdentity(credential, signal);
    if (identity.targetId !== target.targetId) throw new LocalProviderError("ACCOUNT_MISMATCH");
    const frozenTarget = { ...target };
    return { target: frozenTarget, publish: (delivery, abort) => this.publish(credential, frozenTarget, delivery, abort) };
  }
  private async publish(credential: Extract<LocalCredentials, { provider: "linkedin" }>, target: TargetBinding, delivery: FrozenDelivery, signal: AbortSignal): Promise<ProviderOutcome> {
    try {
      if (delivery.payloadVersion !== 1 || !samePayload(delivery.target, target) || !samePayload(delivery.payload, payload(delivery.content))) return failed("PAYLOAD_MISMATCH");
    } catch { return failed("INVALID_CONTENT"); }
    if (signal.aborted) return failed("ABORTED");
    try {
      return await this.bounded(signal, async abort => {
        const response = await this.transport(ORIGIN + "/rest/posts", {
          method: "POST", redirect: "manual", signal: abort,
          headers: { authorization: "Bearer " + credential.accessToken, "content-type": "application/json", accept: "application/json", "LinkedIn-Version": credential.apiVersion, "X-Restli-Protocol-Version": "2.0.0" },
          body: JSON.stringify({ author: target.targetId, ...delivery.payload }),
        });
        void response.body?.cancel().catch(() => undefined);
        if (response.status === 201) {
          const header = response.headers.get("x-restli-id");
          let id = "";
          if (header && header.length <= 256) { try { id = decodeURIComponent(header); } catch {} }
          return /^urn:li:(?:share|ugcPost):[1-9][0-9]*$/.test(id) ? { kind: "succeeded", remoteId: id, url: null } : unknown("UNRECOGNIZED_RESPONSE");
        }
        if (response.status === 401) return failed("AUTH", true);
        if (response.status === 403) return failed("PERMISSION");
        if ([400, 413, 422].includes(response.status)) return failed("INVALID_CONTENT");
        if (response.status === 429) {
          const header = response.headers.get("retry-after");
          if (header === null) return failed("RATE_LIMIT", true);
          if (/^[0-9]{1,6}$/.test(header) && Number(header) <= 604800) return failed("RATE_LIMIT", true, new Date(Date.now() + Number(header) * 1000).toISOString());
          // An unrepresentable hint never schedules an early retry.
          return failed("RATE_LIMIT");
        }
        return unknown("UNRECOGNIZED_RESPONSE");
      });
    } catch {
      return unknown(signal.aborted ? "ABORTED" : "NETWORK");
    }
  }
  private async bounded<T>(signal: AbortSignal, operation: (abort: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let rejectAbort: (error: Error) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => { controller.abort(); rejectAbort(new Error("ABORTED")); };
    const timer = setTimeout(onAbort, this.timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try { return await Promise.race([operation(controller.signal), aborted]); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); controller.abort(); }
  }
}
