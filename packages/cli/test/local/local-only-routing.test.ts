import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/main.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("R3 offline metadata boundary", () => {
  it.each([[], ["help"], ["--help"], ["-h"], ["version"], ["skill", "path"], ["providers", "list"], ["connect", "bluesky", "--help"]])("does not read secrets or start a timer for %j", async (...words) => {
    const argv = words.filter((word): word is string => typeof word === "string");
    const root = mkdtempSync(join(tmpdir(), "syndroo-offline-")); roots.push(root);
    const accesses: string[] = [];
    const env = new Proxy({ HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") } as NodeJS.ProcessEnv, {
      get(target, key: string) {
        if (/^SYNDROO_(API_KEY|BASE_URL)$|TOKEN|PASSWORD|SECRET/.test(key)) { accesses.push(key); throw new Error("forbidden environment access"); }
        return target[key];
      },
    });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is blocked"));
    const interval = vi.spyOn(globalThis, "setInterval");
    const output: string[] = [];
    const sink = () => new Writable({ write(chunk, _enc, done) { output.push(String(chunk)); done(); } });
    const code = await run([...argv, "--json"], { stdin: Readable.from([]), stdout: sink(), stderr: sink(), env, cwd: root,
      stdinIsTty: false, stdoutIsTty: false, hasTty: () => false, readTtyLine: () => undefined, signal: new AbortController().signal });
    expect(code).toBe(0);
    expect(accesses).toEqual([]);
    expect(network).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  });

  it("keeps the instance key registered for a remote command", async () => {
    const root = mkdtempSync(join(tmpdir(), "syndroo-offline-")); roots.push(root);
    const sentinel = "SENTINEL-API-KEY-VALUE";
    const accesses: string[] = [];
    const env = new Proxy({ HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), SYNDROO_API_KEY: sentinel } as NodeJS.ProcessEnv, {
      get(target, key: string) { accesses.push(key); return target[key]; },
    });
    const output: string[] = [];
    const sink = () => new Writable({ write(chunk, _enc, done) { output.push(String(chunk)); done(); } });
    const code = await run(["doctor", "--json"], { stdin: Readable.from([]), stdout: sink(), stderr: sink(), env, cwd: root,
      stdinIsTty: false, stdoutIsTty: false, hasTty: () => false, readTtyLine: () => undefined, signal: new AbortController().signal });
    expect(code).toBe(2);
    expect(accesses).toContain("SYNDROO_API_KEY");
    expect(output.join("")).not.toContain(sentinel);
  });

  it.each([
    ["--sk-live-CANARY-1", "--help"],
    ["version", "--sk-live-CANARY-2"],
    ["skill", "path", "--sk-live-CANARY-3"],
    ["help", "--sk-live-CANARY-4"],
    ["--sk-live-CANARY-5"],
  ])("never echoes an unknown flag value for %j", async (...words) => {
    const argv = words.filter((word): word is string => typeof word === "string");
    const root = mkdtempSync(join(tmpdir(), "syndroo-unknown-flag-")); roots.push(root);
    const output: string[] = [];
    const sink = () => new Writable({ write(chunk, _enc, done) { output.push(String(chunk)); done(); } });
    const code = await run(argv, { stdin: Readable.from([]), stdout: sink(), stderr: sink(),
      env: { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") },
      cwd: root, stdinIsTty: false, stdoutIsTty: false, hasTty: () => false,
      readTtyLine: () => undefined, signal: new AbortController().signal });

    expect(code).toBe(2);
    expect(output.join("")).not.toContain("CANARY");
    expect(output.join("")).not.toContain("sk-live");
    expect(readdirSync(root)).toEqual([]);
  });

});
