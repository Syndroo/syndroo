import { describe, expect, it } from "vitest";

import { CliError } from "../src/cli-error.js";
import { parseArgs, wantsJson } from "../src/args.js";
import { parseDuration } from "../src/duration.js";

function expectUsageError(run: () => unknown): CliError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(2);
    return error as CliError;
  }

  throw new Error("expected a usage error");
}

describe("parseArgs", () => {
  it("resolves a nested command with flags in any position", () => {
    const parsed = parseArgs([
      "--json",
      "posts",
      "create",
      "--file",
      "post.json",
      "--yes",
      "--idempotency-key",
      "release-1",
    ]);

    expect(parsed.command).toBe("posts.create");
    expect(parsed.flags.get("json")).toBe(true);
    expect(parsed.flags.get("file")).toBe("post.json");
    expect(parsed.flags.get("idempotency-key")).toBe("release-1");
    expect(parsed.positionals).toEqual([]);
  });

  it("treats everything after -- as positional arguments", () => {
    const parsed = parseArgs(["posts", "get", "--", "--file"]);

    expect(parsed.command).toBe("posts.get");
    expect(parsed.positionals).toEqual(["--file"]);
  });

  it("reads an inline value", () => {
    const parsed = parseArgs(["posts", "create", "--file=post.json"]);

    expect(parsed.flags.get("file")).toBe("post.json");
  });

  it("rejects an unknown flag", () => {
    const error = expectUsageError(() => parseArgs(["posts", "list", "--nope"]));

    expect(error.code).toBe("USAGE");
    expect(error.message).toContain("--nope");
  });

  it("rejects a flag the command does not accept", () => {
    const error = expectUsageError(() => parseArgs(["doctor", "--limit", "5"]));

    expect(error.message).toContain("not accepted");
  });

  it("rejects a value flag with no value", () => {
    expectUsageError(() => parseArgs(["posts", "validate", "--file"]));
    expectUsageError(() => parseArgs(["posts", "validate", "--file", "--json"]));
  });

  it("rejects a boolean flag given a value", () => {
    expectUsageError(() => parseArgs(["posts", "create", "--yes=1"]));
  });

  it("rejects the wrong number of arguments", () => {
    expectUsageError(() => parseArgs(["posts", "get"]));
    expectUsageError(() => parseArgs(["posts", "get", "a", "b"]));
  });

  it("rejects an unknown command or subcommand", () => {
    expectUsageError(() => parseArgs([]));
    expectUsageError(() => parseArgs(["nope"]));
    expectUsageError(() => parseArgs(["posts", "nope"]));
    expectUsageError(() => parseArgs(["posts"]));
  });

  it("marks help and version as special commands", () => {
    expect(parseArgs(["help"]).command).toBe("help");
    expect(parseArgs(["version"]).command).toBe("version");
    expect(parseArgs(["posts", "wait", "post_1", "--help"]).help).toBe(true);
  });
});

describe("wantsJson", () => {
  it("detects the flag before a full parse", () => {
    expect(wantsJson(["--json", "posts", "list"])).toBe(true);
    expect(wantsJson(["--json=true", "posts", "list"])).toBe(true);
    expect(wantsJson(["posts", "list"])).toBe(false);
  });
});

describe("parseDuration", () => {
  it("parses documented durations", () => {
    expect(parseDuration("60s", "--timeout")).toBe(60_000);
    expect(parseDuration("500ms", "--timeout")).toBe(500);
    expect(parseDuration("5m", "--timeout")).toBe(300_000);
    expect(parseDuration("1h", "--timeout")).toBe(3_600_000);
  });

  it("treats a bare number as seconds", () => {
    expect(parseDuration("60", "--timeout")).toBe(60_000);
  });

  it("rejects nonsense and out-of-range values", () => {
    expectUsageError(() => parseDuration("soon", "--timeout"));
    expectUsageError(() => parseDuration("0s", "--timeout"));
    expectUsageError(() => parseDuration("25h", "--timeout"));
    expectUsageError(() => parseDuration("-5s", "--timeout"));
  });
});
