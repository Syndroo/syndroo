import { parseStrictJson } from "@syndroo/core";
import type { ConnectRequest, ConnectResult, JsonObject } from "@syndroo/core";

import { EXIT_CODE } from "../exit-codes.js";
import { INTERACTIVE_READ_LIMIT_MS } from "../io.js";
import { escapeControls, renderConnect } from "../render/human.js";
import { RequestJournal, mintRequestId } from "../request-journal/journal.js";
import { OAuthError } from "../runtime/oauth/errors.js";
import {
  DEFAULT_ATTEMPT_TTL_MS,
  startLoopbackListener,
  type ArmedDraft,
  type LoopbackTarget,
  type LocalOAuthCallback,
  type RedirectTarget,
} from "../runtime/oauth/index.js";
import {
  callContext,
  isRecord,
  readJsonSource,
  usageError,
  type CommandContext,
} from "./context.js";

/** The environment variable `--from-env` reads and nothing else. */
export const CREDENTIAL_ENV = "SYNDROO_CREDENTIALS";

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_CREDENTIAL_BYTES = 65_536;

export type ConnectOptions = {
  readonly label?: string;
  readonly connection?: string;
  readonly fromEnv?: boolean;
  readonly credentialFile?: string;
  readonly update?: string;
  readonly disconnect?: string;
  readonly input?: string;
  /** Redirect URI this CLI registers with the provider; defaults to loopback. */
  readonly redirectUri?: string;
  /** A redirected URL handed back out of band: a literal URL, or `-` for stdin. */
  readonly callbackUrl?: string;
  /** Present only when `--default`/`--no-default` was actually passed. */
  readonly default?: boolean;
};

type JournalKind = "start" | "resume" | "update" | "disconnect";

/** The `input` of a resume request: a credential step or a callback step. */
type ResumeInput = Extract<ConnectRequest, { readonly type: "resume" }>["input"];

/** A bounded chain of provider steps; nothing legitimate needs more. */
const MAX_CONNECT_STEPS = 8;

/** Longest pasted callback URL accepted, matching the adapter's own bound. */
const MAX_CALLBACK_BYTES = 8_192;

/**
 * `syndroo connect` — start, resume and maintenance.
 *
 * Four entry points, each mutually exclusive:
 * `--input <file|->` reads a whole machine `ConnectRequest`;
 * `--disconnect <id>` and `--update <id>` are maintenance;
 * a provider positional starts a connection, optionally importing credentials
 * from `--credential-file` or `--from-env` and completing the credential step.
 *
 * A start that still needs input is completed interactively only when a human
 * is watching: a `credential_input` action with a controlling terminal and no
 * `--json` prompts field by field. A secret field is read with echo disabled.
 * Without a terminal, or in `--json`, the command reports `action_required`
 * and exits 0 instead of blocking.
 *
 * A provider whose connect is an OAuth redirect (`linkedin`, `threads`,
 * `mastodon`) is driven by the local callback adapter: `--redirect-uri` chooses
 * the redirect (loopback by default), a loopback redirect is received by a
 * listener this process binds, and any other redirect is completed with the URL
 * the browser landed on, taken from `--callback-url` or the pasted/stdin line.
 */
