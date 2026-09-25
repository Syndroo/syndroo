import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

/**
 * Import-boundary proof for the CLI-first design (acceptance ARC-01).
 *
 * One extractor, `dependenciesOfFile`, walks a real syntax tree produced by
 * TypeScript and reports every module reference it finds. The real tree and
 * every fixture go through that same extractor: fixtures are written to a
 * temporary directory outside the source tree and opened through the real API,
 * so a fixture cannot take a path the real tree skips.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const ts = await import("typescript/unstable/sync");
const ast = await import("typescript/unstable/ast");

const FIXTURE_ROOT = mkdtempSync(path.join(tmpdir(), "syndroo-arc-"));

afterAll(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface Dependency {
  /** The specifier exactly as written in the source. */
  readonly raw: string;
  /**
   * The file this dependency was found in. Rules resolve relative specifiers
   * against it, so the same rule judges the real tree and a fixture tree.
   */
  readonly from: string;
  readonly relative: boolean;
  readonly typeOnly: boolean;
  /** A triple-slash `path` or `types` reference. */
  readonly ambient: boolean;
}

/** Absolute normalized path of a dependency, resolved against its importer. */
function targetOf(dependency: Dependency): string {
  return dependency.relative
    ? path.resolve(path.dirname(dependency.from), dependency.raw).split(path.sep).join("/")
    : dependency.raw;
}

interface NodeLike {
  readonly kind: number;
  forEachChild?(visitor: (node: NodeLike) => void): void;
}

interface SourceLike {
  readonly fileName: string;
  readonly referencedFiles?: readonly { readonly fileName: string }[];
  readonly typeReferenceDirectives?: readonly { readonly fileName: string }[];
  forEachChild?(visitor: (node: NodeLike) => void): void;
}

/** Every module reference in one real source file. */
function dependenciesOfFile(file: SourceLike): Dependency[] {
  const dependencies: Dependency[] = [];

  const record = (raw: string | undefined, typeOnly: boolean): void => {
    if (raw === undefined || raw.length === 0) {
      return;
    }

    const relative = raw.startsWith(".");

    dependencies.push({
      raw,
      from: file.fileName,
      relative,
      typeOnly,
      ambient: false,
    });
  };

  const walk = (node: NodeLike): void => {
    const candidate = node as unknown as {
      readonly moduleSpecifier?: { readonly text: string } | undefined;
      readonly moduleReference?: NodeLike | undefined;
      readonly isTypeOnly?: boolean;
      readonly importClause?: { readonly isTypeOnly?: boolean } | undefined;
      readonly argument?: NodeLike | undefined;
      readonly literal?: { readonly text: string } | undefined;
      readonly expression?: NodeLike | undefined;
    };

    if (
      ast.isImportDeclaration(node as never) ||
      ast.isExportDeclaration(node as never)
    ) {
      record(
        candidate.moduleSpecifier?.text,
        candidate.isTypeOnly === true ||
          candidate.importClause?.isTypeOnly === true,
      );
    } else if (ast.isImportEqualsDeclaration(node as never)) {
      // `import x = require("y")`: the specifier hangs off moduleReference.
      const reference = candidate.moduleReference as unknown as
        | { readonly expression?: { readonly text?: string } | undefined }
        | undefined;

      record(reference?.expression?.text, false);
    } else if (ast.isImportTypeNode(node as never)) {
      // `type T = import("node:fs").Stats`: the specifier is a LiteralType.
      const argument = candidate.argument as unknown as
        | { readonly literal?: { readonly text?: string } | undefined }
        | undefined;

      record(argument?.literal?.text, true);
    } else if (
      ast.isCallExpression(node as never) &&
      (candidate.expression as unknown as { readonly kind?: number } | undefined)
        ?.kind === ast.SyntaxKind.ImportKeyword
    ) {
      // Dynamic `import("x")`.
      const [first] = (node as unknown as {
        readonly arguments?: readonly { readonly text?: string }[];
      }).arguments ?? [];

      record(first?.text, false);
    }

    node.forEachChild?.(walk);
  };

  file.forEachChild?.(walk as (node: NodeLike) => void);

  for (const reference of file.referencedFiles ?? []) {
    dependencies.push({
      raw: reference.fileName,
      from: file.fileName,
      relative: true,
      typeOnly: false,
      ambient: true,
    });
  }

  for (const reference of file.typeReferenceDirectives ?? []) {
    dependencies.push({
      raw: reference.fileName,
      from: file.fileName,
      relative: false,
      typeOnly: true,
      ambient: true,
    });
  }

  return dependencies;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const ADAPTER_PACKAGES = [
  "@syndroo/bluesky",
  "@syndroo/threads",
  "@syndroo/x",
  "@syndroo/tumblr",
  "@syndroo/linkedin",
] as const;

const FORBIDDEN_PACKAGES = [
  "@syndroo/cli",
  ...ADAPTER_PACKAGES,
  "@syndroo/cloudflare-worker",
  "@syndroo/sdk",
] as const;

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");

  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] as string);
}

