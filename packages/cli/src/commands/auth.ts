/**
 * The auth, connect, and diagnostics command families.
 *
 * Nothing here re-implements the SDK: each command performs one SDK call per
 * step, reads the revision it is about to submit, and reports what it actually
 * sent. Secret material travels one way — bounded JSON from a file or stdin
 * into the SDK — and is registered with the Reporter before any downstream
 * validation, so it can never reach a stream.
 */

import { createReadStream } from "node:fs";

import type { PlatformStatus, SyndrooClient } from "@syndroo/sdk";

import { CliError } from "../cli-error.js";
import { createClient } from "../client.js";
import { resolveConfig } from "../config.js";
import { canPrompt, confirm } from "../confirm.js";
import { EXIT_CODE, type ExitCode } from "../exit-codes.js";
import type { CommandResult } from "../output.js";
import { flagValue, hasFlag, positional, type CommandContext } from "./context.js";

const SECRET_LIMIT_BYTES = 64 * 1024;
const MAX_AUTHORIZATION_URL_LENGTH = 2_048;

/** Direct credential fields, shown in previews; the SDK re-validates them. */
const CREDENTIAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  bluesky: ["identifier", "password", "host"],
  threads: ["access_token"],
  x: ["access_token", "access_token_secret"],
  tumblr: ["token", "token_secret", "blog"],
  linkedin: ["access_token", "author", "api_version", "refresh_token"],
};

interface ProviderEndpoint {
  readonly endpoint: string;
  readonly query: readonly string[];
  readonly linkedin?: true;
}

/**
 * The provider authorization endpoints this repository configures. A URL that
 * is not exactly one of these is display data the CLI refuses to print.
 */
const PROVIDER_ENDPOINTS: Readonly<Record<string, ProviderEndpoint>> = {
  x: {
    endpoint: "https://api.twitter.com/oauth/authorize",
    query: ["oauth_token"],
  },
  tumblr: {
    endpoint: "https://www.tumblr.com/oauth/authorize",
    query: ["oauth_token"],
  },
  linkedin: {
    endpoint: "https://www.linkedin.com/oauth/v2/authorization",
    query: ["response_type", "client_id", "redirect_uri", "state", "scope"],
    linkedin: true,
  },
};

interface Counts {
  read: number;
  write: number;
}

/**
 * The command's counter, published before configuration or secret work so even
 * an early invalid-input or config failure reports `{read: 0, write: 0}`.
 */
function countsFor(context: CommandContext): Counts {
  const counts: Counts = { read: 0, write: 0 };

  publishCounts(context, counts);

  return counts;
}

/** The client is created lazily: a command that never reaches the network does
 * not need configuration, and a config failure is still reported with counts. */
function open(context: CommandContext, counts: Counts): SyndrooClient {
  return createClient(
    resolveConfig(context.io.env, { baseUrl: flagValue(context, "base-url") }),
  );
}

/**
 * Keeps the reporter's failure payload in step with the counts, including the
 * zero-write cases, so a rejection can never look like a sent request.
 */
function publishCounts(context: CommandContext, counts: Counts): void {
  context.reporter.setRequestCounts({ read: counts.read, write: counts.write });
}

/**
 * A dispatched read. An already-aborted signal makes the SDK reject before it
 * fetches, so nothing is counted; an abort that arrives after dispatch keeps
 * its count, because the request really was sent.
 */
function countRead(context: CommandContext, counts: Counts): void {
  if (context.io.signal.aborted) {
    return;
  }

  counts.read += 1;
  publishCounts(context, counts);
}

/**
 * Own-property lookup. An inherited name such as `constructor` must produce a
 * safe SDK error, not the inherited member and a raw TypeError.
 */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * Counts a write only when a request could actually have been built. The SDK
 * validates before it sends, so a validation or pre-send abort error must not
 * leave a fictitious write in a reported payload.
 */
