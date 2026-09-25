import type { LocalProvider, LocalProviderId } from "@syndroo/core";

import { EXIT_CODE } from "../../exit-codes.js";
import {
  localProviders,
  type LocalRunOverrides,
} from "../../local/composition.js";
import type { CommandContext } from "../context.js";
import type { LocalCommandOutcome } from "./shared.js";

const ORDER: readonly LocalProviderId[] = ["bluesky", "threads"];

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

  const providers: Readonly<Record<LocalProviderId, LocalProvider>> =
    await localProviders(overrides);
  const list = ORDER.map(id => providers[id].describe());

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
