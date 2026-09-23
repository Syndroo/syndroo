/** Deterministic fixtures shared by the fake suite and the D1 contract run. */

import type { Platform } from "@syndroo/core";

import type { EncryptedCredential } from "../contracts/credentials.js";
import type {
  ContentOverrides,
  CreatePostTransaction,
  CredentialGuard,
  NewPublicationRecord,
} from "../contracts/execution.js";
import type { NewOutboxJobRecord } from "../contracts/outbox.js";
import type { IsoInstant } from "../contracts/primitives.js";

export const FIXTURE_NOW: IsoInstant = "2026-09-23T00:00:00.000Z";

export function instant(offsetMs: number, base: IsoInstant = FIXTURE_NOW): IsoInstant {
  return new Date(Date.parse(base) + offsetMs).toISOString();
}

export function testEnvelope(seed: string): EncryptedCredential {
  return Object.freeze({
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyId: "k1",
    iv: "AAAAAAAAAAAAAAAA",
    ciphertext: `ZmFrZS0${seed}`,
  });
}

export interface CreateFixtureOptions {
  readonly key?: string | null;
  readonly fingerprint?: string;
  readonly now?: IsoInstant;
  readonly postId?: string;
  readonly platforms?: readonly Platform[];
  readonly publicationIds?: readonly string[];
  readonly jobIds?: readonly string[];
  readonly scheduledAt?: IsoInstant | null;
  readonly overrides?: ContentOverrides;
  readonly credentialGuards?: readonly CredentialGuard[];
  readonly credentialRevision?: number;
}

export function createTransaction(
  options: CreateFixtureOptions = {},
): CreatePostTransaction {
  const now = options.now ?? FIXTURE_NOW;
  const scheduledAt = options.scheduledAt ?? null;
  const postId = options.postId ?? "post_0001";
  const platforms: readonly Platform[] = options.platforms ?? ["x"];
  // An absent slot reports revision 0, which is the Env-only preparation path.
  const credentialRevision = options.credentialRevision ?? 0;
  const publicationIds =
    options.publicationIds ?? platforms.map((_platform, index) => `pub_000${index + 1}`);
  const jobIds = options.jobIds ?? platforms.map((_platform, index) => `job_000${index + 1}`);

  const publications: NewPublicationRecord[] = platforms.map((platform, index) => ({
    id: requireIndex(publicationIds, index, "publicationIds"),
    postId,
    platform,
    provider: `${platform}-provider`,
    content: `content for ${platform}`,
    status: scheduledAt === null ? "pending" : "scheduled",
    scheduledAt,
    credentialBinding: `binding-hmac-000${index + 1}`,
    credentialRevision,
    createdAt: now,
  }));

  const jobs: NewOutboxJobRecord[] = publications.map((publication, index) => ({
    id: requireIndex(jobIds, index, "jobIds"),
    kind: "delivery.execute" as const,
    aggregateId: publication.id,
    attemptNo: 1,
    availableAt: scheduledAt ?? now,
  }));

  const credentialGuards: readonly CredentialGuard[] =
    options.credentialGuards ??
    platforms.map((platform) => ({
      platform,
      expectedRevision: credentialRevision,
      // Callers that verified a specific slot binding pass it explicitly.
      bindingId: null,
    }));

  const overrides: ContentOverrides = options.overrides ?? Object.freeze({});

  return Object.freeze({
    scope: "posts.create.v1" as const,
    idempotencyKey: options.key === undefined ? "create-key-0001" : options.key,
    requestFingerprint: options.fingerprint ?? "fingerprint-0001",
    now,
    post: Object.freeze({
      id: postId,
      content: platforms.map((platform) => `content for ${platform}`).join("\n&&\n"),
      platforms: Object.freeze([...platforms]),
      overrides,
      scheduledAt,
      status: (scheduledAt === null ? "queued" : "scheduled") as "queued" | "scheduled",
      createdAt: now,
    }),
    publications: Object.freeze(publications),
    jobs: Object.freeze(jobs),
    credentialGuards: Object.freeze([...credentialGuards]),
  });
}

function requireIndex(values: readonly string[], index: number, label: string): string {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`${label} must provide an entry for index ${index}`);
  }
  return value;
}
