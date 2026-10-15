/**
 * The shared publication renderer.
 *
 * One function renders a `PublicationView` for both `publish` and
 * `status --operation`, so a target's identity, its content preview and its
 * outcome always read the same way whether the answer came from this process or
 * from stored history.
 *
 * Every untrusted string is escaped before it is measured, and a body that
 * cannot be trusted never sits at column zero: content, reason and URL lines are
 * indented, so injected text cannot forge a `Status:` heading. Truncation keeps
 * Unicode grapheme boundaries and adds an ellipsis only when it actually cut
 * text. Nothing here reads the clock, the filesystem or a provider.
 */

import type { ProviderFailureReason } from "@syndroo/core";
import { safePublicUrl } from "@syndroo/provider-sdk";

import { staticMessage } from "./envelope.js";
import type { PublicationMode, PublicationOutcome, PublicationTargetView, PublicationView } from "./publication-view.js";
import { escapeSingleLine, summarizeText } from "./terminal-text.js";

export type PublicationRenderOptions = {
  /** Terminal columns; the appended layout clamps to 80. */
  readonly width: number;
  /** Show the operation id, connection id, account id, attempts and diagnostics. */
  readonly verbose: boolean;
  /** `v`: the complete frozen preview, never the shortened one. */
  readonly full: boolean;
  readonly color: boolean;
  /** Optional clock for the readable remaining confirmation window. */
  readonly now?: string;
};

/**
 * Layout width used when the terminal width cannot be read.
 *
 * The appended log and the shared renderer must agree on the fallback, so it
 * lives with the renderer instead of being repeated per caller.
 */
export const DEFAULT_LAYOUT_COLUMNS = 80;
/** Body lines before the shortened view clamps them. */
const CONTENT_LINES = 3;
const REASON_LINES = 2;
const NO_CLAMP = 1_000_000;
const SAFE_OPERATION_ID = /^[A-Za-z0-9._:-]{1,512}$/;

const DURABILITY_WARNING =
  "Warning: the outcome could not be saved reliably, so a target may have been sent even though it is not shown as successful.";
const SHORTENED_REMINDER =
  "Some content is shortened. View the full preview before confirming if needed.";

/** The reviewed reason sentence for one classified failure. */
const REASONS: Readonly<Record<ProviderFailureReason, string>> = {
  auth: "Authentication failed.",
  permission: "The account is not allowed to publish.",
  validation: "The platform did not accept the content or options.",
  rate_limited: "The platform rate-limited the request.",
  provider_unavailable: "The platform is temporarily unavailable.",
  network: "The request could not be completed.",
  unsupported: "The platform does not support this request.",
  unknown: "The result could not be confirmed.",
};

/** The short, controlled next step for one classified failure. */
const NEXT: Readonly<Record<ProviderFailureReason, string>> = {
  auth: "Check this account's credentials or reconnect it.",
  permission: "Check the authorization scope for this account.",
  validation: "Check this target's content and fields.",
  rate_limited: "Wait for the platform to allow another attempt.",
  provider_unavailable: "Check the platform status; a new attempt is not guaranteed to be safe.",
  network: "Check the network; retry only when the failure is provably not applied.",
  unsupported: "Check the target's content and options.",
  unknown: "Check the account and the saved operation before publishing again.",
};

const NOT_STARTED_REASONS: Readonly<Record<string, string>> = {
  cancelled_before_start: "Publishing was cancelled before this target started.",
  execution_interrupted: "The run stopped before this target started.",
  stale_binding: "The connection binding changed before this target started.",
  stale_implementation: "The provider changed before this target started.",
};

/**
 * Every `escape` caller here renders one line: an identity, an id, a field
 * name, a url, a diagnostic or a fixed status word. A newline inside any of
 * them would start a fresh, unindented line, which is exactly how a forged
 * `Status:` heading would appear, so the single-line form is used throughout.
 * Prose bodies keep their real line breaks and go through `summarizeText`.
 */
const escape = escapeSingleLine;

/**
 * Bold a fixed heading when colour is enabled.
 *
 * Only static, already-reviewed text is styled, so a colour sequence can never
 * wrap untrusted content or change how a line measures. `--no-color` simply
 * returns the plain text.
 */
function heading(text: string, color: boolean): string {
  return color ? `\u001b[1m${text}\u001b[0m` : text;
}

function jsonText(value: unknown): string {
  return escape(JSON.stringify(value) ?? "null");
}

/** Body width inside the two-space indent, clamped like the appended log. */
function bodyWidth(width: number): number {
  return Math.max(8, Math.min(width, DEFAULT_LAYOUT_COLUMNS) - 2);
}

/**
 * The one human status for a target.
 *
 * A target without an outcome is never shown as finished: `ready` waits,
 * `in_flight` is publishing, and a record that cannot say which phase it is in
 * says so instead of guessing.
 *
 * A durability warning is a round-level fact and is rendered as its own line.
 * It never rewrites a target whose success really is on disk, and a target left
 * claimed but unrecorded reads as unknown rather than as a live publish.
 */
