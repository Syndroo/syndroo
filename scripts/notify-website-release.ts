/**
 * Dispatches the `syndroo-release` event to `Syndroo/syndroo-web` after a
 * successful stable npm release train.
 *
 * This script is deliberately one-shot: a repository_dispatch POST is not
 * idempotent, so a timeout or an ambiguous response is never retried here. The
 * workflow gates the step on a successful publish and the stable `latest`
 * dist-tag; a later publish rerun dispatches the same tag and SHA again.
 *
 * The dispatch token is read from `SYNDROO_WEB_DISPATCH_TOKEN` and is used only
 * for the HTTP request. The `git` child process that resolves the checked-out
 * HEAD gets a copy of the environment with that variable removed. Nothing from
 * the response body is logged, so a provider error cannot echo credentials.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DISPATCH_URL =
  "https://api.github.com/repos/Syndroo/syndroo-web/dispatches";
export const DISPATCH_EVENT = "syndroo-release";
export const TOKEN_ENV = "SYNDROO_WEB_DISPATCH_TOKEN";
export const VERSION_ENV = "SYNDROO_RELEASE_VERSION";

const STABLE_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const FULL_LOWERCASE_SHA = /^[0-9a-f]{40}$/u;

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type DispatchPayload = {
  readonly event_type: typeof DISPATCH_EVENT;
  readonly client_payload: {
    readonly tag: string;
    readonly sha: string;
  };
};

/** Reject anything that is not a stable `major.minor.patch` version. */
export function parseStableVersion(value: string): string {
  if (!STABLE_SEMVER.test(value)) {
    throw new Error(
      `Expected a stable semver version such as 0.8.0, received ${JSON.stringify(value)}.`,
    );
  }

  return value;
}

/** Reject abbreviated, uppercase, or otherwise malformed commit IDs. */
export function parseFullSha(value: string): string {
  if (!FULL_LOWERCASE_SHA.test(value)) {
    throw new Error(
      `Expected a full lowercase 40-character commit SHA, received ${JSON.stringify(value)}.`,
    );
  }

  return value;
}

export function buildDispatchPayload(
  version: string,
  sha: string,
): DispatchPayload {
  const stableVersion = parseStableVersion(version);
  const fullSha = parseFullSha(sha);

  return {
    event_type: DISPATCH_EVENT,
    client_payload: {
      tag: `v${stableVersion}`,
      sha: fullSha,
    },
  };
}

/**
 * Resolve the commit that is actually checked out. The token environment
 * variable is removed before spawning git: only this process may hold it.
 */
export function readCheckedOutHead(options: {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
} = {}): string {
  const env = { ...(options.env ?? process.env) };
  delete env[TOKEN_ENV];

  let output: string;
  try {
    output = execFileSync("git", ["rev-parse", "HEAD"], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Unable to read the checked-out HEAD with git.");
  }

  return parseFullSha(output.trim());
}

/**
 * Send exactly one repository_dispatch POST. Only HTTP 204 is success; any
 * other status fails without reading or logging the response body.
 */
export async function notifyWebsiteRelease(options: {
  readonly token: string;
  readonly version: string;
  readonly sha: string;
  readonly fetchImpl?: FetchLike;
}): Promise<void> {
  if (options.token.length === 0) {
    throw new Error(
      `${TOKEN_ENV} is required to dispatch ${DISPATCH_EVENT} to Syndroo/syndroo-web.`,
    );
  }

  const payload = buildDispatchPayload(options.version, options.sha);
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(DISPATCH_URL, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(payload),
      // Bound the one POST and refuse redirects: a redirected POST could send
      // the dispatch body somewhere other than the fixed GitHub endpoint.
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
  } catch {
    throw new Error(
      `GitHub repository_dispatch to Syndroo/syndroo-web failed or timed out before a response was received.`,
    );
  }

  if (response.status !== 204) {
    await response.body?.cancel();
    throw new Error(
      `GitHub repository_dispatch to Syndroo/syndroo-web failed with HTTP ${String(response.status)}.`,
    );
  }

  console.log(
    `Dispatched ${DISPATCH_EVENT} for ${payload.client_payload.tag} at ${payload.client_payload.sha}.`,
  );
}

/**
 * Read the workflow inputs from the environment, resolve HEAD, and dispatch.
 * Kept separate from `main` so tests can provide a fake fetch and a fixed SHA.
 */
export async function notifyFromEnvironment(
  env: NodeJS.ProcessEnv,
  options: {
    readonly cwd?: string;
    readonly headSha?: string;
    readonly fetchImpl?: FetchLike;
  } = {},
): Promise<void> {
  const token = env[TOKEN_ENV];
  if (token === undefined || token.length === 0) {
    throw new Error(
      `${TOKEN_ENV} is required to dispatch ${DISPATCH_EVENT} to Syndroo/syndroo-web.`,
    );
  }

  const version = parseStableVersion(env[VERSION_ENV] ?? "");
  const sha = parseFullSha(
    options.headSha ?? readCheckedOutHead({
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env,
    }),
  );

  await notifyWebsiteRelease({
    token,
    version,
    sha,
    ...(options.fetchImpl === undefined
      ? {}
      : { fetchImpl: options.fetchImpl }),
  });
}

async function main(): Promise<void> {
  await notifyFromEnvironment(process.env);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