async function countedWrite<T>(
  context: CommandContext,
  counts: Counts,
  run: () => Promise<T>,
): Promise<T> {
  counts.write += 1;
  publishCounts(context, counts);

  try {
    return await run();
  } catch (error) {
    const failure = error as { code?: unknown; requestMayHaveBeenApplied?: unknown };
    const sent =
      failure.code !== "VALIDATION" &&
      failure.code !== "CONFIG" &&
      !(failure.code === "ABORTED" && failure.requestMayHaveBeenApplied === false);

    if (!sent) {
      counts.write -= 1;
      publishCounts(context, counts);
    }

    throw error;
  }
}

function requestCounts(counts: Counts): Record<string, number> {
  return { read: counts.read, write: counts.write };
}

/** A confirmation gate: `--yes`, or a real prompt; anything else writes nothing. */
function confirmationRequired(): CliError {
  return new CliError(
    "this run is not interactive, so the CLI will not wait for confirmation. Pass --yes to continue without a prompt.",
    { exitCode: EXIT_CODE.USAGE, code: "CONFIRMATION_REQUIRED" },
  );
}

function cancelled(
  command: string,
  human: readonly string[],
  payload: Record<string, unknown>,
): CommandResult {
  return {
    payload: { command, ok: false, cancelled: true, ...payload },
    human: [...human],
    exitCode: EXIT_CODE.CANCELLED as ExitCode,
  };
}

/* Secret input ------------------------------------------------------------ */

function secretInputError(message: string): CliError {
  return new CliError(message, { exitCode: EXIT_CODE.USAGE, code: "INVALID_SECRET" });
}

/** Cancelled secret input: the local process stopped, nothing was written. */
function secretAbortedError(): CliError {
  return new CliError(
    "the secret input was cancelled before it was fully read, so nothing was sent.",
    { exitCode: EXIT_CODE.INTERRUPTED, code: "ABORTED" },
  );
}

/**
 * Bounded chunk collection from a file or stdin. The limit is enforced while
 * reading, and every error is fixed: no path and no raw filesystem cause.
 */
async function collectBounded(
  source: AsyncIterable<Buffer | string>,
  signal: AbortSignal | undefined,
  dispose: () => void,
): Promise<string> {
  if (signal?.aborted === true) {
    dispose();
    throw secretAbortedError();
  }

  const iterator = source[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let total = 0;

  /**
   * Cancellation resolves immediately: a pending Node stream read can make
   * `iterator.return()` wait forever, so cleanup is synchronous disposal and
   * the abandoned promise is never awaited.
   */
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      dispose();
      reject(secretAbortedError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });

  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted]);

      if (next.done === true) {
        break;
      }

      const bytes = Buffer.from(next.value as Buffer | string);
      total += bytes.byteLength;

      if (total > SECRET_LIMIT_BYTES) {
        dispose();
        throw secretInputError(
          `the secret input exceeds ${SECRET_LIMIT_BYTES} bytes. Send only the platform credential fields.`,
        );
      }

      chunks.push(bytes);
    }
  } catch (error) {
    dispose();

    if (error instanceof CliError) {
      throw error;
    }

    throw secretInputError("the secret input could not be fully read.");
  } finally {
    if (onAbort !== undefined) {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readSecretText(context: CommandContext): Promise<string> {
  const file = flagValue(context, "file");
  const signal = context.io.signal;

  // An already-aborted command must not open a file or arm a read at all.
  if (signal.aborted) {
    throw secretAbortedError();
  }

  if (file !== undefined && file !== "-") {
    const stream = createReadStream(file);

    try {
      return await collectBounded(stream, signal, () => {
        stream.destroy();
      });
    } catch (error) {
      stream.destroy();

      if (error instanceof CliError) {
        throw error;
      }

      throw secretInputError(
        "the secret file could not be read. Check the path and its permissions.",
      );
    }
  }

  if (file === undefined && context.io.stdinIsTty) {
    throw secretInputError(
      "no secret input was given. Pipe the credential JSON on stdin or name a file with --file.",
    );
  }

  const stdin = context.io.stdin;

  try {
    return await collectBounded(stdin, signal, () => {
      // stdin is not ours to keep: stop waiting on it so the process can exit.
      stdin.pause();
      stdin.destroy();
    });
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    throw secretInputError("the secret input could not be read from stdin.");
  }
}

/**
 * Parses the secret document, registers every submitted string before any
 * further validation, and returns the parsed object. Malformed text is never
 * echoed: the error names the problem, not the input.
 */
function parseSecretDocument(
  context: CommandContext,
  text: string,
): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw secretInputError("the secret input is not valid JSON.");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw secretInputError(
      "the secret input must be a JSON object of platform credential fields.",
    );
  }

  const record = parsed as Record<string, unknown>;

  registerSecrets(context, record);

  for (const key of Object.keys(record)) {
    if (key === "expectedRevision") {
      throw secretInputError(
        "the secret input must not carry expectedRevision; the CLI reads the revision from the instance.",
      );
    }
  }

  return record;
}

