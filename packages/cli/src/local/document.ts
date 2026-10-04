import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import type {
  FrozenDelivery,
  LocalArticleOptions,
  LocalContentOptions,
  LocalProviderId,
  TargetBinding,
} from "@syndroo/core";
import { parseTree, type Node, type ParseError } from "jsonc-parser";

import { localError } from "./errors.js";

/**
 * Strict local publish input.
 *
 * This is the only way a local publish starts: a JSON document with an explicit
 * key, content, and platform list. Comments, trailing commas, repeated keys
 * (including escaped equivalents), invalid UTF-8, and unpaired surrogates are
 * refused, because a plan freezes exactly what was reviewed.
 */

/** Source limit in UTF-8 bytes, measured before decoding. */
export const MAX_LOCAL_SOURCE_BYTES = 65_536;

/** Content limit in Unicode code points, matching the remote post limit. */
export const MAX_LOCAL_CONTENT_CODE_POINTS = 10_000;

/**
 * Product limits for the v2 article subset, not platform-official limits.
 *
 * They are deliberately conservative: Syndroo accepts a smaller, unambiguous
 * input than the platform API may technically allow.
 */
export const MAX_LOCAL_ARTICLE_TITLE_CODE_POINTS = 128;
export const MAX_LOCAL_ARTICLE_TAGS = 4;
export const MAX_LOCAL_TAG_CHARS = 30;
export const MAX_LOCAL_CANONICAL_URL_CHARS = 2_048;

/** Depth bound: deep enough for every local record, shallow enough to parse. */
const MAX_LOCAL_JSON_DEPTH = 64;

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Providers a schema-1 document may name. */
const LOCAL_PROVIDERS = [
  "bluesky",
  "threads",
  "linkedin",
  "mastodon",
] as const satisfies readonly LocalProviderId[];

const LOCAL_PROVIDER_SET: ReadonlySet<string> = new Set<string>(LOCAL_PROVIDERS);

/** The only provider that carries the v2 article expression. */
const ARTICLE_PROVIDER = "devto";

/** Platforms that keep their remote behavior and have no local input path. */
const REMOTE_ONLY_PROVIDERS: ReadonlySet<string> = new Set<string>([
  "x",
  "tumblr",
]);

const DOCUMENT_FIELDS: ReadonlySet<string> = new Set<string>([
  "schemaVersion",
  "key",
  "content",
  "platforms",
  "overrides",
]);

export interface LocalPublishOverride {
  readonly content: string;
  /** Article metadata; only `devto` under schema 2 may carry it. */
  readonly article?: LocalArticleOptions;
}

export type LocalPublishOverrides = Readonly<
  Partial<Record<LocalProviderId, LocalPublishOverride>>
>;

export interface LocalPublishDocument {
  readonly schemaVersion: 1 | 2;
  readonly key: string;
  readonly content: string;
  readonly platforms: readonly LocalProviderId[];
  readonly overrides?: LocalPublishOverrides;
}

export interface CanonicalDeliveryOptions {
  readonly namespace: string;
  readonly payloadVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Omitted for legacy text deliveries, never materialized as `undefined`. */
  readonly contentOptions?: LocalContentOptions;
}

/**
 * Decodes one source snapshot.
 *
 * The hash covers the exact bytes that were read, including a leading BOM, so a
 * receipt can be checked against the file the operator approved. Exactly one
 * leading BOM is tolerated; a second one means the prefix is not a BOM-prefixed
 * document, and the composed read path must not absorb it.
 */
export function decodeLocalSource(bytes: Uint8Array): {
  text: string;
  sourceSha256: string;
} {
  if (bytes.byteLength > MAX_LOCAL_SOURCE_BYTES) {
    throw localError(
      "INPUT_TOO_LARGE",
      "the document exceeds the 64 KiB source limit",
    );
  }

  let decoded: string;

  try {
    // `ignoreBOM` keeps the marker in the output so the single leading BOM is
    // stripped here, deliberately, instead of somewhere less obvious.
    decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw localError("INVALID_DOCUMENT", "the document is not valid UTF-8");
  }

  const text = stripLeadingBom(decoded);

  if (text.startsWith("\uFEFF")) {
    throw localError(
      "INVALID_DOCUMENT",
      "the document has more than one leading BOM",
    );
  }

  return {
    text,
    sourceSha256: sha256(bytes),
  };
}

