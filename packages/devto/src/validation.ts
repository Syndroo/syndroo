/**
 * Pure DEV.to validation and payload helpers.
 *
 * The article limits mirror the product subset the CLI document contract
 * already enforces (title ≤ 128 code points, ≤ 4 lowercase alphanumeric tags,
 * body ≤ 10 000 code points, HTTPS canonical URL ≤ 2048 characters, no YAML
 * front matter, no Liquid directives). They are Syndroo product limits, not
 * platform-official limits. The CLI validator lives in the CLI package, which a
 * runtime-neutral adapter cannot import, so this module mirrors the rules and
 * is the single gate the adapter itself applies.
 */

import {
  LocalProviderError,
  type LocalArticleOptions,
  type LocalContentOptions,
} from "@syndroo/core";

export const DEVTO_PAYLOAD_VERSION = 1;

export const DEVTO_MAX_TITLE_CODE_POINTS = 128;
export const DEVTO_MAX_TAGS = 4;
export const DEVTO_MAX_TAG_CHARS = 30;
export const DEVTO_MAX_BODY_CODE_POINTS = 10_000;
export const DEVTO_MAX_CANONICAL_URL_CHARS = 2_048;

/** Opaque API key: printable ASCII, bounded, never whitespace. */
export const DEVTO_API_KEY_PATTERN = /^[\x21-\x7e]{1,4096}$/;

const TARGET_ID_PATTERN = /^devto:([1-9][0-9]{0,15})$/;
const TAG_PATTERN = /^[a-z0-9]{1,30}$/;
const TITLE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const URL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const ARTICLE_KEYS: ReadonlySet<string> = new Set(["title", "tags", "canonicalUrl"]);
const OPTION_KEYS: ReadonlySet<string> = new Set(["article"]);

/** `devto:<numericUserId>` — the API key is never part of the identity. */
export function devtoTargetId(userId: number): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new LocalProviderError("ACCOUNT_MISMATCH");
  }

  return `devto:${userId}`;
}

export function parseDevtoTargetId(targetId: unknown): number | null {
  if (typeof targetId !== "string") {
    return null;
  }

  const match = TARGET_ID_PATTERN.exec(targetId);

  if (match === null) {
    return null;
  }

  const id = Number(match[1]);

  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function validateDevtoApiKey(value: unknown): string {
  if (typeof value !== "string" || !DEVTO_API_KEY_PATTERN.test(value)) {
    throw new LocalProviderError("AUTH");
  }

  return value;
}

/** A positive safe integer user id; numeric strings and fractions are refused. */
export function readDevtoUserId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

export function validateDevtoTitle(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || TITLE_CONTROL.test(value)) {
    throw new LocalProviderError("INVALID_CONTENT");
  }

  if (codePointCount(value) > DEVTO_MAX_TITLE_CODE_POINTS) {
    throw new LocalProviderError("INVALID_CONTENT");
  }

  return value;
}

/**
 * `undefined` means "no tags key at all"; an explicit empty array stays an
 * explicit zero-tag list, so the frozen bytes keep the distinction.
 */
export function validateDevtoTags(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length > DEVTO_MAX_TAGS) {
    throw new LocalProviderError("INVALID_CONTENT");
  }

  const tags: string[] = [];

  for (const tag of value) {
    if (typeof tag !== "string" || !TAG_PATTERN.test(tag) || tags.includes(tag)) {
      throw new LocalProviderError("INVALID_CONTENT");
    }

    tags.push(tag);
  }

  return tags;
}

export function validateDevtoCanonicalUrl(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > DEVTO_MAX_CANONICAL_URL_CHARS ||
    URL_CONTROL.test(value) ||
    value !== value.trim()
  ) {
    throw new LocalProviderError("INVALID_CONTENT");
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new LocalProviderError("INVALID_CONTENT");
  }

  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new LocalProviderError("INVALID_CONTENT");
  }

  return value;
}

export function validateDevtoBody(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || BODY_CONTROL.test(value)) {
    throw new LocalProviderError("INVALID_CONTENT");
  }

  if (codePointCount(value) > DEVTO_MAX_BODY_CODE_POINTS) {
    throw new LocalProviderError("INVALID_CONTENT");
  }

  if (hasFrontMatter(value) || value.includes("{%") || value.includes("%}")) {
    throw new LocalProviderError("INVALID_CONTENT");
  }

  return value;
}

/** Strict article object: only `title`, `tags`, and `canonicalUrl`. */
export function validateDevtoArticle(value: unknown): LocalArticleOptions {
  if (!isRecord(value) || !Object.keys(value).every(key => ARTICLE_KEYS.has(key))) {
    throw new LocalProviderError("INVALID_CONTENT");
  }

  const title = validateDevtoTitle(value["title"]);
  const tags = validateDevtoTags(value["tags"]);
  const canonicalUrl = validateDevtoCanonicalUrl(value["canonicalUrl"]);

  return {
    title,
    ...(tags === undefined ? {} : { tags }),
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
  };
}

/** Strict content options: `{article: ...}` and nothing else. */
export function validateDevtoContentOptions(value: unknown): LocalArticleOptions {
  if (!isRecord(value) || !Object.keys(value).every(key => OPTION_KEYS.has(key))) {
    throw new LocalProviderError("INVALID_CONTENT");
  }

  return validateDevtoArticle(value["article"]);
}

/**
 * The exact public wire payload. Optional fields are omitted, never
 * materialized as `undefined`; tag order is preserved.
 */
export function buildDevtoArticlePayload(
  content: string,
  article: LocalArticleOptions,
): Readonly<Record<string, unknown>> {
  const title = validateDevtoTitle(article.title);
  const body = validateDevtoBody(content);
  const tags = validateDevtoTags(article.tags);
  const canonicalUrl = validateDevtoCanonicalUrl(article.canonicalUrl);

  return {
    article: {
      title,
      body_markdown: body,
      published: true,
      ...(tags === undefined ? {} : { tags }),
      ...(canonicalUrl === undefined ? {} : { canonical_url: canonicalUrl }),
    },
  };
}

/**
 * Strict structural equality with the freshly rebuilt payload, so an extra key,
 * a reordered tag list, or a rewritten body fails closed.
 */
export function devtoPayloadMatches(
  payload: unknown,
  content: string,
  article: LocalArticleOptions,
): boolean {
  let expected: Readonly<Record<string, unknown>>;

  try {
    expected = buildDevtoArticlePayload(content, article);
  } catch {
    return false;
  }

  return strictEqual(payload, expected);
}

export function codePointCount(value: string): number {
  return [...value].length;
}

/** True when the first non-blank line is exactly the front-matter fence. */
function hasFrontMatter(body: string): boolean {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    return trimmed === "---";
  }

  return false;
}

function strictEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => strictEqual(item, right[index]))
    );
  }

  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(key => Object.hasOwn(right, key) && strictEqual(left[key], right[key]))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