export async function runConnect(
  ctx: CommandContext,
  provider: string | undefined,
  options: ConnectOptions,
): Promise<number> {
  const journal = new RequestJournal(ctx.runtime().stateRoot);

  if (options.input !== undefined) {
    return await connectFromInput(ctx, journal, provider, options);
  }

  if (options.disconnect !== undefined) {
    rejectExtra(options, ["disconnect"]);
    if (provider !== undefined || options.label !== undefined || options.default !== undefined) {
      throw usageError("USAGE");
    }

    return await callConnect(
      ctx,
      journal,
      { type: "disconnect", connectionId: options.disconnect },
      { kind: "disconnect", targets: [options.disconnect] },
    );
  }

  if (options.update !== undefined) {
    rejectExtra(options, ["update", "label", "default"]);
    if (provider !== undefined || options.connection !== undefined) {
      throw usageError("USAGE");
    }

    const changes: { label?: string; isDefault?: boolean } = {};

    if (options.label !== undefined) {
      changes.label = options.label;
    }

    if (options.default !== undefined) {
      changes.isDefault = options.default;
    }

    if (Object.keys(changes).length === 0) {
      throw usageError("USAGE");
    }

    return await callConnect(
      ctx,
      journal,
      { type: "update", connectionId: options.update, changes },
      { kind: "update", targets: [options.update] },
    );
  }

  rejectExtra(options, [
    "label",
    "connection",
    "fromEnv",
    "credentialFile",
    "redirectUri",
    "callbackUrl",
  ]);

  if (provider === undefined || !PROVIDER_ID.test(provider)) {
    throw usageError("USAGE");
  }

  if (options.fromEnv === true && options.credentialFile !== undefined) {
    throw usageError("USAGE");
  }

  const runtime = ctx.runtime();
  const oauth = runtime.oauth;

  // A redirected URL with no other start option completes the session it names:
  // nothing new is started, and the provider is the one on the command line.
  if (
    options.callbackUrl !== undefined &&
    options.label === undefined &&
    options.connection === undefined &&
    options.fromEnv !== true &&
    options.credentialFile === undefined &&
    options.redirectUri === undefined
  ) {
    const raw = await readCallbackUrl(ctx, options.callbackUrl);

    if (raw === undefined) {
      throw usageError("CALLBACK_URL_INVALID");
    }

    return await resumeFromCallback(ctx, journal, oauth, provider, raw);
  }

  const oauthStart = oauth.supports(provider)
    ? oauthRedirectStart(ctx, oauth, provider, options)
    : undefined;

  const start: ConnectRequest = {
    type: "start",
    provider,
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.connection === undefined ? {} : { connectionId: options.connection }),
    ...(oauthStart === undefined ? {} : { options: { redirectUri: oauthStart.target.uri } }),
  };
  const first = await requestConnect(ctx, journal, start, { kind: "start", targets: [provider] });

  const result =
    oauthStart === undefined
      ? await driveCredentials(ctx, journal, provider, first, options)
      : await driveConnect(ctx, journal, provider, first, oauthStart.draft, oauthStart.target, options);

  ctx.report("connect", result, renderConnect(result, { color: ctx.color }));

  return EXIT_CODE.SUCCESS;
}

type OAuthStart = { readonly draft: ArmedDraft; readonly target: RedirectTarget };

/**
 * Arm the adapter and resolve the redirect URI one `start` will use.
 *
 * The state and PKCE material exist only in memory; the redirect URI is the
 * caller's `--redirect-uri` or the pre-registerable loopback default, and it is
 * also passed to the provider as a connect option, because the provider's own
 * schema requires it.
 */
function oauthRedirectStart(
  ctx: CommandContext,
  oauth: LocalOAuthCallback,
  provider: string,
  options: ConnectOptions,
): OAuthStart {
  try {
    const target = oauth.redirectTarget(provider, options.redirectUri);
    const draft = oauth.arm({ provider, redirectUri: target.uri, signal: ctx.io.signal });

    return { draft, target };
  } catch (error) {
    throw asUsageFailure(error);
  }
}

/**
 * Drive one connect session whose provider is not an OAuth redirect.
 *
 * `bluesky` and `devto` (and any provider that asks for credentials once) run
 * exactly as before; a provider action this loop cannot answer ends the loop
 * with `action_required`.
 */
async function driveCredentials(
  ctx: CommandContext,
  journal: RequestJournal,
  provider: string,
  first: ConnectResult,
  options: ConnectOptions,
): Promise<ConnectResult> {
  let current = first;

  for (let step = 0; step < MAX_CONNECT_STEPS; step += 1) {
    if (current.status !== "action_required" || current.action.type !== "credential_input") {
      return current;
    }

    const credentials = await resolveCredentials(ctx, options, current.action.fields);

    if (credentials === undefined) {
      return current;
    }

    current = await resumeStep(ctx, journal, provider, current, { type: "credentials", credentials });
  }

  return current;
}

