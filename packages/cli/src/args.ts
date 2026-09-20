import { usageError } from "./cli-error.js";

export interface FlagDefinition {
  readonly name: string;
  readonly kind: "boolean" | "value";
  readonly description: string;
  readonly placeholder?: string;
}

export interface CommandSpec {
  /** Canonical command name, for example `posts.create`. */
  readonly name: string;
  /** Command words as the user types them. */
  readonly words: readonly string[];
  readonly summary: string;
  readonly usage: string;
  readonly minPositionals: number;
  readonly maxPositionals: number;
  /** Flags accepted by this command, in addition to the global ones. */
  readonly flags: readonly string[];
}

export const GLOBAL_FLAGS: readonly FlagDefinition[] = [
  {
    name: "json",
    kind: "boolean",
    description: "Write exactly one JSON object to stdout; diagnostics go to stderr.",
  },
  {
    name: "help",
    kind: "boolean",
    description: "Print help for this command and exit.",
  },
];

export const COMMAND_FLAGS: readonly FlagDefinition[] = [
  {
    name: "base-url",
    kind: "value",
    description: "Syndroo instance origin. Overrides SYNDROO_BASE_URL.",
    placeholder: "<url>",
  },
  {
    name: "file",
    kind: "value",
    description: "Post document path, or `-` for stdin.",
    placeholder: "<path>",
  },
  {
    name: "idempotency-key",
    kind: "value",
    description: "Stable key for one logical post. Required with --yes.",
    placeholder: "<key>",
  },
  {
    name: "limit",
    kind: "value",
    description: "Maximum posts to list, 1-100.",
    placeholder: "<n>",
  },
  {
    name: "timeout",
    kind: "value",
    description: "Wait budget, for example 60s.",
    placeholder: "<duration>",
  },
  {
    name: "yes",
    kind: "boolean",
    description: "Confirm without prompting. Non-interactive runs also need --idempotency-key.",
  },
  {
    name: "dry-run",
    kind: "boolean",
    description: "Validate and preview the document without sending anything.",
  },
];

export const COMMAND_SPECS: readonly CommandSpec[] = [
  {
    name: "doctor",
    words: ["doctor"],
    summary: "Check configuration, reachability, and credentials. Read-only.",
    usage: "syndroo doctor [--base-url <url>] [--json]",
    minPositionals: 0,
    maxPositionals: 0,
    flags: ["base-url"],
  },
  {
    name: "posts.validate",
    words: ["posts", "validate"],
    summary: "Validate a post document and print the preview. Sends nothing.",
    usage: "syndroo posts validate [--file <path>] [--json]",
    minPositionals: 0,
    maxPositionals: 0,
    flags: ["file"],
  },
  {
    name: "posts.create",
    words: ["posts", "create"],
    summary: "Submit one post document. Returns an acceptance receipt, not a delivery.",
    usage:
      "syndroo posts create [--file <path>] [--idempotency-key <key>] [--yes] [--dry-run] [--json]",
    minPositionals: 0,
    maxPositionals: 0,
    flags: ["file", "idempotency-key", "yes", "dry-run"],
  },
  {
    name: "posts.list",
    words: ["posts", "list"],
    summary: "List recent posts, newest first.",
    usage: "syndroo posts list [--limit <n>] [--json]",
    minPositionals: 0,
    maxPositionals: 0,
    flags: ["limit"],
  },
  {
    name: "posts.get",
    words: ["posts", "get"],
    summary: "Read one post with its publications.",
    usage: "syndroo posts get <post-id> [--json]",
    minPositionals: 1,
    maxPositionals: 1,
    flags: [],
  },
  {
    name: "posts.wait",
    words: ["posts", "wait"],
    summary: "Read one post until it reaches a terminal status or the budget runs out.",
    usage: "syndroo posts wait <post-id> [--timeout <duration>] [--json]",
    minPositionals: 1,
    maxPositionals: 1,
    flags: ["timeout"],
  },
  {
    name: "skill.path",
    words: ["skill", "path"],
    summary: "Print the absolute path of the bundled Syndroo Skill directory.",
    usage: "syndroo skill path [--json]",
    minPositionals: 0,
    maxPositionals: 0,
    flags: [],
  },
];

