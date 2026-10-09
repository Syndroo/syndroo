import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { fixture } from "./support.js";

const run = promisify(execFile);

it("uses the selected config directory across different process cwd values and imports only after native approval", async () => {
  const a = await fixture();
  const b = await fixture();
  try {
    const bundle = path.join(a.base, "trusted-host.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../../../src/runtime/providers/index.ts", import.meta.url))],
      outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent",
      banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' },
    });
    async function child(configFile: string, cwd: string, load = false) {
      const code = `
import { createNodeProviderRuntime } from ${JSON.stringify(pathToFileURL(bundle).href)};
const runtime = createNodeProviderRuntime(${JSON.stringify({ configFile, stateRoot: a.stateRoot })});
const candidate = await runtime.loader.inspect("fake");
${load ? 'await runtime.loader.approve(candidate, {fingerprint:candidate.artifactFingerprint,approvedAt:"2026-10-09T00:00:00.000Z",source:"interactive"}); await runtime.registry.load("fake");' : 'await runtime.registry.describe("fake"); await runtime.registry.list(); try { await runtime.registry.load("fake"); } catch(error) { if(error.code !== "PROVIDER_TRUST_REQUIRED") throw error; }'}
console.log(JSON.stringify(candidate.resolvedRoot));
`;
      const output = await run(process.execPath, ["--input-type=module", "-e", code], { cwd });
      expect(output.stderr).toBe("");
      return JSON.parse(output.stdout) as string;
    }
    expect(await child(a.configFile, a.base)).toBe(a.root);
    expect(await child(a.configFile, b.base)).toBe(a.root);
    expect(await child(b.configFile, a.base)).toBe(b.root);
    expect(await a.count()).toBe(0);
    expect(await b.count()).toBe(0);
    await expect(fs.stat(a.stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await child(a.configFile, b.base, true)).toBe(a.root);
    expect(await a.count()).toBe(1);
    expect(await b.count()).toBe(0);
  } finally { await Promise.all([a.cleanup(), b.cleanup()]); }
}, 15000);
