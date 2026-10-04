/**
 * Pure Mastodon status-length helpers.
 *
 * The server's own validator (app/validators/status_length_validator.rb) grants
 * a length concession only to entities its Extractor recognizes. This module
 * implements a deliberately narrower, bounded subset instead of copying that
 * algorithm or a third-party regex:
 *
 * - text is counted in Unicode grapheme clusters, so emoji ZWJ sequences,
 *   skin-tone modifiers, regional flags, and combining marks count once;
 * - a URL concession is granted only to `http(s)://` candidates whose authority
 *   is a syntactically valid IPv4, bracketed IPv6, or dotted hostname with an
 *   alphabetic or punycode TLD, with an optional numeric port and an optional
 *   path/query/fragment. Junk after the scheme (`https://%%%%`), a single-label
 *   host (`https://foo`), an embedded match (`xhttps://example.com`), and an
 *   over-long match get no concession and are counted as ordinary text, so
 *   arbitrary prose is never silently undercounted;
 * - a granted URL counts as the instance's `characters_reserved_per_url` value,
 *   whatever its real length;
 * - trailing sentence punctuation is not part of the URL, and a closing bracket
 *   is only part of the URL when it is balanced by an opening bracket inside it;
 * - a mention concession is granted only to `@name@host` whose host is a valid
 *   dotted hostname, whose match is not embedded in a word or email-like token,
 *   and which is outside any URL. It counts as `@name`; the host is not counted;
 * - a non-positive or unsafe `characters_reserved_per_url` makes the count
 *   non-finite, so a bad limit fails closed instead of undercounting.
 *
 * This is not full Mastodon parity. HTML/markdown extraction, punycode
 * normalization beyond `URL`, and any entity the real Extractor recognizes but
 * this subset does not are counted as plain text. That can over-count, never
 * under-count a concession. No new dependency is used: `Intl.Segmenter` is a
 * platform API.
 */

import {
  LocalProviderError,
  type LocalInstanceCapabilities,
} from "@syndroo/core";

/** A bounded URL or mention candidate inside a status text. */
export interface MastodonTextSpan {
  readonly start: number;
  readonly end: number;
}

/** A mention candidate: `end` covers `@name@host`, `nameEnd` covers `@name`. */
export interface MastodonMentionSpan extends MastodonTextSpan {
  readonly nameEnd: number;
}

/**
 * A structured URL candidate. The authority is matched loosely here and
 * validated in `validAuthority`; the path/query/fragment stops at whitespace or
 * a quote so prose is never absorbed into the URL.
 */