/**
 * Drive one OAuth connect session to a terminal result.
 *
 * Each action the adapter can answer is answered and the step resumed, so one
 * invocation spans "credentials -> authorize URL -> callback -> connection".
 * An action nobody answered stops the loop with `action_required`, which is
 * reported unchanged and exits 0: the CLI never claims a connection it did not
 * make, and never connects without a verified callback.
 */
async function driveConnect(
  ctx: CommandContext,
  journal: RequestJournal,
  provider: string,
  first: ConnectResult,
  draft: ArmedDraft,
  target: RedirectTarget,
  options: ConnectOptions,
): Promise<ConnectResult> {
  let current = await recordWhenOpenUrl(ctx, draft, first);

  for (let step = 0; step < MAX_CONNECT_STEPS; step += 1) {
    if (current.status === "done" || current.action.type === "wait_for_callback") {
      return current;
    }

    if (current.action.type === "credential_input") {
      const credentials = await resolveCredentials(ctx, options, current.action.fields);

      if (credentials === undefined) {
        return current;
      }

      current = await recordWhenOpenUrl(
        ctx,
        draft,
        await resumeStep(ctx, journal, provider, current, { type: "credentials", credentials }),
      );
      continue;
    }

    const arrival = await receiveCallback(ctx, provider, target, current, options);

    if (arrival.kind === "pending") {
      return current;
    }

    if (arrival.kind === "failed") {
      throw usageError(arrival.code);
    }

    if (arrival.kind === "url") {
      const outcome = await handleRedirect(ctx, provider, arrival.url, {
        sessionId: current.connectSessionId,
        stepRevision: current.stepRevision,
      });

      if (!outcome.ok) {
        throw usageError(outcome.code);
      }
    }

    const resumed = await recordWhenOpenUrl(
      ctx,
      draft,
      await resumeStep(ctx, journal, provider, current, { type: "callback_complete" }),
    );

    // A resume that did not advance the step cannot be advanced by another
    // delivery of the same callback, so the loop stops rather than asking for
    // the same redirect again.
    if (resumed.status === "action_required" && resumed.stepRevision === current.stepRevision) {
      return resumed;
    }

    current = resumed;
  }

  return current;
}

/** Reserve one step of an existing session, whatever input type it carries. */
function resumeStep(
  ctx: CommandContext,
  journal: RequestJournal,
  provider: string,
  current: ConnectResult & { readonly status: "action_required" },
  input: ResumeInput,
): Promise<ConnectResult> {
  return requestConnect(
    ctx,
    journal,
    {
      type: "resume",
      connectSessionId: current.connectSessionId,
      stepRevision: current.stepRevision,
      input,
    },
    { kind: "resume", targets: [provider] },
  );
}

/**
 * Record the durable attempt the moment a step yields an authorization URL.
 *
 * Recording happens before the URL is shown, so a callback that races the
 * prompt still finds its attempt. A step that yields no `open_url` records
 * nothing, so no later callback can be matched to it.
 */
async function recordWhenOpenUrl(
  ctx: CommandContext,
  draft: ArmedDraft,
  result: ConnectResult,
): Promise<ConnectResult> {
  if (result.status === "action_required" && result.action.type === "open_url") {
    try {
      await ctx.runtime().oauth.recordIfOpenUrl(draft, result);
    } catch (error) {
      throw asUsageFailure(error);
    }
  }

  return result;
}

/** Verify one redirected URL through the adapter, mapping its refusal to exit 2. */
async function handleRedirect(
  ctx: CommandContext,
  provider: string,
  url: string,
  expected?: { readonly sessionId: string; readonly stepRevision: number },
): Promise<Awaited<ReturnType<LocalOAuthCallback["handleRedirect"]>>> {
  try {
    return await ctx.runtime().oauth.handleRedirect(provider, url, expected);
  } catch (error) {
    throw asUsageFailure(error);
  }
}

