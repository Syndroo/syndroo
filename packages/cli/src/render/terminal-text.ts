/**
 * Terminal-safe text measurement, wrapping and truncation.
 *
 * Untrusted text is escaped before it is measured, so an escape sequence, a
 * carriage return or a bidirectional override can never move the cursor, hide
 * text or forge a `Status:` line. Truncation never splits a Unicode grapheme:
 * `Intl.Segmenter` supplies the boundaries instead of a hand-written table.
 *
 * Two escaping modes exist because two shapes of text exist. Prose (a post
 * body, a reason) keeps its real line breaks, so a newline really is a new line
 * and the caller indents it. A single-line field (an identity, an account id, a
 * connection id) must never introduce a line at all, so its newline and tab are
 * rendered as visible escapes too.
 */

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Control codes and bidirectional formatting characters, except a real newline.
 *
 * Tab is included: a tab is rendered as the two-character escape `\t`, so it
 * cannot move the cursor to a column the layout did not account for.
 */
const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** The line breaks a single-line field must not contain either. */
const LINE_BREAK = /[\u000a\u000d]/g;

/** The readable escape for the three characters a reader most expects. */
const NAMED: Readonly<Record<number, string>> = {
  0x09: "\\t",
  0x0a: "\\n",
  0x0d: "\\r",
};

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, "0");
}

function escapeCharacter(character: string): string {
  const code = character.codePointAt(0) ?? 0;

  return NAMED[code] ?? (code <= 0xff ? `\\x${hex(code, 2)}` : `\\u${hex(code, 4)}`);
}

/**
 * Escape every control code except a real newline, plus the bidirectional
 * formatting characters that can reorder a rendered line.
 */
export function escapeUnsafeText(value: string): string {
  return value.replace(UNSAFE, escapeCharacter);
}

/**
 * Escape one single-line field.
 *
 * A newline or carriage return becomes a visible escape instead of a line
 * break, so a forged `Status:` line can never appear at column zero. Used for
 * identities, ids, field names, urls and diagnostics.
 */
export function escapeSingleLine(value: string): string {
  return value.replace(LINE_BREAK, escapeCharacter).replace(UNSAFE, escapeCharacter);
}

/** Grapheme clusters, in order, without any synthetic width table. */
export function graphemes(value: string): readonly string[] {
  return Array.from(segmenter.segment(value), (part) => part.segment);
}

/** Codepoints of one grapheme cluster. */
function codePoints(grapheme: string): readonly number[] {
  return Array.from(grapheme, (character) => character.codePointAt(0) ?? 0);
}

/**
 * Emoji presentation selector (`U+FE0F`): the grapheme renders two cells wide,
 * even when its base character is narrow (`☔️`, `#️⃣`).
 */
const VS16 = 0xfe0f;
/**
 * Text presentation selector (`U+FE0E`): the writer asked for the narrow,
 * monochrome form, so the cluster stays one cell (`⌚︎`, `☔︎`).
 */
const VS15 = 0xfe0e;
/**
 * Characters whose default presentation is already an emoji glyph.
 *
 * `☔` (`U+2614`), `⌚` (`U+231A`) and `⏰` (`U+23F0`) carry
 * `Emoji_Presentation=Yes` without a variation selector, and common terminals
 * render every one of them two cells wide. A hand-written range table misses
 * them, so the Unicode property itself is the authority here.
 */
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;

function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

/**
 * Display columns of one grapheme.
 *
 * `0` for a joiner or a combining mark, `2` for a wide glyph, a tab (rendered as
 * `\t`) or any emoji-presentation glyph (`☔`, `⌚` and `⏰` are two cells with no
 * variation selector at all; `☔️` adds one and stays two), `1` otherwise. The
 * text presentation selector (`⌚︎`) keeps the narrow form.
 */
export function graphemeWidth(grapheme: string): number {
  const points = codePoints(grapheme);
  const first = points[0];

  if (first === undefined) {
    return 0;
  }

  if (first === 0x0a || first === 0x0d) {
    return 0;
  }

  // `☔️` (U+2614 U+FE0F) and `#️⃣` are two cells even though their base
  // character is narrow; the presentation selector promotes the whole cluster.
  if (points.length > 1 && points.includes(VS16)) {
    return 2;
  }

  // The opposite request: the text presentation selector keeps the narrow form.
  if (points.length > 1 && points.includes(VS15)) {
    return 1;
  }

  if (
    first === 0x200d ||
    (first >= 0xfe00 && first <= 0xfe0f) ||
    (first >= 0x20d0 && first <= 0x20ff)
  ) {
    return 0;
  }

  // A tab is always rendered as the escape `\t`, which is two columns.
  if (first === 0x09) {
    return 2;
  }

  // A default-emoji glyph is two cells even with no variation selector, so the
  // property decides before the range table gets a chance to say "narrow".
  if (EMOJI_PRESENTATION.test(String.fromCodePoint(first))) {
    return 2;
  }

  return isWide(first) ? 2 : 1;
}

export function displayWidth(value: string): number {
  let width = 0;

  for (const grapheme of graphemes(value)) {
    width += graphemeWidth(grapheme);
  }

  return width;
}

/** Keep only the leading graphemes that fit inside `width` columns. */
export function truncateToWidth(value: string, width: number): string {
  let used = 0;
  let kept = "";

  for (const grapheme of graphemes(value)) {
    const size = graphemeWidth(grapheme);

    if (used + size > width) {
      break;
    }

    kept += grapheme;
    used += size;
  }

  return kept;
}

/**
 * Wrap and clamp one text body.
 *
 * Real newlines become separate lines, long lines wrap at the requested width
 * and only `maxLines` lines are returned; `truncated` reports whether anything
 * was dropped, so the caller adds an ellipsis only when it actually cut text.
 */
export function summarizeText(
  text: string,
  width: number,
  maxLines: number,
): { lines: string[]; truncated: boolean } {
  const columns = Math.max(1, width);
  const wrapped: string[] = [];

  for (const source of escapeUnsafeText(text).split("\n")) {
    let line = "";
    let used = 0;

    for (const grapheme of graphemes(source)) {
      const size = graphemeWidth(grapheme);

      if (used > 0 && used + size > columns) {
        wrapped.push(line);
        line = "";
        used = 0;
      }

      line += grapheme;
      used += size;
    }

    wrapped.push(line);
  }

  const lines = wrapped.slice(0, Math.max(1, maxLines));

  if (wrapped.length > lines.length) {
    const last = lines.length - 1;
    lines[last] = `${truncateToWidth(lines[last] ?? "", columns - 1)}…`;
  }

  return { lines, truncated: wrapped.length > lines.length };
}