/**
 * Strict JSON for every local file this CLI reads.
 *
 * Objects come back without a prototype, so a `__proto__` key in the document
 * cannot reach the result through the prototype chain.
 */
export function parseLocalJson(text: string): unknown {
  assertUnicodeText(text);

  const errors: ParseError[] = [];
  let root: Node | undefined;

  try {
    root = parseTree(text, errors, {
      disallowComments: true,
      allowTrailingComma: false,
      allowEmptyContent: false,
    });
  } catch (error) {
    if (error instanceof RangeError) {
      throw localError("INVALID_JSON", "the document is nested too deeply to parse");
    }

    throw error;
  }

  if (errors.length > 0 || root === undefined) {
    throw localError("INVALID_JSON", "the document is not strict JSON");
  }

  return readNode(root, 0);
}

/** Recursive, key-sorted JSON. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw localError(
          "INVALID_DOCUMENT",
          "value is not representable as canonical JSON",
        );
      }

      return String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map(item => canonicalJson(item)).join(",")}]`;
      }

      const record = value as Readonly<Record<string, unknown>>;

      return `{${Object.keys(record)
        .sort()
        .map(field => `${JSON.stringify(field)}:${canonicalJson(record[field])}`)
        .join(",")}}`;
    }
    default:
      throw localError(
        "INVALID_DOCUMENT",
        "value is not representable as canonical JSON",
      );
  }
}

export function parseLocalPublishDocument(text: string): LocalPublishDocument {
  // The cap covers the source as handed over, BOM included, so this entry point
  // and `decodeLocalSource` measure the same bytes.
  if (Buffer.byteLength(text, "utf8") > MAX_LOCAL_SOURCE_BYTES) {
    throw localError(
      "INPUT_TOO_LARGE",
      "the document exceeds the 64 KiB source limit",
    );
  }

  const source = stripLeadingBom(text);

  if (source.startsWith("\uFEFF")) {
    throw localError(
      "INVALID_DOCUMENT",
      "the document has more than one leading BOM",
    );
  }

  const value = parseLocalJson(source);

  if (!isJsonObject(value)) {
    throw localError("INVALID_DOCUMENT", "the document must be a JSON object");
  }

  if (Object.hasOwn(value, "scheduledAt")) {
    throw localError(
      "LOCAL_SCHEDULING_UNSUPPORTED",
      "scheduled publishing is not part of this version",
    );
  }

  for (const field of Object.keys(value)) {
    if (!DOCUMENT_FIELDS.has(field)) {
      throw localError(
        "INVALID_DOCUMENT",
        "the document has a field this version does not accept",
      );
    }
  }

  const schemaVersion = value["schemaVersion"];

  if (
    schemaVersion !== undefined &&
    schemaVersion !== 1 &&
    schemaVersion !== 2
  ) {
    throw localError(
      "INVALID_DOCUMENT",
      "schemaVersion must be the number 1 or 2 when it is present",
    );
  }

  const version: 1 | 2 = schemaVersion === undefined ? 1 : schemaVersion;
  const key = readKey(value["key"]);
  const content = readContent(value["content"], "content");
  const platforms = readPlatforms(value["platforms"], version);
  const overrides = readOverrides(value["overrides"], platforms, version);

  if (
    version === 2 &&
    platforms.includes(ARTICLE_PROVIDER) &&
    overrides?.[ARTICLE_PROVIDER] === undefined
  ) {
    // A v2 document that selects devto must carry the article explicitly.
    throw localError(
      "INVALID_DOCUMENT",
      "devto needs an explicit article title and full Markdown body",
    );
  }

  return {
    schemaVersion: version,
    key,
    content,
    platforms,
    ...(overrides === undefined ? {} : { overrides }),
  };
}

/**
 * Freezes one target of a document.
 *
 * The delivery id is the hash of the logical identity `(namespace, key,
 * provider, targetId)`; the payload hash covers the provider payload and its
 * version. Neither includes a credential binding or a timestamp that is not
 * already part of the payload.
 */