function statusText(view: PublicationView, target: PublicationTargetView): string {
  if (view.phase === "dry_run") {
    return "Preview only";
  }

  if (view.phase === "prepared") {
    return view.confirmation === "expired" ? "Expired" : "Awaiting confirmation";
  }

  const outcome = target.outcome ?? null;
  let status: string | undefined;

  if (outcome?.status === "succeeded") {
    status = "Successful";
  } else if (outcome?.status === "failed") {
    status = "Failed";
  } else if (outcome?.status === "not_started") {
    status = "Not sent";
  } else if (outcome?.status === "unknown") {
    status = "Unknown";
  } else if (target.state === "in_flight") {
    status = view.durabilityWarning === undefined ? "Publishing" : "Unknown";
  } else if (target.state === "ready") {
    status = "Waiting";
  } else if (target.state === "settled") {
    status = "Unknown";
  }

  if (status === undefined) {
    return "Phase cannot be determined";
  }

  return view.mode === "recorded" && outcome === null
    ? `Last recorded status: ${status}`
    : status;
}

/** The reason and next step for a target, or nothing when it needs neither. */
function diagnosis(target: PublicationTargetView): { reason?: string; next?: string } {
  const outcome = target.outcome ?? null;

  if (outcome === null) {
    return {};
  }

  if (outcome.status === "not_started") {
    return { reason: NOT_STARTED_REASONS[outcome.reason] ?? "This target was not started." };
  }

  if (outcome.status === "succeeded") {
    return {};
  }

  // An unknown write never claims a classified failure: the platform may have
  // accepted it, so the reason is the ambiguity itself and the advice is to
  // check rather than to retry.
  const reason = outcome.status === "unknown" ? "unknown" : outcome.reason;

  return { reason: REASONS[reason], next: NEXT[reason] };
}

/** Preview fields, dropping only a `text` field that repeats the body. */
function visibleFields(target: PublicationTargetView): readonly { name: string; value: unknown }[] {
  const body = target.preview?.content.text;

  return (target.preview?.fields ?? []).filter(
    (field) => !(field.name === "text" && typeof field.value === "string" && field.value === body),
  );
}

function targetLines(
  view: PublicationView,
  target: PublicationTargetView,
  options: PublicationRenderOptions,
  columns: number,
  state: { shortened: boolean },
): string[] {
  const lines = [
    `-> ${escape(target.provider)} · ${escape(target.displayName)}`,
    `   ${escape(target.displayUrl)}`,
  ];

  if (options.verbose) {
    lines.push(`   connection: ${escape(target.connectionId)}`);
    lines.push(`   account: ${escape(target.accountId)}`);
  }

  const body = target.preview?.content.text;
  const expanded = options.full || options.verbose;

  if (body !== undefined && body.length > 0) {
    lines.push("Content:");

    const summary = summarizeText(body, columns, expanded ? NO_CLAMP : CONTENT_LINES);

    for (const line of summary.lines) {
      lines.push(`  ${line}`);
    }

    state.shortened ||= summary.truncated;
  }

  for (const field of visibleFields(target)) {
    const rendered = `${escape(field.name)}: ${jsonText(field.value)}`;

    if (expanded) {
      lines.push(`  ${rendered}`);
    } else {
      const wrapped = summarizeText(rendered, columns, 1);

      lines.push(`  ${wrapped.lines[0] ?? ""}`);
      state.shortened ||= wrapped.truncated;
    }
  }

  lines.push("Status:", `  ${escape(statusText(view, target))}`);

  const url = target.outcome?.status === "succeeded" ? target.outcome.url : undefined;
  const safeUrl = safePublicUrl(url);

  if (safeUrl !== undefined) {
    lines.push("Post:", `  ${escape(safeUrl)}`);
  }

  const { reason, next } = diagnosis(target);

  if (reason !== undefined) {
    lines.push("Reason:");

    for (const line of summarizeText(reason, columns, expanded ? NO_CLAMP : REASON_LINES).lines) {
      lines.push(`  ${line}`);
    }
  }

  if (next !== undefined) {
    lines.push("Next:");

    for (const line of summarizeText(next, columns, expanded ? NO_CLAMP : REASON_LINES).lines) {
      lines.push(`  ${line}`);
    }
  }

  if (options.verbose && target.outcome !== undefined && target.outcome !== null) {
    const outcome = target.outcome;

    if (outcome.status !== "succeeded" && outcome.status !== "not_started") {
      const diagnostic = outcome.diagnostic;

      if (diagnostic !== undefined) {
        const parts = [
          diagnostic.providerCode,
          diagnostic.httpStatus === undefined ? undefined : String(diagnostic.httpStatus),
          diagnostic.message,
        ].filter((part): part is string => part !== undefined);

        if (parts.length > 0) {
          lines.push(`   diagnostic: ${escape(parts.join(" · "))}`);
        }
      }
    }

    if (target.attempts !== undefined) {
      lines.push(`   attempts: ${target.attempts}`);
    }
  }

  return lines;
}