/**
 * Registers every submitted string — nested or not — before any further
 * validation, so a malformed document cannot leak a value through an error.
 */
function registerSecrets(context: CommandContext, value: unknown): void {
  try {
    if (typeof value === "string") {
      context.reporter.addSecret(value);
      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        registerSecrets(context, entry);
      }

      return;
    }

    if (typeof value === "object" && value !== null) {
      for (const key of Object.keys(value)) {
        registerSecrets(context, (value as Record<string, unknown>)[key]);
      }
    }
  } catch {
    // A hostile getter cannot be read; nothing was registered for that branch.
  }
}

/** The validated, string-only credential the SDK will submit. */
function submittedCredential(
  platform: string,
  credential: Record<string, unknown>,
): Record<string, string> {
  const names = credentialFieldNames(platform, credential);
  const submitted: Record<string, string> = {};

  for (const name of names) {
    const value = credential[name];

    if (typeof value !== "string") {
      throw secretInputError(`credential ${name} must be a string.`);
    }

    submitted[name] = value;
  }

  return submitted;
}

function credentialFieldNames(
  platform: string,
  credential: Record<string, unknown>,
): string[] {
  const allowed = own(CREDENTIAL_FIELDS, platform);

  if (allowed === undefined) {
    throw secretInputError(
      "this CLI does not document direct credential fields for that platform.",
    );
  }

  for (const key of Object.keys(credential)) {
    if (!allowed.includes(key)) {
      throw secretInputError(
        "the secret input must contain only this platform's documented credential fields.",
      );
    }
  }

  return allowed.filter(name => credential[name] !== undefined);
}

/* Authorization URL ------------------------------------------------------- */

/**
 * Validates a provider authorization URL before it is displayed. It is display
 * data only: the CLI never opens a browser or a shell.
 */