function isForbiddenPackage(specifier: string, names: readonly string[]): boolean {
  return names.includes(packageNameOf(specifier));
}

/**
 * Node's own builtin registry, so a bare `crypto` or `http` cannot slip past
 * an incomplete hand-written list.
 */
function isNodeBuiltin(specifier: string): boolean {
  return isBuiltin(specifier);
}

/**
 * A relative or package target that leaves the pure local module set.
 *
 * The comparison uses the fully resolved path, so a basename that merely looks
 * familiar cannot buy an escape: `../../../threads/src/results.js` and
 * `../../config/cli-error.js` both land outside the allowed set.
 */
function escapesPureLocal(dependency: Dependency, root: string): boolean {
  if (!dependency.relative) {
    return (
      isForbiddenPackage(dependency.raw, ADAPTER_PACKAGES) ||
      isForbiddenPackage(dependency.raw, [
        "@syndroo/cloudflare-worker",
        "@syndroo/sdk",
      ])
    );
  }

  const resolved = targetOf(dependency);
  const cli = `${path.resolve(root, "packages", "cli", "src").split(path.sep).join("/")}/`;
  const inside = resolved.startsWith(cli)
    ? resolved.slice(cli.length).replace(/\.(js|ts)$/u, "")
    : null;

  if (inside === null) {
    return true;
  }

  return !PURE_LOCAL_ALLOWED.has(inside);
}

/**
 * The only files a pure local use case may reach by relative path.
 *
 * Extensions are dropped before comparison, because TypeScript specifiers
 * carry `.js` while the files on disk are `.ts`.
 */
const PURE_LOCAL_ALLOWED: ReadonlySet<string> = new Set([
  "cli-error",
  "exit-codes",
  "local/document",
  "local/errors",
  "local/results",
  "local/plan",
  "local/execute",
  "local/retry",
  "local/ports/credentials",
  "local/ports/local-store",
]);

/**
 * `sourceRoot` is the tree a relative specifier resolves against, so the same
 * rule judges the real repository and a fixture tree without branching.
 */
interface BoundaryRule {
  readonly name: string;
  readonly forbidden: (dependency: Dependency, root: string) => boolean;
}

const CORE_RULE: BoundaryRule = {
  name: "core stays platform-neutral",
  forbidden: (dependency, root) =>
    isForbiddenPackage(dependency.raw, [
      "@syndroo/cli",
      ...ADAPTER_PACKAGES,
      "@syndroo/cloudflare-worker",
      "@syndroo/sdk",
    ]) ||
    // Core requires no Node builtin at all, including pure ones.
    isNodeBuiltin(dependency.raw) ||
    dependency.raw.startsWith("cloudflare:") ||
    // An ambient `types="node"` reference.
    (dependency.ambient && dependency.raw === "node") ||
    // A relative specifier that lands outside this tree's `packages/core/src`.
    (dependency.relative && !landsInCore(dependency, root)),
};

const PURE_LOCAL_RULE: BoundaryRule = {
  name: "pure local use cases avoid I/O and concrete providers",
  forbidden: (dependency, root) =>
    escapesPureLocal(dependency, root) ||
    isForbiddenPackage(dependency.raw, [
      "@syndroo/cli",
      ...ADAPTER_PACKAGES,
      "@syndroo/cloudflare-worker",
      "@syndroo/sdk",
    ]) ||
    dependency.raw.startsWith("cloudflare:") ||
    (isNodeBuiltin(dependency.raw) &&
      !PURE_BUILTINS.includes(dependency.raw)) ||
    // An ambient reference is a dependency the module did not ask for.
    dependency.ambient,
};

/** Node builtins a pure local module may use: pure computation only. */
const PURE_BUILTINS: readonly string[] = ["node:crypto", "node:util"];

