import {
  isPlatform,
  type Platform,
  type Post,
  type PostStatus,
  type Publication,
  type PublicationStatus,
  type PublishError,
  type PublishErrorCode,
} from "@syndroo/core";

export interface PostDetail extends Post {
  publications: Publication[];
}

/**
 * Worker-internal publication view. `retryAt` is the persisted earliest retry
 * time and stays out of the public API shape (`getPost` maps plain
 * `Publication` values).
 */
export interface StoredPublication extends Publication {
  retryAt?: string;
}

interface PostRow {
  id: string;
  content: string;
  platforms: string;
  overrides: string | null;
  scheduled_at: string | null;
  status: string;
  created_at: string;
}

interface IdempotentPostRow extends PostRow {
  idempotency_key: string;
}

interface PublicationRow {
  id: string;
  post_id: string;
  platform: string;
  provider: string;
  content: string;
  status: string;
  attempts: number;
  external_id: string | null;
  external_url: string | null;
  error_code: string | null;
  error_message: string | null;
  error_ambiguous: number;
  scheduled_at: string | null;
  enqueued_at: string | null;
  publishing_at: string | null;
  retry_at: string | null;
  created_at: string;
  published_at: string | null;
}

interface PostIdRow {
  post_id: string;
}

interface CredentialRow {
  data: string;
}

interface OAuthStateRow {
  platform: string;
  request_token: string | null;
}

const PUBLICATION_SELECT =
  "SELECT p.id, p.post_id, p.platform, p.provider, p.content, p.status, " +
  "p.attempts, p.external_id, p.external_url, p.error_code, p.error_message, " +
  "p.error_ambiguous, po.scheduled_at, p.enqueued_at, p.publishing_at, " +
  "p.retry_at, p.created_at, p.published_at FROM publications p " +
  "JOIN posts po ON po.id = p.post_id";

// Mirrors retryDelaySeconds in src/retry.ts so a failure transaction can derive
// the earliest retry time from the stored attempt count without a second read.
const RETRY_DELAY_SECONDS_SQL =
  "CASE WHEN attempts <= 1 THEN 60 WHEN attempts = 2 THEN 120 " +
  "WHEN attempts = 3 THEN 240 WHEN attempts = 4 THEN 480 ELSE 900 END";

// Compute from the transaction's current rows, never from an earlier JS snapshot.
const POST_STATUS_UPDATE =
  "UPDATE posts SET status = (SELECT CASE " +
  "WHEN COUNT(*) = 0 THEN posts.status " +
  "WHEN SUM(status = 'published') = COUNT(*) THEN 'published' " +
  "WHEN SUM(status = 'failed') = COUNT(*) THEN 'failed' " +
  "WHEN SUM(status IN ('published', 'failed')) = COUNT(*) THEN 'partial' " +
  "WHEN SUM(status = 'publishing') > 0 THEN 'publishing' " +
  "WHEN SUM(status = 'scheduled') = COUNT(*) THEN 'scheduled' " +
  "ELSE 'queued' END FROM publications WHERE post_id = posts.id), updated_at = ? ";

export class D1Repository {
  constructor(private readonly db: D1Database) {}

