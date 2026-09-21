import { PublishError, type PlatformAdapter, type Publisher, type PublishRequest, type PublishResult } from "@syndroo/core";

export interface LinkedInPublisherOptions {
  accessToken: string;
  author: string;
  apiVersion: string;
  timeoutMs?: number;
}

export function isLinkedInConfigurationValid(accessToken: string | undefined, author: string | undefined,
  apiVersion: string | undefined): boolean {
  return Boolean(accessToken && /^[\x21-\x7e]+$/.test(accessToken) && author &&
    /^(?:urn:li:person:[A-Za-z0-9_-]+|urn:li:organization:[1-9][0-9]*)$/.test(author) &&
    apiVersion && /^20\d{2}(?:0[1-9]|1[0-2])$/.test(apiVersion));
}

// Posts commentary uses LinkedIn's "little" grammar, not raw plain text.
// Escape every reserved character so user text cannot introduce mentions or
// formatting, or be truncated by unbalanced delimiters. JSON escaping follows.
function plainCommentary(text: string): string {
  return text.replace(/[|{}@\[\]()<>#\\*_~]/g, "\\$&");
}

export class LinkedInPublisher implements Publisher {
  readonly name = "linkedin-native";
  private readonly timeoutMs: number;

  constructor(private readonly options: LinkedInPublisherOptions) {
    if (!isLinkedInConfigurationValid(options.accessToken, options.author, options.apiVersion)) {
      throw new TypeError("LinkedIn requires an access token, author URN, and YYYYMM API version");
    }
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new TypeError("LinkedIn timeout must be positive");
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    // Conservative UTF-16 limit includes the little-text escape characters.
    // Do not truncate user text or rely on a provider-side validation request.
    const commentary = plainCommentary(request.content);
    if (request.platform !== "linkedin" || !request.content.trim() || commentary.length > 3000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(request.content)) {
      throw new PublishError("LinkedIn requires plain text within 3000 escaped UTF-16 units", "INVALID_CONTENT");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch("https://api.linkedin.com/rest/posts", {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.options.accessToken}`,
          "content-type": "application/json", accept: "application/json",
          "LinkedIn-Version": this.options.apiVersion, "X-Restli-Protocol-Version": "2.0.0",
        },
        body: JSON.stringify({
          author: this.options.author, commentary, visibility: "PUBLIC",
          distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
          lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
        }),
      });
      // Creation is confirmed by status + x-restli-id, not a JSON body.
      // Never buffer provider response bodies (including error details). Cancel
      // without waiting for a possibly stalled stream; abort again in finally.
      void response.body?.cancel().catch(() => undefined);
      if (response.status !== 201) {
        const status = response.status;
        const code = status === 401 || status === 403 ? "AUTH"
          : status === 429 ? "RATE_LIMIT"
          : [400, 413, 422].includes(status) ? "INVALID_CONTENT"
          : status >= 500 ? "PROVIDER_UNAVAILABLE" : "UNKNOWN";
        throw new PublishError(`LinkedIn request failed (HTTP ${status})`, code,
          status >= 500 || code === "UNKNOWN");
      }
      const header = response.headers.get("x-restli-id");
      let id = "";
      if (header && header.length <= 256) {
        try { id = decodeURIComponent(header); } catch { /* Invalid header remains unconfirmed. */ }
      }
      if (!/^urn:li:(?:share|ugcPost):[1-9][0-9]*$/.test(id)) {
        throw new PublishError("LinkedIn response did not confirm a valid post ID", "UNKNOWN", true);
      }
      return { externalId: id, externalUrl: `https://www.linkedin.com/feed/update/${encodeURIComponent(id)}/` };
    } catch (error) {
      if (error instanceof PublishError) throw error;
      // A lost response does not prove that LinkedIn rejected the write.
      throw new PublishError("LinkedIn request was interrupted", "NETWORK", true);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}

// ---------------------------------------------------------------------------
// Platform adapter
// ---------------------------------------------------------------------------


export const linkedinAdapter: PlatformAdapter = {
  providerName: "linkedin-native",

  buildPublisher: (cred) => {
    if (!isLinkedInConfigurationValid(cred.access_token, cred.author, cred.api_version)) {
      throw new PublishError(
        "LinkedIn credential is incomplete (access_token, author)",
        "AUTH",
      );
    }
    return new LinkedInPublisher({
      accessToken: cred.access_token!,
      author: cred.author!,
      apiVersion: cred.api_version ?? "202604",
    });
  },

  oauth: {
    type: "oauth2",
    authorizationUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: "w_member_social openid profile",
  },
};
