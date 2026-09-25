import { EXIT_CODE } from "../../exit-codes.js";
import type { LocalRunOverrides } from "../../local/composition.js";
import {
  initLocalConfig,
  localConfigPath,
  resolveStateHome,
} from "../../local/config.js";
import {
  createLocalFileStore,
  withLocalWriteLock,
} from "../../local/state/store.js";
import { flagValue, type CommandContext } from "../context.js";
import type { LocalCommandOutcome } from "./shared.js";

/**
 * `syndroo init` — create the local config and state.
 *
 * The config is written first and the state directories are created under the
 * global lock. Repeating `init` with the same namespace is a no-op; a different
 * namespace is refused rather than silently starting a second deduplication
 * domain.
 */
export async function runInit(
  context: CommandContext,
  overrides: LocalRunOverrides = {},
): Promise<LocalCommandOutcome> {
  const env = context.io.env;
  const clock = overrides.clock ?? (() => new Date());
  const stateHome = resolveStateHome(
    env,
    flagValue(context, "state-home"),
    context.io.cwd,
  );
  const configPath = localConfigPath(env);
  const requested = flagValue(context, "namespace");

  const initialized = await withLocalWriteLock(stateHome, async () => {
    const created = await initLocalConfig(requested, env);
    const store = createLocalFileStore(stateHome, { now: clock });

    await store.initialize();

    return created;
  });

  return {
    ok: true,
    result: {
      schemaVersion: 1,
      namespace: initialized.config.namespace,
      configPath,
      stateHome,
    },
    human: [
      "syndroo init",
      `  namespace  ${initialized.config.namespace}`,
      `  config     ${configPath}`,
      `  state      ${stateHome}`,
      `  created    ${initialized.created ? "yes" : "no (already present)"}`,
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}
