import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  DocumentError,
  canonicalRequestJson,
  escapeControls,
  freezePost,
  parsePostDocument,
  readPostSource,
  sha256,
} from "../src/document.js";
import { CliError } from "../src/cli-error.js";

const VALID = JSON.stringify({
  content: "We just shipped a new release.",
  platforms: ["bluesky", "threads"],
});

function issuesOf(run: () => unknown): readonly { path: string; message: string }[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentError);
    return (error as DocumentError).issues;
  }

  throw new Error("expected a DocumentError");
}

describe("parsePostDocument", () => {
  it("accepts a minimal document", () => {
    const parsed = parsePostDocument(VALID, "post.json");

    expect(parsed.input.content).toBe("We just shipped a new release.");
    expect(parsed.input.platforms).toEqual(["bluesky", "threads"]);
    expect(parsed.input.scheduledAt).toBeUndefined();
    expect(parsed.warnings).toEqual([]);
  });

  it("normalizes a scheduled time to ISO and keeps the overrides", () => {
    const parsed = parsePostDocument(
      JSON.stringify({
        content: "base",
        platforms: ["x", "bluesky"],
        overrides: { x: { content: "for x" } },
        scheduledAt: "2030-01-02T03:04:05+09:00",
      }),
      "post.json",
    );

    expect(parsed.input.scheduledAt).toBe("2030-01-01T18:04:05.000Z");
    expect(parsed.input.overrides).toEqual({ x: { content: "for x" } });
  });

  it("warns instead of failing on unknown fields and past times", () => {
    const parsed = parsePostDocument(
      JSON.stringify({
        content: "hi",
        platforms: ["x"],
        extra: 1,
        scheduledAt: "2001-01-01T00:00:00Z",
      }),
      "post.json",
    );

    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.warnings[0]).toContain("extra");
  });

  it("reports every problem at once", () => {
    const issues = issuesOf(() =>
      parsePostDocument(
        JSON.stringify({ content: "", platforms: ["x", "x", "myspace"] }),
        "post.json",
      ),
    );

    expect(issues.map(issue => issue.path)).toEqual([
      "content",
      "platforms[1]",
      "platforms[2]",
    ]);
  });

  it("rejects a document that is not JSON or not an object", () => {
    expect(issuesOf(() => parsePostDocument("{", "post.json"))[0]?.path).toBe("");
    expect(issuesOf(() => parsePostDocument("[]", "post.json"))[0]?.message).toContain(
      "must be a JSON object",
    );
  });

  it("rejects overrides that do not match the selected platforms", () => {
    const issues = issuesOf(() =>
      parsePostDocument(
        JSON.stringify({
          content: "hi",
          platforms: ["x"],
          overrides: { bluesky: { content: "nope" } },
        }),
        "post.json",
      ),
    );

    expect(issues[0]?.path).toBe("overrides.bluesky");
  });

  it("rejects unsupported override fields", () => {
    const issues = issuesOf(() =>
      parsePostDocument(
        JSON.stringify({
          content: "hi",
          platforms: ["x"],
          overrides: { x: { content: "ok", media: "no" } },
        }),
        "post.json",
      ),
    );

    expect(issues[0]?.message).toContain("media");
  });

  it("rejects a scheduled time that is not a date", () => {
    expect(
      issuesOf(() =>
        parsePostDocument(
          JSON.stringify({ content: "hi", platforms: ["x"], scheduledAt: "tomorrow" }),
          "post.json",
        ),
      )[0]?.path,
    ).toBe("scheduledAt");
  });

  it("rejects content above the documented limit", () => {
    const issues = issuesOf(() =>
      parsePostDocument(
        JSON.stringify({ content: "a".repeat(10_001), platforms: ["x"] }),
        "post.json",
      ),
    );

    expect(issues[0]?.message).toContain("10000");
  });

  it("accepts 10000 multi-byte characters", () => {
    const parsed = parsePostDocument(
      JSON.stringify({ content: "\u{1f600}".repeat(10_000), platforms: ["x"] }),
      "post.json",
    );

    expect([...parsed.input.content]).toHaveLength(10_000);
  });
});

