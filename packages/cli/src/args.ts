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
  /**
   * A local command. Local commands are stricter than the legacy remote ones:
   * a repeated flag is refused and a parse error never repeats a user value.
   */
  readonly local?: boolean;
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

/**
 * Flags that only the local command surface accepts.
 *
 * None of them selects an endpoint, a credential value, or a fallback route.
 */
export const LOCAL_FLAGS: readonly FlagDefinition[] = [
  {
    name: "local",
    kind: "boolean",
    description: "Use the local (no server) path.",
  },
  {
    name: "no-input",
    kind: "boolean",
    description: "Never prompt. A write also needs --yes.",
  },
  {
    name: "state-home",
    kind: "value",
    description: "Local state directory. Overrides XDG_STATE_HOME.",
    placeholder: "<path>",
  },
  {
    name: "namespace",
    kind: "value",
    description: "Namespace for local deduplication.",
    placeholder: "<name>",
  },
  {
    name: "from-env",
    kind: "boolean",
    description: "Read the whole credential group from the fixed environment variables.",
  },
  {
    name: "credential-file",
    kind: "value",
    description: "Read the whole credential group from a strict JSON file.",
    placeholder: "<path>",
  },
  {
    name: "expect-account",
    kind: "value",
    description: "Stable account id the operator already verified.",
    placeholder: "<id>",
  },
  {
    name: "verify",
    kind: "boolean",
    description: "Re-check the bound identity. Uses the network; changes nothing.",
  },
  {
    name: "input",
    kind: "value",
    description: "Local publish document path, or `-` for stdin.",
    placeholder: "<path>",
  },
  {
    name: "plan",
    kind: "value",
    description: "Frozen local plan id to execute.",
    placeholder: "<plan-id>",
  },
  {
    name: "to",
    kind: "value",
    description: "Explicit retry targets, comma separated.",
    placeholder: "<csv>",
  },
  {
    name: "confirm-no-writers",
    kind: "boolean",
    description: "Confirm every other writer has stopped.",
  },
];

