import { previewDocument, parseStrictJson, ProtocolError } from "@syndroo/core";
import type {
  Content,
  PostDocument,
  PrepareRequest,
  PublishRequest,
  PublishResult,
  RetryRequest,
  TargetInput,
} from "@syndroo/core";

import type { ExecutionResult } from "@syndroo/core";

import { EXIT_CODE } from "../exit-codes.js";
import { INTERACTIVE_READ_LIMIT_MS } from "../io.js";
import { exitForExecution } from "../render/envelope.js";
import { renderExecuteInstruction } from "../render/human.js";
import { renderPublication } from "../render/publication.js";
import {
  publicationFailureView,
  publicationView,
  type PublicationView,
} from "../render/publication-view.js";
import {
  mintRequestId,
  RequestJournal,
  REQUEST_ID_PATTERN,
} from "../request-journal/journal.js";
import {
  callContext,
  isRecord,
  readJsonSource,
  renderOptions,
  usageError,
  type CommandContext,
} from "./context.js";

export type PublishOptions = {
  readonly input?: string;
  readonly data?: string;
  readonly retry?: string;
  readonly to?: readonly string[];
  readonly requestId?: string;
  readonly dryRun?: boolean;
  /**
   * `--yes`: auto-confirm the same frozen intent this process just prepared.
   *
   * It is an authorization shortcut, never a safety shortcut: the token, the
   * binding check, the approval window, the frozen payload and the idempotency
   * rules are unchanged. With an explicit execute request it is redundant; with
   * `--dry-run` it is ignored because a dry run never sends.
   */
  readonly yes?: boolean;
};

/** Where the request body came from; an execute token is stdin-only. */
type Origin = "file" | "stdin" | "argv";

/**
 * `syndroo publish` — the machine publication surface.
 *
 * Exactly one source: `--input <file|->`, `--data <json>`, or
 * `--retry <operationId> --to <connectionId>` (repeatable `--to`). A body
 * without a `type` is an ordinary document and becomes a prepare request.
 * An execute request carries a live approval token, so it is only ever read
 * from standard input and never from argv.
 *
 * In human mode a prepared result prints the full preview and then asks the
 * controlling terminal for an explicit yes. A confirmed run executes the same
 * in-process token and renders the execution; a declined answer prints the
 * exact later command and exits with `CANCELLED`; a non-TTY run prints the
 * preview and the later command and exits 0 without sending. `--json` never
 * prompts and keeps the machine envelope untouched.
 */
export async function runPublish(
  ctx: CommandContext,
  options: PublishOptions,
): Promise<number> {
  const sources = [
    options.input !== undefined,
    options.data !== undefined,
    options.retry !== undefined,
  ].filter((selected) => selected).length;

  if (sources === 0) {
    throw usageError("INPUT_SOURCE_MISSING");
  }

  if (sources > 1) {
    throw usageError("INPUT_SOURCE_CONFLICT");
  }

  if (options.dryRun === true && options.retry !== undefined) {
    throw usageError("USAGE");
  }

  if ((options.to?.length ?? 0) > 0 && options.retry === undefined) {
    throw usageError("USAGE");
  }

  const requestId = options.requestId ?? mintRequestId();

  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw usageError("USAGE");
  }

  const runtime = ctx.runtime();
  const journal = new RequestJournal(runtime.stateRoot);

  if (options.retry !== undefined) {
    const request = await buildRetryRequest(ctx, options.retry, options.to ?? []);

    await journal.record({
      requestId,
      contentMetadata: {
        family: "publish",
        kind: "retry",
        targets: request.targets.map((target) => target.connection),
        bytes: 0,
      },
    });

    return await finishPrepared(
      ctx,
      await prepareWithReport(ctx, request, requestId),
      options,
    );
  }

  const origin: Origin = options.data !== undefined ? "argv" : options.input === "-" ? "stdin" : "file";
  const parsed =
    options.data !== undefined
      ? parseArgvJson(options.data)
      : await readJsonSource(ctx, options.input as string);
  const request = asPublishRequest(parsed, origin);

  if (options.dryRun === true) {
    if (request.type !== "prepare") {
      throw usageError("USAGE");
    }

    return await runDryRun(ctx, request, requestId);
  }

  if (request.type === "execute") {
    return await executeToken(ctx, request.approvalToken);
  }

  await journal.record({
    requestId,
    contentMetadata: {
      family: "publish",
      kind: request.type,
      targets: request.targets.map((target) => target.provider),
      bytes: 0,
    },
  });

  return await finishPrepared(
    ctx,
    await prepareWithReport(ctx, request, requestId),
    options,
  );
}

