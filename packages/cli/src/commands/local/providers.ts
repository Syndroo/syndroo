import type { LocalProvider, LocalProviderId } from "@syndroo/core";

import { EXIT_CODE } from "../../exit-codes.js";
import {
  localProviders,
  type LocalRunOverrides,
} from "../../local/composition.js";
import type { CommandContext } from "../context.js";
import type { LocalCommandOutcome } from "./shared.js";

const ORDER: readonly LocalProviderId[] = [
  "bluesky",
  "threads",
  "linkedin",
  "mastodon",
  "devto",
];

/**
 * `syndroo providers list` — read-only and offline.
 *
 * It reports what this build can do locally, never what a server is configured
 * for. Constructing the providers opens no socket.
 */
export async function runProvidersList(
  context: CommandContext,
  overrides: LocalRunOverrides = {},
): Promise<LocalCommandOutcome> {
  void context;

  const providers: Readonly<
    Partial<Record<LocalProviderId, LocalProvider>>
  > = await localProviders(overrides);
  // A provider this build does not register is not listed as available.
  const list = ORDER.flatMap(id => {
    const provider = providers[id];

    return provider === undefined ? [] : [provider.describe()];
  });

  return {
    ok: true,
    result: { providers: list },
    human: [
      "syndroo providers list",
      ...list.map(
        description =>
          `  ${description.provider.padEnd(8)} ${description.maturity}${
            description.localPublish ? " local" : ""
          }`,
      ),
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}
