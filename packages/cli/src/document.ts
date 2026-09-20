import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Readable } from "node:stream";
import type { CreatePostInput, KnownPlatform } from "@syndroo/sdk";

import { CliError, usageError } from "./cli-error.js";
import { EXIT_CODE } from "./exit-codes.js";

/** Mirrors the server contract in `packages/cloudflare-worker/src/posts.ts`. */
export const MAX_CONTENT_CODE_POINTS = 10_000;

/** A document larger than this is a mistake, not a post. */
const MAX_SOURCE_BYTES = 1024 * 1024;

const PLATFORM_LIST = [
  "x",
  "threads",
  "bluesky",
  "tumblr",
  "mastodon",
  "linkedin",
  "nostr",
] as const satisfies readonly KnownPlatform[];

/**
 * Compile-time guard: every platform the SDK documents must appear above, so
 * the local list cannot silently fall behind the published contract.
 */
export type PlatformListIsComplete = Exclude<
  KnownPlatform,
  (typeof PLATFORM_LIST)[number]
> extends never
  ? true
  : never;

const PLATFORM_SET: ReadonlySet<string> = new Set<string>(PLATFORM_LIST);

export interface DocumentIssue {
  readonly path: string;
  readonly message: string;
}

/** The document itself is wrong. Reported with every issue, never one at a time. */
export class DocumentError extends CliError {
  readonly issues: readonly DocumentIssue[];

  constructor(issues: readonly DocumentIssue[]) {
    super(
      `the post document is invalid: ${issues
        .map(issue => `${issue.path === "" ? "document" : issue.path} ${issue.message}`)
        .join("; ")}`,
      {
        exitCode: EXIT_CODE.USAGE,
        code: "INVALID_DOCUMENT",
        details: { issues },
      },
    );
    this.name = "DocumentError";
    this.issues = issues;
  }
}

export interface ParsedDocument {
  /** Normalized request body, built in the exact key order that is hashed. */
  readonly input: CreatePostInput;
  readonly warnings: readonly string[];
}

export interface PostSource {
  readonly kind: "file" | "stdin";
  readonly label: string;
  readonly bytes: number;
  readonly text: string;
}

export interface FrozenPost {
  readonly input: CreatePostInput;
  /** sha256 of the exact bytes that will be sent, so a preview can be checked against a receipt. */
  readonly requestSha256: string;
  /** sha256 of the document as read, before normalization. */
  readonly sourceSha256: string;
  readonly source: PostSource;
  readonly warnings: readonly string[];
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The document as it will appear on the wire.
 *
 * `create` sends this object unchanged, so the previewed hash and the request
 * body are the same bytes. Nothing re-reads the source file afterwards.
 */
export function canonicalRequestJson(input: CreatePostInput): string {
  const body: Record<string, unknown> = {
    content: input.content,
    platforms: [...input.platforms],
  };
  const overrides = input.overrides;

  if (overrides !== undefined) {
    const ordered: Record<string, { content: string }> = {};

    for (const platform of input.platforms) {
      const override = overrides[platform];

      if (override?.content !== undefined) {
        ordered[platform] = { content: override.content };
      }
    }

    body["overrides"] = ordered;
  }

  if (input.scheduledAt !== undefined) {
    body["scheduledAt"] = input.scheduledAt;
  }

  return JSON.stringify(body);
}

/**
 * Local validation. It mirrors the server's documented rules and says nothing
 * about platform configuration, which only the instance can know.
 */
export function parsePostDocument(text: string, label: string): ParsedDocument {
  const issues: DocumentIssue[] = [];
  const warnings: string[] = [];
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new DocumentError([
      {
        path: "",
        message: `is not valid JSON (${(error as Error).message}) in ${label}`,
      },
    ]);
  }

  if (!isRecord(value)) {
    throw new DocumentError([
      { path: "document", message: "must be a JSON object" },
    ]);
  }

  const known = new Set(["content", "platforms", "overrides", "scheduledAt"]);
  const unknownKeys = Object.keys(value).filter(key => !known.has(key));

  if (unknownKeys.length > 0) {
    warnings.push(
      `ignored unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`,
    );
  }

  const content = readContent(value["content"], "content", issues);
  const platforms = readPlatforms(value["platforms"], issues);
  const overrides = readOverrides(value["overrides"], platforms ?? [], issues);
  const scheduledAt = readScheduledAt(value["scheduledAt"], issues, warnings);

  if (issues.length > 0) {
    throw new DocumentError(issues);
  }

  // Insertion order matters: `canonicalRequestJson` hashes these same keys.
  const input: Record<string, unknown> = {
    content: content as string,
    platforms: platforms as readonly string[],
  };

  if (overrides !== undefined) {
    input["overrides"] = overrides;
  }

  if (scheduledAt !== undefined) {
    input["scheduledAt"] = scheduledAt;
  }

  return { input: input as unknown as CreatePostInput, warnings };
}

export function freezePost(parsed: ParsedDocument, source: PostSource): FrozenPost {
  return {
    input: parsed.input,
    requestSha256: sha256(canonicalRequestJson(parsed.input)),
    sourceSha256: sha256(source.text),
    source,
    warnings: parsed.warnings,
  };
}

