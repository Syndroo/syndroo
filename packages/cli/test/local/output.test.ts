import { Readable, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { EXIT_CODE } from "../../src/exit-codes.js";
import type { CliIo } from "../../src/io.js";
import { Reporter } from "../../src/output.js";

/**
 * The local envelope and the escaping rules that make human output safe.
 *
 * The legacy remote envelope must stay byte-identical, so every assertion here
 * is paired with the legacy behavior it must not disturb.
 */

interface Captured {
  readonly io: CliIo;
  readonly stdout: string[];
  readonly stderr: string[];
}

function collect(): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const sink = (into: string[]): Writable =>
    new Writable({
      write(chunk, _encoding, callback) {
        into.push(String(chunk));
        callback();
      },
    });

  return {
    stdout,
    stderr,
    io: {
      stdin: new Readable({ read() {} }),
      stdout: sink(stdout),
      stderr: sink(stderr),
      env: {},
      cwd: "/tmp",
      stdinIsTty: false,
      stdoutIsTty: false,
      hasTty: () => false,
      readTtyLine: () => undefined,
      signal: new AbortController().signal,
    },
  };
}

function parseLines(lines: readonly string[]): Record<string, unknown>[] {
  return lines
    .join("")
    .split("\n")
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe("local envelope", () => {
  it("writes exactly one documented object and no legacy exitCode field", () => {
    const captured = collect();
    const reporter = new Reporter(captured.io, true);

    reporter.finishLocal("publish", {
      ok: true,
      result: { planId: "plan_1" },
      error: null,
      human: ["ignored in json mode"],
    });

    const rows = parseLines(captured.stdout);

    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] as object).sort()).toEqual([
      "command",
      "error",
      "mode",
      "ok",
      "result",
      "schemaVersion",
    ]);
    expect(rows[0]).toEqual({
      schemaVersion: 1,
      command: "publish",
      mode: "local",
      ok: true,
      result: { planId: "plan_1" },
      error: null,
    });
    expect(captured.stderr.join("")).toBe("");
  });

  it("keeps the legacy envelope exactly as it was", () => {
    const captured = collect();
    const reporter = new Reporter(captured.io, true);

    reporter.finish({
      payload: { command: "posts.create", ok: true },
      human: [],
      exitCode: EXIT_CODE.SUCCESS,
    });

    expect(JSON.parse(captured.stdout.join("")) as unknown).toEqual({
      command: "posts.create",
      ok: true,
      exitCode: 0,
    });
  });

  it("sends a local failure to stderr in human mode", () => {
    const captured = collect();
    const reporter = new Reporter(captured.io, false);

    reporter.failLocal("publish", {
      code: "CONFIRMATION_REQUIRED",
      message: "a non-interactive run needs both --yes and --no-input",
    });

    expect(captured.stdout.join("")).toBe("");
    expect(captured.stderr.join("")).toContain("CONFIRMATION_REQUIRED");
    expect(captured.stderr.join("")).toContain("syndroo: ");
  });

  it("escapes CR, ESC, and C1 but keeps real line breaks", () => {
    const captured = collect();
    const reporter = new Reporter(captured.io, false);

    reporter.localDiagnostic("first\rsecond\u001b[31mthird\u0085fourth");

    const text = captured.stderr.join("");

    expect(text).not.toContain("\r");
    expect(text).not.toContain("\u001b");
    expect(text).toContain("\\u000d");
    expect(text).toContain("\\u001b");
    expect(text).toContain("\\u0085");
  });

  it("renders each content line through the same escaping as diagnostics", () => {
    const captured = collect();
    const reporter = new Reporter(captured.io, false);

    reporter.finishLocal("publish", {
      ok: true,
      result: null,
      error: null,
      human: ["    content | line one\u001b[0m", "    content | line two"],
    });

    const text = captured.stdout.join("");

    expect(text).toContain("line one\\u001b[0m");
    expect(text).toContain("line two");
    expect(text).not.toContain("\u001b");
  });

  it("never rewrites the JSON payload itself", () => {
    const captured = collect();
    const reporter = new Reporter(captured.io, true);
    const content = "raw \r esc \u001b and \u0085 stays data";

    reporter.finishLocal("publish", {
      ok: true,
      result: { content },
      error: null,
      human: [],
    });

    const row = parseLines(captured.stdout)[0] as {
      result: { content: string };
    };

    expect(row.result.content).toBe(content);
    expect(captured.stdout.join("")).not.toContain("\u001b");
  });
});