const URL_PATTERN =
  /https?:\/\/(?:\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)(?::[0-9]{1,5})?(?:[/?#][^\s<>"']*)?/g;

/** A remote mention: `@name@` plus a dotted hostname of at least two labels. */
const MENTION_PATTERN =
  /@([A-Za-z0-9_]{1,64})@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)/g;

/** A URL concession must not start inside a word, an email, or another entity. */
const URL_EMBEDDED_PREFIX = /[A-Za-z0-9_@.-]/;

/**
 * Official counter rule for remote mentions: the match starts at the beginning
 * of the text or after a character that is neither a word character nor `/`.
 */
const MENTION_BOUNDARY_PREFIX = /[A-Za-z0-9_/]/;

const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const ALPHA_TLD = /^[A-Za-z]{2,63}$/;
const PUNYCODE_TLD = /^xn--[A-Za-z0-9-]{2,59}$/;

/** A granted URL longer than this is counted as plain text instead. */
const MAX_URL_LENGTH = 2048;

const TRAILING_PUNCTUATION = /[.,!?;:'"]/;

/** C0/C1 controls that must never reach a status payload. Tab and newline stay. */
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

let graphemeSegmenter: Intl.Segmenter | null = null;

/**
 * Extracts URL candidates and trims the trailing punctuation that Mastodon's
 * validator also excludes. Trimming is incremental, so a pathological run of
 * closing brackets stays linear rather than re-scanning the candidate.
 */
export function extractMastodonUrls(text: string): readonly MastodonTextSpan[] {
  if (typeof text !== "string" || text === "") {
    return [];
  }

  const spans: MastodonTextSpan[] = [];

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const matched = match[0];

    if (start > 0 && URL_EMBEDDED_PREFIX.test(text[start - 1]!)) {
      continue;
    }

    if (matched.length > MAX_URL_LENGTH) {
      continue;
    }

    const authority = readAuthority(matched);

    // Junk after the scheme, a single-label host, an invalid port, or an
    // unusable hostname gets no concession and is counted as ordinary text.
    if (authority === null || !isValidAuthority(authority)) {
      continue;
    }

    let candidate = matched;
    let openParen = 0;
    let closeParen = 0;
    let openBracket = 0;
    let closeBracket = 0;

    for (const character of candidate) {
      if (character === "(") openParen += 1;
      else if (character === ")") closeParen += 1;
      else if (character === "[") openBracket += 1;
      else if (character === "]") closeBracket += 1;
    }

    while (candidate.length > 0) {
      const last = candidate[candidate.length - 1]!;

      if (TRAILING_PUNCTUATION.test(last)) {
        candidate = candidate.slice(0, -1);
        continue;
      }

      if (last === ")" && closeParen > openParen) {
        closeParen -= 1;
        candidate = candidate.slice(0, -1);
        continue;
      }

      if (last === "]" && closeBracket > openBracket) {
        closeBracket -= 1;
        candidate = candidate.slice(0, -1);
        continue;
      }

      break;
    }

    // A bare scheme is not a URL; require at least one character after it.
    if (candidate.length > "https://".length) {
      spans.push({ start, end: start + candidate.length });
    }
  }

  return spans;
}

/** Remote mentions outside any URL. The host is excluded from the counted part. */
export function extractMastodonMentions(
  text: string,
  urls: readonly MastodonTextSpan[],
): readonly MastodonMentionSpan[] {
  if (typeof text !== "string" || text === "") {
    return [];
  }

  const spans: MastodonMentionSpan[] = [];
  let urlIndex = 0;

  for (const match of text.matchAll(MENTION_PATTERN)) {
    const start = match.index ?? 0;
    const name = match[1] ?? "";
    const host = match[2] ?? "";

    if (start > 0 && MENTION_BOUNDARY_PREFIX.test(text[start - 1]!)) {
      continue;
    }

    // A malformed or single-label host gets no concession.
    if (!isDottedHostname(host)) {
      continue;
    }

    const end = start + match[0].length;

    while (urlIndex < urls.length && urls[urlIndex]!.end <= start) {
      urlIndex += 1;
    }

    const url = urls[urlIndex];

    if (url !== undefined && start < url.end && end > url.start) {
      continue;
    }

    spans.push({ start, end, nameEnd: start + 1 + name.length });
  }

  return spans;
}

/**
 * Counts a status the way this adapter enforces it. An unusable
 * `charactersReservedPerUrl` makes the total non-finite, so every limit check
 * fails closed instead of guessing.
 */
export function countMastodonCharacters(
  text: string,
  charactersReservedPerUrl: number,
): number {
  if (typeof text !== "string") {
    return Number.POSITIVE_INFINITY;
  }

  // A bad limit must never shrink a URL to nothing.
  if (!Number.isSafeInteger(charactersReservedPerUrl) || charactersReservedPerUrl <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  const reserved = charactersReservedPerUrl;
  const urls = extractMastodonUrls(text);
  const mentions = extractMastodonMentions(text, urls);
  const pieces = [
    ...urls.map(span => ({ ...span, kind: "url" as const, nameEnd: span.end })),
    ...mentions.map(span => ({ ...span, kind: "mention" as const })),
  ].sort((left, right) => left.start - right.start);

  let count = 0;
  let cursor = 0;

  for (const piece of pieces) {
    count += graphemeCount(text.slice(cursor, piece.start));
    count +=
      piece.kind === "url"
        ? reserved
        : graphemeCount(text.slice(piece.start, piece.nameEnd));
    cursor = piece.end;
  }

  return count + graphemeCount(text.slice(cursor));
}

/** Plain status text must be non-empty and free of C0/C1 controls. */
export function assertMastodonStatusText(content: unknown): asserts content is string {
  if (
    typeof content !== "string" ||
    content.trim().length === 0 ||
    FORBIDDEN_CONTROL.test(content)
  ) {
    throw new LocalProviderError("INVALID_CONTENT");
  }
}

/**
 * Cached-capability gate shared by plan/preview validation and `prepare`.
 * Malformed capabilities fail closed before any content is considered.
 */
export function assertMastodonContentFits(
  content: string,
  capabilities: LocalInstanceCapabilities,
): void {
  assertMastodonStatusText(content);

  const maxCharacters = capabilities.maxCharacters;
  const reserved = capabilities.charactersReservedPerUrl;

  if (
    !Number.isSafeInteger(maxCharacters) ||
    maxCharacters <= 0 ||
    !Number.isSafeInteger(reserved) ||
    reserved <= 0
  ) {
    throw new LocalProviderError("PROVIDER_UNAVAILABLE");
  }

  if (countMastodonCharacters(content, reserved) > maxCharacters) {
    throw new LocalProviderError("INVALID_CONTENT");
  }
}

/** The authority between `://` and the first path/query/fragment delimiter. */
function readAuthority(matched: string): string | null {
  const schemeEnd = matched.indexOf("://") + 3;
  const rest = matched.slice(schemeEnd);
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);

  return authority === "" ? null : authority;
}

/** Structural authority check: IPv4, bracketed IPv6, or a dotted hostname. */
function isValidAuthority(authority: string): boolean {
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");

    if (close === -1) {
      return false;
    }

    const host = authority.slice(1, close);
    const port = authority.slice(close + 1);

    if (port !== "" && !/^:[0-9]{1,5}$/.test(port)) {
      return false;
    }

    return (
      host.length >= 2 &&
      host.length <= 45 &&
      host.includes(":") &&
      /^[0-9A-Fa-f:.]{2,45}$/.test(host)
    );
  }

  const colon = authority.lastIndexOf(":");
  let host = authority;

  if (colon !== -1) {
    const port = authority.slice(colon + 1);

    if (!/^[0-9]{1,5}$/.test(port)) {
      return false;
    }

    host = authority.slice(0, colon);
  }

  return isValidIpv4(host) || isDottedHostname(host);
}

function isValidIpv4(host: string): boolean {
  const parts = host.split(".");

  return (
    parts.length === 4 &&
    parts.every(part => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/**
 * A dotted hostname: 2+ bounded labels and an alphabetic or punycode TLD. The
 * official mention rule caps the host at 253 characters and requires it to end
 * with an alphanumeric character, which every label check here enforces.
 */
function isDottedHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) {
    return false;
  }

  const labels = host.split(".");

  if (labels.length < 2 || !labels.every(label => HOST_LABEL.test(label))) {
    return false;
  }

  const tld = labels[labels.length - 1]!;

  return ALPHA_TLD.test(tld) || PUNYCODE_TLD.test(tld);
}

function graphemeCount(value: string): number {
  if (value === "") {
    return 0;
  }

  const factory = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;

  if (factory === undefined) {
    return [...value].length;
  }

  graphemeSegmenter ??= new factory("en", { granularity: "grapheme" });

  let count = 0;

  for (const segment of graphemeSegmenter.segment(value)) {
    if (segment.segment.length > 0) {
      count += 1;
    }
  }

  return count;
}