/**
 * Reads the document exactly once.
 *
 * The returned text is what the preview shows and what gets sent. A later edit
 * to the file cannot change the request, because the file is not read again.
 */
export async function readPostSource(options: {
  file: string | undefined;
  stdin: Readable;
  stdinIsTty: boolean;
  cwd: string;
}): Promise<PostSource> {
  const file = options.file;

  if (file !== undefined && file !== "-") {
    const bytes = readSourceFile(file);
    return {
      kind: "file",
      label: file,
      bytes: bytes.byteLength,
      text: bytes.toString("utf8"),
    };
  }

  if (options.stdinIsTty) {
    throw usageError(
      file === "-"
        ? "stdin is a terminal, so there is no document to read. Pass --file <path>."
        : "--file is required when stdin is a terminal. Pass --file <path> or pipe the document on stdin.",
    );
  }

  const text = await readAll(options.stdin);
  const bytes = Buffer.byteLength(text, "utf8");

  if (bytes === 0) {
    throw usageError(
      "the post document on stdin is empty. Pass --file <path> or pipe the document on stdin.",
    );
  }

  return { kind: "stdin", label: "stdin", bytes, text };
}

function readSourceFile(file: string): Buffer {
  let size: number;

  try {
    size = statSync(file).size;
  } catch (error) {
    throw usageError(
      `cannot read --file ${file}: ${(error as Error).message}`,
    );
  }

  if (size > MAX_SOURCE_BYTES) {
    throw usageError(
      `--file ${file} is ${size} bytes; the limit is ${MAX_SOURCE_BYTES}.`,
    );
  }

  try {
    return readFileSync(file);
  } catch (error) {
    throw usageError(`cannot read --file ${file}: ${(error as Error).message}`);
  }
}

async function readAll(readable: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of readable) {
    const buffer =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk as Uint8Array);

    total += buffer.byteLength;

    if (total > MAX_SOURCE_BYTES) {
      throw usageError(
        `the document on stdin exceeds ${MAX_SOURCE_BYTES} bytes.`,
      );
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function readContent(
  value: unknown,
  path: string,
  issues: DocumentIssue[],
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path, message: "must be a non-empty string" });
    return undefined;
  }

  if ([...value].length > MAX_CONTENT_CODE_POINTS) {
    issues.push({
      path,
      message: `exceeds ${MAX_CONTENT_CODE_POINTS} characters`,
    });
    return undefined;
  }

  return value;
}

function readPlatforms(
  value: unknown,
  issues: DocumentIssue[],
): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path: "platforms", message: "must be a non-empty array" });
    return undefined;
  }

  const platforms: string[] = [];
  const seen = new Set<string>();
  let failed = false;

  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !PLATFORM_SET.has(item)) {
      issues.push({
        path: `platforms[${index}]`,
        message: `must be one of ${PLATFORM_LIST.join(", ")}`,
      });
      failed = true;
      continue;
    }

    if (seen.has(item)) {
      issues.push({
        path: `platforms[${index}]`,
        message: "must not repeat a platform",
      });
      failed = true;
      continue;
    }

    seen.add(item);
    platforms.push(item);
  }

  return failed ? undefined : platforms;
}

function readOverrides(
  value: unknown,
  platforms: readonly string[],
  issues: DocumentIssue[],
): Record<string, { content: string }> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    issues.push({ path: "overrides", message: "must be an object" });
    return undefined;
  }

  const overrides: Record<string, { content: string }> = {};
  let failed = false;

  for (const [platform, override] of Object.entries(value)) {
    if (!PLATFORM_SET.has(platform) || !platforms.includes(platform)) {
      issues.push({
        path: `overrides.${platform}`,
        message: "must name a platform selected in platforms",
      });
      failed = true;
      continue;
    }

    if (!isRecord(override)) {
      issues.push({
        path: `overrides.${platform}`,
        message: "must be an object",
      });
      failed = true;
      continue;
    }

    const unknown = Object.keys(override).filter(key => key !== "content");

    if (unknown.length > 0) {
      issues.push({
        path: `overrides.${platform}`,
        message: `contains unsupported field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
      });
      failed = true;
      continue;
    }

    const content = readContent(
      override["content"],
      `overrides.${platform}.content`,
      issues,
    );

    if (content === undefined) {
      failed = true;
      continue;
    }

    overrides[platform] = { content };
  }

  return failed ? undefined : overrides;
}

function readScheduledAt(
  value: unknown,
  issues: DocumentIssue[],
  warnings: string[],
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({
      path: "scheduledAt",
      message: "must be an ISO date-time string",
    });
    return undefined;
  }

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    issues.push({
      path: "scheduledAt",
      message: "must be a valid ISO date-time string",
    });
    return undefined;
  }

  if (timestamp <= Date.now()) {
    warnings.push(
      "scheduledAt is not in the future, so Syndroo publishes as soon as it can.",
    );
  }

  return new Date(timestamp).toISOString();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Terminal-safe rendering of untrusted text.
 *
 * Control characters are replaced for display only; the request body keeps the
 * original bytes. A document must not be able to move the cursor or rewrite the
 * preview it was approved in.
 */
export function escapeControls(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, character => {
    const code = character.codePointAt(0) as number;
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}
