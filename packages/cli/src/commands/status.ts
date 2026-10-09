import type { StatusRequest } from "@syndroo/core";

import { EXIT_CODE } from "../exit-codes.js";
import { renderStatus } from "../render/human.js";
import { callContext, usageError, type CommandContext } from "./context.js";

/** Raw option values as Commander hands them over. */
export type StatusOptions = {
  readonly provider?: string;
  readonly connections?: boolean;
  readonly operation?: string;
  readonly operations?: boolean;
  readonly limit?: string;
  readonly cursor?: string;
};

/**
 * `syndroo status` — the read-only query surface.
 *
 * Exactly one of `--connections`, `--operation` and `--operations` may be used.
 * `--provider` alone asks about one provider and may also filter
 * `--connections`. `--limit` and `--cursor` belong only to `--operations`. With
 * no selector, the overview is returned. Nothing here creates the state root,
 * takes a write lock or reads a secret: reads never mutate and never repair.
 */
export async function runStatus(
  ctx: CommandContext,
  options: StatusOptions,
): Promise<number> {
  const request = buildStatusRequest(options);
  const runtime = ctx.runtime();
  const result = await runtime.core.status(request, callContext(ctx.io));

  ctx.report("status", result, renderStatus(result, { color: ctx.color }));

  return EXIT_CODE.SUCCESS;
}

function parseLimit(raw: string): number {
  if (!/^[0-9]{1,3}$/.test(raw)) {
    throw usageError("USAGE");
  }

  const value = Number.parseInt(raw, 10);

  if (value < 1 || value > 100) {
    throw usageError("USAGE");
  }

  return value;
}

function buildStatusRequest(options: StatusOptions): StatusRequest {
  const selectors = [
    options.connections === true,
    options.operation !== undefined,
    options.operations === true,
  ].filter((selected) => selected).length;

  if (selectors > 1) {
    throw usageError("USAGE");
  }

  if (
    options.provider !== undefined &&
    (options.operation !== undefined || options.operations === true)
  ) {
    throw usageError("USAGE");
  }

  if (
    (options.limit !== undefined || options.cursor !== undefined) &&
    options.operations !== true
  ) {
    throw usageError("USAGE");
  }

  if (options.connections === true) {
    return options.provider === undefined
      ? { type: "connections" }
      : { type: "connections", provider: options.provider };
  }

  if (options.operations === true) {
    const limit = options.limit === undefined ? undefined : parseLimit(options.limit);
    const cursor = options.cursor;

    if (cursor !== undefined && (cursor.length === 0 || cursor.length > 1024)) {
      throw usageError("USAGE");
    }

    return {
      type: "operations",
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    };
  }

  if (options.operation !== undefined) {
    if (options.operation.length === 0 || options.operation.length > 1024) {
      throw usageError("USAGE");
    }

    return { type: "operation", operationId: options.operation };
  }

  if (options.provider !== undefined) {
    return { type: "provider", provider: options.provider };
  }

  return { type: "overview" };
}