/**
 * Run one prepare, reporting a preparation that never produced a target.
 *
 * A failure before any target exists has no per-target outcome, so human mode
 * prints the shared `Publication not started` view with the safe classified
 * message and no invented query command. `--json` prints nothing here: the
 * top-level handler still writes exactly one failure envelope.
 */
async function prepareWithReport(
  ctx: CommandContext,
  request: PrepareRequest | RetryRequest,
  requestId: string,
): Promise<PublishResult> {
  try {
    return await ctx.runtime().core.publish(request, callContext(ctx.io, requestId));
  } catch (error) {
    if (!ctx.json) {
      const code = error instanceof ProtocolError ? error.code : "INTERNAL";

      writeLines(
        ctx,
        renderPublication(publicationFailureView({ code }), renderOptions(ctx)),
      );
    }

    throw error;
  }
}

async function finishPrepared(
  ctx: CommandContext,
  result: PublishResult,
  options: PublishOptions,
): Promise<number> {
  if (result.status === "confirmation_required") {
    return await confirmPrepared(ctx, result, options);
  }

  ctx.report("publish", result, executionLines(ctx, result));

  return exitForExecution(result.status);
}

function preparedLines(ctx: CommandContext, result: PublishResult): string[] {
  return renderPublication(publicationView(result, "preview"), renderOptions(ctx));
}

function executionLines(ctx: CommandContext, result: ExecutionResult): string[] {
  return renderPublication(publicationView(result, "live"), renderOptions(ctx));
}

/**
 * One prepared publication: confirm, auto-confirm, or report and stop.
 *
 * `--json` never prompts and never touches a terminal. `--yes` skips the
 * prompt but not the frozen-intent checks: it executes the token minted by this
 * same process. Human mode without `--yes` needs a writable controlling
 * terminal to both show the preview and read the answer; without one it
 * reports the pending result instead of blocking or sending.
 */
async function confirmPrepared(
  ctx: CommandContext,
  result: Extract<PublishResult, { status: "confirmation_required" }>,
  options: PublishOptions,
): Promise<number> {
  if (ctx.verbose) {
    // An execution-process diagnostic, never a result: it goes to stderr so a
    // machine stdout keeps exactly one envelope and a live redraw is paused
    // rather than torn. It carries no token and no provider text.
    ctx.diagnostic(`prepared ${result.operationId}; awaiting confirmation`);
  }

  if (ctx.json) {
    if (options.yes === true) {
      return await executeApproved(ctx, result);
    }

    ctx.report("publish", result, preparedLines(ctx, result));

    return EXIT_CODE.SUCCESS;
  }

  if (options.yes === true) {
    writeLines(ctx, preparedLines(ctx, result));

    return await executeApproved(ctx, result);
  }

  return await confirmInteractively(ctx, result);
}

/**
 * Show the frozen preview and read one answer from the controlling terminal.
 *
 * The preview and prompt go to the controlling terminal, not to stdout, so a
 * redirected stdout never becomes the place a `y` is typed. The read deadline
 * is fixed before the first prompt and `v` never resets it. Only an
 * unambiguous `y`/`yes` executes; `n`/`no`, an empty line and end-of-input
 * cancel; `v` shows the complete frozen preview and asks again; anything else
 * is not an authorization and asks again.
 */