  async createPost(
    post: Post,
    publications: Publication[],
    idempotencyKey?: string,
  ): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          "INSERT INTO posts " +
            "(id, content, platforms, overrides, scheduled_at, status, created_at, updated_at, idempotency_key) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          post.id,
          post.content,
          JSON.stringify(post.platforms),
          post.overrides ? JSON.stringify(post.overrides) : null,
          post.scheduledAt ?? null,
          post.status,
          post.createdAt,
          post.createdAt,
          idempotencyKey ?? null,
        ),
    ];

    for (const publication of publications) {
      statements.push(
        this.db
          .prepare(
            "INSERT INTO publications " +
              "(id, post_id, platform, provider, content, status, attempts, created_at, updated_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            publication.id,
            publication.postId,
            publication.platform,
            publication.provider,
            publication.content,
            publication.status,
            publication.attempts,
            publication.createdAt,
            publication.createdAt,
          ),
      );
    }

    await this.db.batch(statements);
  }

  async getPostByIdempotencyKey(key: string): Promise<Post | null> {
    const row = await this.db
      .prepare(
        "SELECT id, content, platforms, overrides, scheduled_at, status, created_at, idempotency_key " +
          "FROM posts WHERE idempotency_key = ?",
      )
      .bind(key)
      .first<IdempotentPostRow>();

    return row ? mapPost(row) : null;
  }

  async listPosts(limit = 50): Promise<Post[]> {
    const result = await this.db
      .prepare(
        "SELECT id, content, platforms, overrides, scheduled_at, status, created_at " +
          "FROM posts ORDER BY created_at DESC LIMIT ?",
      )
      .bind(limit)
      .run<PostRow>();

    return result.results.map(mapPost);
  }

  async getPost(id: string): Promise<PostDetail | null> {
    const row = await this.db
      .prepare(
        "SELECT id, content, platforms, overrides, scheduled_at, status, created_at " +
          "FROM posts WHERE id = ?",
      )
      .bind(id)
      .first<PostRow>();

    if (!row) {
      return null;
    }

    const publicationResult = await this.db
      .prepare(PUBLICATION_SELECT + " WHERE p.post_id = ? ORDER BY p.created_at")
      .bind(id)
      .run<PublicationRow>();

    return {
      ...mapPost(row),
      publications: publicationResult.results.map(mapPublication),
    };
  }

  async getPublication(id: string): Promise<StoredPublication | null> {
    const row = await this.db
      .prepare(PUBLICATION_SELECT + " WHERE p.id = ?")
      .bind(id)
      .first<PublicationRow>();

    return row ? mapStoredPublication(row) : null;
  }

  async claimPublication(
    id: string,
    now: string,
  ): Promise<StoredPublication | null> {
    const [claim, , selected] = await this.db.batch<PublicationRow>([
      this.db.prepare(
        "UPDATE publications SET status = 'publishing', attempts = attempts + 1, " +
          "publishing_at = ?, updated_at = ?, retry_at = NULL WHERE id = ? " +
          "AND status = 'pending' AND (retry_at IS NULL OR retry_at <= ?)",
      ).bind(now, now, id, now),
      this.postStatusUpdateForPublication(id, now),
      this.db.prepare(PUBLICATION_SELECT + " WHERE p.id = ?").bind(id),
    ]);

    if (claim?.meta.changes !== 1) {
      return null;
    }

    const row = selected?.results[0];
    if (!row) {
      throw new Error("Claimed publication was not returned");
    }
    return mapStoredPublication(row);
  }

  async markPublished(
    id: string,
    externalId: string | undefined,
    externalUrl: string | undefined,
    now: string,
  ): Promise<void> {
    await this.db.batch([
      this.db.prepare(
        "UPDATE publications SET status = 'published', external_id = ?, external_url = ?, " +
          "error_code = NULL, error_message = NULL, error_ambiguous = 0, " +
          "published_at = ?, updated_at = ?, retry_at = NULL WHERE id = ?",
      )
      .bind(externalId ?? null, externalUrl ?? null, now, now, id),
      this.postStatusUpdateForPublication(id, now),
    ]);
  }

  /**
   * Persist a failure together with its retry eligibility in one transaction.
   * `retryAt` is the earliest time the next attempt may run; when omitted, the
   * delay is derived from the stored attempt count so `retry: true` can never
   * leave a publication immediately claimable. Terminal failures clear it.
   */
  async markFailed(
    id: string,
    error: PublishError,
    retry: boolean,
    now: string,
    retryAt?: string,
  ): Promise<void> {
    await this.db.batch([
      this.db.prepare(
        "UPDATE publications SET status = ?, error_code = ?, error_message = ?, " +
          "error_ambiguous = ?, publishing_at = NULL, updated_at = ?, " +
          "retry_at = CASE WHEN ? = 1 THEN COALESCE(?, " +
          "strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || (" +
          RETRY_DELAY_SECONDS_SQL +
          ") || ' seconds')) ELSE NULL END WHERE id = ?",
      )
      .bind(
        retry ? "pending" : "failed",
        error.code,
        error.message,
        error.ambiguous ? 1 : 0,
        now,
        retry ? 1 : 0,
        retryAt ?? null,
        now,
        id,
      ),
      this.postStatusUpdateForPublication(id, now),
    ]);
  }

  async findDuePublications(
    now: string,
    enqueuedCutoff: string,
    limit = 50,
  ): Promise<StoredPublication[]> {
    const result = await this.db
      .prepare(
        PUBLICATION_SELECT +
          " WHERE (p.retry_at IS NULL OR p.retry_at <= ?) AND " +
          "((p.status = 'scheduled' AND po.scheduled_at <= ? " +
          "AND p.enqueued_at IS NULL) OR (p.status = 'pending' AND " +
          "(p.enqueued_at IS NULL OR p.enqueued_at < ?))) " +
          "ORDER BY po.scheduled_at, p.created_at LIMIT ?",
      )
      .bind(now, now, enqueuedCutoff, limit)
      .run<PublicationRow>();

    return result.results.map(mapStoredPublication);
  }

  async activateScheduled(id: string, now: string): Promise<boolean> {
    const [result] = await this.db.batch([
      this.db.prepare(
        "UPDATE publications SET status = 'pending', updated_at = ? " +
          "WHERE id = ? AND status = 'scheduled' AND EXISTS (" +
          "SELECT 1 FROM posts WHERE posts.id = publications.post_id " +
          "AND posts.scheduled_at <= ?)",
      )
      .bind(now, id, now),
      this.postStatusUpdateForPublication(id, now),
    ]);

    return result?.meta.changes === 1;
  }

  async markEnqueued(ids: string[], now: string): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.db.batch(
      ids.map(id =>
        this.db
          .prepare(
            "UPDATE publications SET enqueued_at = ?, updated_at = ? WHERE id = ?",
          )
          .bind(now, now, id),
      ),
    );
  }

  async recoverStalePublishing(cutoff: string, now: string): Promise<number> {
    const affected = await this.db
      .prepare(
        "SELECT DISTINCT post_id FROM publications " +
          "WHERE status = 'publishing' AND publishing_at < ?",
      )
      .bind(cutoff)
      .run<PostIdRow>();

    let recovered = 0;
    for (const row of affected.results) {
      // Limit each transaction to one Post. Recheck the predicate so a provider
      // result committed since discovery is never overwritten by stale recovery.
      const [result] = await this.db.batch([
        this.db.prepare(
          "UPDATE publications SET status = 'failed', error_code = 'UNKNOWN', " +
            "error_message = 'Publish outcome was not persisted before timeout', " +
            "error_ambiguous = 1, retry_at = NULL, updated_at = ? " +
            "WHERE post_id = ? AND status = 'publishing' AND publishing_at < ?",
        ).bind(now, row.post_id, cutoff),
        this.db.prepare(POST_STATUS_UPDATE + "WHERE id = ?").bind(now, row.post_id),
      ]);
      recovered += result?.meta.changes ?? 0;
    }

    return recovered;
  }

  async getCredential(platform: Platform): Promise<Record<string, string> | null> {
    const row = await this.db
      .prepare("SELECT data FROM credentials WHERE platform = ?")
      .bind(platform)
      .first<CredentialRow>();
    return row ? (JSON.parse(row.data) as Record<string, string>) : null;
  }

  async setCredential(platform: Platform, data: Record<string, string>): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        "INSERT INTO credentials (platform, data, created_at, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(platform) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      )
      .bind(platform, JSON.stringify(data), now, now)
      .run();
  }

  async deleteCredential(platform: Platform): Promise<void> {
    await this.db
      .prepare("DELETE FROM credentials WHERE platform = ?")
      .bind(platform)
      .run();
  }

  async getOAuthState(
    state: string,
  ): Promise<{ platform: string; requestToken: string | null } | null> {
    const row = await this.db
      .prepare("SELECT platform, request_token FROM oauth_state WHERE state = ?")
      .bind(state)
      .first<OAuthStateRow>();
    return row ? { platform: row.platform, requestToken: row.request_token } : null;
  }

  async setOAuthState(state: string, platform: Platform, requestToken?: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        "INSERT INTO oauth_state (state, platform, request_token, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(state, platform, requestToken ?? null, now)
      .run();
  }

  async deleteOAuthState(state: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM oauth_state WHERE state = ?")
      .bind(state)
      .run();
  }

  private postStatusUpdateForPublication(id: string, now: string): D1PreparedStatement {
    return this.db.prepare(
      POST_STATUS_UPDATE + "WHERE id = (SELECT post_id FROM publications WHERE id = ?)",
    ).bind(now, id);
  }
}