/**
 * True when a relative specifier stays inside the core source tree.
 *
 * Both the repository and a fixture tree mirror `packages/`, so the check is
 * structural: the resolved target must sit under a `packages/core/src` path.
 */
function landsInCore(dependency: Dependency, root: string): boolean {
  const core =
    path.resolve(root, "packages", "core", "src").split(path.sep).join("/") + "/";

  return targetOf(dependency).startsWith(core);
}

// ---------------------------------------------------------------------------
// Real projects
// ---------------------------------------------------------------------------

interface ProjectLike {
  readonly configFileName: string;
  readonly program: {
    getSourceFileNames(): readonly string[];
    getSourceFile(name: string): SourceLike | undefined;
  };
}

async function openProjects(): Promise<readonly ProjectLike[]> {
  const api = new ts.API({ cwd: REPO_ROOT });
  const snapshot = api.updateSnapshot({
    openFiles: [
      "packages/core/src/index.ts",
      "packages/cli/src/index.ts",
    ],
  });

  return [...snapshot.getProjects()] as unknown as ProjectLike[];
}

function sourcesUnder(
  project: ProjectLike,
  prefix: string,
): readonly SourceLike[] {
  const sources: SourceLike[] = [];

  for (const name of project.program.getSourceFileNames()) {
    const relative = path
      .relative(REPO_ROOT, path.resolve(name))
      .split(path.sep)
      .join("/")
      .toLowerCase();

    if (!relative.startsWith(prefix.toLowerCase())) {
      continue;
    }

    const source = project.program.getSourceFile(name);

    if (source !== undefined) {
      sources.push(source);
    }
  }

  return sources;
}

/** One fixture file, parsed by the same API the real tree uses. */
function sourceForFixture(name: string, text: string): SourceLike {
  const file = path.join(FIXTURE_ROOT, name);

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);

  const api = new ts.API({ cwd: REPO_ROOT });
  const snapshot = api.updateSnapshot({ openFiles: [file] });
  const project = [...snapshot.getProjects()][0];
  const source = project?.program.getSourceFile(
    project.program.getSourceFileNames().find(candidate =>
      candidate.endsWith(name),
    ) ?? "",
  );

  if (source === undefined) {
    throw new Error(`the fixture ${name} was not parsed`);
  }

  return source;
}

