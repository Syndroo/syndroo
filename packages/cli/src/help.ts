import {
  COMMAND_FLAGS,
  COMMAND_SPECS,
  GLOBAL_FLAGS,
  LOCAL_FLAGS,
  type CommandSpec,
} from "./args.js";
import { cliVersion } from "./version.js";

const EXIT_CODE_HELP: readonly string[] = [
  "Exit codes",
  "  0   the command finished; for `posts create` this means accepted, not delivered",
  "  1   the command failed",
  "  2   usage, configuration, or post-document problem (nothing was sent)",
  "  3   `posts wait` reached its deadline; the post still exists",
  "  4   a write may have reached Syndroo and no result is known",
  "  5   the preview was declined (nothing was sent)",
  "  6   the post ended without full delivery (`failed` or `partial`)",
  "  130 the local process stopped on a signal; server-side work was not cancelled",
];

const CONFIG_HELP: readonly string[] = [
  "Configuration",
  "  SYNDROO_BASE_URL   origin of a deployed Syndroo instance, for example https://syndroo.example.com",
  "  SYNDROO_API_KEY    instance API key, sent only as a Bearer header and never printed",
  "",
  "The CLI reads only these environment variables and the flags above. It never reads",
  ".env, .dev.vars, or a configuration file, and it never writes a shell profile.",
];

/** The local commands never read the remote environment or the remote flags. */
const LOCAL_CONFIG_HELP: readonly string[] = [
  "Local configuration",
  "  XDG_CONFIG_HOME    overrides $HOME/.config; the file is <base>/syndroo/config.json",
  "  XDG_STATE_HOME     overrides $HOME/.local/state; the state lives in <base>/syndroo",
  "",
  "A local command never reads SYNDROO_BASE_URL, never falls back to a server, and",
  "never reads .env or a shell profile.",
];

const LOCAL_EXIT_CODE_HELP: readonly string[] = [
  "Exit codes (local)",
  "  0   a preview wrote its plan, a query read successfully, or a run fully succeeded",
  "  1   local I/O or runtime failure; a trusted success that could not be persisted also exits 1",
  "  2   admission failure: usage, config, document, confirmation, or binding; no content request",
  "  4   an unknown platform write result; stop and read the receipt before retrying",
  "  5   the operator declined before any content request",
  "  6   the run ended without full delivery",
  "  130 the local process stopped on a signal; an in-flight write is not cancelled",
];

/**
 * Local wording for flags the legacy surface describes differently.
 *
 * The legacy descriptions stay untouched for the remote commands; a local
 * command must not imply that `--yes` needs an idempotency key or that a local
 * `--dry-run` sends a request.
 */
const LOCAL_FLAG_HELP: Readonly<Record<string, string>> = {
  json: "Write exactly one local envelope object to stdout; diagnostics go to stderr.",
  yes: "Confirm without prompting. A non-interactive run also needs --no-input.",
  "dry-run":
    "Preview only: freeze and save a local plan. Nothing is sent to a platform.",
  timeout:
    "Command budget, for example 120s or 15000ms. Default 120s, maximum 600s.",
  limit: "Maximum local operations to list, 1-100. Default 20.",
};

export function generalHelp(): string {
  const commandLabels = COMMAND_SPECS.map(spec =>
    spec.usage.replace(/^syndroo /u, ""),
  );
  const labelWidth = Math.max(...commandLabels.map(label => label.length)) + 2;
  const lines: string[] = [
    `syndroo ${cliVersion()} - talk to one deployed Syndroo instance`,
    "",
    "Usage",
    "  syndroo <command> [options]",
    "",
    "Commands",
    ...COMMAND_SPECS.map(
      (spec, index) =>
        `  ${(commandLabels[index] as string).padEnd(labelWidth)}${spec.summary}`,
    ),
    "  help / version",
    "",
    "Global options",
    ...GLOBAL_FLAGS.map(
      flag =>
        `  --${flag.name}${flag.placeholder === undefined ? "" : " " + flag.placeholder}`.padEnd(
          24,
        ) + flag.description,
    ),
    "",
    "Local options",
    ...LOCAL_FLAGS.map(
      flag =>
        `  --${flag.name}${flag.placeholder === undefined ? "" : " " + flag.placeholder}`.padEnd(
          24,
        ) + flag.description,
    ),
    "",
    ...CONFIG_HELP,
    "",
    ...EXIT_CODE_HELP,
    "",
    ...LOCAL_EXIT_CODE_HELP,
  ];

  return lines.join("\n");
}

export function commandHelp(spec: CommandSpec): string {
  const accepted = [
    ...GLOBAL_FLAGS,
    ...COMMAND_FLAGS.filter(flag => spec.flags.includes(flag.name)),
    ...LOCAL_FLAGS.filter(flag => spec.flags.includes(flag.name)),
  ];

  const describe = (name: string, fallback: string): string =>
    spec.local === true ? (LOCAL_FLAG_HELP[name] ?? fallback) : fallback;

  const config = spec.local === true ? LOCAL_CONFIG_HELP : CONFIG_HELP;
  const exitCodes =
    spec.local === true
      ? [...EXIT_CODE_HELP, "", ...LOCAL_EXIT_CODE_HELP]
      : EXIT_CODE_HELP;

  return [
    `Usage: ${spec.usage}`,
    "",
    spec.summary,
    "",
    "Options",
    ...accepted.map(
      flag =>
        `  --${flag.name}${flag.placeholder === undefined ? "" : " " + flag.placeholder}`.padEnd(
          24,
        ) + describe(flag.name, flag.description),
    ),
    "",
    ...config,
    "",
    ...exitCodes,
  ].join("\n");
}
