import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNodeProcessRunner,
  serverProcessEnvironment,
} from "../src/server/process.js";
import {
  readPrivateStateFile,
  writePrivateStateFile,
} from "../src/server/state.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const created = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "syndroo-server-")));
  roots.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((created) => fs.rm(created, { recursive: true, force: true })));
});

describe("bounded server process runner", () => {
  it("stops output at the requested bound", async () => {
    const cwd = await root();
    const runner = createNodeProcessRunner({ ...process.env }, new AbortController().signal);

    const result = await runner.run({
      tool: "node",
      args: ["-e", "process.stdout.write('x'.repeat(100000))"],
      cwd,
      maxOutputBytes: 256,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("output_limit");
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(256);
  });

  it("terminates a process at its timeout", async () => {
    const cwd = await root();
    const runner = createNodeProcessRunner({ ...process.env }, new AbortController().signal);

    const result = await runner.run({
      tool: "node",
      args: ["-e", "setTimeout(() => {}, 5000)"],
      cwd,
      timeoutMs: 50,
    });

    expect(result.status).toBe("timed_out");
  });

  it("keeps multi-chunk output intact when it remains below the bound", async () => {
    const cwd = await root();
    const runner = createNodeProcessRunner({ ...process.env }, new AbortController().signal);

    const result = await runner.run({
      tool: "node",
      args: [
        "-e",
        "process.stdout.write('{\"part\":\"'); setTimeout(() => process.stdout.write('a'.repeat(20)), 10); setTimeout(() => process.stdout.write('b'.repeat(20)), 20); setTimeout(() => process.stdout.write('\"}'), 30)",
      ],
      cwd,
      maxOutputBytes: 64,
    });

    expect(result.status).toBe("exited");
    expect(result.stdout).toBe(`{"part":"${"a".repeat(20)}${"b".repeat(20)}"}`);
  });

  it("does not forward unrelated credential-shaped environment variables", async () => {
    const cwd = await root();
    const runner = createNodeProcessRunner(
      { ...process.env, SYNDROO_TEST_SECRET: "must-not-cross-boundary" },
      new AbortController().signal,
    );

    const result = await runner.run({
      tool: "node",
      args: [
        "-e",
        "process.stdout.write(process.env.SYNDROO_TEST_SECRET ?? 'ABSENT')",
      ],
      cwd,
    });

    expect(result.status).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ABSENT");
  });

  it("preserves auth only for the tool that owns it", () => {
    const env = {
      GH_TOKEN: "github-auth",
      NODE_AUTH_TOKEN: "npm-auth",
      SYNDROO_ADMIN_TOKEN: "must-not-cross",
    };

    expect(serverProcessEnvironment("gh", env)).toMatchObject({ GH_TOKEN: "github-auth" });
    expect(serverProcessEnvironment("gh", env)).not.toHaveProperty("NODE_AUTH_TOKEN");
    expect(serverProcessEnvironment("npm", env)).toMatchObject({ NODE_AUTH_TOKEN: "npm-auth" });
    expect(serverProcessEnvironment("node", env)).not.toHaveProperty("GH_TOKEN");
    expect(serverProcessEnvironment("gh", env)).not.toHaveProperty("SYNDROO_ADMIN_TOKEN");
    expect(
      serverProcessEnvironment(
        "wrangler",
        { CLOUDFLARE_API_TOKEN: "base-cloudflare-auth", SYNDROO_ADMIN_TOKEN: "must-not-cross" },
        { CLOUDFLARE_ACCOUNT_ID: "account-id", GH_TOKEN: "wrong-tool" },
      ),
    ).toEqual({
      CLOUDFLARE_API_TOKEN: "base-cloudflare-auth",
      CLOUDFLARE_ACCOUNT_ID: "account-id",
    });
  });

  it("allows Wrangler machine-output and noninteractive settings without API-base overrides", () => {
    const env = {
      WRANGLER_OUTPUT_FILE_PATH: "/private/state/wrangler.jsonl",
      WRANGLER_SEND_METRICS: "true",
      CLOUDFLARE_API_BASE_URL: "https://untrusted.example",
    };

    expect(
      serverProcessEnvironment("wrangler", env, {
        WRANGLER_SEND_METRICS: "false",
        CI: "true",
        CLOUDFLARE_API_BASE_URL: "https://evil.example",
      }),
    ).toEqual({
      WRANGLER_OUTPUT_FILE_PATH: "/private/state/wrangler.jsonl",
      WRANGLER_SEND_METRICS: "false",
      CI: "true",
    });
  });
});

describe("private server state", () => {
  it("writes atomic 0600 files below 0700 directories", async () => {
    const base = await root();
    const stateRoot = path.join(base, "state");

    await writePrivateStateFile(stateRoot, "record.json", Buffer.from('{"ok":true}\n'));

    expect((await fs.stat(stateRoot)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(stateRoot, "record.json"))).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(stateRoot)).sort()).toEqual(["record.json"]);
    expect((await readPrivateStateFile(stateRoot, "record.json"))?.toString("utf8")).toBe(
      '{"ok":true}\n',
    );
  });

  it("refuses a symlinked state root instead of following it", async () => {
    const base = await root();
    const real = path.join(base, "real");
    const linked = path.join(base, "linked");
    await fs.mkdir(real, { mode: 0o700 });
    await fs.symlink(real, linked, "dir");

    await expect(
      writePrivateStateFile(linked, "record.json", Buffer.from("secret")),
    ).rejects.toMatchObject({ code: "STATE_RECOVERY_REQUIRED" });
  });

  it("reads absent state without creating the state root", async () => {
    const base = await root();
    const stateRoot = path.join(base, "absent-state");

    await expect(readPrivateStateFile(stateRoot, "record.json")).resolves.toBeNull();
    await expect(fs.stat(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a state directory with group or other permissions", async () => {
    const base = await root();
    const stateRoot = path.join(base, "state");
    await fs.mkdir(stateRoot, { mode: 0o755 });
    await fs.chmod(stateRoot, 0o755);

    await expect(readPrivateStateFile(stateRoot, "record.json")).rejects.toMatchObject({
      code: "STATE_RECOVERY_REQUIRED",
    });
  });
});
