import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DocumentError, parsePostDocument } from "../src/document.js";
import { EXIT_CODE } from "../src/exit-codes.js";
import { parseLocalPublishDocument } from "../src/local/document.js";
import { CLI_ROOT, runCli } from "./support/harness.js";

/**
 * The Skill ships inside this package, so its documented surface has to match
 * the CLI that ships next to it. These tests read the real `--help` output
 * instead of the flag tables in source, so a flag that is added, renamed, or
 * removed shows up as a Skill drift failure rather than a stale document.
 */

const SKILL_DIR = path.join(CLI_ROOT, "skills", "syndroo");
const CLI_REFERENCE = path.join(SKILL_DIR, "references", "cli.md");

interface SkillFile {
  /** Path relative to the Skill directory, with forward slashes. */
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

  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

/** Lines between exact headers in built help or the shipped reference. */
function section(text: string, header: string, stop: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(header);

  expect(start, `missing the "${header}" section`).toBeGreaterThanOrEqual(0);

  const end = lines.indexOf(stop, start);

  expect(end, `no "${stop}" after "${header}"`).toBeGreaterThan(start);

  return lines.slice(start + 1, end);
}

function documentedPlatforms(reference: string, header: string, stop: string): string[] {
  const rows = section(reference, header, stop)
    .filter(line => line.startsWith("| `platforms` |"));

  expect(rows, `${header} documents exactly one platforms field`).toHaveLength(1);

  const rule = rows[0]?.split("|")[2] ?? "";

  return [...rule.matchAll(/`([a-z0-9-]+)`/gu)].map(match => match[1] as string);
}

function flagsIn(help: string): string[] {
  const names: string[] = [];

  for (const line of help.split("\n")) {
    const match = /^ {2}--([a-z0-9-]+)/u.exec(line);

    if (match?.[1] !== undefined) {
      names.push(match[1]);
    }
  }

  return names;
}

interface HelpSurface {
  /** Every command, as the words a user types, for example `posts create`. */
  readonly commands: ReadonlySet<string>;
  /** The words plus the documented positional placeholders, for `--help`. */
  readonly invocation: ReadonlyMap<string, readonly string[]>;
  readonly flags: ReadonlySet<string>;
}

/** Ground truth: the commands and flags the built binary actually advertises. */
async function readHelpSurface(): Promise<HelpSurface> {
  const general = await runCli(["help"]);

  expect(general.code).toBe(0);

  const commands = new Set<string>();
  const invocation = new Map<string, readonly string[]>();

  for (const line of section(general.stdout, "Commands", "Global options")) {
    // A command row is two spaces, the label padded to a common width, then the
    // summary. The row for the special commands is the bare label.
    const label = line.trim().split(/ {2,}/u)[0];

    if (label === undefined || !/^[a-z]/u.test(label)) {
      continue;
    }

    // A label looks like `posts get <post-id> [--json]`, and the special entry
    // is `help / version`. A command that takes a positional needs a value
    // before `--help` is accepted, so keep the documented placeholder too.
    // Local usage lines also carry required flags and alternatives, as in
    // `auth set <provider> --local (--from-env | --credential-file <path>)`;
    // the run stops at the first optional or alternative group, because only
    // the words before it are needed to reach this command's help.
    for (const part of label.split("/")) {
      const words: string[] = [];
      const positionals: string[] = [];

      for (const token of part.trim().split(/\s+/u)) {
        if (token.startsWith("[") || token.startsWith("(") || token === "|") {
          break;
        }

        if (words.length < 2 && /^[a-z][a-z0-9-]*$/u.test(token)) {
          words.push(token);
          continue;
        }

        positionals.push(token);
      }

      if (words.length > 0) {
        const command = words.join(" ");

        commands.add(command);
        invocation.set(command, [...words, ...positionals]);
      }
    }
  }

  const flags = new Set<string>(flagsIn(general.stdout));

  for (const [command, argv] of invocation) {
    const result = await runCli([...argv, "--help"]);

    expect(result.code, `help for "syndroo ${command}"`).toBe(0);

    for (const flag of flagsIn(result.stdout)) {
      flags.add(flag);
    }
  }

  expect(commands.size).toBeGreaterThan(0);
  expect(flags.size).toBeGreaterThan(0);

  return { commands, invocation, flags };
}

const FLAG_PATTERN = /--[a-z][a-z0-9-]*/gu;
const COMMAND_PATTERN = /syndroo ([a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)?)/gu;

/** The longest leading run of a mention that resolves to a real command. */
function resolveCommand(
  mention: string,
  commands: ReadonlySet<string>,
): string | undefined {
  if (commands.has(mention)) {
    return mention;
  }

  const [first] = mention.split(" ");

  return first !== undefined && commands.has(first) ? first : undefined;
}

describe("the bundled Skill matches the CLI it ships with", () => {
  it("documents only commands and flags the CLI accepts", async () => {
    const { commands, flags } = await readHelpSurface();
    const files = readSkillFiles();

    expect(files.map(file => file.relative)).toContain("SKILL.md");

    const unknownFlags: string[] = [];
    const unknownCommands: string[] = [];

    for (const file of files) {
      for (const match of file.text.matchAll(FLAG_PATTERN)) {
        const name = match[0].slice(2);

        if (!flags.has(name)) {
          unknownFlags.push(`${file.relative}: ${match[0]}`);
        }
      }

      for (const match of file.text.matchAll(COMMAND_PATTERN)) {
        const mention = match[1] as string;

        if (resolveCommand(mention, commands) === undefined) {
          unknownCommands.push(`${file.relative}: syndroo ${mention}`);
        }
      }
    }

    expect(unknownFlags).toEqual([]);
    expect(unknownCommands).toEqual([]);
  });

  it("documents every command and flag the CLI offers", async () => {
    const { commands, flags } = await readHelpSurface();
    const reference = readFileSync(CLI_REFERENCE, "utf8");

    const undocumentedCommands = [...commands]
      .filter(command => !reference.includes(`syndroo ${command}`))
      .sort();
    const undocumentedFlags = [...flags]
      .filter(flag => !reference.includes(`--${flag}`))
      .sort();

    expect(undocumentedCommands).toEqual([]);
    expect(undocumentedFlags).toEqual([]);
  });

  it("keeps the entrypoint frontmatter and reference links resolvable", () => {
    const files = readSkillFiles();
    const entry = files.find(file => file.relative === "SKILL.md");

    expect(entry).toBeDefined();

    const frontmatter = /^---\nname: ([a-z0-9-]+)\ndescription: (\S[^\n]*)\n---\n/u.exec(
      (entry as SkillFile).text,
    );

    expect(frontmatter?.[1]).toBe("syndroo");
    expect((frontmatter?.[2] ?? "").length).toBeGreaterThan(20);

    const missing: string[] = [];
    const escaping: string[] = [];

    for (const file of files) {
      for (const match of file.text.matchAll(/\]\(([^)\s]+)\)/gu)) {
        const target = match[1] as string;

        if (/^[a-z]+:/iu.test(target)) {
          continue;
        }

        const resolved = path.resolve(path.dirname(path.join(SKILL_DIR, file.relative)), target);
        const relative = path.relative(SKILL_DIR, resolved);

        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          escaping.push(`${file.relative} -> ${target}`);
          continue;
        }

        const shipped = files.some(candidate => candidate.relative === relative.split(path.sep).join("/"));

        if (!shipped) {
          missing.push(`${file.relative} -> ${target}`);
        }
      }
    }

    expect(escaping).toEqual([]);
    expect(missing).toEqual([]);
  });

  it("documents exactly the exit codes the CLI defines", () => {
    const reference = readFileSync(CLI_REFERENCE, "utf8");
    const documented = new Set<number>(
      [...reference.matchAll(/^\| `(\d+)` \|/gmu)].map(match =>
        Number.parseInt(match[1] as string, 10),
      ),
    );
    const defined = new Set<number>(Object.values(EXIT_CODE));

    expect([...documented].sort((left, right) => left - right)).toEqual(
      [...defined].sort((left, right) => left - right),
    );
  });

  it("documents all five local platforms with their local document schemas", () => {
    const names = documentedPlatforms(
      readFileSync(CLI_REFERENCE, "utf8"),
      "## Local surface",
      "## Remote surface (retained)",
    );

    expect([...names].sort()).toEqual(["bluesky", "devto", "linkedin", "mastodon", "threads"]);

    for (const platform of names) {
      for (const schemaVersion of platform === "devto" ? [2] : [1, 2]) {
        const document = {
          schemaVersion,
          key: `skill-platform-contract-${platform}`,
          content: "Summary for text providers.",
          platforms: [platform],
          ...(platform === "devto" ? {
            overrides: {
              devto: {
                content: "# Article\n\nFull Markdown body for DEV.to.",
                article: {
                  title: "Documented local article",
                  tags: ["typescript"],
                  canonicalUrl: "https://example.com/posts/skill-contract",
                },
              },
            },
          } : {}),
        };

        expect(
          parseLocalPublishDocument(JSON.stringify(document)),
          `local cli.md platform ${platform} under schema ${schemaVersion}`,
        ).toEqual(document);
      }
    }
  });

  it("documents the retained remote schema platforms and rejects DEV.to remotely", () => {
    const names = documentedPlatforms(
      readFileSync(CLI_REFERENCE, "utf8"),
      "## Remote surface (retained)",
      "## Exit codes",
    );

    // Schema acceptance is independent of the adapters configured on an instance.
    expect([...names].sort()).toEqual([
      "bluesky", "linkedin", "mastodon", "nostr", "threads", "tumblr", "x",
    ]);

    for (const platform of names) {
      const document = { content: "Remote text.", platforms: [platform] };

      expect(
        parsePostDocument(JSON.stringify(document), "cli.md remote surface"),
        `remote cli.md platform ${platform}`,
      ).toEqual({ input: document, warnings: [] });
    }

    expect(() => parsePostDocument(
      JSON.stringify({ content: "Remote text.", platforms: ["devto"] }),
      "cli.md remote surface",
    )).toThrow(DocumentError);
  });
});