/** Complete a pending session from a redirected URL, starting nothing new. */
async function resumeFromCallback(
  ctx: CommandContext,
  journal: RequestJournal,
  oauth: LocalOAuthCallback,
  provider: string,
  raw: string,
): Promise<number> {
  if (!oauth.supports(provider)) {
    throw usageError("OAUTH_PROVIDER_UNSUPPORTED");
  }

  const outcome = await handleRedirect(ctx, provider, raw);

  if (!outcome.ok || outcome.session === undefined) {
    throw usageError(outcome.code);
  }

  const resumed = await requestConnect(
    ctx,
    journal,
    {
      type: "resume",
      connectSessionId: outcome.session.sessionId,
      stepRevision: outcome.session.stepRevision,
      input: { type: "callback_complete" },
    },
    { kind: "resume", targets: [provider] },
  );

  ctx.report("connect", resumed, renderConnect(resumed, { color: ctx.color }));

  return EXIT_CODE.SUCCESS;
}

type CallbackArrival =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "accepted" }
  | { readonly kind: "pending" }
  | { readonly kind: "failed"; readonly code: string };

/**
 * Wait for the one redirect of an `open_url` step.
 *
 * The URL is shown first, in every mode, because the human has to open it. A
 * loopback redirect with a terminal present is received by a listener bound to
 * exactly that host, port and path; anything else is completed with the URL the
 * browser landed on. When nothing can answer, the caller gets `pending` and the
 * session stays open.
 */
async function receiveCallback(
  ctx: CommandContext,
  provider: string,
  target: RedirectTarget,
  current: ConnectResult & { readonly status: "action_required" },
  options: ConnectOptions,
): Promise<CallbackArrival> {
  const expected = { sessionId: current.connectSessionId, stepRevision: current.stepRevision };

  if (current.action.type !== "open_url") {
    return { kind: "pending" };
  }

  presentAuthorizeUrl(ctx, current.action.url);

  if (options.callbackUrl !== undefined) {
    const url = await readCallbackUrl(ctx, options.callbackUrl);

    return url === undefined ? { kind: "pending" } : { kind: "url", url };
  }

  if (target.kind === "loopback" && ctx.io.hasTty()) {
    return await receiveOnLoopback(ctx, provider, target, current.expiresAt, expected);
  }

  const pasted = await readPastedUrl(ctx);

  return pasted === undefined ? { kind: "pending" } : { kind: "url", url: pasted };
}

/**
 * Bind exactly the registered loopback redirect and wait for one delivery.
 *
 * The listener is closed on every exit path, including a timeout, an abort and
 * a refusal, so a finished command never leaves a port held.
 */
async function receiveOnLoopback(
  ctx: CommandContext,
  provider: string,
  target: LoopbackTarget,
  expiresAt: string,
  expected: { readonly sessionId: string; readonly stepRevision: number },
): Promise<CallbackArrival> {
  let listener;

  try {
    listener = await startLoopbackListener({
      host: target.host,
      port: target.port,
      path: target.path,
      uri: target.uri,
      timeoutMs: waitBudget(expiresAt),
      signal: ctx.io.signal,
      onRedirect: async (url) => {
        const outcome = await handleRedirect(ctx, provider, url, expected);

        return { ok: outcome.ok, message: outcome.code };
      },
    });
  } catch {
    // The redirect could never arrive here, so continuing would be a false
    // promise rather than a slow one.
    throw usageError("OAUTH_LISTENER_UNAVAILABLE");
  }

  try {
    const outcome = await listener.wait();

    return outcome.ok ? { kind: "accepted" } : { kind: "failed", code: outcome.code };
  } finally {
    await listener.close();
  }
}

/** How long to wait for a redirect: the attempt ceiling, capped by the session. */
function waitBudget(expiresAt: string): number {
  const remaining = Date.parse(expiresAt) - Date.now();

  if (!Number.isFinite(remaining)) {
    return DEFAULT_ATTEMPT_TTL_MS;
  }

  return Math.max(1_000, Math.min(DEFAULT_ATTEMPT_TTL_MS, remaining));
}

