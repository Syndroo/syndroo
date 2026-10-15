import { promises as fs, constants as FS } from "node:fs";
import path from "node:path";

import { parseStrictJson, ProtocolError } from "@syndroo/core";
import type { CallContext, ProgressSink } from "@syndroo/core";

import { CliError } from "../cli-error.js";
import type { ResolvedConfig } from "../config.js";
import { EXIT_CODE } from "../exit-codes.js";
import type { CliIo } from "../io.js";
import { DEFAULT_LAYOUT_COLUMNS, type PublicationRenderOptions } from "../render/publication.js";
import { createPublicationOutput, type PublicationOutput } from "../render/publication-output.js";
import {
  createLocalRuntime,
  LOCAL_PRINCIPAL_ID,
  type LocalRuntime,
  type LocalRuntimeOverrides,
} from "../runtime/local/composition.js";
import type { Operation } from "../render/envelope.js";

/** Identity every local call runs as; owned by the composition that builds it. */
export const LOCAL_PRINCIPAL = LOCAL_PRINCIPAL_ID;

/** One request body may not exceed this, matching Core's request bound. */
export const MAX_INPUT_BYTES = 65_536;

export type CommandContext = {
  readonly io: CliIo;
  readonly json: boolean;
  readonly verbose: boolean;
  readonly color: boolean;
  readonly config: ResolvedConfig;
  /** Lazily composed Core instance; construction touches no filesystem. */
  runtime(): LocalRuntime;
  /**
   * The one publication output block for this process, created on first use.
   *
   * `publish` draws its live round through it and every human diagnostic goes
   * through it too, so a diagnostic pauses a redraw instead of tearing it.
   * `--json` never creates one: machine stdout carries exactly one document and
   * a read-only command that never draws never creates anything.
   */
  output(): PublicationOutput;
  /** Write one result: a JSON envelope in `--json`, else the human lines. */
  report(operation: Operation, result: unknown, human: readonly string[]): void;
  /** Write a safe diagnostic to stderr. Never carries raw error text. */
  diagnostic(message: string): void;
};

/**
 * The shared renderer options for one command invocation.
 *
 * `publish` and `status --operation` render through the same options, so one
 * target reads the same way while it is being published and after it is only
 * history.
 */
export function renderOptions(
  ctx: CommandContext,
  overrides: { readonly full?: boolean } = {},
): PublicationRenderOptions {
  return {
    width: ctx.io.columns ?? DEFAULT_LAYOUT_COLUMNS,
    verbose: ctx.verbose,
    full: overrides.full ?? ctx.verbose,
    color: ctx.color,
    now: new Date().toISOString(),
  };
}

export type CreateContextInput = {
  readonly io: CliIo;
  readonly json: boolean;
  readonly verbose: boolean;
  readonly color: boolean;
  readonly config: ResolvedConfig;
  readonly overrides: LocalRuntimeOverrides;
};

export function createCommandContext(input: CreateContextInput): CommandContext {
  let runtime: LocalRuntime | undefined;
  let publicationOutput: PublicationOutput | undefined;

  const output = (): PublicationOutput => {
    publicationOutput ??= createPublicationOutput(input.io, {
      verbose: input.verbose,
      full: input.verbose,
      color: input.color,
    });

    return publicationOutput;
  };

  return {
    io: input.io,
    json: input.json,
    verbose: input.verbose,
    color: input.color,
    config: input.config,
    runtime(): LocalRuntime {
      runtime ??= createLocalRuntime(input.config, input.overrides);

      return runtime;
    },
    output,
    report(operation, result, human): void {
      if (input.json) {
        input.io.stdout.write(
          `${JSON.stringify({ protocolVersion: 1, operation, ok: true, result, error: null })}\n`,
        );

        return;
      }

      if (human.length > 0) {
        input.io.stdout.write(`${human.join("\n")}\n`);
      }
    },
    diagnostic(message): void {
      if (input.json) {
        // stdout already carries exactly one document and there is no live
        // block to protect, so a machine diagnostic goes straight to stderr and
        // no output controller is ever created for a machine call.
        input.io.stderr.write(`syndroo: ${message}\n`);

        return;
      }

      output().diagnostic(message);
    },
  };
}

/**
 * The call identity for one Core request.
 *
 * `onProgress` is a local, in-process observation of the stored operation; it is
 * never part of the HTTP wire and a consumer that throws can never change the
 * publish outcome.
 */
export function callContext(
  io: CliIo,
  idempotencyKey?: string,
  onProgress?: ProgressSink,
): CallContext {
  return {
    principalId: LOCAL_PRINCIPAL,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(onProgress === undefined ? {} : { onProgress }),
    signal: io.signal,
  };
}

export function usageError(code: string): CliError {
  return new CliError(code, { code, exitCode: EXIT_CODE.USAGE });
}

/** Read one request/credential document from `-` (stdin) or a file path. */
export async function readJsonSource(
  ctx: CommandContext,
  source: string,
): Promise<unknown> {
  const bytes = source === "-" ? await readStandardInput(ctx) : await readInputFile(ctx, source);

  try {
    return parseStrictJson(bytes);
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "BODY_TOO_LARGE") {
      throw error;
    }

    throw usageError("INPUT_INVALID");
  }
}

async function readStandardInput(ctx: CommandContext): Promise<Uint8Array> {
  // B3a is the machine surface: a terminal is never read for a document.
  if (ctx.io.stdinIsTty) {
    throw usageError("INPUT_INVALID");
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of ctx.io.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;

    if (total > MAX_INPUT_BYTES) {
      throw new ProtocolError("BODY_TOO_LARGE");
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks, total);
}

async function readInputFile(ctx: CommandContext, source: string): Promise<Uint8Array> {
  const absolute = path.resolve(ctx.io.cwd, source);
  let handle;

  try {
    handle = await fs.open(absolute, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch {
    throw usageError("INPUT_UNREADABLE");
  }

  try {
    const stat = await handle.stat();

    if (!stat.isFile()) {
      throw usageError("INPUT_UNREADABLE");
    }

    if (stat.size > MAX_INPUT_BYTES) {
      throw new ProtocolError("BODY_TOO_LARGE");
    }

    const bytes = await handle.readFile();

    if (bytes.length > MAX_INPUT_BYTES) {
      throw new ProtocolError("BODY_TOO_LARGE");
    }

    return bytes;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