function violationsOf(
  sources: readonly SourceLike[],
  rule: BoundaryRule,
  root: string,
): readonly string[] {
  const violations: string[] = [];

  for (const source of sources) {
    for (const dependency of dependenciesOfFile(source)) {
      if (rule.forbidden(dependency, root)) {
        violations.push(
          `${path.relative(REPO_ROOT, source.fileName)} -> ${dependency.raw}`,
        );
      }
    }
  }

  return violations.sort();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("import boundaries (ARC-01)", () => {
  it("keeps the real core inside its boundary", async () => {
    const projects = await openProjects();
    const core = projects.find(project =>
      project.configFileName.endsWith("packages/core/tsconfig.json"),
    );

    expect(core).toBeDefined();

    const sources = sourcesUnder(core as ProjectLike, "packages/core/src/");

    expect(sources.length).toBeGreaterThan(0);
    expect(violationsOf(sources, CORE_RULE, REPO_ROOT)).toEqual([]);
  });

  it("keeps every pure local module inside its boundary", async () => {
    const projects = await openProjects();
    const cli = projects.find(project =>
      project.configFileName.endsWith("packages/cli/tsconfig.json"),
    );

    expect(cli).toBeDefined();

    const byName = new Map(
      sourcesUnder(cli as ProjectLike, "packages/cli/src/").map(source => [
        path
          .relative(REPO_ROOT, path.resolve(source.fileName))
          .split(path.sep)
          .join("/"),
        source,
      ]),
    );
    const pureFiles = [
      "packages/cli/src/local/document.ts",
      "packages/cli/src/local/plan.ts",
      "packages/cli/src/local/execute.ts",
      "packages/cli/src/local/retry.ts",
      "packages/cli/src/local/results.ts",
      "packages/cli/src/local/errors.ts",
      "packages/cli/src/local/ports/credentials.ts",
      "packages/cli/src/local/ports/local-store.ts",
    ].map(name => {
      const source = byName.get(name);

      if (source === undefined) {
        throw new Error(`the cli project did not include ${name}`);
      }

      return source;
    });

    expect(violationsOf(pureFiles, PURE_LOCAL_RULE, REPO_ROOT)).toEqual([]);
  });

  it("extracts the real dependencies of a pure local module", async () => {
    const projects = await openProjects();
    const cli = projects.find(project =>
      project.configFileName.endsWith("packages/cli/tsconfig.json"),
    );
    const plan = sourcesUnder(cli as ProjectLike, "packages/cli/src/").find(
      source => source.fileName.endsWith(path.join("local", "plan.ts")),
    );

    expect(plan).toBeDefined();

    const raw = dependenciesOfFile(plan as SourceLike).map(
      dependency => dependency.raw,
    );

    expect(raw).toContain("node:crypto");
    expect(raw).toContain("@syndroo/core");
    expect(raw).toContain("./ports/local-store.js");
  });

  it("rejects one real fixture source per prohibited direction", () => {
    const fixtures: readonly {
      readonly name: string;
      readonly text: string;
      readonly rule: typeof CORE_RULE;
    }[] = [
      { name: "core-cli.ts", text: 'import "@syndroo/cli";', rule: CORE_RULE },
      {
        name: "core-adapter.ts",
        text: 'import type { B } from "@syndroo/bluesky";',
        rule: CORE_RULE,
      },
      {
        name: "core-worker.ts",
        text: 'export * from "@syndroo/cloudflare-worker";',
        rule: CORE_RULE,
      },
      {
        name: "core-sdk.ts",
        text: 'import type { S } from "@syndroo/sdk";',
        rule: CORE_RULE,
      },
      { name: "core-fs.ts", text: 'import "node:fs";', rule: CORE_RULE },
      {
        name: "core-fs-promises.ts",
        text: 'import type { F } from "node:fs/promises";',
        rule: CORE_RULE,
      },
      { name: "core-crypto.ts", text: 'import "node:crypto";', rule: CORE_RULE },
      { name: "core-util.ts", text: 'import "node:util";', rule: CORE_RULE },
      {
        name: "core-import-type.ts",
        text: 'type S = import("node:fs").Stats;',
        rule: CORE_RULE,
      },
      {
        name: "core-import-equals.ts",
        text: 'import f = require("node:fs");',
        rule: CORE_RULE,
      },
      {
        name: "core-dynamic-import.ts",
        text: 'void import("node:http");',
        rule: CORE_RULE,
      },
      {
        name: "core-relative-escape.ts",
        text: 'export * from "../../cli/src/main.js";',
        rule: CORE_RULE,
      },
      {
        name: "core-reference.ts",
        text: '/// <reference path="../../cli/src/main.ts" />',
        rule: CORE_RULE,
      },
      {
        name: "core-reference-types.ts",
        text: '/// <reference types="node" />',
        rule: CORE_RULE,
      },
      {
        name: "pure-adapter.ts",
        text: 'import "@syndroo/threads";',
        rule: PURE_LOCAL_RULE,
      },
      {
        name: "pure-worker-escape.ts",
        text: 'export * from "../../../cloudflare-worker/src/index.js";',
        rule: PURE_LOCAL_RULE,
      },
      {
        name: "pure-adapter-escape.ts",
        text: 'export * from "../../../bluesky/src/local.js";',
        rule: PURE_LOCAL_RULE,
      },
      { name: "pure-fs.ts", text: 'import "node:fs";', rule: PURE_LOCAL_RULE },
      {
        name: "pure-import-type.ts",
        text: 'type S = import("node:path").ParsedPath;',
        rule: PURE_LOCAL_RULE,
      },
      {
        name: "pure-import-equals.ts",
        text: 'import p = require("node:path");',
        rule: PURE_LOCAL_RULE,
      },
      {
        name: "pure-state.ts",
        text: 'export * from "../state/store.js";',
        rule: PURE_LOCAL_RULE,
      },
      {
        name: "pure-config.ts",
        text: 'import "../config.js";',
        rule: PURE_LOCAL_RULE,
      },
      {
        name: "pure-credentials.ts",
        text: 'import "../credentials.js";',
        rule: PURE_LOCAL_RULE,
      },
      {
        name: "pure-reference.ts",
        text: '/// <reference types="node" />',
        rule: PURE_LOCAL_RULE,
      },
    ];
    const violations: string[] = [];

    for (const fixture of fixtures) {
      // Fixtures live one directory below the real module, matching the depth
      // the relative paths above assume.
      const directory = path.join(FIXTURE_ROOT, "packages", "cli", "src", "local");
      const source = sourceForFixture(
        path.join("packages/cli/src/local", fixture.name),
        fixture.text,
      );
      const found = dependenciesOfFile(source);

      expect(found.length, `${fixture.name} must yield a dependency`).toBeGreaterThan(0);
      expect(directory.length).toBeGreaterThan(0);

      if (found.some(dependency => fixture.rule.forbidden(dependency, FIXTURE_ROOT))) {
        violations.push(fixture.name);
      }
    }

    expect(violations.sort()).toEqual(
      fixtures.map(fixture => fixture.name).sort(),
    );
  });

  it("accepts a clean fixture and catches each added violation", () => {
    const clean = [
      'import { createHash } from "node:crypto";',
      'import { TextDecoder } from "node:util";',
      'import type { FrozenDelivery } from "@syndroo/core";',
      'import { canonicalJson } from "./document.js";',
      'import type { LocalStore } from "./ports/local-store.js";',
    ].join("\n");
    const file = path.join("packages/cli/src/local", "clean.ts");
    const source = sourceForFixture(file, clean);
    const dependencies = dependenciesOfFile(source);

    expect(dependencies.map(dependency => dependency.raw).sort()).toEqual([
      "./document.js",
      "./ports/local-store.js",
      "@syndroo/core",
      "node:crypto",
      "node:util",
    ]);
    expect(
      dependencies.filter(dependency => PURE_LOCAL_RULE.forbidden(dependency, FIXTURE_ROOT)),
    ).toEqual([]);

    for (const addition of [
      'import "node:fs";',
      'type S = import("node:fs").Stats;',
      'import f = require("node:fs");',
      'export * from "../state/store.js";',
      'export * from "../../../bluesky/src/local.js";',
      'void import("node:http");',
    ]) {
      const extended = dependenciesOfFile(
        sourceForFixture(
          path.join("packages/cli/src/local", `extended-${addition.length}.ts`),
          `${clean}\n${addition}`,
        ),
      );

      expect(
        extended.some(dependency => PURE_LOCAL_RULE.forbidden(dependency, FIXTURE_ROOT)),
        `the extractor must catch: ${addition}`,
      ).toBe(true);
    }
  });

  it("labels type-only, ambient, and equals-import dependencies", () => {
    const source = sourceForFixture(
      path.join("packages/cli/src/local", "labels.ts"),
      [
        '/// <reference path="../state/store.ts" />',
        '/// <reference types="node" />',
        'import type { A } from "@syndroo/core";',
        'export type { B } from "./results.js";',
        'import f = require("node:fs");',
        'type S = import("node:path").ParsedPath;',
      ].join("\n"),
    );
    const dependencies = dependenciesOfFile(source);
    const byRaw = new Map(
      dependencies.map(dependency => [dependency.raw, dependency]),
    );

    expect(byRaw.get("@syndroo/core")?.typeOnly).toBe(true);
    expect(byRaw.get("./results.js")?.typeOnly).toBe(true);
    expect(byRaw.get("node:path")?.typeOnly).toBe(true);
    expect(byRaw.get("node:fs")?.typeOnly).toBe(false);
    expect(byRaw.get("../state/store.ts")?.ambient).toBe(true);
    expect(byRaw.get("node")?.ambient).toBe(true);
    expect(byRaw.get("node")?.typeOnly).toBe(true);
    expect(targetOf(byRaw.get("./results.js") as Dependency)).toBe(
      path.join(FIXTURE_ROOT, "packages/cli/src/local", "results.js")
        .split(path.sep)
        .join("/"),
    );
  });

  it("resolves a relative escape out of core as a violation", () => {
    const escape = dependenciesOfFile(
      sourceForFixture(
        path.join("packages/core/src", "escape.ts"),
        'export * from "../../cli/src/main.js";',
      ),
    );

    expect(escape).toHaveLength(1);
    expect(targetOf(escape[0] as Dependency)).toBe(
      path.join(FIXTURE_ROOT, "packages/cli/src/main.js").split(path.sep).join("/"),
    );
    expect(CORE_RULE.forbidden(escape[0] as Dependency, FIXTURE_ROOT)).toBe(true);

    const internal = dependenciesOfFile(
      sourceForFixture(
        path.join("packages/core/src", "internal.ts"),
        'export * from "./local-publishing.js";',
      ),
    );

    expect(CORE_RULE.forbidden(internal[0] as Dependency, FIXTURE_ROOT)).toBe(false);
  });
});
