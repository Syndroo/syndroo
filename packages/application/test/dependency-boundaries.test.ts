import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const srcDir = join(packageRoot, "src");

const ALLOWED_SPECIFIER = /^(\.\.?\/[^"']+|@syndroo\/core)$/;

const FORBIDDEN_SPECIFIER_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] =
  [
    { pattern: /^cloudflare:/, label: "cloudflare: runtime module" },
    { pattern: /^node:/, label: "node builtin" },
    { pattern: /^@cloudflare\//, label: "Cloudflare package or types" },
    { pattern: /^@syndroo\/cloudflare-worker$/, label: "Worker package" },
    {
      pattern: /^@syndroo\/(x|bluesky|threads|tumblr|linkedin|sdk|cli)$/,
      label: "provider/SDK package",
    },
    { pattern: /^@atproto\//, label: "provider SDK" },
    { pattern: /^wrangler/, label: "wrangler" },
  ];

const FORBIDDEN_SOURCE_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\brequire\s*\(/, label: "CommonJS require" },
  { pattern: /\bprocess\.(env|argv|exit)\b/, label: "Node process global" },
  { pattern: /\bD1Database\b/, label: "Cloudflare D1 ambient type" },
  { pattern: /\bR2Bucket\b/, label: "Cloudflare R2 ambient type" },
  { pattern: /\bMessageBatch\b/, label: "Cloudflare Queue ambient type" },
  { pattern: /\bExecutionContext\b/, label: "Cloudflare runtime ambient type" },
  { pattern: /\bimport\s*\(\s*["'](node:|cloudflare:)/, label: "dynamic runtime import" },
];

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** Returns one message per violation so the same scanner can be self-tested. */
export function scanSource(text: string): string[] {
  const violations: string[] = [];
  const body = stripComments(text);
  for (const { pattern, label } of FORBIDDEN_SOURCE_PATTERNS) {
    if (pattern.test(body)) {
      violations.push(`forbidden source usage: ${label}`);
    }
  }
  const specifiers = [
    ...text.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g),
  ].map((match) => match[1] ?? "");
  for (const specifier of specifiers) {
    for (const { pattern, label } of FORBIDDEN_SPECIFIER_PATTERNS) {
      if (pattern.test(specifier)) {
        violations.push(`forbidden module specifier: ${label}`);
      }
    }
    if (!ALLOWED_SPECIFIER.test(specifier)) {
      violations.push(`unexpected module specifier outside the allowlist: ${specifier}`);
    }
  }
  return violations;
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return listSourceFiles(path);
    }
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("application dependency boundaries", () => {
  it("flags a violating fixture, proving the scanner is real", () => {
    const violations = scanSource(
      'import { D1Database } from "cloudflare:workers";\nconst env = process.env;\n',
    );
    expect(violations).toContain("forbidden module specifier: cloudflare: runtime module");
    expect(violations).toContain("forbidden source usage: Node process global");
  });

  it("keeps every src file free of Cloudflare, Node and provider imports", () => {
    const files = listSourceFiles(srcDir);
    expect(files.length).toBeGreaterThan(10);
    const violations = files.flatMap((file) =>
      scanSource(readFileSync(file, "utf8")).map((message) => `${file}: ${message}`),
    );
    expect(violations).toEqual([]);
  });

  it("compiles with zero ambient types so Worker globals cannot leak in", () => {
    const tsconfig = JSON.parse(readFileSync(join(packageRoot, "tsconfig.json"), "utf8")) as {
      compilerOptions: { types?: string[]; lib?: string[] };
    };
    expect(tsconfig.compilerOptions.types).toEqual([]);
    expect(tsconfig.compilerOptions.lib).toEqual(["ES2022", "DOM", "DOM.Iterable"]);
  });

  it("keeps the test double on a separate export path", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.exports)).toEqual([".", "./testing"]);
    expect(manifest.dependencies?.["@syndroo/core"]).toBe("0.1.0");
  });
});