/**
 * Show the authorization URL.
 *
 * In `--json` the envelope owns stdout, so the URL goes to stderr instead of
 * being dropped. The URL is the one the provider built: it carries the state and
 * the PKCE challenge, never a code, a verifier or a client secret.
 */
function presentAuthorizeUrl(ctx: CommandContext, authorizeUrl: string): void {
  if (ctx.json) {
    ctx.diagnostic(`open ${authorizeUrl}`);

    return;
  }

  ctx.io.stdout.write(`Open this URL to authorize:\n  ${escapeControls(authorizeUrl)}\n`);
}

/**
 * The redirected URL a caller hands back.
 *
 * `-` reads one line (a paste); anything else is the value itself, unless that
 * value is a delivered callback. The URL is never echoed: it carries an
 * authorization code, so it must not reach stdout, the envelope or a log — and
 * the design also forbids it reaching the process argument vector, which is why
 * an argv value that carries a code or a state is refused instead of used.
 */
async function readCallbackUrl(ctx: CommandContext, source: string): Promise<string | undefined> {
  if (source !== "-") {
    if (carriesCallbackCredential(source)) {
      throw usageError("CALLBACK_URL_INVALID");
    }

    return source;
  }

  return await readPastedUrl(ctx);
}

/**
 * Does this raw argv value carry the material a real callback delivery has?
 *
 * OAuth parameter names are case-sensitive, so the check is. Both the query and
 * the fragment are scanned, because a provider that answers in the fragment
 * would otherwise slip the same code past the guard.
 */
function carriesCallbackCredential(raw: string): boolean {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    // Not a URL at all: the adapter refuses it later, and there is nothing to leak.
    return false;
  }

  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const parameters = new URLSearchParams(fragment);

  return url.searchParams.has("code") || url.searchParams.has("state") ||
    parameters.has("code") || parameters.has("state");
}

/** Read one pasted line: piped standard input first, then the terminal. */
async function readPastedUrl(ctx: CommandContext): Promise<string | undefined> {
  const piped = await readStdinLine(ctx);

  if (piped !== undefined) {
    return piped;
  }

  if (ctx.json || !ctx.io.hasTty()) {
    return undefined;
  }

  ctx.io.stdout.write("Paste the URL you were redirected to: ");

  const line = ctx.io.readTtyLine(INTERACTIVE_READ_LIMIT_MS);
  const trimmed = line?.trim() ?? "";

  return trimmed.length === 0 ? undefined : trimmed;
}

/** One line from a piped standard input, or `undefined` when nothing was piped. */
async function readStdinLine(ctx: CommandContext): Promise<string | undefined> {
  if (ctx.io.stdinIsTty) {
    return undefined;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let tooLong = false;

  try {
    for await (const chunk of ctx.io.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);

      total += buffer.length;

      if (total > MAX_CALLBACK_BYTES) {
        tooLong = true;
        break;
      }

      chunks.push(buffer);

      if (buffer.includes(0x0a)) {
        break;
      }
    }
  } catch {
    // A stream that is already consumed or torn down carries no pasted URL.
    return undefined;
  }

  if (tooLong) {
    throw usageError("CALLBACK_URL_INVALID");
  }

  if (total === 0) {
    return undefined;
  }

  const line = Buffer.concat(chunks, total).toString("utf8").split("\n", 1)[0] ?? "";
  const trimmed = line.trim();

  return trimmed.length === 0 ? undefined : trimmed;
}

/** Map an adapter refusal onto the CLI's exit-2 usage family, unchanged otherwise. */
function asUsageFailure(error: unknown): unknown {
  return error instanceof OAuthError ? usageError(error.code) : error;
}

/**
 * Decide how a `credential_input` action is completed.
 *
 * An explicit source wins: `--from-env` or `--credential-file` is read exactly
 * as before. With neither flag, a human at a terminal is prompted field by
 * field; a non-TTY or `--json` run reads nothing and reports the pending action.
 */
async function resolveCredentials(
  ctx: CommandContext,
  options: ConnectOptions,
  fields: readonly CredentialField[],
): Promise<JsonObject | undefined> {
  const supplied = await readCredentials(ctx, options);

  if (supplied !== undefined || ctx.json || !ctx.io.hasTty()) {
    return supplied;
  }

  return await promptCredentialInput(ctx, fields);
}

