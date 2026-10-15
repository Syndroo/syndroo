/**
 * Optional, untrusted account presentation and safe diagnostics.
 *
 * A provider may return a human-readable account name, a public profile URL, a
 * connection label and a small, bounded diagnostic alongside its real result.
 * None of it is identity: it never participates in target selection, account
 * de-duplication, authentication or binding revision. Every value here is
 * untrusted input, so each field is validated field by field and an invalid
 * field is dropped (never repaired, never echoed) rather than failing the whole
 * result. Dropping a presentation field can never mask a real identity or
 * evidence failure, because identity and evidence are validated separately.
 *
 * The module is inert: no I/O, no clock read, no randomness, no imports.
 */

import type {
  AccountPresentation,
  ProviderFailureReason,
  SafeDiagnostic,
  TargetPresentation
} from "./types.js";

/** Bounded sizes shared with `protocol.schema.json`. */
export const PRESENTATION_LIMITS = {
  /** Readable account name and label, in Unicode code points. */
  nameMax: 256,
  /** Public profile URL, in UTF-16 code units (matching the schema). */
  urlMax: 2048
} as const;

export const DIAGNOSTIC_LIMITS = {
  codeMax: 64,
  statusMin: 100,
  statusMax: 599,
  messageMax: 512
} as const;

const ACCOUNT_NAME = /^[\P{Cc}\P{Cf}\P{Zl}\P{Zp}]+$/u;
const URL_FORBIDDEN = /[\u0000-\u0020\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const PROVIDER_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Scheme plus a non-empty, `@`-free authority: `https://host[:port]`. */
const HTTPS_AUTHORITY = /^https:\/\/([^/?#]+)/;
const AUTHORITY = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value) as unknown;

  return proto === Object.prototype || proto === null;
}

/**
 * True when a string can be shown as one terminal line without escaping.
 *
 * Rejects lone surrogates, C0/C1 controls, carriage return, line/paragraph
 * separators, and bidirectional/zero-width formatting controls, so text can
 * never forge a status line or reorder what a human reads.
 */
export function isSafeDisplayText(value: string): boolean {
  return value.isWellFormed() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

/** A bounded, single-line, control-free account name, or `undefined`. */
export function sanitizeAccountName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || !isSafeDisplayText(value)) {
    return undefined;
  }

  if ([...value].length > PRESENTATION_LIMITS.nameMax || !ACCOUNT_NAME.test(value)) {
    return undefined;
  }

  return value;
}

/**
 * A conservative public URL: `https`, no userinfo, no query or fragment, no
 * control or bidirectional characters, bounded length.
 *
 * The original string is returned unchanged (never normalized), and the check
 * is never a substitute for the transport's own egress policy. A string that
 * merely begins with `https://` is not trusted.
 */
export function safePublicUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > PRESENTATION_LIMITS.urlMax) {
    return undefined;
  }

  if (!value.isWellFormed() || URL_FORBIDDEN.test(value)) {
    return undefined;
  }

  // The raw authority is checked before parsing: `new URL` repairs inputs like
  // `https:///host` or `https://@host`, and a repaired string is not evidence
  // that the original was a safe public profile URL.
  const authority = HTTPS_AUTHORITY.exec(value)?.[1];

  if (authority === undefined || !AUTHORITY.test(authority)) {
    return undefined;
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return undefined;
  }

  return value;
}

/** Drop unknown keys; keep only presentation fields that individually validate. */
export function sanitizeAccountPresentation(value: unknown): AccountPresentation | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  const accountName = sanitizeAccountName(value["accountName"]);
  const profileUrl = safePublicUrl(value["profileUrl"]);

  if (accountName === undefined && profileUrl === undefined) {
    return undefined;
  }

  return {
    ...(accountName === undefined ? {} : { accountName }),
    ...(profileUrl === undefined ? {} : { profileUrl })
  };
}

export function sanitizeTargetPresentation(value: unknown): TargetPresentation | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  const accountName = sanitizeAccountName(value["accountName"]);
  const profileUrl = safePublicUrl(value["profileUrl"]);
  const label = sanitizeAccountName(value["label"]);

  if (accountName === undefined && profileUrl === undefined && label === undefined) {
    return undefined;
  }

  return {
    ...(accountName === undefined ? {} : { accountName }),
    ...(profileUrl === undefined ? {} : { profileUrl }),
    ...(label === undefined ? {} : { label })
  };
}

/**
 * Fixed, reviewed sentence for one classified failure reason.
 *
 * A diagnostic message is a template chosen here, never text reflected from a
 * platform response, an exception or user input, so an official provider can
 * attach a diagnostic without inventing prose or echoing a body.
 */
export const DIAGNOSTIC_MESSAGES: Readonly<Record<ProviderFailureReason, string>> = {
  auth: "The platform rejected the credential.",
  permission: "The platform refused the publish permission.",
  validation: "The platform rejected the content or options.",
  rate_limited: "The platform rate-limited the request.",
  provider_unavailable: "The platform reported a server error.",
  network: "The request could not be completed.",
  unsupported: "The platform does not support this request.",
  unknown: "The result could not be confirmed."
};

const REVIEWED_DIAGNOSTIC_MESSAGES: ReadonlySet<string> = new Set(Object.values(DIAGNOSTIC_MESSAGES));

/**
 * A bounded diagnostic message from the fixed, reviewed set, or `undefined`.
 *
 * A message is only accepted when it is one of the sentences in
 * `DIAGNOSTIC_MESSAGES`. Length and character checks are not a redaction
 * boundary, so an arbitrary single-line string — a token, a cookie, a raw
 * `error.message` or a response body — is never a valid value here, even when
 * it happens to be short and control-free.
 */
export function sanitizeDiagnosticMessage(value: unknown): string | undefined {
  if (typeof value !== 'string' || !REVIEWED_DIAGNOSTIC_MESSAGES.has(value)) {
    return undefined;
  }

  return value;
}

/** Drop invalid diagnostic fields; return `undefined` when nothing survives. */
export function sanitizeSafeDiagnostic(value: unknown): SafeDiagnostic | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  const providerCode =
    typeof value["providerCode"] === 'string' && PROVIDER_CODE.test(value["providerCode"])
      ? value["providerCode"]
      : undefined;
  const httpStatus =
    typeof value["httpStatus"] === 'number' &&
    Number.isInteger(value["httpStatus"]) &&
    value["httpStatus"] >= DIAGNOSTIC_LIMITS.statusMin &&
    value["httpStatus"] <= DIAGNOSTIC_LIMITS.statusMax
      ? value["httpStatus"]
      : undefined;
  const message = sanitizeDiagnosticMessage(value["message"]);

  if (providerCode === undefined && httpStatus === undefined && message === undefined) {
    return undefined;
  }

  return {
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(message === undefined ? {} : { message })
  };
}



/**
 * The bounded diagnostic for one definite HTTP rejection.
 *
 * `httpStatus` is the status the provider just received and `message` is the
 * fixed sentence for the classified reason. `providerCode` is attached only
 * when the caller proved it against the platform's own published error names;
 * an unproven name is never invented here.
 */
export function safeHttpDiagnostic(input: {
  httpStatus: number;
  reason: ProviderFailureReason;
  providerCode?: string;
}): SafeDiagnostic | undefined {
  return sanitizeSafeDiagnostic({
    ...(input.providerCode === undefined ? {} : { providerCode: input.providerCode }),
    httpStatus: input.httpStatus,
    message: DIAGNOSTIC_MESSAGES[input.reason]
  });
}
