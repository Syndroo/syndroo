import {
  COMMAND_FLAGS,
  COMMAND_SPECS,
  GLOBAL_FLAGS,
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
    ...CONFIG_HELP,
    "",
    ...EXIT_CODE_HELP,
  ];

  return lines.join("\n");
}

export function commandHelp(spec: CommandSpec): string {
  const accepted = [
    ...GLOBAL_FLAGS,
    ...COMMAND_FLAGS.filter(flag => spec.flags.includes(flag.name)),
  ];

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
        ) + flag.description,
    ),
    "",
    ...CONFIG_HELP,
    "",
    ...EXIT_CODE_HELP,
  ].join("\n");
}
