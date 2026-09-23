/**
 * Test-project inventory for the Worker package.
 *
 * Claims are authoritative: every project configuration is asked for its file
 * list through Vitest's own discovery (`vitest list --filesOnly --json`), which
 * resolves includes, excludes and defaults exactly as a real run would without
 * collecting or executing any test. The filesystem walk only decides which
 * files look like tests, so an unclaimed test file can be reported as an
 * orphan; it never decides ownership.
 *
 * The vitest process is started through the bounded watchdog, so a hung or
 * broken discovery cannot hold the inventory open.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { runBounded } from "./bounded-run.js";

export interface ProjectDiscovery {
  /** Project name derived from its configuration file name. */
  readonly name: string;
  /** Package-relative configuration path. */
  readonly config: string;
  /** Package-relative files Vitest reports for this project. */
  readonly files: readonly string[];
  /** Discovery exit code; 0 when the project was listed successfully. */
  readonly exitCode: number;
  /** Failure detail when discovery did not report a file list. */
  readonly error: string | undefined;
}

export interface InventoryReport {
  readonly projects: readonly ProjectDiscovery[];
  /** Every test-like file on disk, package-relative and sorted. */
  readonly candidates: readonly string[];
  /** Candidate file to the names of the projects that own it. */
  readonly claims: ReadonlyMap<string, readonly string[]>;
  /** Candidates owned by no project. */
  readonly orphans: readonly string[];
  /** Candidates owned by more than one project. */
  readonly duplicates: readonly string[];
  /** Files a project lists that the filesystem walk does not consider a test. */
  readonly unexpectedProjectFiles: readonly string[];
  /** Projects whose discovery failed. */
  readonly discoveryFailures: readonly string[];
  /** Projects that reported no file at all. */
  readonly emptyProjects: readonly string[];
}

/** Test-like file names: the Worker suites use `.spec.ts` and `.native.ts`. */
const CANDIDATE_PATTERN = /\.(?:spec|test|native)\.ts$/u;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);

function walk(directory: string, root: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
        walk(absolute, root, files);
      }

      continue;
    }

    if (entry.isFile()) {
      files.push(relative(root, absolute).split(sep).join("/"));
    }
  }
}

/** Every test-like file under `test/`, package-relative and sorted. */
export function listTestCandidates(packageRoot: string): string[] {
  const files: string[] = [];
  walk(join(packageRoot, "test"), packageRoot, files);

  return files.filter((file) => CANDIDATE_PATTERN.test(file)).sort();
}

/** The main project plus every dedicated project configuration on disk. */
export function listProjectConfigs(packageRoot: string): string[] {
  const configs = ["vitest.config.ts"];

  for (const entry of readdirSync(join(packageRoot, "test")).sort()) {
    if (entry.endsWith(".vitest.config.ts")) {
      const absolute = join(packageRoot, "test", entry);

      if (statSync(absolute).isFile()) {
        configs.push(`test/${entry}`);
      }
    }
  }

  return configs;
}

function projectName(config: string): string {
  const fileName = config.split("/").pop() ?? config;

  return fileName === "vitest.config.ts"
    ? "main"
    : fileName.replace(/\.vitest\.config\.ts$/u, "");
}

/**
 * Extracts the JSON file list Vitest prints on stdout. Watchdog lines share the
 * same stream, so they are removed before the array is located.
 */
export function parseDiscoveryOutput(output: string): string[] {
  const lines = output
    .split("\n")
    .filter((line) => !line.startsWith("[watchdog "));
  const candidates: string[] = [];
  const single = lines.find((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("[") && trimmed.endsWith("]");
  });

  if (single !== undefined) {
    candidates.push(single.trim());
  }

  const cleaned = lines.join("\n");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");

  if (start !== -1 && end > start) {
    candidates.push(cleaned.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    if (!Array.isArray(parsed)) {
      continue;
    }

    return parsed.map((entry) => {
      const file = (entry as { file?: unknown }).file;

      if (typeof file !== "string") {
        throw new Error(
          `discovery entry without a file: ${JSON.stringify(entry)}`,
        );
      }

      return file;
    });
  }

  throw new Error(`no JSON file list in discovery output: ${output.slice(0, 512)}`);
}

/**
 * Runs Vitest discovery for one configuration. No test is collected or
 * executed, and the child is bounded and group-cleaned by the watchdog.
 */
export async function discoverProjectFiles(
  packageRoot: string,
  config: string,
  options: { readonly timeoutMs: number; readonly vitest: string },
): Promise<ProjectDiscovery> {
  let output = "";
  const collector = {
    write(chunk: string | Uint8Array): boolean {
      output += chunk.toString();
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  const exitCode = await runBounded({
    command: [
      process.execPath,
      options.vitest,
      "list",
      "--filesOnly",
      "--json",
      "--config",
      config,
    ],
    timeoutMs: options.timeoutMs,
    killGraceMs: 2_000,
    heartbeatMs: 0,
    diagnosticTimeoutMs: 2_000,
    label: `inventory:${projectName(config)}`,
    stdout: collector,
    stderr: collector,
  });

  try {
    const files = parseDiscoveryOutput(output).map((file) =>
      relative(packageRoot, resolve(file)).split(sep).join("/"),
    );

    return {
      name: projectName(config),
      config,
      files: [...new Set(files)].sort(),
      exitCode,
      error: exitCode === 0 ? undefined : `discovery exited ${String(exitCode)}`,
    };
  } catch (error) {
    return {
      name: projectName(config),
      config,
      files: [],
      exitCode,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Builds the report from discovered projects and the on-disk candidate set. */
export function buildReport(
  projects: readonly ProjectDiscovery[],
  candidates: readonly string[],
): InventoryReport {
  const claims = new Map<string, readonly string[]>();

  for (const file of candidates) {
    claims.set(
      file,
      projects
        .filter((project) => project.files.includes(file))
        .map((project) => project.name),
    );
  }

  const known = new Set(candidates);
  const listed = new Set(projects.flatMap((project) => project.files));

  return {
    projects,
    candidates,
    claims,
    orphans: candidates.filter((file) => (claims.get(file) ?? []).length === 0),
    duplicates: candidates.filter((file) => (claims.get(file) ?? []).length > 1),
    unexpectedProjectFiles: [...listed].filter((file) => !known.has(file)).sort(),
    discoveryFailures: projects
      .filter((project) => project.error !== undefined)
      .map((project) => `${project.name}: ${project.error ?? ""}`),
    emptyProjects: projects
      .filter((project) => project.files.length === 0)
      .map((project) => project.name),
  };
}

/** Discovers every project, then compares the claims against the file tree. */
export async function computeInventory(
  packageRoot: string,
  options: { readonly timeoutMs: number; readonly vitest: string },
): Promise<InventoryReport> {
  const projects: ProjectDiscovery[] = [];

  for (const config of listProjectConfigs(packageRoot)) {
    projects.push(await discoverProjectFiles(packageRoot, config, options));
  }

  return buildReport(projects, listTestCandidates(packageRoot));
}
