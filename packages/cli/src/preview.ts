import { MAX_CONTENT_CODE_POINTS, escapeControls, type FrozenPost } from "./document.js";

/**
 * The text a human approves.
 *
 * It shows exactly what will be sent and nothing that will not: the request
 * hash, the platforms, the scheduled time, the per-platform overrides, and the
 * idempotency key. Everything here goes to stderr, so an agent running with
 * `--json` still gets a clean stdout.
 */
export function previewText(
  frozen: FrozenPost,
  options: {
    idempotencyKey?: string | undefined;
    idempotencyKeyGenerated?: boolean;
    idempotencyKeyNote?: string | undefined;
  } = {},
): string {
  const { input, source } = frozen;
  const lines: string[] = [
    "Syndroo post preview",
    `  source         ${source.kind} ${source.label} (${source.bytes} bytes)`,
    `  source sha256  ${frozen.sourceSha256}`,
    `  request sha256 ${frozen.requestSha256}`,
    `  platforms      ${input.platforms.join(", ")}`,
    `  scheduled      ${input.scheduledAt ?? "as soon as Syndroo can publish"}`,
  ];

  const overrides = input.overrides;

  if (overrides !== undefined) {
    for (const [platform, override] of Object.entries(overrides)) {
      if (override.content !== undefined) {
        lines.push(`  override ${platform}  ${JSON.stringify(escapeControls(override.content))}`);
      }
    }
  }

  if (options.idempotencyKey !== undefined) {
    const note =
      options.idempotencyKeyNote ??
      (options.idempotencyKeyGenerated === true
        ? "generated for this request; reuse it to replay a failed attempt"
        : "");

    lines.push(
      `  idempotency    ${options.idempotencyKey}${note === "" ? "" : ` (${note})`}`,
    );
  }

  for (const warning of frozen.warnings) {
    lines.push(`  warning        ${warning}`);
  }

  const content = escapeControls(input.content);
  const length = [...input.content].length;

  lines.push(
    `  content        ${length} of ${MAX_CONTENT_CODE_POINTS} characters allowed`,
    "",
    content,
    "",
    "Accepting this request means Syndroo queued it. It is not a delivery result:",
    "read the post before claiming that any platform published it.",
  );

  return lines.join("\n");
}
