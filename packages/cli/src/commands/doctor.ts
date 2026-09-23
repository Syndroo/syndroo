import { SyndrooApiError, isSyndrooError, type AuthStatus } from "@syndroo/sdk";

import { CliError } from "../cli-error.js";
import { createClient } from "../client.js";
import { API_KEY_ENV, inspectConfig, resolveConfig } from "../config.js";
import { EXIT_CODE, type ExitCode } from "../exit-codes.js";
import type { CommandResult } from "../output.js";
import { cliVersion } from "../version.js";
import { flagValue, type CommandContext } from "./context.js";

const NOTES: readonly string[] = [
  "GET /health is unauthenticated, so it proves reachability only.",
  "Platform credentials live on the instance and are not exposed by this endpoint.",
  "The API key value is never printed, and no request in this command writes.",
];

/**
 * `syndroo doctor` — read-only.
 *
 * It answers three questions and refuses to guess at a fourth: is the
 * configuration complete, is the instance reachable, and does it accept this
 * key. What it cannot see (which platforms are configured) it does not claim.
 */
export async function runDoctor(context: CommandContext): Promise<CommandResult> {
  const inspection = inspectConfig(context.io.env, {
    baseUrl: flagValue(context, "base-url"),
  });

  if (inspection.problems.length > 0) {
    throw new CliError(inspection.problems.join(" "), {
      exitCode: EXIT_CODE.USAGE,
      code: "CONFIG",
      details: {
        baseUrlConfigured: inspection.baseUrl !== undefined,
        baseUrlSource: inspection.baseUrlSource ?? null,
        apiKeyConfigured: inspection.apiKeyConfigured,
      },
    });
  }

  const client = createClient(
    resolveConfig(context.io.env, { baseUrl: flagValue(context, "base-url") }),
  );
  const health = await client.health({ signal: context.io.signal });
  // Read-only readiness: the same projection `auth status` shows, never a claim
  // that an account or a publish path was verified. A deployment that predates
  // the 0.5.0 auth API is reported as unavailable rather than failing doctor.
  let readiness: AuthStatus | undefined;
  let readinessProblem: string | undefined;

  try {
    // The documented platform-optional form; the list projection is explicit.
    readiness = (await client.auth.status(undefined, {
      signal: context.io.signal,
    })) as AuthStatus;
  } catch (error) {
    // Only an old deployment that lacks the endpoint is a compatibility
    // unknown. An abort, a rejected key, a server failure, or malformed auth
    // data must never turn into a doctor success.
    if (!(error instanceof SyndrooApiError) || (error.status !== 404 && error.status !== 405)) {
      throw error;
    }

    readinessProblem = "the instance does not expose the 0.5.0 auth status endpoint";
  }

  let visiblePosts: number;

  try {
    const posts = await client.posts.list({ limit: 1, signal: context.io.signal });
    visiblePosts = posts.length;
  } catch (error) {
    // A local signal stops the command; it is not a credential verdict, and
    // every read stage must preserve it as ABORTED (exit 130).
    if (isSyndrooError(error) && error.code === "ABORTED") {
      throw error;
    }

    const detail = isSyndrooError(error) ? error.message : String(error);
    const status = error instanceof SyndrooApiError ? error.status : undefined;

    throw new CliError(
      status === 401 || status === 403
        ? `the instance rejected ${API_KEY_ENV}: ${detail}`
        : `the instance did not accept an authenticated read: ${detail}`,
      {
        exitCode: EXIT_CODE.FAILURE,
        code: status === 401 || status === 403 ? "AUTH_REJECTED" : "CREDENTIAL_CHECK_FAILED",
        details: { status: status ?? null },
        cause: error,
      },
    );
  }

  const payload: Record<string, unknown> = {
    command: "doctor",
    ok: true,
    cliVersion: cliVersion(),
    nodeVersion: process.versions.node,
    baseUrl: inspection.baseUrl,
    baseUrlSource: inspection.baseUrlSource,
    apiKeyConfigured: true,
    apiKeySource: API_KEY_ENV,
    health: { reachable: true, status: health.status },
    credentials: { checked: true, ok: true, visiblePosts },
    instance: readiness?.instance ?? null,
    platforms: readiness?.platforms ?? {},
    authReadiness: readinessProblem ?? "available",
    createRequests: 0,
    authRequests: { read: 1, write: 0 },
    notes: NOTES,
  };

  return {
    payload,
    human: [
      `syndroo doctor`,
      `  cli            ${cliVersion()} (node ${process.versions.node})`,
      `  base url       ${inspection.baseUrl} (${inspection.baseUrlSource})`,
      `  api key        configured in ${API_KEY_ENV}; the value is never printed`,
      `  health         reachable (status "${health.status}")`,
      `  credentials    accepted (${visiblePosts} post${visiblePosts === 1 ? "" : "s"} visible)`,
      `  instance       ${
        readiness === undefined
          ? `unknown (${readinessProblem})`
          : `${readiness.instance.publishingReady ? "publishing ready" : "not ready"}${
              readiness.instance.missingFields.length === 0
                ? ""
                : ` (missing ${readiness.instance.missingFields.join(", ")})`
            }`
      }`,
      ...Object.values(readiness?.platforms ?? {}).map(
        entry => `  ${entry.platform.padEnd(14)} ${entry.readiness} (revision ${entry.revision})`,
      ),
      `  writes         0`,
      ...NOTES.map(note => `  note           ${note}`),
    ],
    exitCode: EXIT_CODE.SUCCESS as ExitCode,
  };
}

/** Shared classifier so `doctor` and the write path agree on what a failure means. */
export function classifyFailure(error: unknown): {
  code: string;
  message: string;
  exitCode: ExitCode;
  viewApplied: boolean;
} {
  if (error instanceof CliError) {
    return {
      code: error.code,
      message: error.message,
      exitCode: error.exitCode,
      viewApplied: false,
    };
  }

  if (isSyndrooError(error)) {
    const applied = error.requestMayHaveBeenApplied;

    if (applied) {
      return {
        code: "AMBIGUOUS_DELIVERY",
        message: error.message,
        exitCode: EXIT_CODE.AMBIGUOUS,
        viewApplied: true,
      };
    }

    const exitCode =
      error.code === "CONFIG" || error.code === "VALIDATION"
        ? EXIT_CODE.USAGE
        : error.code === "WAIT_TIMEOUT"
          ? EXIT_CODE.WAIT_TIMEOUT
          : error.code === "ABORTED"
            ? EXIT_CODE.INTERRUPTED
            : EXIT_CODE.FAILURE;

    return { code: error.code, message: error.message, exitCode, viewApplied: false };
  }

  const message = error instanceof Error ? error.message : String(error);

  return {
    code: "UNEXPECTED",
    message,
    exitCode: EXIT_CODE.FAILURE,
    viewApplied: false,
  };
}