describe("canonicalRequestJson", () => {
  it("hashes exactly the bytes that will be sent", () => {
    const parsed = parsePostDocument(
      JSON.stringify({
        content: "hi",
        platforms: ["x", "bluesky"],
        overrides: { bluesky: { content: "b" } },
      }),
      "post.json",
    );
    const json = canonicalRequestJson(parsed.input);

    expect(json).toBe(
      '{"content":"hi","platforms":["x","bluesky"],"overrides":{"bluesky":{"content":"b"}}}',
    );
    expect(sha256(json)).toHaveLength(64);
  });
});

describe("freezePost", () => {
  it("changes the hash when the document changes", () => {
    const before = readFromText(VALID, "post.json");
    const after = readFromText(
      JSON.stringify({ content: "changed", platforms: ["bluesky"] }),
      "post.json",
    );

    expect(before.requestSha256).not.toBe(after.requestSha256);
  });

  it("is stable for the same document", () => {
    expect(readFromText(VALID, "post.json").requestSha256).toBe(
      readFromText(VALID, "stdin").requestSha256,
    );
  });
});

describe("readPostSource", () => {
  it("reads a file", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "syndroo-doc-"));

    try {
      const file = path.join(directory, "post.json");
      writeFileSync(file, VALID);

      const source = await readPostSource({
        file,
        stdin: Readable.from([]),
        stdinIsTty: true,
        cwd: directory,
      });

      expect(source.kind).toBe("file");
      expect(source.text).toBe(VALID);
      expect(source.bytes).toBe(Buffer.byteLength(VALID));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads stdin when it is not a terminal", async () => {
    const source = await readPostSource({
      file: undefined,
      stdin: Readable.from([VALID]),
      stdinIsTty: false,
      cwd: "/",
    });

    expect(source.kind).toBe("stdin");
    expect(source.text).toBe(VALID);
  });

  it("reads stdin when the file argument is -", async () => {
    const source = await readPostSource({
      file: "-",
      stdin: Readable.from([VALID]),
      stdinIsTty: false,
      cwd: "/",
    });

    expect(source.kind).toBe("stdin");
  });

  it("refuses to read a document from a terminal", async () => {
    await expect(
      readPostSource({
        file: undefined,
        stdin: Readable.from([]),
        stdinIsTty: true,
        cwd: "/",
      }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("refuses an empty stdin document", async () => {
    await expect(
      readPostSource({
        file: undefined,
        stdin: Readable.from([]),
        stdinIsTty: false,
        cwd: "/",
      }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("reports a missing file as a usage problem", async () => {
    await expect(
      readPostSource({
        file: "/definitely/not/here.json",
        stdin: Readable.from([]),
        stdinIsTty: false,
        cwd: "/",
      }),
    ).rejects.toThrow(/cannot read --file/u);
  });

  it("rejects a document above the size limit", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "syndroo-doc-"));

    try {
      const file = path.join(directory, "big.json");
      writeFileSync(file, "x".repeat(1024 * 1024 + 1));

      await expect(
        readPostSource({ file, stdin: Readable.from([]), stdinIsTty: true, cwd: directory }),
      ).rejects.toThrow(/limit/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("escapeControls", () => {
  it("renders control characters without changing ordinary text", () => {
    expect(escapeControls("a\u001b[31mred")).toBe("a\\u001b[31mred");
    expect(escapeControls("plain \u{1f600} text")).toBe("plain \u{1f600} text");
  });
});

function readFromText(text: string, label: string) {
  const source = { kind: "stdin" as const, label, bytes: Buffer.byteLength(text), text };
  return freezePost(parsePostDocument(text, label), source);
}