async function confirmInteractively(
  ctx: CommandContext,
  result: Extract<PublishResult, { status: "confirmation_required" }>,
): Promise<number> {
  const write = ctx.io.writeTty;

  if (write === undefined || !ctx.io.hasTty()) {
    return cannotConfirm(ctx, result, "no terminal is available: nothing was sent");
  }

  const view = publicationView(result, "preview");
  const deadline = Date.now() + INTERACTIVE_READ_LIMIT_MS;
  let full = false;

  for (;;) {
    const shown =
      write(`${renderPublication(view, renderOptions(ctx, { full })).join("\n")}\n`) &&
      write(`${promptLine(view)}\n  y: publish · N: cancel · v: view full preview\n`);

    // A terminal that refuses the preview or the prompt cannot be asked a
    // question: stop before any read, never consume an answer nobody saw, and
    // never execute on one.
    if (!shown) {
      return cannotConfirm(
        ctx,
        result,
        "the confirmation could not be shown on a terminal: nothing was sent",
      );
    }

    const remaining = deadline - Date.now();
    const answer = remaining > 0 ? ctx.io.readTtyLine(remaining) : undefined;

    if (answer === undefined) {
      return cancel(ctx, result);
    }

    const normalized = answer.trim().toLowerCase();

    if (normalized === "y" || normalized === "yes") {
      write("\n");

      return await executeApproved(ctx, result);
    }

    if (normalized === "" || normalized === "n" || normalized === "no") {
      write("\n");

      return cancel(ctx, result);
    }

    if (normalized === "v" || normalized === "view") {
      full = true;
      continue;
    }

    // Not an authorization and not a cancellation: ask again, but never past
    // the fixed deadline.
    write("\n");

    if (Date.now() >= deadline) {
      return cancel(ctx, result);
    }
  }
}

/**
 * Report a prepared publication that cannot be confirmed here.
 *
 * Nothing was sent and nothing was read; the later execute command is printed
 * once so the same frozen intent is still reachable from a machine surface.
 */
function cannotConfirm(
  ctx: CommandContext,
  result: Extract<PublishResult, { status: "confirmation_required" }>,
  lead: string,
): number {
  writeLines(ctx, preparedLines(ctx, result));
  writeLines(ctx, renderExecuteInstruction(result, lead));

  return EXIT_CODE.SUCCESS;
}

function promptLine(view: PublicationView): string {
  const count = view.targets.length;

  return `Publish to ${count} account${count === 1 ? "" : "s"}? [y/N/v]`;
}

/**
 * Run one execute request and draw the round through the shared controller.
 *
 * `token` is the approval token this process minted, or the one an explicit
 * execute request carried. Human output is one block: progress arrives as
 * post-commit projections of the stored operation, so the block can never show
 * a state that was not durably recorded, and the final round is the last draw.
 * `--json` never creates a controller: stdout keeps exactly one envelope.
 */
async function executeToken(ctx: CommandContext, token: string): Promise<number> {
  const output = ctx.json ? undefined : ctx.output();

  try {
    const executed = await ctx.runtime().core.publish(
      { type: "execute", approvalToken: token },
      callContext(
        ctx.io,
        undefined,
        output === undefined
          ? undefined
          : (event) => {
              output.update(publicationView(event.execution, "live"));
            },
      ),
    );

    if (output === undefined) {
      ctx.report("publish", executed, executionLines(ctx, executed));

      return exitForExecution(executed.status);
    }

    output.finish(publicationView(executed, "live"));

    const business = exitForExecution(executed.status);

    // A broken output channel may make the exit non-zero, but it never rewrites
    // the publication: the state store keeps the truth, and a business code
    // (ambiguous, not delivered) is always the more specific answer.
    return output.failed && business === EXIT_CODE.SUCCESS
      ? EXIT_CODE.FAILURE
      : business;
  } catch (error) {
    // The window closed between the prompt and the answer: say so plainly and
    // ask for a fresh prepare, never extend the old approval, never reprint a
    // token that can no longer be used.
    if (
      !ctx.json &&
      error instanceof ProtocolError &&
      error.code === "APPROVAL_EXPIRED"
    ) {
      writeLines(ctx, [
        "  the approval window has closed: prepare again and confirm the new preview",
      ]);
    }

    throw error;
  } finally {
    // Every path restores the cursor and drops the resize and abort listeners,
    // including a Core rejection: the terminal must stay usable either way.
    output?.close();
  }
}

