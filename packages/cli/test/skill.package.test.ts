import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CLI_ROOT } from "./support/harness.js";

/**
 * Packaging fixture for the bundled Skill.
 *
 * The Skill directory is what `npm pack` ships, so these checks run against the
 * authored files that become the tarball contents. They cover the parts of
 * PKG-08 that do not need a pack: the `files` allowlist, portability, and the
 * absence of credentials and of paths that only exist on one machine.
 */

const SKILL_DIR = path.join(CLI_ROOT, "skills", "syndroo");

interface SkillFile {
  readonly relative: string;
  readonly text: string;
}

function readSkillFiles(): SkillFile[] {
  const files: SkillFile[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }

      files.push({
        relative: path.relative(SKILL_DIR, absolute).split(path.sep).join("/"),
        text: readFileSync(absolute, "utf8"),
      });
    }
  };

  walk(SKILL_DIR);

  return files;
}

/**
 * Secret shapes, not secret words. `SKILL.md` may name `SYNDROO_API_KEY`; it may
 * not carry a value for it, or any literal credential.
 */
const SECRET_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "openai-style key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/u },
  { name: "github token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/u },
  { name: "aws access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: "private key block", pattern: /BEGIN [A-Z ]*PRIVATE KEY/u },
  {
    name: "literal bearer credential",
    pattern: /\bBearer (?![$<{])(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{24,}/u,
  },
  { name: "64-character hex blob", pattern: /\b[A-Fa-f0-9]{64}\b/u },
  { name: "assigned API key", pattern: /\bSYNDROO_API_KEY\s*[:=]\s*\S/u },
  { name: "test sentinel", pattern: /sentinel[-_]/iu },
];

/** Absolute paths that only resolve on the machine that authored the file. */
const MACHINE_PATH_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "user or system directory", pattern: /[/\\](Users|home|private|opt|mnt|Volumes)[/\\]/u },
  { name: "temporary directory", pattern: /[/\\]tmp[/\\]/u },
  { name: "windows drive path", pattern: /\b[A-Za-z]:\\/u },
  { name: "file URL", pattern: /\bfile:\/\//u },
];

describe("the bundled Skill is portable and clean", () => {
  it("ships the Skill directory in the package allowlist", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(CLI_ROOT, "package.json"), "utf8"),
    ) as { files?: unknown };

    expect(Array.isArray(manifest.files)).toBe(true);
    expect(manifest.files as unknown[]).toContain("skills");
  });

  it("keeps every shipped file a non-empty markdown document", () => {
    const files = readSkillFiles();

    expect(files.length).toBeGreaterThanOrEqual(4);

    for (const file of files) {
      expect(file.relative, "every shipped Skill file is markdown").toMatch(/\.md$/u);
      expect(file.text.trim().length, `${file.relative} is not empty`).toBeGreaterThan(0);
    }
  });

  it("carries no credential-shaped value", () => {
    const findings: string[] = [];

    for (const file of readSkillFiles()) {
      for (const { name, pattern } of SECRET_PATTERNS) {
        if (pattern.test(file.text)) {
          findings.push(`${file.relative}: ${name}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it("carries no path that only exists on the authoring machine", () => {
    const findings: string[] = [];

    for (const file of readSkillFiles()) {
      for (const { name, pattern } of MACHINE_PATH_PATTERNS) {
        if (pattern.test(file.text)) {
          findings.push(`${file.relative}: ${name}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it("refers only inside the Skill directory", () => {
    const findings: string[] = [];

    for (const file of readSkillFiles()) {
      for (const needle of ["packages/cli", "../../", "../src", "node_modules"]) {
        if (file.text.includes(needle)) {
          findings.push(`${file.relative}: ${needle}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });
});