export function canonicalDeliveryPayload(
  document: LocalPublishDocument,
  target: TargetBinding,
  options: CanonicalDeliveryOptions,
): FrozenDelivery {
  const override = document.overrides?.[target.provider];
  // Copy the approved metadata into the frozen record: the plan must not alias
  // the parsed document, or a later mutation could change what was confirmed.
  const contentOptions =
    options.contentOptions === undefined
      ? undefined
      : copyContentOptions(options.contentOptions);

  return {
    deliveryId: sha256(
      canonicalJson([
        options.namespace,
        document.key,
        target.provider,
        target.targetId,
      ]),
    ),
    key: document.key,
    namespace: options.namespace,
    target,
    content: override === undefined ? document.content : override.content,
    ...(contentOptions === undefined ? {} : { contentOptions }),
    payloadVersion: options.payloadVersion,
    payloadHash: frozenPayloadHash(
      options.payloadVersion,
      options.payload,
      contentOptions,
    ),
    payload: options.payload,
  };
}

/** A detached, field-preserving copy of one provider's content options. */
function copyContentOptions(options: LocalContentOptions): LocalContentOptions {
  const article = options.article;

  if (article === undefined) {
    return {};
  }

  return {
    article: {
      title: article.title,
      ...(article.tags === undefined ? {} : { tags: [...article.tags] }),
      ...(article.canonicalUrl === undefined
        ? {}
        : { canonicalUrl: article.canonicalUrl }),
    },
  };
}

/**
 * The frozen payload hash domain.
 *
 * Legacy deliveries hash `{payloadVersion, payload}` exactly as before. A
 * delivery that carries content options hashes them too, so metadata is bound
 * to the approved bytes even when a provider's payload would not show it.
 */
export function frozenPayloadHash(
  payloadVersion: number,
  payload: Readonly<Record<string, unknown>>,
  contentOptions?: LocalContentOptions,
): string {
  return sha256(
    canonicalJson(
      contentOptions === undefined
        ? { payloadVersion, payload }
        : { contentOptions, payloadVersion, payload },
    ),
  );
}

/**
 * The content options one provider's frozen payload is built from.
 *
 * Only the article-bearing provider carries metadata in this version; every
 * other provider returns `undefined` so its legacy bytes never change.
 */
export function contentOptionsFor(
  document: LocalPublishDocument,
  provider: LocalProviderId,
): LocalContentOptions | undefined {
  const article = document.overrides?.[provider]?.article;

  return article === undefined ? undefined : { article };
}

/**
 * Whether one frozen target needs a schema-2 record and installation.
 *
 * A schema-1 record is readable by every older build, so only a target that
 * actually carries something new (an article option, or one of the providers
 * this version adds) is written as schema 2.
 */
export function requiresSchema2Record(
  provider: LocalProviderId,
  contentOptions?: LocalContentOptions,
): boolean {
  return (
    contentOptions !== undefined ||
    provider === ARTICLE_PROVIDER ||
    provider === "mastodon"
  );
}

function readNode(node: Node, depth: number): unknown {
  if (depth > MAX_LOCAL_JSON_DEPTH) {
    throw localError(
      "INVALID_JSON",
      "the document is nested too deeply to parse",
    );
  }

  switch (node.type) {
    case "object": {
      const record = Object.create(null) as Record<string, unknown>;
      const seen = new Set<string>();

      for (const property of node.children ?? []) {
        const name = property.children?.[0]?.value as string | undefined;

        if (name === undefined) {
          throw localError("INVALID_JSON", "the document is not strict JSON");
        }

        assertUnicodeText(name);

        if (seen.has(name)) {
          throw localError(
            "INVALID_DOCUMENT",
            "the document repeats an object key",
          );
        }

        seen.add(name);

        const child = property.children?.[1];
        record[name] = child === undefined ? null : readNode(child, depth + 1);
      }

      return record;
    }
    case "array":
      return (node.children ?? []).map(child => readNode(child, depth + 1));
    case "string": {
      const text = node.value as string;

      assertUnicodeText(text);

      return text;
    }
    case "number": {
      const value = node.value as number;

      if (!Number.isFinite(value)) {
        throw localError(
          "INVALID_JSON",
          "the document has a number outside the JSON range",
        );
      }

      return value;
    }
    default:
      return node.value;
  }
}

