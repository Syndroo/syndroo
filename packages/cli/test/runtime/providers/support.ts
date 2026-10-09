import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { ProviderManifest } from "@syndroo/provider-sdk";

export function manifest(): ProviderManifest {
  const object = { type: "object", additionalProperties: false };
  return {
    id: "fake", name: "Fixture provider", version: "1.0.0", apiVersion: 1,
    declaredCapabilities: ["text"],
    egress: { fixedOrigins: ["https://social.example"] },
    schemas: { connectOptions: object, credentialInput: object, content: object, publishOptions: object },
  };
}

export async function fixture() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "syndroo-trust-")));
  const root = path.join(base, "plugin");
  const stateRoot = path.join(base, "state");
  const configFile = path.join(base, "config.json");
  const counter = path.join(base, "evaluations.txt");
  await fs.mkdir(root);
  await fs.writeFile(configFile, JSON.stringify({ providers: { fake: { path: "./plugin" } } }));
  const packageJson = { name: "fixture-plugin", version: "1.0.0", type: "module", exports: "./index.mjs" };
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(packageJson));
  async function source(definition: unknown = manifest(), extra = "") {
    await fs.writeFile(path.join(root, "index.mjs"), `
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(counter)}, "evaluated\\n");
${extra}
export default {
  manifest: ${JSON.stringify(definition)},
  connect: { async run() { throw Error("not used"); }, async verify() { throw Error("not used"); } },
  freeze() { throw Error("not used"); },
  async publish() { throw Error("not used"); }
};
`);
  }
  await source();
  async function count() {
    return (await fs.readFile(counter, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  }
  return { base, root, stateRoot, configFile, counter, packageJson, source, count,
    options: { configFile, stateRoot }, cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}

export async function metadata(root: string): Promise<Record<string, { mode: number; mtime: number; bytes: string }>> {
  const result: Record<string, { mode: number; mtime: number; bytes: string }> = {};
  async function visit(directory: string) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const target = path.join(directory, name);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) continue;
      result[path.relative(root, target)] = {
        mode: stat.mode & 0o777, mtime: stat.mtimeMs,
        bytes: stat.isFile() && !path.relative(root, target).startsWith("secrets/")
          ? (await fs.readFile(target)).toString("base64") : "",
      };
      if (stat.isDirectory()) await visit(target);
    }
  }
  await visit(root);
  return result;
}
