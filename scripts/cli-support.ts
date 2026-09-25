import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

/**
 * CLI-specific packaging facts and checks.
 *
 * The CLI is the only package in the 0.6 candidate that publishes, so it ships
 * as a self-contained Node ESM bundle: the SDK and the private workspace
 * packages are compiled in, and their declarations are vendored next to the
 * emitted ones. Nothing in the tarball may point at an unpublished package.
 */

export const CLI_PACKAGE_NAME = "@syndroo/cli";
export const CLI_PACKAGE_PATH = "packages/cli";
export const CLI_ARTIFACT_DIRECTORY = "artifacts";

/** The published command and the embeddable library entry point. */
export const CLI_BUNDLE_ENTRIES = [
  { source: "src/bin.ts", output: "bin.js" },
  { source: "src/index.ts", output: "index.js" },
] as const;

/**
 * Declarations the public surface re-exports but that must never become a
 * runtime dependency. They are copied into the bundle and rewritten to a
 * relative specifier.
 */
export const CLI_VENDORED_DECLARATIONS = [
  { specifier: "@syndroo/sdk", slug: "sdk", directory: "packages/sdk" },
  { specifier: "@syndroo/core", slug: "core", directory: "packages/core" },
] as const;

export const CLI_VENDOR_DIRECTORY = "_vendor";

/** Runtime built-ins that are legitimately external in a Node bundle. */
const ALLOWED_BARE_PREFIXES = ["node:"] as const;

export type BareSpecifier = {
  readonly specifier: string;
  readonly file: string;
};

export function cliDirectory(repositoryRoot: string): string {
  return resolve(repositoryRoot, CLI_PACKAGE_PATH);
}

export function cliDistDirectory(repositoryRoot: string): string {
  return resolve(cliDirectory(repositoryRoot), "dist");
}

export function cliArtifactDirectory(repositoryRoot: string): string {
  return resolve(repositoryRoot, CLI_ARTIFACT_DIRECTORY);
}

export function cliArtifactFileName(version: string): string {
  return `syndroo-cli-${version}.tgz`;
}

export async function readCliVersion(repositoryRoot: string): Promise<string> {
  const manifestPath = resolve(cliDirectory(repositoryRoot), "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    version?: unknown;
  };

  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`${CLI_PACKAGE_NAME} package.json declares no version.`);
  }

  return manifest.version;
}

/** Every file below `directory`, as absolute paths, sorted for stable output. */
export async function listFilesRecursively(
  directory: string,
): Promise<string[]> {
  if (!existsSync(directory)) {
    return [];
  }

  const collected: string[] = [];
  const pending = [directory];

  while (pending.length > 0) {
    const current = pending.pop() as string;

    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);

      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }

      if (entry.isFile()) {
        collected.push(absolute);
      }
    }
  }

  return collected.sort();
}

/**
 * Bare import specifiers in one file.
 *
 * Only real import positions count: a module specifier that appears inside a
 * string literal, a comment, or a `switch` label is not an import. Matching the
 * keyword together with its string is what keeps a bundle's own prose (for
 * example an error message that mentions `"http-errors"`) from being reported
 * as a dependency.
 */