function readKey(value: unknown): string {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
    throw localError(
      "INVALID_DOCUMENT",
      "key must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    );
  }

  return value;
}

function readContent(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw localError("INVALID_DOCUMENT", `${field} must be a string`);
  }

  if (value.trim().length === 0) {
    throw localError("INVALID_DOCUMENT", `${field} must not be blank`);
  }

  if (countCodePoints(value) > MAX_LOCAL_CONTENT_CODE_POINTS) {
    throw localError(
      "INVALID_DOCUMENT",
      `${field} exceeds ${MAX_LOCAL_CONTENT_CODE_POINTS} code points`,
    );
  }

  return value;
}

function readPlatforms(
  value: unknown,
  schemaVersion: 1 | 2,
): readonly LocalProviderId[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw localError("INVALID_DOCUMENT", "platforms must be a non-empty array");
  }

  const platforms: LocalProviderId[] = [];

  for (const item of value) {
    if (typeof item !== "string") {
      throw localError("INVALID_DOCUMENT", "platforms must name local providers");
    }

    if (REMOTE_ONLY_PROVIDERS.has(item)) {
      throw localError(
        "PROVIDER_LOCAL_UNAVAILABLE",
        "this platform has no local publishing path in this version",
      );
    }

    if (item === ARTICLE_PROVIDER) {
      if (schemaVersion !== 2) {
        throw localError(
          "INVALID_DOCUMENT",
          "devto needs an explicit schemaVersion 2 article document",
        );
      }

      if (!platforms.includes(item)) {
        platforms.push(item);
      } else {
        throw localError(
          "INVALID_DOCUMENT",
          "platforms must not repeat a provider",
        );
      }

      continue;
    }

    if (!isLocalProvider(item)) {
      throw localError(
        "INVALID_DOCUMENT",
        "platforms must name a supported local provider",
      );
    }

    if (platforms.includes(item)) {
      throw localError(
        "INVALID_DOCUMENT",
        "platforms must not repeat a provider",
      );
    }

    platforms.push(item);
  }

  return platforms;
}

function readOverrides(
  value: unknown,
  platforms: readonly LocalProviderId[],
  schemaVersion: 1 | 2,
): LocalPublishOverrides | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isJsonObject(value)) {
    throw localError("INVALID_DOCUMENT", "overrides must be an object");
  }

  const overrides: Partial<Record<LocalProviderId, LocalPublishOverride>> = {};

  for (const field of Object.keys(value)) {
    const isArticleProvider = field === ARTICLE_PROVIDER;

    if (
      (!isLocalProvider(field) && !isArticleProvider) ||
      !platforms.includes(field as LocalProviderId)
    ) {
      throw localError(
        "INVALID_DOCUMENT",
        "overrides may only name a platform selected in platforms",
      );
    }

    const override = value[field];

    if (!isJsonObject(override)) {
      throw localError("INVALID_DOCUMENT", "an override must be an object");
    }

    for (const overrideField of Object.keys(override)) {
      if (
        overrideField !== "content" &&
        !(
          overrideField === "article" &&
          isArticleProvider &&
          schemaVersion === 2
        )
      ) {
        throw localError(
          "INVALID_DOCUMENT",
          "an override accepts only the fields this version defines",
        );
      }
    }

    if (!Object.hasOwn(override, "content")) {
      throw localError("INVALID_DOCUMENT", "an override must carry content");
    }

    if (isArticleProvider) {
      if (schemaVersion !== 2 || !Object.hasOwn(override, "article")) {
        throw localError(
          "INVALID_DOCUMENT",
          "devto needs an explicit article title and full Markdown body",
        );
      }

      overrides[field] = {
        content: readArticleBody(override["content"]),
        article: readArticle(override["article"]),
      };

      continue;
    }

    overrides[field] = {
      content: readContent(override["content"], "override content"),
    };
  }

  return overrides;
}

/**
 * The article body: the same text limits as any content, plus the two
 * structural defences that stop a second metadata channel from overriding the
 * fields the operator actually approved.
 */