export const COMMAND_SPECS: readonly CommandSpec[] = [
  {
    name: "doctor",
    words: ["doctor"],
    summary: "Check configuration, reachability, and credentials. Read-only.",
    usage:
      "syndroo doctor [--base-url <url>] [--json]  |  syndroo doctor --local [--state-home <path>] [--json]",
    minPositionals: 0,
    maxPositionals: 0,
    flags: ["base-url", "local", "state-home", "namespace"],
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
  {
    name: "init",
    words: ["init"],
    summary: "Create the local config and state. Safe to repeat with the same namespace.",
    usage:
      "syndroo init [--namespace <name>] [--state-home <path>] [--json]",
    minPositionals: 0,
    maxPositionals: 0,
    flags: ["namespace", "state-home"],
    local: true,
  },
  {
    name: "providers.list",
    words: ["providers", "list"],
    summary: "List the local providers, their maturity, and their availability.",
    usage: "syndroo providers list [--state-home <path>] [--json]",
    minPositionals: 0,
    maxPositionals: 0,
    flags: ["state-home"],
    local: true,
  },
  {
    name: "auth.set",
    words: ["auth", "set"],
    summary: "Verify one local account and register its credential reference.",
    usage:
      "syndroo auth set <provider> --local (--from-env | --credential-file <path>) [--expect-account <id>] [--yes] [--no-input] [--state-home <path>] [--json]",
    minPositionals: 1,
    maxPositionals: 1,
    flags: [
      "local",
      "from-env",
      "credential-file",
      "expect-account",
      "yes",
      "no-input",
      "timeout",
      "state-home",
    ],
    local: true,
  },
  {
    name: "auth.status",
    words: ["auth", "status"],
    summary:
      "Show the local account bindings. Offline by default; --verify adds an identity check.",
    usage:
      "syndroo auth status [<provider>] --local [--verify] [--state-home <path>] [--json]",
    minPositionals: 0,
    maxPositionals: 1,
    flags: ["local", "verify", "no-input", "timeout", "state-home"],
    local: true,
  },
  {
    name: "auth.remove",
    words: ["auth", "remove"],
    summary: "Remove one local binding. Writes a tombstone; never revokes a remote token.",
    usage:
      "syndroo auth remove <provider> --local [--expect-account <id>] [--yes] [--no-input] [--state-home <path>] [--json]",
    minPositionals: 1,
    maxPositionals: 1,
    flags: ["local", "expect-account", "yes", "no-input", "state-home"],
    local: true,
  },
  {
    name: "publish",
    words: ["publish"],
    summary: "Preview a local publish plan, or execute one frozen plan.",
    usage:
      "syndroo publish (--input <path|-> --dry-run | --plan <plan-id>) [--yes] [--no-input] [--timeout <duration>] [--state-home <path>] [--namespace <name>] [--json]",
    minPositionals: 0,
    maxPositionals: 0,
    flags: [
      "input",
      "plan",
      "dry-run",
      "yes",
      "no-input",
      "timeout",
      "state-home",
      "namespace",
    ],
    local: true,
  },
  {
    name: "retry",
    words: ["retry"],
    summary: "Preview a safe explicit retry plan, or execute one frozen retry plan.",
    usage:
      "syndroo retry (<operation-id> --to <csv> --dry-run | --plan <plan-id>) [--yes] [--no-input] [--timeout <duration>] [--state-home <path>] [--namespace <name>] [--json]",
    minPositionals: 0,
    maxPositionals: 1,
    flags: [
      "plan",
      "to",
      "dry-run",
      "yes",
      "no-input",
      "timeout",
      "state-home",
      "namespace",
    ],
    local: true,
  },
  {
    name: "receipts.list",
    words: ["receipts", "list"],
    summary: "List recent local operations, newest first.",
    usage:
      "syndroo receipts list [--limit <1-100>] [--namespace <name>] [--state-home <path>] [--json]",
    minPositionals: 0,
    maxPositionals: 0,
    flags: ["limit", "namespace", "state-home"],
    local: true,
  },
  {
    name: "receipts.show",
    words: ["receipts", "show"],
    summary: "Show one local operation and its authoritative per-target records.",
    usage:
      "syndroo receipts show <operation-id> [--namespace <name>] [--state-home <path>] [--json]",
    minPositionals: 1,
    maxPositionals: 1,
    flags: ["namespace", "state-home"],
    local: true,
  },
  {
    name: "state.inspect",
    words: ["state", "inspect"],
    summary: "Inspect local state: lock, versions, and defects. Never repairs.",
    usage: "syndroo state inspect [--state-home <path>] [--json]",
    minPositionals: 0,
    maxPositionals: 0,
    flags: ["state-home"],
    local: true,
  },
  {
    name: "state.recover",
    words: ["state", "recover"],
    summary: "Recover local state after every writer has stopped.",
    usage:
      "syndroo state recover --confirm-no-writers --yes [--state-home <path>] [--json]",
    minPositionals: 0,
    maxPositionals: 0,
    flags: ["confirm-no-writers", "yes", "state-home"],
    local: true,
  },
];

/**
 * Commands that are resolved but never advertised.
 *
 * `auth connect --local` exists only to answer an explicit local OAuth request
 * with `LOCAL_OAUTH_UNAVAILABLE`; it must not look like a capability in help.
 */
export const HIDDEN_COMMAND_SPECS: readonly CommandSpec[] = [
  {
    name: "auth.connect",
    words: ["auth", "connect"],
    summary: "Not available in this version; answers with LOCAL_OAUTH_UNAVAILABLE.",
    usage: "syndroo auth connect --local [--json]",
    minPositionals: 0,
    maxPositionals: 0,
    flags: ["local", "no-input", "state-home"],
    local: true,
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

const ALL_SPECS: readonly CommandSpec[] = [
  ...COMMAND_SPECS,
  ...HIDDEN_COMMAND_SPECS,
  ...SPECIAL_COMMANDS,
];

const ALL_FLAGS: readonly FlagDefinition[] = [
  ...GLOBAL_FLAGS,
  ...COMMAND_FLAGS,
  ...LOCAL_FLAGS,
];

/** Accepted by every local command, whatever the spec already lists. */
const LOCAL_GLOBAL_FLAG_NAMES: readonly string[] = ["no-input"];

/** Local command word prefixes, longest match first for `detectLocalCommand`. */
const LOCAL_COMMAND_WORDS: readonly (readonly string[])[] = [
  ["init"],
  ["providers", "list"],
  ["auth", "set"],
  ["auth", "status"],
  ["auth", "remove"],
  ["auth", "connect"],
  ["publish"],
  ["retry"],
  ["receipts", "list"],
  ["receipts", "show"],
  ["state", "inspect"],
  ["state", "recover"],
];

/** Non-flag words of an argv, skipping the value of a known value flag. */
function positionalWords(argv: readonly string[]): readonly string[] {
  const words: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;

    if (token === "--") {
      words.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("--")) {
      words.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const definition = ALL_FLAGS.find(flag => flag.name === name);

    if (definition?.kind === "value" && equals === -1) {
      index += 1;
    }
  }

  return words;
}

/**
 * The canonical local command this argv is about, if any.
 *
 * This runs before parsing on purpose: a parse failure still has to produce the
 * local envelope and must not repeat a user-supplied value back to the caller.
 * `doctor` is local only when `--local` is present; a bare `doctor` stays the
 * legacy remote command.
 */
export function detectLocalCommand(
  argv: readonly string[],
): string | undefined {
  const words = positionalWords(argv);

  if (words[0] === "doctor") {
    return argv.some(
      token => token === "--local" || token.startsWith("--local="),
    )
      ? "doctor"
      : undefined;
  }

  let best: readonly string[] | undefined;

  for (const candidate of LOCAL_COMMAND_WORDS) {
    if (
      candidate.length <= words.length &&
      candidate.every((word, position) => words[position] === word)
    ) {
      if (best === undefined || candidate.length > best.length) {
        best = candidate;
      }
    }
  }

  return best?.join(".");
}

/** Cheap pre-parse check so even a parse failure can honor `--json`. */
export function wantsJson(argv: readonly string[]): boolean {
  return argv.some(token => token === "--json" || token.startsWith("--json="));
}

/**
 * Hand-written parser. The surface is small and fixed, and avoiding a
 * dependency keeps the published CLI free of a parser package; the release
 * bundle owns the runtime dependency graph.
 */
export function parseArgs(argv: readonly string[]): ParsedCommand {
  const localHint = detectLocalCommand(argv);
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const repeated = new Set<string>();

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
      // A local parse error never repeats an argument: an unknown name could
      // itself be a secret (`--sk-live-...`), so only the allowlisted flag
      // names below are ever echoed.
      if (localHint !== undefined) {
        throw usageError(
          `Unknown flag. Run \`syndroo ${localHint} --help\` for the accepted flags.`,
        );
      }

      throw usageError(`Unknown flag "${token}".`, { flag: name });
    }

    if (definition.kind === "boolean") {
      if (inlineValue !== undefined) {
        throw usageError(`--${name} does not take a value.`);
      }

      if (flags.has(name)) {
        repeated.add(name);
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

    if (flags.has(name)) {
      repeated.add(name);
    }

    flags.set(name, value);
  }

  const spec = resolveSpec(positionals);
  const rest = positionals.slice(spec.words.length);
  const localMode =
    spec.local === true ||
    (spec.name === "doctor" && flags.get("local") === true);

  const allowed = new Set([
    ...GLOBAL_FLAGS.map(flag => flag.name),
    ...spec.flags,
    // Every new local command accepts `--no-input`; the legacy surface does
    // not change.
    ...(localMode ? LOCAL_GLOBAL_FLAG_NAMES : []),
  ]);

  if (localMode) {
    for (const name of repeated) {
      throw usageError(
        `--${name} may only be given once on a local command.`,
        { flag: name },
      );
    }
  }

  for (const name of flags.keys()) {
    if (!allowed.has(name)) {
      throw usageError(
        `--${name} is not accepted by "${spec.words.join(" ")}". Run \`${spec.usage}\` for the accepted flags.`,
      );
    }
  }

  // A local `--help` needs no operands: the help text is the answer. Unknown
  // and duplicate flags were already refused above, and the legacy surface
  // keeps its original requirement.
  const helpOnly = localMode && flags.get("help") === true;

  if (
    !helpOnly &&
    (rest.length < spec.minPositionals || rest.length > spec.maxPositionals)
  ) {
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