export function findBareSpecifiers(text: string): string[] {
  const found = new Set<string>();
  const patterns = [
    // Every form is anchored to the start of a line, because a bundled string
    // constant can contain text that looks like an import statement (the
    // Bluesky lexicon ships one) and that is not a dependency.
    //
    // import … from "x" / export … from "x"
    /^[ \t]*(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']/gmu,
    // import "x" / export "x"
    /^[ \t]*(?:import|export)\s*["']([^"']+)["']\s*;?/gmu,
    // import("x") / require("x"), indented inside an expression
    /^[ \t]*(?:const|let|var|return|await)?[^\n]*?\b(?:import|require)\s*\(\s*["']([^"']+)["']/gmu,
    // A leading dynamic import with no statement keyword.
    /^[ \t]*import\s*\(\s*["']([^"']+)["']/gmu,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];

      if (specifier === undefined || specifier.startsWith(".")) {
        continue;
      }

      found.add(specifier);
    }
  }

  return [...found].sort();
}

export function isAllowedBareSpecifier(specifier: string): boolean {
  return ALLOWED_BARE_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

/** Collects every disallowed bare specifier under `directory`. */
export async function collectDisallowedSpecifiers(
  directory: string,
  extensions: readonly string[],
): Promise<BareSpecifier[]> {
  const violations: BareSpecifier[] = [];

  for (const file of await listFilesRecursively(directory)) {
    if (!extensions.some((extension) => file.endsWith(extension))) {
      continue;
    }

    const text = await readFile(file, "utf8");

    for (const specifier of findBareSpecifiers(text)) {
      if (!isAllowedBareSpecifier(specifier)) {
        violations.push({ specifier, file });
      }
    }
  }

  return violations;
}

/**
 * Copies the vendored declaration trees into `dist/_vendor/<slug>` and rewrites
 * every reference to the original bare specifier into a relative one.
 *
 * The copied trees are self-contained by construction, so their own relative
 * imports keep resolving inside the copied directory. Source maps are dropped
 * with their `sourceMappingURL` comment: the sources are not published, and a
 * dangling map is worse than no map.
 */
export async function vendorCliDeclarations(
  repositoryRoot: string,
  distDirectory: string,
): Promise<readonly string[]> {
  const vendoredRoot = resolve(distDirectory, CLI_VENDOR_DIRECTORY);

  await rm(vendoredRoot, { recursive: true, force: true });

  const rewrittenFiles: string[] = [];

  for (const vendored of CLI_VENDORED_DECLARATIONS) {
    const sourceDirectory = resolve(repositoryRoot, vendored.directory, "dist");

    if (!existsSync(sourceDirectory)) {
      throw new Error(
        `Missing ${vendored.directory}/dist. Build the workspace before bundling the CLI.`,
      );
    }

    const targetDirectory = resolve(vendoredRoot, vendored.slug);
    await mkdir(targetDirectory, { recursive: true });

    const declarations = (await listFilesRecursively(sourceDirectory)).filter(
      (file) => file.endsWith(".d.ts"),
    );

    if (declarations.length === 0) {
      throw new Error(`${vendored.directory}/dist has no declarations.`);
    }

    for (const declaration of declarations) {
      const text = await readFile(declaration, "utf8");
      const target = resolve(
        targetDirectory,
        relative(sourceDirectory, declaration),
      );

      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, stripSourceMapComment(text), "utf8");
    }

    for (const file of await rewriteSpecifiers(
      distDirectory,
      vendored.specifier,
      resolve(vendoredRoot, vendored.slug, "index.js"),
      vendoredRoot,
    )) {
      rewrittenFiles.push(file);
    }
  }

  return rewrittenFiles;
}

/**
 * Rewrites one bare specifier to a relative path in every declaration outside
 * the vendored trees.
 */
async function rewriteSpecifiers(
  distDirectory: string,
  specifier: string,
  target: string,
  vendoredRoot: string,
): Promise<string[]> {
  const rewritten: string[] = [];

  for (const file of await listFilesRecursively(distDirectory)) {
    if (!file.endsWith(".d.ts") || isInside(vendoredRoot, file)) {
      continue;
    }

    const text = await readFile(file, "utf8");

    if (!text.includes(`"${specifier}"`)) {
      continue;
    }

    const replacement = relativeSpecifier(dirname(file), target);
    const updated = text.split(`"${specifier}"`).join(`"${replacement}"`);

    if (updated.includes(`"${specifier}"`)) {
      throw new Error(`${file} still references ${specifier} after rewriting.`);
    }

    await writeFile(file, updated, "utf8");
    rewritten.push(file);
  }

  return rewritten;
}

/** A relative specifier that always starts with `./` or `../`. */
export function relativeSpecifier(fromDirectory: string, target: string): string {
  const candidate = relative(fromDirectory, target).split(sep).join("/");

  return candidate.startsWith(".") ? candidate : `./${candidate}`;
}

function stripSourceMapComment(text: string): string {
  return `${text.replace(/^\/\/# sourceMappingURL=.*$/gmu, "").trimEnd()}\n`;
}

export function isInside(directory: string, candidate: string): boolean {
  const parent = resolve(directory);
  const target = resolve(candidate);

  return (
    target === parent ||
    target.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
  );
}

/** The executable entry point must stay runnable after a pack. */
export async function makeExecutable(file: string): Promise<void> {
  await chmod(file, 0o755);
}

export type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CommandOptions = {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
};

/** Runs one command with no shell in between, capturing both streams. */
export function runCommand(
  executable: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

export type PackedCli = {
  readonly version: string;
  readonly fileName: string;
  readonly tarballPath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly files: readonly string[];
};

/**
 * Packs the CLI workspace into `artifacts/syndroo-cli-<version>.tgz`.
 *
 * `npm pack` is the only supported producer of a publishable tarball, so the
 * filename it chooses is normalised to the documented artifact name instead of
 * being re-implemented here.
 */
export async function packCliArtifact(
  repositoryRoot: string,
): Promise<PackedCli> {
  const version = await readCliVersion(repositoryRoot);
  const artifactDirectory = cliArtifactDirectory(repositoryRoot);

  await mkdir(artifactDirectory, { recursive: true });

  const packed = await runCommand(
    npmBinary(),
    [
      "pack",
      "--workspace",
      CLI_PACKAGE_NAME,
      "--pack-destination",
      artifactDirectory,
      "--json",
    ],
    { cwd: repositoryRoot },
  );

  if (packed.code !== 0) {
    throw new Error(
      `npm pack failed for ${CLI_PACKAGE_NAME}:\n${packed.stderr.trim()}`,
    );
  }

  // `node ../../.build/scripts/pack-cli.js` prints its own progress lines to the
  // same stdout, so the JSON array is extracted by its position rather than
  // assumed to be the whole stream.
  const jsonStart = packed.stdout.indexOf("[");
  const jsonEnd = packed.stdout.lastIndexOf("]");

  if (jsonStart === -1 || jsonEnd <= jsonStart) {
    throw new Error(
      `npm pack reported no JSON result for ${CLI_PACKAGE_NAME}: ${packed.stdout.slice(-400)}`,
    );
  }

  const entries = JSON.parse(
    packed.stdout.slice(jsonStart, jsonEnd + 1),
  ) as ReadonlyArray<{
    readonly filename?: unknown;
    readonly files?: unknown;
    readonly size?: unknown;
  }>;
  const entry = entries[0];

  if (entry === undefined || typeof entry.filename !== "string") {
    throw new Error(
      `npm pack reported no tarball for ${CLI_PACKAGE_NAME}: ${packed.stdout.slice(0, 400)}`,
    );
  }

  const produced = resolve(artifactDirectory, entry.filename);
  const wanted = resolve(artifactDirectory, cliArtifactFileName(version));

  if (produced !== wanted) {
    await rm(wanted, { force: true });
    await rename(produced, wanted);
  }

  const contents = await readFile(wanted);
  const stats = await stat(wanted);
  const files = Array.isArray(entry.files)
    ? entry.files
        .map((file) =>
          typeof file === "object" && file !== null && "path" in file
            ? String((file as { path: unknown }).path)
            : undefined,
        )
        .filter((path): path is string => path !== undefined)
        .sort()
    : [];

  return {
    version,
    fileName: cliArtifactFileName(version),
    tarballPath: wanted,
    sha256: createHash("sha256").update(contents).digest("hex"),
    bytes: stats.size,
    files,
  };
}

export function npmBinary(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