function readArticleBody(value: unknown): string {
  const body = readContent(value, "article content");

  if (hasFrontMatter(body)) {
    throw localError(
      "INVALID_DOCUMENT",
      "the article must not open with YAML front matter",
    );
  }

  if (body.includes("{%") || body.includes("%}")) {
    throw localError(
      "INVALID_DOCUMENT",
      "the article must not carry Liquid directives",
    );
  }

  return body;
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

function readArticle(value: unknown): LocalArticleOptions {
  if (!isJsonObject(value)) {
    throw localError("INVALID_DOCUMENT", "article must be an object");
  }

  for (const field of Object.keys(value)) {
    if (field !== "title" && field !== "tags" && field !== "canonicalUrl") {
      throw localError(
        "INVALID_DOCUMENT",
        "the article has a field this version does not accept",
      );
    }
  }

  const title = readArticleTitle(value["title"]);
  const tags = readArticleTags(value["tags"]);
  const canonicalUrl = readCanonicalUrl(value["canonicalUrl"]);

  return {
    title,
    ...(tags === undefined ? {} : { tags }),
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
  };
}

function readArticleTitle(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw localError("INVALID_DOCUMENT", "article title must not be blank");
  }

  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw localError(
      "INVALID_DOCUMENT",
      "article title must not contain control characters",
    );
  }

  if (countCodePoints(value) > MAX_LOCAL_ARTICLE_TITLE_CODE_POINTS) {
    throw localError(
      "INVALID_DOCUMENT",
      `article title exceeds ${MAX_LOCAL_ARTICLE_TITLE_CODE_POINTS} code points`,
    );
  }

  return value;
}

function readArticleTags(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw localError("INVALID_DOCUMENT", "article tags must be an array");
  }

  if (value.length > MAX_LOCAL_ARTICLE_TAGS) {
    throw localError(
      "INVALID_DOCUMENT",
      `article tags must not exceed ${MAX_LOCAL_ARTICLE_TAGS} entries`,
    );
  }

  const tags: string[] = [];

  for (const tag of value) {
    if (typeof tag !== "string" || !/^[a-z0-9]{1,30}$/.test(tag)) {
      throw localError(
        "INVALID_DOCUMENT",
        "each article tag must be 1-30 lowercase alphanumeric characters",
      );
    }

    if (tags.includes(tag)) {
      throw localError("INVALID_DOCUMENT", "article tags must not repeat");
    }

    tags.push(tag);
  }

  return tags;
}

function readCanonicalUrl(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw localError("INVALID_DOCUMENT", "canonicalUrl must be a string");
  }

  if (value.length === 0 || value.length > MAX_LOCAL_CANONICAL_URL_CHARS) {
    throw localError(
      "INVALID_DOCUMENT",
      `canonicalUrl must be 1-${MAX_LOCAL_CANONICAL_URL_CHARS} characters`,
    );
  }

  if (/[\u0000-\u001f\u007f-\u009f]/.test(value) || value !== value.trim()) {
    throw localError("INVALID_DOCUMENT", "canonicalUrl is not a usable URL");
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw localError("INVALID_DOCUMENT", "canonicalUrl must be an absolute URL");
  }

  if (url.protocol !== "https:") {
    throw localError("INVALID_DOCUMENT", "canonicalUrl must use HTTPS");
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw localError("INVALID_DOCUMENT", "canonicalUrl must not carry userinfo");
  }

  return value;
}

function isLocalProvider(value: string): value is LocalProviderId {
  return LOCAL_PROVIDER_SET.has(value);
}

/** JSON-derived objects only: no arrays, no `null`, no class instances. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One leading BOM is tolerated; the marker stays visible anywhere else. */
function stripLeadingBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Rejects unpaired surrogates, including the escaped form `"\ud800"`, which
 * the JSON scanner decodes without validating pairs.
 */
function assertUnicodeText(text: string): void {
  if (hasUnpairedSurrogate(text)) {
    throw localError("INVALID_DOCUMENT", "the document is not valid Unicode text");
  }
}

/** True when the text contains a surrogate that is not part of a valid pair. */
function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);

      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }

      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }

  return false;
}

function countCodePoints(value: string): number {
  let count = 0;

  for (const _ of value) {
    count++;
  }

  return count;
}
