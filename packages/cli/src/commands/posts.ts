import { randomUUID } from "node:crypto";
import {
  isPostDelivered,
  isPostTerminal,
  SyndrooApiError,
  type PostDetail,
  type PostReceipt,
} from "@syndroo/sdk";

import { CliError } from "../cli-error.js";
import { createClient } from "../client.js";
import { resolveConfig } from "../config.js";
import { canPrompt, confirm } from "../confirm.js";
import { parseDuration } from "../duration.js";
import {
  DocumentError,
  freezePost,
  parsePostDocument,
  readPostSource,
  type FrozenPost,
} from "../document.js";
import { EXIT_CODE, type ExitCode } from "../exit-codes.js";
import type { CommandResult } from "../output.js";
import { previewText } from "../preview.js";
import { flagValue, hasFlag, positional, type CommandContext } from "./context.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const ACCEPTED_NOTE =
  "HTTP 202 is an acceptance receipt, not a delivery result. Read the post before claiming any platform published it.";

async function loadFrozenPost(
  context: CommandContext,
): Promise<FrozenPost> {
  const source = await readPostSource({
    file: flagValue(context, "file"),
    stdin: context.io.stdin,
    stdinIsTty: context.io.stdinIsTty,
    cwd: context.io.cwd,
  });

  return freezePost(parsePostDocument(source.text, source.label), source);
}

/**
 * `syndroo posts validate` — offline.
 *
 * It validates the document and prints the preview. It never contacts the
 * instance, so platform configuration stays the server's business.
 */
