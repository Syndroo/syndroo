import { promises as fs, constants as FS } from "node:fs";
import path from "node:path";

import { parseStrictJson, ProtocolError } from "@syndroo/core";
import type { CallContext } from "@syndroo/core";

import { CliError } from "../cli-error.js";
import type { ResolvedConfig } from "../config.js";
import { EXIT_CODE } from "../exit-codes.js";
import type { CliIo } from "../io.js";
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
  /** Write one result: a JSON envelope in `--json`, else the human lines. */
  report(operation: Operation, result: unknown, human: readonly string[]): void;
  /** Write a safe diagnostic to stderr. Never carries raw error text. */
  diagnostic(message: string): void;
};

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
      input.io.stderr.write(`syndroo: ${message}\n`);
    },
  };
}

/** The call identity for one Core request. */
export function callContext(io: CliIo, idempotencyKey?: string): CallContext {
  return {
    principalId: LOCAL_PRINCIPAL,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
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
