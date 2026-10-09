import { afterEach, describe, expect, it } from "vitest";

import { parseEnvelope, runCli, sandbox, stateRootExists, type Sandbox } from "./support/harness.js";
import { fakeRegistry } from "./support/registry.js";

/**
 * Usage and preflight refusals.
 *
 * Each of these must stop before any local write or protocol call, report a
 * stable code, and leave the state root absent. The machine envelope carries a
 * static message, never the offending argv token.
 */

const boxes: Sandbox[] = [];

async function box(): Promise<Sandbox> {
  const created = await sandbox("syndroo-cli-usage-");

  boxes.push(created);

  return created;
}

afterEach(async () => {
  await Promise.all(boxes.splice(0).map((created) => created.cleanup()));
});

const overrides = { providers: fakeRegistry() };

describe("usage refusals", () => {
  it("rejects a duplicated global flag without echoing argv", async () => {
    const space = await box();
    const result = await runCli(["--json", "--json", "status"], {
      env: space.env,
      cwd: space.root,
      overrides,
    });

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("syndroo: The command line is not valid. Run `syndroo --help`.\n");
    expect(stateRootExists(space)).toBe(false);
  });

  it("rejects conflicting status selectors with a coded envelope", async () => {
    const space = await box();
    const result = await runCli(["status", "--connections", "--operations", "--json"], {
      env: space.env,
      cwd: space.root,
      overrides,
    });

    expect(result.exit).toBe(2);
    expect(parseEnvelope(result)).toMatchObject({
      operation: "status",
      ok: false,
      result: null,
      error: { code: "USAGE" },
    });
    expect(stateRootExists(space)).toBe(false);
  });

  it("rejects --limit and --cursor outside --operations", async () => {
    const space = await box();

    for (const argv of [["status", "--limit", "5", "--json"], ["status", "--cursor", "abc", "--json"]]) {
      const result = await runCli(argv, { env: space.env, cwd: space.root, overrides });

      expect(result.exit).toBe(2);
      expect(parseEnvelope(result)["error"].code).toBe("USAGE");
    }
  });

  it("bounds an --operations page size to 1..100", async () => {
    const space = await box();
    const result = await runCli(["status", "--operations", "--limit", "101", "--json"], {
      env: space.env,
      cwd: space.root,
      overrides,
    });

    expect(result.exit).toBe(2);
    expect(parseEnvelope(result)["error"].code).toBe("USAGE");
  });

  it("requires exactly one publish source", async () => {
    const space = await box();
    const missing = await runCli(["publish", "--json"], { env: space.env, cwd: space.root, overrides });

    expect(missing.exit).toBe(2);
    expect(parseEnvelope(missing)["error"].code).toBe("INPUT_SOURCE_MISSING");

    const conflict = await runCli(
      ["publish", "--input", "a.json", "--data", "{}", "--json"],
      { env: space.env, cwd: space.root, overrides },
    );

    expect(conflict.exit).toBe(2);
    expect(parseEnvelope(conflict)["error"].code).toBe("INPUT_SOURCE_CONFLICT");
  });

  it("never accepts an execute request from argv", async () => {
    const space = await box();
    const result = await runCli(
      ["publish", "--data", '{"type":"execute","approvalToken":"live-token"}', "--json"],
      { env: space.env, cwd: space.root, overrides },
    );

    expect(result.exit).toBe(2);
    const envelope = parseEnvelope(result);

    expect(envelope["error"].code).toBe("EXECUTE_REQUIRES_STDIN");
    expect(result.stdout).not.toContain("live-token");
    expect(stateRootExists(space)).toBe(false);
  });

  it("refuses a retry without an explicit target", async () => {
    const space = await box();
    const result = await runCli(["publish", "--retry", "op_1", "--json"], {
      env: space.env,
      cwd: space.root,
      overrides,
    });

    expect(result.exit).toBe(2);
    expect(parseEnvelope(result)["error"].code).toBe("USAGE");
  });

  it("refuses --to without --retry", async () => {
    const space = await box();
    const result = await runCli(
      ["publish", "--input", "doc.json", "--to", "conn_1", "--json"],
      { env: space.env, cwd: space.root, overrides },
    );

    expect(result.exit).toBe(2);
    expect(parseEnvelope(result)["error"].code).toBe("USAGE");
  });

  it("rejects an invalid provider id", async () => {
    const space = await box();
    const result = await runCli(["connect", "Bad Id", "--json"], {
      env: space.env,
      cwd: space.root,
      overrides,
    });

    expect(result.exit).toBe(2);
    expect(parseEnvelope(result)["error"].code).toBe("USAGE");
  });

  it("requires an absolute --config path", async () => {
    const space = await box();
    const result = await runCli(["--config", "config.json", "status", "--json"], {
      env: space.env,
      cwd: space.root,
      overrides,
    });

    expect(result.exit).toBe(2);
    expect(parseEnvelope(result)["error"].code).toBe("CONFIG_PATH_NOT_ABSOLUTE");
  });
});