/** One provider-declared credential field; only `name`/`secret` guide the read. */
type CredentialField = {
  readonly name: string;
  readonly label: string;
  readonly secret: boolean;
};

/**
 * Read every credential field from the controlling terminal.
 *
 * A secret field is read with echo disabled through `readHiddenTtyLine`; a
 * non-secret field is read as a normal line. Any read that cannot complete - no
 * hidden reader, echo that could not be disabled, or end-of-input - abandons
 * the prompt and returns `undefined`, so a partial credential never leaves the
 * process. A value typed for a secret field is only ever assigned, never
 * printed, and never attached to a thrown error.
 */
async function promptCredentialInput(
  ctx: CommandContext,
  fields: readonly CredentialField[],
): Promise<JsonObject | undefined> {
  const credentials: JsonObject = {};

  for (const field of fields) {
    const value = field.secret
      ? await readSecretField(ctx, field)
      : readPlainField(ctx, field);

    if (value === undefined) {
      return undefined;
    }

    credentials[field.name] = value;
  }

  return credentials;
}

function readPlainField(ctx: CommandContext, field: CredentialField): string | undefined {
  ctx.io.stdout.write(`${escapeControls(field.label)}: `);

  return ctx.io.readTtyLine(INTERACTIVE_READ_LIMIT_MS);
}

async function readSecretField(
  ctx: CommandContext,
  field: CredentialField,
): Promise<string | undefined> {
  const reader = ctx.io.readHiddenTtyLine;

  if (reader === undefined) {
    return undefined;
  }

  const value = await reader(INTERACTIVE_READ_LIMIT_MS, ctx.io.signal, () => {
    // The prompt is written only once echo is really off, so the typed secret
    // can never race an echoed prompt. Only the field label is emitted; the
    // value read below is never written anywhere.
    ctx.io.stdout.write(`${escapeControls(field.label)} (secret): `);
  });

  if (value !== undefined) {
    // Echo was off while this line was typed, so the terminal printed no
    // newline after Enter; emit one so later output starts on its own line.
    ctx.io.stdout.write("\n");
  }

  return value;
}

/** Reject convenience flags that do not belong to the selected mode. */
function rejectExtra(options: ConnectOptions, allowed: readonly (keyof ConnectOptions)[]): void {
  const names = Object.keys(options) as (keyof ConnectOptions)[];

  for (const name of names) {
    if (options[name] !== undefined && !allowed.includes(name)) {
      throw usageError("USAGE");
    }
  }
}

async function connectFromInput(
  ctx: CommandContext,
  journal: RequestJournal,
  provider: string | undefined,
  options: ConnectOptions,
): Promise<number> {
  rejectExtra(options, ["input"]);

  if (provider !== undefined) {
    throw usageError("USAGE");
  }

  const source = options.input as string;
  const request = asConnectRequest(await readJsonSource(ctx, source));

  // A resume carries a credential or callback exchange, so it is only ever
  // accepted from standard input; a file could have been staged by someone else.
  if (request.type === "resume" && source !== "-") {
    throw usageError("INPUT_INVALID");
  }

  const oauth = ctx.runtime().oauth;
  const start = request.type === "start" ? oauthRequestStart(ctx, oauth, request) : undefined;
  const first = await requestConnect(ctx, journal, request, { kind: request.type, targets: [] });

  const result =
    start === undefined
      ? first
      : await driveConnect(ctx, journal, start.provider, first, start.draft, start.target, {});

  ctx.report("connect", result, renderConnect(result, { color: ctx.color }));

  return EXIT_CODE.SUCCESS;
}

/**
 * Arm the adapter for a machine `start` when the request names a redirect URI.
 *
 * The options come from the request document, so nothing is injected here. A
 * request without a `redirectUri` for an OAuth provider is left alone: Core
 * refuses it against the provider's own schema, and a provider that was never
 * armed keeps its own audited behaviour.
 */