function safeAuthorizationUrl(platform: string, raw: string): string {
  const spec = own(PROVIDER_ENDPOINTS, platform);

  if (spec === undefined) {
    throw new CliError(
      "this CLI does not recognize that platform's authorization endpoint, so it will not display the URL.",
      { exitCode: EXIT_CODE.FAILURE, code: "UNSAFE_AUTHORIZATION_URL" },
    );
  }

  // URL strips tabs and newlines, so the raw text is checked first: a control
  // character must never reach the terminal through the display value.
  if (
    raw.length === 0 ||
    raw.length > MAX_AUTHORIZATION_URL_LENGTH ||
    /[\u0000-\u0020\u007f]/u.test(raw)
  ) {
    throw new CliError(
      "the instance returned an authorization URL that is empty, overlong, or carries whitespace or control characters.",
      { exitCode: EXIT_CODE.FAILURE, code: "UNSAFE_AUTHORIZATION_URL" },
    );
  }

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new CliError("the instance returned an authorization URL that is not absolute.", {
      exitCode: EXIT_CODE.FAILURE,
      code: "UNSAFE_AUTHORIZATION_URL",
    });
  }

  const unsafe =
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.port !== "" ||
    `${url.origin}${url.pathname}` !== spec.endpoint;

  if (unsafe) {
    throw new CliError(
      "the instance returned an authorization URL this CLI will not display: it must be the configured HTTPS provider endpoint with no userinfo, fragment, or port.",
      { exitCode: EXIT_CODE.FAILURE, code: "UNSAFE_AUTHORIZATION_URL" },
    );
  }

  const seen = new Set<string>();

  for (const [key, value] of url.searchParams) {
    if (!spec.query.includes(key) || seen.has(key)) {
      throw new CliError(
        "the instance returned an authorization URL with unexpected or duplicate query keys.",
        { exitCode: EXIT_CODE.FAILURE, code: "UNSAFE_AUTHORIZATION_URL" },
      );
    }

    seen.add(key);

    if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new CliError(
        "the instance returned an authorization URL with an empty or control-character query value.",
        { exitCode: EXIT_CODE.FAILURE, code: "UNSAFE_AUTHORIZATION_URL" },
      );
    }
  }

  for (const key of spec.query) {
    if (!seen.has(key)) {
      throw new CliError(
        "the instance returned an authorization URL without the fields the provider requires.",
        { exitCode: EXIT_CODE.FAILURE, code: "UNSAFE_AUTHORIZATION_URL" },
      );
    }
  }

  if (spec.linkedin === true) {
    if (url.searchParams.get("response_type") !== "code") {
      throw new CliError("the LinkedIn authorization URL must use response_type=code.", {
        exitCode: EXIT_CODE.FAILURE,
        code: "UNSAFE_AUTHORIZATION_URL",
      });
    }

    const redirect = url.searchParams.get("redirect_uri") as string;
    let callback: URL;

    try {
      callback = new URL(redirect);
    } catch {
      throw new CliError(
        "the LinkedIn authorization URL must carry an absolute HTTPS callback.",
        { exitCode: EXIT_CODE.FAILURE, code: "UNSAFE_AUTHORIZATION_URL" },
      );
    }

    if (
      callback.protocol !== "https:" ||
      callback.username !== "" ||
      callback.password !== "" ||
      callback.hash !== ""
    ) {
      throw new CliError(
        "the LinkedIn callback must be an HTTPS URL without userinfo or fragment.",
        { exitCode: EXIT_CODE.FAILURE, code: "UNSAFE_AUTHORIZATION_URL" },
      );
    }
  }

  // The normalized href is what gets displayed: no raw bytes survive.
  return url.href;
}

/* Status helpers ---------------------------------------------------------- */

async function readStatus(
  context: CommandContext,
  client: SyndrooClient,
  platform: string,
  counts: Counts,
): Promise<PlatformStatus> {
  countRead(context, counts);

  return client.auth.status(platform, { signal: context.io.signal });
}

function statusLines(status: PlatformStatus): string[] {
  return [
    `  platform       ${status.platform}`,
    `  readiness      ${status.readiness}`,
    `  configured     ${status.configured}`,
    `  source         ${status.source ?? "none"}`,
    `  revision       ${status.revision}`,
    `  oauth          ${status.oauthSupported ? "supported" : "not supported"}`,
    `  missing        ${status.missingFields.join(", ") || "none"}`,
    `  expires        ${status.expiresAt ?? "unknown"}`,
    `  target         ${status.target?.label ?? "none"}`,
  ];
}

/* Commands ---------------------------------------------------------------- */

export async function runAuthStatus(context: CommandContext): Promise<CommandResult> {
  const counts = countsFor(context);
  const client = open(context, counts);
  const platform = context.parsed.positionals[0];
  const signal = context.io.signal;

  if (platform === undefined) {
    countRead(context, counts);
    const status = await client.auth.status({ signal });

    return {
      payload: {
        command: "auth.status",
        ok: true,
        instance: status.instance,
        platforms: status.platforms,
        authRequests: requestCounts(counts),
        notes: ["Local readiness only. This never verifies a real account."],
      },
      human: [
        "syndroo auth status",
        `  publishing     ${status.instance.publishingReady ? "ready" : "not ready"}`,
        `  instance       ${status.instance.missingFields.join(", ") || "nothing missing"}`,
        ...Object.values(status.platforms).flatMap(entry => [
          `${entry.platform}:`,
          ...statusLines(entry),
        ]),
      ],
      exitCode: EXIT_CODE.SUCCESS,
    };
  }

  const status = await readStatus(context, client, platform, counts);

  return {
    payload: {
      command: "auth.status",
      ok: true,
      platform: status.platform,
      status,
      authRequests: requestCounts(counts),
      notes: ["Local readiness only. This never verifies a real account."],
    },
    human: [`syndroo auth status ${status.platform}`, ...statusLines(status)],
    exitCode: EXIT_CODE.SUCCESS,
  };
}

