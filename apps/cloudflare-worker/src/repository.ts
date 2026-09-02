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

interface PostRow {
  id: string;
  content: string;
  platforms: string;
  overrides: string | null;
  scheduled_at: string | null;
  status: string;
  created_at: string;
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
  created_at: string;
  published_at: string | null;
}

interface PostIdRow {
  post_id: string;
}

interface StatusCountRow {
  total: number;
  scheduled: number;
  pending: number;
  publishing: number;
  published: number;
  failed: number;
}

const PUBLICATION_SELECT =
  "SELECT p.id, p.post_id, p.platform, p.provider, p.content, p.status, " +
  "p.attempts, p.external_id, p.external_url, p.error_code, p.error_message, " +
  "p.error_ambiguous, po.scheduled_at, p.enqueued_at, p.publishing_at, " +
  "p.created_at, p.published_at FROM publications p " +
  "JOIN posts po ON po.id = p.post_id";

export class D1Repository {
  constructor(private readonly db: D1Database) {}

  async createPost(post: Post, publications: Publication[]): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          "INSERT INTO posts " +
            "(id, content, platforms, overrides, scheduled_at, status, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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

  async getPublication(id: string): Promise<Publication | null> {
    const row = await this.db
      .prepare(PUBLICATION_SELECT + " WHERE p.id = ?")
      .bind(id)
      .first<PublicationRow>();

    return row ? mapPublication(row) : null;
  }

  async claimPublication(id: string, now: string): Promise<Publication | null> {
    const result = await this.db
      .prepare(
        "UPDATE publications SET status = 'publishing', attempts = attempts + 1, " +
          "publishing_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      )
      .bind(now, now, id)
      .run();

    if (result.meta.changes !== 1) {
      return null;
    }

    await this.refreshPostStatusForPublication(id, now);
    return this.getPublication(id);
  }

  async markPublished(
    id: string,
    externalId: string | undefined,
    externalUrl: string | undefined,
    now: string,
  ): Promise<void> {
    await this.db
      .prepare(
        "UPDATE publications SET status = 'published', external_id = ?, external_url = ?, " +
          "error_code = NULL, error_message = NULL, error_ambiguous = 0, " +
          "published_at = ?, updated_at = ? WHERE id = ?",
      )
      .bind(externalId ?? null, externalUrl ?? null, now, now, id)
      .run();

    await this.refreshPostStatusForPublication(id, now);
  }

  async markFailed(
    id: string,
    error: PublishError,
    retry: boolean,
    now: string,
  ): Promise<void> {
    await this.db
      .prepare(
        "UPDATE publications SET status = ?, error_code = ?, error_message = ?, " +
          "error_ambiguous = ?, publishing_at = NULL, updated_at = ? WHERE id = ?",
      )
      .bind(
        retry ? "pending" : "failed",
        error.code,
        error.message,
        error.ambiguous ? 1 : 0,
        now,
        id,
      )
      .run();

    await this.refreshPostStatusForPublication(id, now);
  }

  async findDuePublications(
    now: string,
    enqueuedCutoff: string,
    limit = 50,
  ): Promise<Publication[]> {
    const result = await this.db
      .prepare(
        PUBLICATION_SELECT +
          " WHERE (p.status = 'scheduled' AND po.scheduled_at <= ? " +
          "AND p.enqueued_at IS NULL) OR (p.status = 'pending' AND " +
          "(p.enqueued_at IS NULL OR p.enqueued_at < ?)) " +
          "ORDER BY po.scheduled_at, p.created_at LIMIT ?",
      )
      .bind(now, enqueuedCutoff, limit)
      .run<PublicationRow>();

    return result.results.map(mapPublication);
  }

  async activateScheduled(id: string, now: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE publications SET status = 'pending', updated_at = ? " +
          "WHERE id = ? AND status = 'scheduled' AND EXISTS (" +
          "SELECT 1 FROM posts WHERE posts.id = publications.post_id " +
          "AND posts.scheduled_at <= ?)",
      )
      .bind(now, id, now)
      .run();

    if (result.meta.changes === 1) {
      await this.refreshPostStatusForPublication(id, now);
      return true;
    }

    return false;
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

    const result = await this.db
      .prepare(
        "UPDATE publications SET status = 'failed', error_code = 'UNKNOWN', " +
          "error_message = 'Publish outcome was not persisted before timeout', " +
          "error_ambiguous = 1, updated_at = ? " +
          "WHERE status = 'publishing' AND publishing_at < ?",
      )
      .bind(now, cutoff)
      .run();

    for (const row of affected.results) {
      await this.refreshPostStatus(row.post_id, now);
    }

    return result.meta.changes;
  }

  private async refreshPostStatusForPublication(
    publicationId: string,
    now: string,
  ): Promise<void> {
    const row = await this.db
      .prepare("SELECT post_id FROM publications WHERE id = ?")
      .bind(publicationId)
      .first<PostIdRow>();

    if (row) {
      await this.refreshPostStatus(row.post_id, now);
    }
  }

  private async refreshPostStatus(postId: string, now: string): Promise<void> {
    const counts = await this.db
      .prepare(
        "SELECT COUNT(*) AS total, " +
          "SUM(status = 'scheduled') AS scheduled, " +
          "SUM(status = 'pending') AS pending, " +
          "SUM(status = 'publishing') AS publishing, " +
          "SUM(status = 'published') AS published, " +
          "SUM(status = 'failed') AS failed " +
          "FROM publications WHERE post_id = ?",
      )
      .bind(postId)
      .first<StatusCountRow>();

    if (!counts || counts.total === 0) {
      return;
    }

    const status = aggregatePostStatus(counts);

    await this.db
      .prepare("UPDATE posts SET status = ?, updated_at = ? WHERE id = ?")
      .bind(status, now, postId)
      .run();
  }
}

function aggregatePostStatus(counts: StatusCountRow): PostStatus {
  if (counts.published === counts.total) {
    return "published";
  }

  if (counts.failed === counts.total) {
    return "failed";
  }

  if (counts.published + counts.failed === counts.total) {
    return "partial";
  }

  if (counts.publishing > 0) {
    return "publishing";
  }

  if (counts.scheduled === counts.total) {
    return "scheduled";
  }

  return "queued";
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