export async function runValidate(context: CommandContext): Promise<CommandResult> {
  let frozen: FrozenPost;

  try {
    frozen = await loadFrozenPost(context);
  } catch (error) {
    if (error instanceof DocumentError) {
      return invalidDocumentResult("posts.validate", error);
    }

    throw error;
  }

  context.reporter.diagnostic(previewText(frozen));

  return {
    payload: {
      command: "posts.validate",
      ok: true,
      valid: true,
      source: {
        kind: frozen.source.kind,
        label: frozen.source.label,
        bytes: frozen.source.bytes,
      },
      requestSha256: frozen.requestSha256,
      sourceSha256: frozen.sourceSha256,
      platforms: frozen.input.platforms,
      scheduledAt: frozen.input.scheduledAt ?? null,
      contentCodePoints: [...frozen.input.content].length,
      overridePlatforms: Object.keys(frozen.input.overrides ?? {}),
      createRequests: 0,
      warnings: frozen.warnings,
      notes: [
        "Local validation only. Whether a platform is configured is answered by the instance, not here.",
      ],
    },
    human: [
      `Valid post document (${frozen.source.kind} ${frozen.source.label}, ${frozen.source.bytes} bytes).`,
      `  platforms      ${frozen.input.platforms.join(", ")}`,
      `  scheduled      ${frozen.input.scheduledAt ?? "as soon as Syndroo can publish"}`,
      `  request sha256 ${frozen.requestSha256}`,
      `  writes         0`,
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}

function invalidDocumentResult(
  command: string,
  error: DocumentError,
): CommandResult {
  return {
    payload: {
      command,
      ok: false,
      valid: false,
      issues: error.issues,
      createRequests: 0,
    },
    human: [
      "The post document is invalid. Nothing was sent.",
      ...error.issues.map(
        issue => `  ${issue.path === "" ? "document" : issue.path}: ${issue.message}`,
      ),
    ],
    exitCode: EXIT_CODE.USAGE,
  };
}

/**
 * `syndroo posts create`.
 *
 * The document is read once, previewed, and then sent unchanged: a file edited
 * after the preview cannot change the request. A create is attempted at most
 * once, and the idempotency key is never regenerated to hide a failure.
 */
export async function runCreate(context: CommandContext): Promise<CommandResult> {
  const dryRun = hasFlag(context, "dry-run");
  const assumeYes = hasFlag(context, "yes");
  let frozen: FrozenPost;

  try {
    frozen = await loadFrozenPost(context);
  } catch (error) {
    if (error instanceof DocumentError) {
      return invalidDocumentResult("posts.create", error);
    }

    throw error;
  }

  const explicitKey = flagValue(context, "idempotency-key");
  const interactive = !assumeYes && canPrompt(context);

  // Both refusals happen before the preview, so a misconfigured run never looks
  // like it was about to send something.
  if (!dryRun && !assumeYes && !interactive) {
    throw new CliError(
      "this run is not interactive, so the CLI will not wait for confirmation. Pass --yes and a stable --idempotency-key to submit without a prompt.",
      { exitCode: EXIT_CODE.USAGE, code: "CONFIRMATION_REQUIRED" },
    );
  }

  if (!dryRun && assumeYes && explicitKey === undefined) {
    throw new CliError(
      "--yes requires an explicit --idempotency-key so a retry cannot create a second post.",
      { exitCode: EXIT_CODE.USAGE, code: "IDEMPOTENCY_KEY_REQUIRED" },
    );
  }

  const generatedKey =
    explicitKey === undefined ? `post-${randomUUID()}` : undefined;
  const idempotencyKey = explicitKey ?? (generatedKey as string);

  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new CliError(
      "--idempotency-key must be 1-128 characters from A-Z a-z 0-9 . _ : - .",
      { exitCode: EXIT_CODE.USAGE, code: "USAGE" },
    );
  }

  context.reporter.diagnostic(
    previewText(frozen, {
      idempotencyKey,
      ...(dryRun && explicitKey === undefined
        ? { idempotencyKeyGenerated: false }
        : { idempotencyKeyGenerated: generatedKey !== undefined }),
      ...(dryRun && explicitKey === undefined
        ? { idempotencyKeyNote: "suggested; pass it as --idempotency-key to make this run reproducible" }
        : {}),
    }),
  );

  if (dryRun) {
    return {
      payload: {
        command: "posts.create",
        ok: true,
        dryRun: true,
        accepted: false,
        delivered: false,
        id: null,
        idempotencyKey,
        requestSha256: frozen.requestSha256,
        sourceSha256: frozen.sourceSha256,
        createRequests: 0,
        warnings: frozen.warnings,
      },
      human: [
        "Dry run complete. Nothing was sent.",
        `  request sha256 ${frozen.requestSha256}`,
        `  idempotency    ${idempotencyKey}`,
        `  writes         0`,
      ],
      exitCode: EXIT_CODE.SUCCESS,
    };
  }

  if (interactive && !confirm(context)) {
    return {
      payload: {
        command: "posts.create",
        ok: false,
        cancelled: true,
        accepted: false,
        delivered: false,
        id: null,
        idempotencyKey,
        requestSha256: frozen.requestSha256,
        createRequests: 0,
        notes: ["The preview was declined. Nothing was sent."],
      },
      human: [
        "Cancelled. Nothing was sent.",
        `  idempotency    ${idempotencyKey}`,
        `  writes         0`,
      ],
      exitCode: EXIT_CODE.CANCELLED,
    };
  }

  const client = createClient(
    resolveConfig(context.io.env, { baseUrl: flagValue(context, "base-url") }),
  );

  let receipt: PostReceipt;

  try {
    // Exactly one attempt. The SDK sends one request and never retries a write.
    receipt = await client.posts.create(frozen.input, {
      idempotencyKey,
      signal: context.io.signal,
    });
  } catch (error) {
    return createFailureResult(context, error, {
      idempotencyKey,
      generatedKey: generatedKey !== undefined,
      frozen,
    });
  }

  return {
    payload: {
      command: "posts.create",
      ok: true,
      accepted: true,
      delivered: false,
      id: receipt.id,
      status: receipt.status,
      scheduledAt: receipt.scheduledAt ?? null,
      replayed: receipt.replayed ?? false,
      idempotencyKey,
      idempotencyKeyGenerated: generatedKey !== undefined,
      requestSha256: frozen.requestSha256,
      sourceSha256: frozen.sourceSha256,
      createRequests: 1,
      notes: [ACCEPTED_NOTE],
    },
    human: [
      `Accepted: post ${receipt.id} (status "${receipt.status}")${receipt.replayed === true ? " - replayed from this idempotency key" : ""}.`,
      ACCEPTED_NOTE,
      `  idempotency    ${idempotencyKey}`,
      `  request sha256 ${frozen.requestSha256}`,
      `  next           syndroo posts wait ${receipt.id} --timeout 60s`,
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}

function createFailureResult(
  context: CommandContext,
  error: unknown,
  attempt: {
    idempotencyKey: string;
    generatedKey: boolean;
    frozen: FrozenPost;
  },
): CommandResult {
  const conflict =
    error instanceof SyndrooApiError && error.code === "IDEMPOTENCY_CONFLICT";
  const ambiguous =
    !conflict &&
    (error as { requestMayHaveBeenApplied?: boolean }).requestMayHaveBeenApplied === true;
  const message = error instanceof Error ? error.message : String(error);
  const exitCode: ExitCode = conflict
    ? EXIT_CODE.FAILURE
    : ambiguous
      ? EXIT_CODE.AMBIGUOUS
      : EXIT_CODE.FAILURE;
  const code = conflict
    ? "IDEMPOTENCY_CONFLICT"
    : ambiguous
      ? "AMBIGUOUS_DELIVERY"
      : "CREATE_FAILED";
  const guidance = conflict
    ? `This idempotency key already carries a different request. Reuse the original content, or choose a new key for a different post.`
    : ambiguous
      ? `The request may have reached Syndroo and no receipt was read. Do not resend under a new key: re-run with --idempotency-key ${attempt.idempotencyKey} to replay the original result, or read the post once you have its id.`
      : `Nothing was retried automatically.`;
  const notes = [
    guidance,
    `Idempotency-Key for this request: ${attempt.idempotencyKey}`,
  ];

  context.reporter.diagnostic(`syndroo: ${message}`);
  context.reporter.diagnostic(guidance);

  return {
    payload: {
      command: "posts.create",
      ok: false,
      accepted: false,
      delivered: false,
      error: { code, message },
      id: null,
      idempotencyKey: attempt.idempotencyKey,
      idempotencyKeyGenerated: attempt.generatedKey,
      requestSha256: attempt.frozen.requestSha256,
      ambiguous,
      createRequests: ambiguous ? 1 : 0,
      notes,
    },
    human: [
      `Create failed: ${message}`,
      guidance,
    ],
    exitCode,
  };
}

/** `syndroo posts list` — a read, so repeating it is safe. */
export async function runList(context: CommandContext): Promise<CommandResult> {
  const rawLimit = flagValue(context, "limit");
  let limit: number | undefined;

  if (rawLimit !== undefined) {
    limit = Number.parseInt(rawLimit, 10);

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new CliError("--limit must be an integer between 1 and 100.", {
        exitCode: EXIT_CODE.USAGE,
        code: "USAGE",
      });
    }
  }

  const client = createClient(
    resolveConfig(context.io.env, { baseUrl: flagValue(context, "base-url") }),
  );
  const posts = await client.posts.list({
    ...(limit === undefined ? {} : { limit }),
    signal: context.io.signal,
  });

  return {
    payload: {
      command: "posts.list",
      ok: true,
      count: posts.length,
      posts,
      createRequests: 0,
    },
    human: [
      `${posts.length} post${posts.length === 1 ? "" : "s"}`,
      ...posts.map(
        post =>
          `  ${post.id}  ${post.status.padEnd(9)}  ${post.platforms.join(",")}  ${post.createdAt}`,
      ),
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}

/** `syndroo posts get <id>` — a read that reports delivery without inventing it. */
export async function runGet(context: CommandContext): Promise<CommandResult> {
  const client = createClient(
    resolveConfig(context.io.env, { baseUrl: flagValue(context, "base-url") }),
  );
  const post = await client.posts.get(positional(context, 0), {
    signal: context.io.signal,
  });

  return {
    payload: {
      command: "posts.get",
      ok: true,
      post,
      ...deliveryVerdict(post),
      createRequests: 0,
    },
    human: humanPost(post),
    exitCode: EXIT_CODE.SUCCESS,
  };
}

/**
 * `syndroo posts wait <id>`.
 *
 * Waiting only reads. A timeout stops this process and nothing else, so the
 * server-side post keeps going and can be read again later.
 */
export async function runWait(context: CommandContext): Promise<CommandResult> {
  const rawTimeout = flagValue(context, "timeout");
  const timeoutMs =
    rawTimeout === undefined ? undefined : parseDuration(rawTimeout, "--timeout");
  const postId = positional(context, 0);
  const client = createClient(
    resolveConfig(context.io.env, { baseUrl: flagValue(context, "base-url") }),
  );

  let post: PostDetail;

  try {
    post = await client.posts.wait(postId, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      signal: context.io.signal,
    });
  } catch (error) {
    const timedOut = (error as { code?: string }).code === "WAIT_TIMEOUT";

    if (!timedOut) {
      throw error;
    }

    const lastStatus = (error as { lastStatus?: string }).lastStatus ?? null;
    const guidance =
      "Waiting only reads, so nothing was created or cancelled and the server-side post still exists. Re-run `syndroo posts wait` or `syndroo posts get` later; do not resend it.";

    context.reporter.diagnostic(guidance);

    return {
      payload: {
        command: "posts.wait",
        ok: false,
        timedOut: true,
        id: postId,
        timeoutMs: timeoutMs ?? null,
        lastStatus,
        delivered: false,
        createRequests: 0,
        notes: [guidance],
      },
      human: [
        `Still not terminal after the wait budget${lastStatus === null ? "" : ` (last status "${lastStatus}")`}.`,
        guidance,
      ],
      exitCode: EXIT_CODE.WAIT_TIMEOUT,
    };
  }

  const verdict = deliveryVerdict(post);
  const exitCode = verdict.delivered
    ? EXIT_CODE.SUCCESS
    : verdict.ambiguous
      ? (EXIT_CODE.AMBIGUOUS as ExitCode)
      : (EXIT_CODE.NOT_DELIVERED as ExitCode);

  return {
    payload: {
      command: "posts.wait",
      ok: verdict.delivered,
      post,
      ...verdict,
      createRequests: 0,
    },
    human: humanPost(post),
    exitCode,
  };
}

/**
 * Never infers delivery. `published` is the only status that means every
 * selected platform succeeded, and an `errorAmbiguous` publication means the
 * outcome is genuinely unknown rather than failed.
 */
function deliveryVerdict(post: PostDetail): {
  delivered: boolean;
  ambiguous: boolean;
  terminal: boolean;
} {
  return {
    delivered: isPostDelivered(post.status),
    ambiguous: post.publications.some(publication => publication.errorAmbiguous === true),
    terminal: isPostTerminal(post.status),
  };
}

function humanPost(post: PostDetail): string[] {
  const verdict = deliveryVerdict(post);
  const lines = [
    `${post.id}  status "${post.status}"`,
    `  platforms      ${post.platforms.join(", ")}`,
    `  created        ${post.createdAt}`,
    `  scheduled      ${post.scheduledAt ?? "-"}`,
    `  delivered      ${verdict.delivered ? "yes" : "no"}${verdict.ambiguous ? " (at least one platform is ambiguous)" : ""}`,
  ];

  for (const publication of post.publications) {
    lines.push(
      `  ${publication.platform.padEnd(10)} ${publication.status.padEnd(10)} attempts=${publication.attempts}${
        publication.errorCode === undefined ? "" : ` code=${publication.errorCode}`
      }${publication.errorAmbiguous === true ? " ambiguous" : ""}`,
    );
  }

  return lines;
}