export async function runAuthSet(context: CommandContext): Promise<CommandResult> {
  const counts = countsFor(context);
  const platform = positional(context, 0);
  const text = await readSecretText(context);
  const credential = parseSecretDocument(context, text);
  const submitted = submittedCredential(platform, credential);
  const fieldNames = Object.keys(submitted);
  const client = open(context, counts);
  const assumeYes = hasFlag(context, "yes");
  const interactive = !assumeYes && canPrompt(context);

  if (!assumeYes && !interactive) {
    throw confirmationRequired();
  }

  const status = await readStatus(context, client, platform, counts);

  context.reporter.diagnostic(
    [
      `Store credentials for ${platform}:`,
      `  revision       ${status.revision}`,
      `  fields         ${fieldNames.join(", ")}`,
      `  readiness now  ${status.readiness}`,
    ].join("\n"),
  );

  if (interactive && !confirm(context, "Store this credential? [y/N] ")) {
    context.reporter.diagnostic("Cancelled. Nothing was sent.");

    return cancelled(
      "auth.set",
      [`Not storing credentials for ${platform}.`, `  writes         0`],
      {
        platform,
        revision: status.revision,
        authRequests: requestCounts(counts),
        notes: ["The preview was declined. Nothing was sent."],
      },
    );
  }

  const receipt = await countedWrite(context, counts, () =>
    client.auth.set(platform, submitted, {
      expectedRevision: status.revision,
      signal: context.io.signal,
    }),
  );

  return {
    payload: {
      command: "auth.set",
      ok: true,
      platform: receipt.platform,
      stored: true,
      revision: receipt.revision,
      configured: receipt.configured,
      readiness: receipt.readiness,
      credentialFields: fieldNames,
      authRequests: requestCounts(counts),
    },
    human: [
      `Stored credentials for ${receipt.platform}.`,
      `  revision       ${receipt.revision}`,
      `  readiness      ${receipt.readiness}`,
      `  writes         1`,
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}

export async function runAuthConnect(context: CommandContext): Promise<CommandResult> {
  const platform = positional(context, 0);
  const counts = countsFor(context);
  const client = open(context, counts);
  const status = await readStatus(context, client, platform, counts);

  const receipt = await countedWrite(context, counts, () =>
    client.auth.connect(platform, {
      expectedRevision: status.revision,
      signal: context.io.signal,
    }),
  );
  const url = safeAuthorizationUrl(platform, receipt.url);

  return {
    payload: {
      command: "auth.connect",
      ok: true,
      platform: receipt.platform,
      operationId: receipt.operationId,
      expectedRevision: receipt.expectedRevision,
      expiresAt: receipt.expiresAt,
      authorizationUrl: url,
      authRequests: requestCounts(counts),
      notes: [
        "Open this URL yourself. The CLI never launches a browser, and the URL is not saved anywhere.",
      ],
    },
    human: [
      `Started authorization for ${receipt.platform} (operation ${receipt.operationId}).`,
      `  expires        ${receipt.expiresAt}`,
      `  revision       ${receipt.expectedRevision}`,
      `  url            ${url}`,
      `  writes         1`,
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}

export async function runAuthOperation(context: CommandContext): Promise<CommandResult> {
  const platform = positional(context, 0);
  const id = positional(context, 1);
  const counts = countsFor(context);
  const client = open(context, counts);
  countRead(context, counts);
  const status = await client.auth.operation(platform, id, {
    signal: context.io.signal,
  });

  return {
    payload: {
      command: "auth.operation",
      ok: true,
      operation: status,
      authRequests: requestCounts(counts),
      notes: ["The candidate is separate from the currently active credential."],
    },
    human: [
      `syndroo auth operation ${status.platform} ${status.operationId}`,
      `  phase          ${status.phase}`,
      `  expires        ${status.expiresAt}`,
      `  revision       ${status.expectedRevision}`,
      `  missing        ${status.missingFields.join(", ") || "none"}`,
      `  candidate      ${status.candidate?.target?.label ?? "none"}`,
      `  active         ${status.active.target?.label ?? status.active.platform}`,
      `  receipt        ${
        status.receipt === undefined
          ? "none"
          : `revision ${status.receipt.revision}${status.receipt.replayed === true ? " (replayed)" : ""}`
      }`,
      `  error code     ${status.errorCode ?? "none"}`,
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}

export async function runAuthComplete(context: CommandContext): Promise<CommandResult> {
  const platform = positional(context, 0);
  const id = positional(context, 1);
  const author = flagValue(context, "author");
  const apiVersion = flagValue(context, "api-version");
  const blog = flagValue(context, "blog");
  const target: Record<string, string> = {};

  if (author !== undefined) {
    target["author"] = author;
  }

  if (apiVersion !== undefined) {
    target["api_version"] = apiVersion;
  }

  if (blog !== undefined) {
    target["blog"] = blog;
  }

  const counts = countsFor(context);
  const client = open(context, counts);
  const assumeYes = hasFlag(context, "yes");
  const interactive = !assumeYes && canPrompt(context);

  if (!assumeYes && !interactive) {
    throw confirmationRequired();
  }

  countRead(context, counts);
  const operation = await client.auth.operation(platform, id, {
    signal: context.io.signal,
  });
  const active = await readStatus(context, client, platform, counts);
  const completing = operation.phase === "completed";

  // A live operation must still belong to the slot the operator sees; a replay
  // of a completed one keeps its historical revision.
  if (!completing && operation.expectedRevision !== active.revision) {
    throw new CliError(
      "the operation was started from a different credential revision than the one now active. Run `syndroo auth status` and start a new connect instead of completing this one.",
      {
        exitCode: EXIT_CODE.FAILURE,
        code: "AUTH_CONFLICT",
        details: {
          operationRevision: operation.expectedRevision,
          activeRevision: active.revision,
        },
      },
    );
  }

  context.reporter.diagnostic(
    [
      `Complete authorization for ${platform}:`,
      `  operation      ${operation.operationId} (${operation.phase})`,
      `  revision       ${operation.expectedRevision}${completing ? " (replayed completion)" : ""}`,
      `  candidate      ${operation.candidate?.target?.label ?? "none"}`,
      `  active         ${active.target?.label ?? active.platform}`,
      `  target         ${
        Object.entries(target)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ") || "none"
      }`,
    ].join("\n"),
  );

  if (interactive && !confirm(context, "Complete this authorization? [y/N] ")) {
    context.reporter.diagnostic("Cancelled. Nothing was sent.");

    return cancelled(
      "auth.complete",
      [`Not completing ${operation.operationId}.`, `  writes         0`],
      {
        platform,
        operationId: operation.operationId,
        revision: operation.expectedRevision,
        authRequests: requestCounts(counts),
        notes: ["The preview was declined. Nothing was sent."],
      },
    );
  }

  const receipt = await countedWrite(context, counts, () =>
    client.auth.complete(
      platform,
      id,
      {
        expectedRevision: operation.expectedRevision,
        ...(Object.keys(target).length === 0 ? {} : { target }),
      },
      { signal: context.io.signal },
    ),
  );

  return {
    payload: {
      command: "auth.complete",
      ok: true,
      platform: receipt.platform,
      operationId: receipt.operationId,
      stored: true,
      replayed: receipt.replayed === true,
      revision: receipt.revision,
      configured: receipt.configured,
      readiness: receipt.readiness,
      authRequests: requestCounts(counts),
    },
    human: [
      `Completed authorization ${receipt.operationId} for ${receipt.platform}${
        receipt.replayed === true ? " (replayed)" : ""
      }.`,
      `  revision       ${receipt.revision}`,
      `  readiness      ${receipt.readiness}`,
      `  writes         1`,
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}

export async function runAuthRefresh(context: CommandContext): Promise<CommandResult> {
  const platform = positional(context, 0);
  const counts = countsFor(context);
  const client = open(context, counts);
  const status = await readStatus(context, client, platform, counts);
  const receipt = await countedWrite(context, counts, () =>
    client.auth.refresh(platform, {
      expectedRevision: status.revision,
      signal: context.io.signal,
    }),
  );

  return {
    payload: {
      command: "auth.refresh",
      ok: true,
      platform: receipt.platform,
      refreshed: true,
      revision: receipt.revision,
      configured: receipt.configured,
      readiness: receipt.readiness,
      expiresAt: receipt.expiresAt,
      authRequests: requestCounts(counts),
      notes: ["The SDK never repeats a refresh exchange automatically."],
    },
    human: [
      `Refreshed credentials for ${receipt.platform}.`,
      `  revision       ${receipt.revision}`,
      `  expires        ${receipt.expiresAt ?? "unknown"}`,
      `  writes         1`,
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}

export async function runAuthRemove(context: CommandContext): Promise<CommandResult> {
  const platform = positional(context, 0);
  const counts = countsFor(context);
  const client = open(context, counts);
  const assumeYes = hasFlag(context, "yes");
  const interactive = !assumeYes && canPrompt(context);

  if (!assumeYes && !interactive) {
    throw confirmationRequired();
  }

  const status = await readStatus(context, client, platform, counts);

  context.reporter.diagnostic(
    [
      `Remove stored credentials for ${platform}:`,
      `  revision       ${status.revision}`,
      `  readiness now  ${status.readiness}`,
      `  target         ${status.target?.label ?? "none"}`,
    ].join("\n"),
  );

  if (interactive && !confirm(context, "Remove this credential? [y/N] ")) {
    context.reporter.diagnostic("Cancelled. Nothing was sent.");

    return cancelled(
      "auth.remove",
      [`Not removing credentials for ${platform}.`, `  writes         0`],
      {
        platform,
        revision: status.revision,
        authRequests: requestCounts(counts),
        notes: ["The preview was declined. Nothing was sent."],
      },
    );
  }

  const receipt = await countedWrite(context, counts, () =>
    client.auth.remove(platform, {
      expectedRevision: status.revision,
      signal: context.io.signal,
    }),
  );

  return {
    payload: {
      command: "auth.remove",
      ok: true,
      platform: receipt.platform,
      removed: true,
      revision: receipt.revision,
      configured: receipt.configured,
      readiness: receipt.readiness,
      authRequests: requestCounts(counts),
    },
    human: [
      `Removed credentials for ${receipt.platform}.`,
      `  revision       ${receipt.revision}`,
      `  readiness      ${receipt.readiness}`,
      `  writes         1`,
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}

export async function runDiagnostics(context: CommandContext): Promise<CommandResult> {
  const counts = countsFor(context);
  const client = open(context, counts);
  countRead(context, counts);
  const diagnostics = await client.diagnostics({ signal: context.io.signal });

  return {
    payload: {
      command: "diagnostics",
      ok: true,
      diagnostics,
      authRequests: requestCounts(counts),
      notes: ["Counts describe current rows, not lifetime totals."],
    },
    human: [
      "syndroo diagnostics",
      `  pending        ${diagnostics.pendingOutbox}`,
      `  retry          ${diagnostics.retryScheduled}`,
      `  dead lettered  ${diagnostics.deadLettered}`,
      `  oldest due     ${diagnostics.oldestDueAt ?? "none"}`,
      `  storage bytes  ${diagnostics.storage.approximateBytes ?? "unknown"}`,
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}