function mapPost(row: PostRow): Post {
  const post: Post = {
    id: row.id,
    content: row.content,
    platforms: parsePlatforms(row.platforms),
    status: row.status as PostStatus,
    createdAt: row.created_at,
  };

  if (row.overrides !== null) {
    post.overrides = parseOverrides(row.overrides);
  }

  if (row.scheduled_at !== null) {
    post.scheduledAt = row.scheduled_at;
  }

  return post;
}

function mapPublication(row: PublicationRow): Publication {
  if (!isPlatform(row.platform)) {
    throw new Error("Stored publication has invalid platform");
  }

  const publication: Publication = {
    id: row.id,
    postId: row.post_id,
    platform: row.platform,
    provider: row.provider,
    content: row.content,
    status: row.status as PublicationStatus,
    attempts: row.attempts,
    errorAmbiguous: row.error_ambiguous === 1,
    createdAt: row.created_at,
  };

  assignOptional(publication, "externalId", row.external_id);
  assignOptional(publication, "externalUrl", row.external_url);
  assignOptional(publication, "errorMessage", row.error_message);
  assignOptional(publication, "scheduledAt", row.scheduled_at);
  assignOptional(publication, "enqueuedAt", row.enqueued_at);
  assignOptional(publication, "publishingAt", row.publishing_at);
  assignOptional(publication, "publishedAt", row.published_at);

  if (row.error_code !== null) {
    publication.errorCode = row.error_code as PublishErrorCode;
  }

  return publication;
}