function oauthRequestStart(
  ctx: CommandContext,
  oauth: LocalOAuthCallback,
  request: Extract<ConnectRequest, { readonly type: "start" }>,
): { readonly provider: string; readonly draft: ArmedDraft; readonly target: RedirectTarget } | undefined {
  if (!oauth.supports(request.provider)) {
    return undefined;
  }

  const requested = request.options?.["redirectUri"];

  if (typeof requested !== "string") {
    return undefined;
  }

  try {
    const target = oauth.redirectTarget(request.provider, requested);
    const draft = oauth.arm({
      provider: request.provider,
      redirectUri: target.uri,
      signal: ctx.io.signal,
    });

    return { provider: request.provider, draft, target };
  } catch (error) {
    throw asUsageFailure(error);
  }
}

type ConnectMeta = { readonly kind: JournalKind; readonly targets: readonly string[] };

async function callConnect(
  ctx: CommandContext,
  journal: RequestJournal,
  request: ConnectRequest,
  meta: ConnectMeta,
): Promise<number> {
  const result = await requestConnect(ctx, journal, request, meta);

  ctx.report("connect", result, renderConnect(result, { color: ctx.color }));

  return EXIT_CODE.SUCCESS;
}

async function requestConnect(
  ctx: CommandContext,
  journal: RequestJournal,
  request: ConnectRequest,
  meta: ConnectMeta,
): Promise<ConnectResult> {
  const runtime = ctx.runtime();
  const needsIdentity = request.type !== "resume";
  const key = needsIdentity ? mintRequestId() : undefined;

  if (key !== undefined) {
    await journal.record({
      requestId: key,
      contentMetadata: { family: "connect", kind: meta.kind, targets: meta.targets, bytes: 0 },
    });
  }

  const result = await runtime.core.connect(request, callContext(ctx.io, key));

  if (key !== undefined && ctx.verbose) {
    ctx.diagnostic(`request id ${key}`);
  }

  return result;
}

async function readCredentials(
  ctx: CommandContext,
  options: ConnectOptions,
): Promise<JsonObject | undefined> {
  if (options.fromEnv === true) {
    const raw = ctx.io.env[CREDENTIAL_ENV];

    if (raw === undefined || raw.length === 0 || raw.length > MAX_CREDENTIAL_BYTES) {
      throw usageError("CREDENTIAL_INVALID");
    }

    return asCredentialObject(parseCredential(raw));
  }

  if (options.credentialFile !== undefined) {
    return asCredentialObject(await readJsonSource(ctx, options.credentialFile));
  }

  return undefined;
}

function parseCredential(raw: string): unknown {
  try {
    return parseStrictJson(Buffer.from(raw, "utf8"));
  } catch {
    throw usageError("CREDENTIAL_INVALID");
  }
}

function asCredentialObject(value: unknown): JsonObject {
  if (!isRecord(value)) {
    throw usageError("CREDENTIAL_INVALID");
  }

  return value as JsonObject;
}

function asConnectRequest(value: unknown): ConnectRequest {
  if (!isRecord(value) || typeof value["type"] !== "string") {
    throw usageError("INPUT_INVALID");
  }

  switch (value["type"]) {
    case "start":
      if (typeof value["provider"] !== "string" || !PROVIDER_ID.test(value["provider"])) {
        throw usageError("INPUT_INVALID");
      }
      break;
    case "resume":
      if (
        typeof value["connectSessionId"] !== "string" ||
        typeof value["stepRevision"] !== "number" ||
        !isRecord(value["input"])
      ) {
        throw usageError("INPUT_INVALID");
      }
      break;
    case "update":
      if (typeof value["connectionId"] !== "string" || !isRecord(value["changes"])) {
        throw usageError("INPUT_INVALID");
      }
      break;
    case "disconnect":
      if (typeof value["connectionId"] !== "string") {
        throw usageError("INPUT_INVALID");
      }
      break;
    default:
      throw usageError("INPUT_INVALID");
  }

  return value as unknown as ConnectRequest;
}