export const SPECIAL_COMMANDS: readonly CommandSpec[] = [
  {
    name: "help",
    words: ["help"],
    summary: "Print this help.",
    usage: "syndroo help",
    minPositionals: 0,
    maxPositionals: 0,
    flags: [],
  },
  {
    name: "version",
    words: ["version"],
    summary: "Print the CLI version.",
    usage: "syndroo version",
    minPositionals: 0,
    maxPositionals: 0,
    flags: [],
  },
];

export interface ParsedCommand {
  readonly command: string;
  readonly spec: CommandSpec;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
  readonly help: boolean;
}

const ALL_SPECS: readonly CommandSpec[] = [...COMMAND_SPECS, ...SPECIAL_COMMANDS];

const ALL_FLAGS: readonly FlagDefinition[] = [...GLOBAL_FLAGS, ...COMMAND_FLAGS];

/** Cheap pre-parse check so even a parse failure can honor `--json`. */
export function wantsJson(argv: readonly string[]): boolean {
  return argv.some(token => token === "--json" || token.startsWith("--json="));
}

/**
 * Hand-written parser. The surface is small and fixed, and avoiding a
 * dependency keeps the published CLI at exactly one runtime dependency: the SDK.
 */
export function parseArgs(argv: readonly string[]): ParsedCommand {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;

    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);
    const definition = ALL_FLAGS.find(flag => flag.name === name);

    if (definition === undefined) {
      throw usageError(`Unknown flag "${token}".`, { flag: name });
    }

    if (definition.kind === "boolean") {
      if (inlineValue !== undefined) {
        throw usageError(`--${name} does not take a value.`);
      }

      flags.set(name, true);
      continue;
    }

    let value = inlineValue;

    if (value === undefined) {
      const next = argv[index + 1];

      if (next === undefined || next.startsWith("--")) {
        throw usageError(`--${name} requires a value.`);
      }

      value = next;
      index += 1;
    }

    if (value.length === 0) {
      throw usageError(`--${name} requires a value.`);
    }

    flags.set(name, value);
  }

  const spec = resolveSpec(positionals);
  const rest = positionals.slice(spec.words.length);
  const allowed = new Set([...GLOBAL_FLAGS.map(flag => flag.name), ...spec.flags]);

  for (const name of flags.keys()) {
    if (!allowed.has(name)) {
      throw usageError(
        `--${name} is not accepted by "${spec.words.join(" ")}". Run \`${spec.usage}\` for the accepted flags.`,
      );
    }
  }

  if (rest.length < spec.minPositionals || rest.length > spec.maxPositionals) {
    throw usageError(
      `"${spec.words.join(" ")}" expects ${
        spec.minPositionals === spec.maxPositionals
          ? `${spec.minPositionals} argument${spec.minPositionals === 1 ? "" : "s"}`
          : `${spec.minPositionals}-${spec.maxPositionals} arguments`
      }; received ${rest.length}.`,
      { usage: spec.usage },
    );
  }

  return {
    command: spec.name,
    spec,
    positionals: rest,
    flags,
    help: flags.get("help") === true,
  };
}

function resolveSpec(positionals: readonly string[]): CommandSpec {
  const [first] = positionals;

  if (first === undefined) {
    throw usageError("No command given. Run `syndroo help`.", {
      usage: "syndroo <command> [options]",
    });
  }

  const exact = ALL_SPECS.find(
    spec => spec.words.length === 1 && spec.words[0] === first,
  );

  if (exact !== undefined) {
    return exact;
  }

  const nested = ALL_SPECS.filter(
    spec => spec.words.length > 1 && spec.words[0] === first,
  );

  if (nested.length === 0) {
    throw usageError(`Unknown command "${first}". Run \`syndroo help\`.`, {
      command: first,
    });
  }

  const second = positionals[1];
  const match = nested.find(spec => spec.words[1] === second);

  if (match === undefined) {
    throw usageError(
      `Unknown command "${first} ${second ?? ""}". Expected ${nested
        .map(spec => `"${spec.words.join(" ")}"`)
        .join(", ")}.`,
      { command: `${first} ${second ?? ""}`.trim() },
    );
  }

  return match;
}