/** Human status bucket used for the final non-zero summary. */
function bucket(view: PublicationView, target: PublicationTargetView): string | undefined {
  switch (statusText(view, target)) {
    case "Successful":
      return "successful";
    case "Failed":
      return "failed";
    case "Unknown":
      return "unknown";
    case "Not sent":
      return "not sent";
    default:
      return undefined;
  }
}

function summaryLine(view: PublicationView): string | undefined {
  if (view.phase !== "execution" || view.targets.length < 2) {
    return undefined;
  }

  const order = ["successful", "failed", "unknown", "not sent"] as const;
  const counts = new Map<string, number>();

  for (const target of view.targets) {
    const name = bucket(view, target);

    if (name !== undefined) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  const parts = order
    .filter((name) => (counts.get(name) ?? 0) > 0)
    .map((name) => `${counts.get(name)} ${name}`);

  return parts.length === 0 ? undefined : `Summary: ${parts.join(", ")}`;
}

/** The follow-up states that deserve one query entry point. */
function needsQueryEntry(view: PublicationView): boolean {
  if (view.durabilityWarning !== undefined) {
    return true;
  }

  return (
    view.status === "failed" ||
    view.status === "partial" ||
    view.status === "unknown" ||
    view.status === "pending" ||
    view.status === "running"
  );
}

function queryLines(view: PublicationView): string[] {
  if (view.phase !== "execution" || view.operationId === undefined || !needsQueryEntry(view)) {
    return [];
  }

  const operationId = view.operationId;

  if (!SAFE_OPERATION_ID.test(operationId)) {
    return ["Check this operation:", "  syndroo status --verbose"];
  }

  return [
    "Check this operation:",
    `  syndroo status --operation ${operationId} --verbose`,
  ];
}

function remainingLabel(expiresAt: string, now: string): string | undefined {
  const remaining = Date.parse(expiresAt) - Date.parse(now);

  if (!Number.isFinite(remaining)) {
    return undefined;
  }

  if (remaining <= 0) {
    return "expired";
  }

  const minutes = Math.ceil(remaining / 60_000);

  return `${minutes} minute${minutes === 1 ? "" : "s"} remaining`;
}

/**
 * Render one publication view as terminal lines.
 *
 * The caller owns the mode that selects the heading (`preview`, `live` or
 * `recorded`); this function only turns the normalized view into text.
 */
export function renderPublication(
  view: PublicationView,
  options: PublicationRenderOptions,
): string[] {
  const columns = bodyWidth(options.width);
  const lines: string[] = [];
  const state = { shortened: false };

  if (view.durabilityWarning !== undefined) {
    lines.push(DURABILITY_WARNING);
  }

  switch (view.phase) {
    case "failure":
      lines.push(
        heading("Publication not started", options.color),
        `  ${staticMessage(view.failureCode ?? "INTERNAL")}`,
      );
      break;
    case "dry_run":
      lines.push(
        heading(
          "Preview only — nothing has been sent and no credentials were verified",
          options.color,
        ),
      );

      if (view.unverified.length > 0) {
        lines.push(`  unverified: ${view.unverified.map(escape).join(", ")}`);
      }

      break;
    case "prepared":
      lines.push(
        heading(
          view.confirmation === "expired"
            ? "Confirmation window closed — prepare again to review and confirm"
            : "Review publication — nothing has been sent",
          options.color,
        ),
      );
      break;
    case "execution":
      break;
  }

  if (options.verbose && view.operationId !== undefined) {
    lines.push(`Operation: ${escape(view.operationId)}`);
  }

  if (options.verbose && view.expiresAt !== undefined) {
    const remaining = options.now === undefined ? undefined : remainingLabel(view.expiresAt, options.now);

    lines.push(
      remaining === undefined
        ? `Expires: ${escape(view.expiresAt)}`
        : `Expires: ${escape(view.expiresAt)} (${escape(remaining)})`,
    );
  }

  for (const target of view.targets) {
    if (lines.length > 0) {
      lines.push("");
    }

    lines.push(...targetLines(view, target, options, columns, state));
  }

  if (state.shortened && view.mode !== "recorded") {
    lines.push("", SHORTENED_REMINDER);
  }

  const summary = summaryLine(view);

  if (summary !== undefined) {
    lines.push("", summary);
  }

  const query = queryLines(view);

  if (query.length > 0) {
    lines.push("", ...query);
  }

  return lines;
}

export type { PublicationMode };

/**
 * The status line for one target, shared with the append-only log controller.
 *
 * A log that appends only changed status lines must not re-derive what
 * "changed" means, so the one status vocabulary lives here.
 */
export { statusText as publicationTargetStatus };
