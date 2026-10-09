import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { after, describe, it } from "node:test";

import { bundlePackage, collectImportSpecifiers, verifyBundleArtifact, type BundleSpec } from "./lib/bundle-v1.js";
import {
  CLOUDFLARE_PACKAGE_DIR,
  CLOUDFLARE_DIST_DIR,
  CLOUDFLARE_INLINED_PACKAGES,
  bundleCloudflare,
  verifyCloudflareBundleArtifact,
} from "./bundle-v1-cloudflare.js";

/**
 * The `@syndroo/cloudflare` Worker bundle must inline the private
 * `@syndroo/core` (plus `@syndroo/server` and the providers) and must carry no
 * `node:` or external import. These tests build the real artifact and prove the
 * gate is falsifiable: a copy that imports Core, and a copy that imports a Node
 * built-in, must both fail verification.
 */

const scratch: string[] = [];

after(() => {
  for (const directory of scratch) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function copyOfArtifact(): string {
  const directory = mkdtempSync(join(tmpdir(), "syndroo-worker-bundle-"));
  scratch.push(directory);
  cpSync(CLOUDFLARE_DIST_DIR, directory, { recursive: true });
  return directory;
}

/** Every declaration file in the artifact, relative to the artifact root. */
function declarations(directory = CLOUDFLARE_DIST_DIR): string[] {
  return readdirSync(directory, { recursive: true })
    .map((entry) => String(entry).replaceAll("\\", "/"))
    .filter((entry) => entry.endsWith(".d.ts"))
    .sort();
}

describe("@syndroo/cloudflare bundle", () => {
  it("builds a publishable Worker that inlines private Core with no external import", async () => {
    await bundleCloudflare();

    assert.deepEqual(
      verifyCloudflareBundleArtifact(),
      [],
      "the freshly built Worker bundle must verify with no problems",
    );

    const worker = readFileSync(join(CLOUDFLARE_DIST_DIR, "worker.js"), "utf8");

    assert.doesNotMatch(worker, /from\s*["']@syndroo\/core["']/u, "the Worker must not import Core");
    assert.doesNotMatch(worker, /from\s*["']node:/u, "the Worker must not import a Node built-in");
  });

  it("fails verification when the Worker imports Core instead of inlining it", () => {
    const directory = copyOfArtifact();
    const worker = join(directory, "worker.js");

    writeFileSync(worker, `import { createCore } from "@syndroo/core";\n${readFileSync(worker, "utf8")}`);

    const problems = verifyCloudflareBundleArtifact(directory);

    assert.ok(
      problems.some((problem) => problem.includes("@syndroo/core")),
      `expected a Core-import problem, got:\n${problems.join("\n")}`,
    );
  });

  it("fails verification when the Worker imports a Node built-in", () => {
    const directory = copyOfArtifact();
    const worker = join(directory, "worker.js");

    writeFileSync(worker, `import { createHash } from "node:crypto";\n${readFileSync(worker, "utf8")}`);

    const problems = verifyCloudflareBundleArtifact(directory);

    assert.ok(
      problems.some((problem) => problem.includes("node:")),
      `expected a node: import problem, got:\n${problems.join("\n")}`,
    );
  });

  it("fails verification when the Worker imports an external package", () => {
    const directory = copyOfArtifact();
    const worker = join(directory, "worker.js");

    writeFileSync(worker, `import Ajv from "ajv";\n${readFileSync(worker, "utf8")}`);

    const problems = verifyCloudflareBundleArtifact(directory);

    assert.ok(
      problems.some((problem) => problem.includes("external package")),
      `expected an external-import problem, got:\n${problems.join("\n")}`,
    );
  });

  it("resolves the inlined declarations instead of importing a private workspace package", () => {
    // Falsifiable: remove the declaration inlining from `bundlePackage` and the
    // `queue`/`secrets`/`crypto`/`transport` declarations below keep their bare
    // `@syndroo/core` specifier, so this assertion fails.
    const offenders: string[] = [];

    for (const relative of declarations()) {
      for (const specifier of collectImportSpecifiers(readFileSync(join(CLOUDFLARE_DIST_DIR, relative), "utf8"))) {
        if (CLOUDFLARE_INLINED_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
          offenders.push(`${relative} imports ${specifier}`);
        }
      }
    }

    assert.deepEqual(offenders, [], "no published declaration may import a bundled workspace package");
    assert.ok(
      existsSync(join(CLOUDFLARE_DIST_DIR, "_vendor", "core", "index.d.ts")),
      "the inlined Core declarations must be copied into the artifact",
    );
    assert.match(
      readFileSync(join(CLOUDFLARE_DIST_DIR, "secrets.d.ts"), "utf8"),
      /\.\/_vendor\/core\/index\.js/u,
      "public declarations must point at the vendored Core declarations",
    );
  });

  it("fails verification when an emitted declaration still imports a bundled package", () => {
    const directory = copyOfArtifact();
    const target = join(directory, "secrets.d.ts");

    writeFileSync(target, `import type * as T from "@syndroo/core";\n${readFileSync(target, "utf8")}`);

    const problems = verifyCloudflareBundleArtifact(directory);

    assert.ok(
      problems.some((problem) => problem.includes("imports") && problem.includes("@syndroo/core")),
      `expected a surviving-declaration-import problem, got:\n${problems.join("\n")}`,
    );
  });

  it("rewrites inlined workspace specifiers that are not private packages", () => {
    // Falsifiable: `@syndroo/provider-sdk` is published, so an inliner that only
    // handled the private Core would leave the bare specifier in place and the
    // first assertion would fail.
    const records = readFileSync(join(CLOUDFLARE_DIST_DIR, "_vendor", "core", "domain", "records.d.ts"), "utf8");

    assert.doesNotMatch(records, /["']@syndroo\/provider-sdk["']/u, "the public SDK must be resolved, not imported");
    assert.match(records, /\.\.\/\.\.\/provider-sdk\/index\.js/u, "the public SDK must resolve to its vendored copy");
  });

  it("fails verification when a declaration names a workspace package the Worker does not depend on", () => {
    // The packaging trap: `@syndroo/server`'s Node-only compose surface names
    // `@syndroo/cli/runtime`, which the Worker manifest does not declare.
    const directory = copyOfArtifact();
    const target = join(directory, "worker.d.ts");

    writeFileSync(
      target,
      `import type { NodeTransportDependencies } from "@syndroo/cli/runtime";\n${readFileSync(target, "utf8")}`,
    );

    const problems = verifyCloudflareBundleArtifact(directory);

    assert.ok(
      problems.some(
        (problem) => problem.includes("@syndroo/cli/runtime") && problem.includes("not a declared dependency"),
      ),
      `expected an undeclared-workspace-dependency problem, got:\n${problems.join("\n")}`,
    );
  });

  it("vendors only declarations the emitted entry points can reach", () => {
    // Falsifiable: without the prune, the vendored copy of `@syndroo/server`
    // still contains `compose/node-provider.d.ts`, so this fails.
    const vendored = declarations().filter((relative) => relative.startsWith("_vendor/"));

    assert.ok(vendored.includes("_vendor/core/index.d.ts"), "the declaration closure of Core must ship");
    assert.ok(
      !vendored.some((relative) => relative.startsWith("_vendor/server/compose/")),
      `unreachable Node-only declarations must not ship, got:\n${vendored.join("\n")}`,
    );

    const offenders: string[] = [];

    for (const relative of declarations()) {
      for (const specifier of collectImportSpecifiers(readFileSync(join(CLOUDFLARE_DIST_DIR, relative), "utf8"))) {
        if (specifier.startsWith("@syndroo/")) {
          offenders.push(`${relative} imports ${specifier}`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "the Worker declares no workspace dependency, so no emitted declaration may name one",
    );
  });

  it("lists every declaration the published types can reach in the manifest `files`", () => {
    // Falsifiable: drop `dist/_vendor` from `files` and the closure below reaches
    // the vendored declarations that the emitted `.d.ts` resolve into.
    const manifest = JSON.parse(readFileSync(join(CLOUDFLARE_PACKAGE_DIR, "package.json"), "utf8")) as {
      files: string[];
    };
    const isShipped = (relative: string): boolean =>
      manifest.files.some((entry) => relative === entry || relative.startsWith(`${entry.replace(/\/$/u, "")}/`));

    const needed = new Set<string>();
    const queue = manifest.files.filter((entry) => entry.endsWith(".d.ts"));

    while (queue.length > 0) {
      const relative = queue.pop() as string;

      if (needed.has(relative)) {
        continue;
      }

      needed.add(relative);

      for (const specifier of collectImportSpecifiers(readFileSync(join(CLOUDFLARE_PACKAGE_DIR, relative), "utf8"))) {
        if (!specifier.startsWith(".")) {
          continue;
        }

        const base = join(CLOUDFLARE_PACKAGE_DIR, relative, "..", specifier.replace(/\.js$/u, ""));

        for (const candidate of [`${base}.d.ts`, join(base, "index.d.ts")]) {
          if (existsSync(candidate)) {
            queue.push(candidate.slice(CLOUDFLARE_PACKAGE_DIR.length + 1).replaceAll("\\", "/"));
            break;
          }
        }
      }
    }

    const missing = [...needed].filter((relative) => !isShipped(relative));
    const vendored = declarations().filter((relative) => relative.startsWith("_vendor/"));
    const unshipped = vendored.filter((relative) => !isShipped(`dist/${relative}`));

    assert.deepEqual(missing, [], "every declaration reachable from the published types must ship");
    assert.ok(vendored.length > 0, "the artifact must vendor the declarations its entry points resolve into");
    assert.deepEqual(unshipped, [], "every vendored declaration must be listed in `files`");
    assert.ok(manifest.files.includes("dist/_vendor"), "the vendored declarations must be part of `files`");
  });

  it("fails the Worker build when an inlined provider reaches an unresolvable Node-only dependency", async () => {
    // PLG-07: a third-party package can be contract-compatible and still be
    // Node-only. `node-only-renderer` installs cleanly and its surface matches,
    // but its implementation imports `node:fs`, so it cannot exist in the
    // Worker's browser platform. The fixture provider is bundled into the entry
    // (not left external), so the only reason the build can fail here is the
    // Node-only dependency.
    const root = nodeOnlyProviderFixture();
    const dist = join(root, "dist");
    const spec = workerFixtureSpec(root);

    await assert.rejects(
      () => bundlePackage(spec),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);

        assert.match(
          message,
          /Could not resolve "node:fs"/u,
          `the build must fail on the Node-only dependency, got:\n${message}`,
        );
        assert.match(
          message,
          /node-only-renderer/u,
          `the failure must name the dependency that reaches Node, got:\n${message}`,
        );
        return true;
      },
    );

    // The failing build leaves no *verified* artifact: even if esbuild wrote a
    // partial file before failing, the verifier refuses the tree, so nothing
    // here can be published or mistaken for a built Worker.
    assert.notDeepEqual(
      verifyBundleArtifact(spec, dist),
      [],
      "a build that reaches Node must never produce a verifiable Worker artifact",
    );
  });

  it("fails the Worker build when a Node-only dependency is externalized instead of resolved", async () => {
    // The second half of PLG-07: if a bundler configuration ever marked the
    // Node built-in external (the only way `node:fs` survives esbuild on the
    // browser platform), the Worker's own `rejectExternalImports` rule must
    // still refuse the artifact. Falsifiable: drop the rule and this build
    // succeeds and writes `worker.js`, so both assertions below fail. The
    // failure is raised by the existing external-import rule - `rejectNodeImports`
    // never sees it, because an externalized built-in is not a bundle input.
    const root = nodeOnlyProviderFixture();
    const dist = join(root, "dist");
    const spec = workerFixtureSpec(root, { external: ["node:fs"] });

    await assert.rejects(
      () => bundlePackage(spec),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);

        assert.match(
          message,
          /WORKER_EXTERNAL_IMPORT/u,
          `the Worker must refuse an external import, got:\n${message}`,
        );
        return true;
      },
    );

    assert.notDeepEqual(
      verifyBundleArtifact(spec, dist),
      [],
      "an externalized Node-only dependency must never produce a verifiable Worker artifact",
    );
  });
});

/**
 * A throwaway Worker package whose only entry point imports a provider that
 * reaches a Node-only third-party dependency. Returns the fixture root.
 */
function nodeOnlyProviderFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "syndroo-worker-node-only-"));
  scratch.push(root);
  const write = (relative: string, contents: string): void => {
    const absolute = join(root, ...relative.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  };

  write(
    "node_modules/node-only-renderer/package.json",
    `${JSON.stringify({ name: "node-only-renderer", version: "1.0.0", type: "module", main: "index.js" }, null, 2)}\n`,
  );
  write(
    "node_modules/node-only-renderer/index.js",
    'import { statSync } from "node:fs";\nexport const render = (text) => `${statSync(".").size}${text}`;\n',
  );
  write(
    "node_modules/@syndroo/provider-fixture-node-only/package.json",
    `${JSON.stringify(
      {
        name: "@syndroo/provider-fixture-node-only",
        version: "0.0.0",
        type: "module",
        main: "index.js",
        dependencies: { "node-only-renderer": "1.0.0" },
      },
      null,
      2,
    )}\n`,
  );
  write(
    "node_modules/@syndroo/provider-fixture-node-only/index.js",
    'import { render } from "node-only-renderer";\nexport const manifest = { id: "fixture-node-only" };\nexport const freeze = (text) => render(text);\n',
  );
  write(
    "src/worker.ts",
    'import { manifest, freeze } from "@syndroo/provider-fixture-node-only";\nexport default { fetch: () => new Response(freeze(manifest.id)) };\n',
  );

  return root;
}

/** The Worker-critical half of `CLOUDFLARE_BUNDLE_SPEC`, pointed at a fixture. */
function workerFixtureSpec(root: string, overrides: { external?: string[] } = {}): BundleSpec {
  return {
    name: "@syndroo/fixture-worker",
    label: "fixture Worker",
    packageDir: root,
    distDir: join(root, "dist"),
    infoFile: "bundle.json",
    format: "syndroo-fixture-worker-bundle-v1",
    generator: "scripts/bundle-v1-cloudflare.spec.ts",
    entries: [{ source: "src/worker.ts", output: "worker.js" }],
    external: overrides.external ?? [],
    requiredInlined: [],
    forbiddenImports: [],
    platform: "browser",
    target: "es2024",
    aliasNodeBuiltins: false,
    allowedExtensions: [".js", ".json", ".d.ts"],
    rejectNodeImports: true,
    rejectExternalImports: true,
    coreLabel: "Core",
  };
}
