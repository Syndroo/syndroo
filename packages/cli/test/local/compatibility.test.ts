import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseJsonObject, runCli, type RunResult } from "../support/harness.js";

/**
 * The local surface next to the unmodified remote surface.
 *
 * These run the real `dist/bin.js`, so they also prove the published entry
 * point still routes both families of commands and that a local command is
 * never redirected by the remote instance environment.
 */

const homes: string[] = [];

function tempHome(): { home: string; env: NodeJS.ProcessEnv; cwd: string } {
  const home = mkdtempSync(path.join(tmpdir(), "syndroo-cli-compat-"));
  const cwd = path.join(home, "cwd");

  mkdirSync(cwd, { recursive: true });
  homes.push(home);

  return {
    home,
    cwd,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_STATE_HOME: path.join(home, "state"),
    },
  };
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function json(result: RunResult): Record<string, unknown> {
  return parseJsonObject(result.stdout);
}

describe("legacy remote surface", () => {
  it("keeps the legacy envelope and config failure for bare doctor", async () => {
    const result = await runCli(["doctor", "--json"], { env: {} });

    expect(result.code).toBe(2);

    const payload = json(result);

    expect(payload["exitCode"]).toBe(2);
    expect(payload["schemaVersion"]).toBeUndefined();
    expect(payload["mode"]).toBeUndefined();
  });

  it("does not accept local flags or commands on the remote surface", async () => {
    const cases: readonly (readonly string[])[] = [
      ["posts", "list", "--local", "--json"],
      ["sync", "--json"],
      ["skill", "install", "--json"],
      ["skill", "status", "--json"],
      ["publish", "--allow-experimental", "--json"],
    ];

    for (const argv of cases) {
      const result = await runCli(argv, { env: {} });

      expect(result.code, argv.join(" ")).toBe(2);
    }
  });

  it("advertises the remote commands and never the excluded ones", async () => {
    const result = await runCli(["help"], { env: {} });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("posts create");
    expect(result.stdout).toContain("doctor");
    expect(result.stdout).not.toContain("sync");
    expect(result.stdout).not.toContain("skill install");
    expect(result.stdout).not.toContain("allow-experimental");
  });
});

describe("local surface through the published binary", () => {
  it("rejects --base-url on doctor --local and answers local help without operands", async () => {
    const { env } = tempHome();

    const local = await runCli(["doctor", "--local", "--json"], { env });

    expect(local.code).toBe(1);
    expect(json(local)["mode"]).toBe("local");
    expect(json(local)["exitCode"]).toBeUndefined();

    const rejected = await runCli(
      [
        "doctor",
        "--local",
        "--base-url",
        "https://example.invalid",
        "--json",
      ],
      { env },
    );

    expect(rejected.code).toBe(2);
    expect(json(rejected)["error"]).toMatchObject({ code: "USAGE" });

    for (const words of [
      ["auth", "set"],
      ["auth", "remove"],
      ["receipts", "show"],
    ]) {
      const result = await runCli([...words, "--help"], { env });

      expect(result.code, `syndroo ${words.join(" ")} --help`).toBe(0);
    }
  });

  it("never routes a local command through SYNDROO_BASE_URL", async () => {
    const { env, cwd } = tempHome();
    const file = path.join(cwd, "input.json");

    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        key: "compat-001",
        content: "compat",
        platforms: ["bluesky"],
      }),
      "utf8",
    );

    const result = await runCli(
      ["publish", "--input", file, "--dry-run", "--json"],
      {
        cwd,
        env: {
          ...env,
          SYNDROO_BASE_URL: "https://example.invalid",
          SYNDROO_API_KEY: "unused-remote-key",
        },
      },
    );

    // Without `init` there is no local config, so this is a local CONFIG
    // failure. The important part is the local envelope and exit 2: the remote
    // instance origin did not capture the command.
    expect(result.code).toBe(2);

    const payload = json(result);

    expect(payload["mode"]).toBe("local");
    expect(payload["error"]).toMatchObject({ code: "CONFIG" });
    expect(result.stdout + result.stderr).not.toContain("unused-remote-key");
  });

  it("initializes and reports a local installation without a remote instance", async () => {
    const { env } = tempHome();

    const init = await runCli(["init", "--json"], { env });

    expect(init.code).toBe(0);
    expect(json(init)["result"]).toMatchObject({
      schemaVersion: 1,
      namespace: "default",
    });

    expect((await runCli(["init", "--json"], { env })).code).toBe(0);

    const providers = await runCli(["providers", "list", "--json"], { env });

    expect(providers.code).toBe(0);
    expect(json(providers)["result"]).toBeDefined();
  });
});