/** Execute the token this process just prepared. */
async function executeApproved(
  ctx: CommandContext,
  result: Extract<PublishResult, { status: "confirmation_required" }>,
): Promise<number> {
  return await executeToken(ctx, result.approvalToken);
}

/** A decline prints the exact later command on stdout and sends nothing. */
function cancel(
  ctx: CommandContext,
  result: Extract<PublishResult, { status: "confirmation_required" }>,
): number {
  writeLines(ctx, renderExecuteInstruction(result, "declined: nothing was sent"));

  return EXIT_CODE.CANCELLED;
}

/** Write already-rendered human lines; never called in `--json`. */
function writeLines(ctx: CommandContext, lines: readonly string[]): void {
  if (lines.length > 0) {
    ctx.io.stdout.write(`${lines.join("\n")}\n`);
  }
}

function parseArgvJson(raw: string): unknown {
  try {
    return parseStrictJson(Buffer.from(raw, "utf8"));
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "BODY_TOO_LARGE") {
      throw error;
    }

    throw usageError("INPUT_INVALID");
  }
}

function asPublishRequest(value: unknown, origin: Origin): PublishRequest {
  if (isRecord(value) && typeof value["type"] === "string") {
    switch (value["type"]) {
      case "execute":
        if (origin !== "stdin") {
          throw usageError("EXECUTE_REQUIRES_STDIN");
        }

        if (typeof value["approvalToken"] !== "string" || value["approvalToken"].length === 0) {
          throw usageError("INPUT_INVALID");
        }

        return value as unknown as PublishRequest;
      case "prepare":
        if (!isRecord(value["content"]) || !Array.isArray(value["targets"])) {
          throw usageError("INPUT_INVALID");
        }

        return value as unknown as PublishRequest;
      case "retry":
        if (typeof value["retryOf"] !== "string" || !Array.isArray(value["targets"])) {
          throw usageError("INPUT_INVALID");
        }

        return value as unknown as PublishRequest;
      default:
        throw usageError("INPUT_INVALID");
    }
  }

  if (!isRecord(value) || !isRecord(value["content"]) || !Array.isArray(value["targets"])) {
    throw usageError("INPUT_INVALID");
  }

  return {
    type: "prepare",
    content: value["content"] as unknown as Content,
    targets: value["targets"] as unknown as readonly TargetInput[],
  };
}

async function buildRetryRequest(
  ctx: CommandContext,
  retryOf: string,
  to: readonly string[],
): Promise<RetryRequest> {
  if (to.length === 0 || to.length > 20 || retryOf.length === 0 || retryOf.length > 1024) {
    throw usageError("USAGE");
  }

  const runtime = ctx.runtime();
  const queried = await runtime.core.status({ type: "connections" }, callContext(ctx.io));
  const connections = queried.type === "connections" ? queried.connections : [];
  const seen = new Set<string>();
  const targets = to.map((connectionId) => {
    if (seen.has(connectionId)) {
      throw usageError("DUPLICATE_TARGET");
    }

    seen.add(connectionId);

    const match = connections.find((connection) => connection.connectionId === connectionId);

    if (match === undefined) {
      throw new ProtocolError("NOT_FOUND");
    }

    return { provider: match.account.provider, connection: connectionId };
  });

  return { type: "retry", retryOf, targets };
}

async function runDryRun(
  ctx: CommandContext,
  request: PrepareRequest,
  seed: string,
): Promise<number> {
  const runtime = ctx.runtime();
  const queried = await runtime.core.status({ type: "connections" }, callContext(ctx.io));
  const connections = queried.type === "connections" ? queried.connections : [];
  const input: PostDocument = { content: request.content, targets: request.targets };
  const result = await previewDocument(input, {
    providers: runtime.providers,
    connections,
    now: new Date().toISOString(),
    seed,
  });

  ctx.report(
    "publish",
    result,
    renderPublication(publicationView(result, "preview"), renderOptions(ctx)),
  );

  return EXIT_CODE.SUCCESS;
}
