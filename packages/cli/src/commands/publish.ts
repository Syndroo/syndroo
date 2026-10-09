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

import { EXIT_CODE } from "../exit-codes.js";
import { INTERACTIVE_READ_LIMIT_MS } from "../io.js";
import { exitForExecution } from "../render/envelope.js";
import {
  renderDryRun,
  renderExecuteInstruction,
  renderExecution,
  renderPublish,
} from "../render/human.js";
import {
  mintRequestId,
  RequestJournal,
  REQUEST_ID_PATTERN,
} from "../request-journal/journal.js";
import {
  callContext,
  isRecord,
  readJsonSource,
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
      await runtime.core.publish(request, callContext(ctx.io, requestId)),
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
    const result = await runtime.core.publish(request, callContext(ctx.io));

    ctx.report("publish", result, renderExecution(result, { color: ctx.color }));

    return exitForExecution(result.status);
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
    await runtime.core.publish(request, callContext(ctx.io, requestId)),
  );
}

async function finishPrepared(ctx: CommandContext, result: PublishResult): Promise<number> {
  if (result.status === "confirmation_required") {
    return await confirmPrepared(ctx, result);
  }

  ctx.report("publish", result, renderPublish(result, { color: ctx.color }));

  return exitForExecution(result.status);
}

/**
 * Human confirmation for one prepared publication.
 *
 * The complete preview is rendered first - every target and every field - and
 * only then is the terminal asked. JSON mode never prompts. A non-TTY prints
 * the same preview plus the exact later command and stops without sending.
 * Only an unambiguous yes executes, and it executes the token minted by this
 * same process; a token from an earlier run is never read back or reused.
 */
async function confirmPrepared(
  ctx: CommandContext,
  result: Extract<PublishResult, { status: "confirmation_required" }>,
): Promise<number> {
  if (ctx.json) {
    ctx.report("publish", result, renderPublish(result, { color: ctx.color }));

    return EXIT_CODE.SUCCESS;
  }

  if (ctx.verbose) {
    ctx.diagnostic(`prepared ${result.operationId}; awaiting confirmation`);
  }

  writeLines(ctx, renderPublish(result, { color: ctx.color }));

  if (!ctx.io.hasTty()) {
    writeLines(
      ctx,
      renderExecuteInstruction(result, "no terminal is available: nothing was sent"),
    );

    return EXIT_CODE.SUCCESS;
  }

  ctx.io.stdout.write("Confirm this publication? [y/N] ");

  const answer = ctx.io.readTtyLine(INTERACTIVE_READ_LIMIT_MS);

  ctx.io.stdout.write("\n");

  if (!isAffirmative(answer)) {
    writeLines(ctx, renderExecuteInstruction(result, "declined: nothing was sent"));

    return EXIT_CODE.CANCELLED;
  }

  const executed = await ctx.runtime().core.publish(
    { type: "execute", approvalToken: result.approvalToken },
    callContext(ctx.io),
  );

  ctx.report("publish", executed, renderExecution(executed, { color: ctx.color }));

  return exitForExecution(executed.status);
}

/** Only `y` or `yes`, any case, with surrounding whitespace trimmed, confirms. */
function isAffirmative(answer: string | undefined): boolean {
  if (answer === undefined) {
    return false;
  }

  const normalized = answer.trim().toLowerCase();

  return normalized === "y" || normalized === "yes";
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

  ctx.report("publish", result, renderDryRun(result, { color: ctx.color }));

  return EXIT_CODE.SUCCESS;
}
