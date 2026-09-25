import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import type {
  FrozenDelivery,
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

/** Depth bound: deep enough for every local record, shallow enough to parse. */
const MAX_LOCAL_JSON_DEPTH = 64;

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const LOCAL_PROVIDERS = [
  "bluesky",
  "threads",
] as const satisfies readonly LocalProviderId[];

const LOCAL_PROVIDER_SET: ReadonlySet<string> = new Set<string>(LOCAL_PROVIDERS);

/** Platforms that keep their remote behavior and have no local input path. */
const REMOTE_ONLY_PROVIDERS: ReadonlySet<string> = new Set<string>([
  "x",
  "tumblr",
  "linkedin",
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
}

export type LocalPublishOverrides = Readonly<
  Partial<Record<LocalProviderId, LocalPublishOverride>>
>;

export interface LocalPublishDocument {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly content: string;
  readonly platforms: readonly LocalProviderId[];
  readonly overrides?: LocalPublishOverrides;
}

export interface CanonicalDeliveryOptions {
  readonly namespace: string;
  readonly payloadVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
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

  if (value["schemaVersion"] !== 1) {
    throw localError("INVALID_DOCUMENT", "schemaVersion must be the number 1");
  }

  const key = readKey(value["key"]);
  const content = readContent(value["content"], "content");
  const platforms = readPlatforms(value["platforms"]);
  const overrides = readOverrides(value["overrides"], platforms);

  return {
    schemaVersion: 1,
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
    payloadVersion: options.payloadVersion,
    payloadHash: sha256(
      canonicalJson({
        payloadVersion: options.payloadVersion,
        payload: options.payload,
      }),
    ),
    payload: options.payload,
  };
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

function readPlatforms(value: unknown): readonly LocalProviderId[] {
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
): LocalPublishOverrides | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isJsonObject(value)) {
    throw localError("INVALID_DOCUMENT", "overrides must be an object");
  }

  const overrides: Partial<Record<LocalProviderId, LocalPublishOverride>> = {};

  for (const field of Object.keys(value)) {
    if (!isLocalProvider(field) || !platforms.includes(field)) {
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
      if (overrideField !== "content") {
        throw localError(
          "INVALID_DOCUMENT",
          "an override accepts only content",
        );
      }
    }

    if (!Object.hasOwn(override, "content")) {
      throw localError("INVALID_DOCUMENT", "an override must carry content");
    }

    overrides[field] = {
      content: readContent(override["content"], "override content"),
    };
  }

  return overrides;
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
