import type { LocalProviderId } from "@syndroo/core";

import { usageError } from "../../cli-error.js";
import { EXIT_CODE } from "../../exit-codes.js";
import {
  type LocalRunOverrides,
  localProviders,
} from "../../local/composition.js";
import { readLocalConfig, resolveStateHome } from "../../local/config.js";
import { assertSupportedRuntime } from "../../local/state/atomic.js";
import {
  createLocalFileStore,
  inspectLocalState,
} from "../../local/state/store.js";
import { flagValue, type CommandContext } from "../context.js";
import type { LocalCommandOutcome } from "./shared.js";

type CheckStatus = "ok" | "warn" | "fail";

interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail?: string;
  /** A documented envelope code when this check fails. */
  readonly code?: string;
}

const PROVIDERS: readonly LocalProviderId[] = ["bluesky", "threads"];

/**
 * `syndroo doctor --local` — read-only.
 *
 * It never creates a directory, never writes state, and never opens a socket.
 * It reports what it can see instead of claiming to prove the file system has
 * no network or sync aliasing.
 */
export async function runDoctorLocal(
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

  if (flagValue(context, "base-url") !== undefined) {
    throw usageError("--base-url is not accepted with --local");
  }

  const checks: DoctorCheck[] = [];

  try {
    assertSupportedRuntime();
    checks.push({
      name: "runtime",
      status: "ok",
      detail: `${process.platform} node ${process.versions.node}`,
    });
  } catch {
    checks.push({
      name: "runtime",
      status: "fail",
      detail: "this platform has no supported local state implementation",
      code: "LOCAL_RUNTIME_UNSUPPORTED",
    });
  }

  const config = await readLocalConfig(env).catch(() => null);

  checks.push(
    config === null
      ? {
          name: "config",
          status: "fail",
          detail: "no local config exists; run `syndroo init` first",
          code: "CONFIG",
        }
      : { name: "config", status: "ok", detail: `namespace ${config.namespace}` },
  );

  const inspection = await inspectLocalState(stateHome);

  checks.push(
    !inspection.exists
      ? {
          name: "state",
          status: "fail",
          detail: "no local state directory exists; run `syndroo init` first",
          code: "STATE_CORRUPT",
        }
      : inspection.safe
        ? { name: "state", status: "ok", detail: "controlled directory" }
        : {
            name: "state",
            status: "fail",
            detail: "the state directory is not safe to use",
            code: "STATE_CORRUPT",
          },
  );

  if (inspection.corrupt.length > 0) {
    checks.push({
      name: "state-integrity",
      status: "fail",
      detail: `${inspection.corrupt.length} unreadable or unsafe record(s)`,
      code: "STATE_CORRUPT",
    });
  } else if (inspection.exists) {
    checks.push({ name: "state-integrity", status: "ok" });
  }

  checks.push(
    inspection.lock.held
      ? {
          name: "write-lock",
          status: "warn",
          detail: "another local writer appears to hold the write lock",
        }
      : { name: "write-lock", status: "ok", detail: "not held" },
  );

  if (inspection.recoveryGuard) {
    checks.push({
      name: "recovery-guard",
      status: "fail",
      detail: "a recovery guard is present; finish or recover that state first",
      code: "STATE_CORRUPT",
    });
  }

  const providers = await localProviders(overrides);

  for (const provider of PROVIDERS) {
    const description = providers[provider].describe();

    checks.push({
      name: `provider ${provider}`,
      status: description.localPublish ? "ok" : "fail",
      detail: description.maturity,
    });
  }

  if (inspection.exists && inspection.safe) {
    const store = createLocalFileStore(stateHome, { now: clock });

    for (const provider of PROVIDERS) {
      try {
        const connection = await store.getConnection(provider);

        checks.push(
          connection === null || connection.removed
            ? {
                name: `binding ${provider}`,
                status: "warn",
                detail: "no active local binding",
              }
            : {
                name: `binding ${provider}`,
                status: "ok",
                detail: `${connection.target.targetId} revision ${connection.target.bindingRevision}`,
              },
        );
      } catch {
        checks.push({
          name: `binding ${provider}`,
          status: "fail",
          detail: "the binding record could not be read",
          code: "STATE_CORRUPT",
        });
      }
    }
  }

  const failed = checks.some(check => check.status === "fail");
  const firstFailure = checks.find(check => check.status === "fail");

  return {
    ok: !failed,
    result: {
      runtime: `${process.platform} node ${process.versions.node}`,
      statePath: stateHome,
      checks,
    },
    human: [
      "syndroo doctor --local",
      ...checks.map(
        check =>
          `  ${check.status.padEnd(4)} ${check.name}${
            check.detail === undefined ? "" : ` - ${check.detail}`
          }`,
      ),
    ],
    exitCode: failed ? EXIT_CODE.FAILURE : EXIT_CODE.SUCCESS,
    ...(failed
      ? {
          error: {
            code: firstFailure?.code ?? "STATE_CORRUPT",
            message:
              firstFailure?.detail ?? "the local doctor found a problem",
          },
        }
      : {}),
  };
}