function mapStoredPublication(row: PublicationRow): StoredPublication {
  const publication: StoredPublication = mapPublication(row);

  if (row.retry_at !== null) {
    publication.retryAt = row.retry_at;
  }

  return publication;
}

function parsePlatforms(json: string): Platform[] {
  const value: unknown = JSON.parse(json);

  if (!Array.isArray(value) || !value.every(isPlatform)) {
    throw new Error("Stored post has invalid platforms");
  }

  return value;
}

function parseOverrides(
  json: string,
): Partial<Record<Platform, { content?: string }>> {
  const value: unknown = JSON.parse(json);

  if (!isRecord(value)) {
    throw new Error("Stored post has invalid overrides");
  }

  const overrides: Partial<Record<Platform, { content?: string }>> = {};

  for (const [platform, override] of Object.entries(value)) {
    if (
      !isPlatform(platform) ||
      !isRecord(override) ||
      (override.content !== undefined && typeof override.content !== "string")
    ) {
      throw new Error("Stored post has invalid overrides");
    }

    overrides[platform] =
      typeof override.content === "string" ? { content: override.content } : {};
  }

  return overrides;
}

function assignOptional<
  Key extends
    | "externalId"
    | "externalUrl"
    | "errorMessage"
    | "scheduledAt"
    | "enqueuedAt"
    | "publishingAt"
    | "publishedAt",
>(publication: Publication, key: Key, value: string | null): void {
  if (value !== null) {
    publication[key] = value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
