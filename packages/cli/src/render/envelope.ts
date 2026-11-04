import { ProtocolError } from "@syndroo/core";

import { CliError } from "../cli-error.js";
import { EXIT_CODE, type ExitCode } from "../exit-codes.js";

/** The three protocol families the CLI speaks. */
export type Operation = "connect" | "publish" | "status";

/** Server management is a CLI-local surface, not a Core protocol operation. */
export type ServerSubcommand =
  | "init"
  | "doctor"
  | "deploy"
  | "connect"
  | "publish"
  | "ci"
  | "server";

export type ServerFailureDetails = {
  readonly subcommand: ServerSubcommand;
  readonly nextAction?: string;
  readonly operationId?: string;
  readonly failedStep?: string;
  readonly confirmedResources?: {
    readonly d1?: { readonly name: string; readonly id?: string };
    readonly queues?: readonly { readonly name: string; readonly id?: string }[];
    readonly worker?: { readonly name: string; readonly tag: string } | null;
  };
  readonly receiptRetained?: boolean;
  readonly evidence?: {
    readonly stage: "deploy" | "verification";
    readonly processStatus?:
      | "exited"
      | "timed_out"
      | "output_limit"
      | "spawn_error";
    readonly processExitCode?: number | null;
    readonly receiptRetained?: boolean;
    readonly receipt?:
      | "complete"
      | "missing"
      | "unreadable"
      | "invalid"
      | "incomplete"
      | "mismatched_worker"
      | "target_mismatch";
  };
  readonly machineRecord?: {
    readonly status?: string;
    readonly workerTag?: string;
    readonly versionId?: string;
    readonly targets?: readonly string[];
  };
};

/** The only details a safe error may carry (validated ids/paths/times). */
export type SafeDetails = {
  readonly field?: string;
  readonly operationId?: string;
  readonly retryAt?: string;
};

/** One machine envelope, exactly as the generated schema declares it. */
export type CliEnvelope =
  | {
      readonly protocolVersion: 1;
      readonly operation: Operation;
      readonly ok: true;
      readonly result: unknown;
      readonly error: null;
    }
  | {
      readonly protocolVersion: 1;
      readonly operation: Operation;
      readonly ok: false;
      readonly result: null;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: SafeDetails;
      };
    };

export type ServerEnvelope =
  | {
      readonly protocolVersion: 1;
      readonly operation: "server";
      readonly ok: true;
      readonly result: unknown;
      readonly error: null;
    }
  | {
      readonly protocolVersion: 1;
      readonly operation: "server";
      readonly ok: false;
      readonly result: null;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details: ServerFailureDetails;
      };
    };

/**
 * Static text keyed by stable code.
 *
 * No message is ever built from a raw error, a stack, a response body, a path
 * or an argv value, so a diagnostic can never carry a secret or a terminal
 * escape sequence through this module.
 */
const MESSAGES: Readonly<Record<string, string>> = {
  INTERNAL: "The command failed.",
  USAGE: "The command line is not valid. Run `syndroo --help`.",
  INPUT_INVALID: "The request document is not valid.",
  INPUT_UNREADABLE: "The request document could not be read.",
  INPUT_SOURCE_MISSING: "Exactly one input source is required.",
  INPUT_SOURCE_CONFLICT: "Only one input source may be used.",
  EXECUTE_REQUIRES_STDIN: "An execute request may only be read from standard input.",
  CONFIG_INVALID: "The configuration file is not valid.",
  CONFIG_NOT_FOUND: "The configuration file does not exist.",
  CONFIG_PATH_NOT_ABSOLUTE: "The configuration path must be absolute.",
  CONFIG_VERSION_UNSUPPORTED: "The configuration version is not supported.",
  CONFIG_SECRET_REJECTED: "The configuration file contains a secret-looking key.",
  SERVER_CONFIG_NOT_FOUND: "The server project configuration does not exist.",
  SERVER_CONFIG_INVALID: "The server project configuration is not valid.",
  SERVER_CONFIG_UNKNOWN_KEY: "The server project configuration contains an unknown key.",
  SERVER_CONFIG_DUPLICATE_KEY: "The server project configuration contains a duplicate key.",
  SERVER_CONFIG_SECRET_REJECTED: "Secret values do not belong in the server project configuration.",
  SERVER_CONFIG_VERSION_UNSUPPORTED: "The server project configuration version is not supported.",
  SERVER_CONFIG_WRITE_FAILED: "The server project configuration could not be updated.",
  SERVER_PROJECT_CONFLICT:
    "The destination contains unrelated content or an incomplete generated project.",
  SERVER_PROJECT_AMBIGUOUS: "Choose the project directory in one place.",
  SERVER_PROJECT_UNREADABLE: "The server project contains a file that could not be read safely.",
  SERVER_PROJECT_WRITE_FAILED: "The server project files could not be written safely.",
  SERVER_LOCAL_CONFIG_UNSUPPORTED:
    "The local --config option does not select a server project. Use server --project.",
  SERVER_PROJECT_REQUIRED: "Select a server project with server --project.",
  SERVER_INPUT_INVALID: "The bounded input is not valid.",
  SERVER_INPUT_UNREADABLE: "The bounded input file could not be read.",
  SERVER_VISIBILITY_CONFLICT: "Choose either public or private GitHub visibility.",
  SERVER_GITHUB_TARGET_INVALID: "The GitHub repository must be owner/repo.",
  SERVER_GITHUB_COLLISION:
    "The named GitHub repository already exists and was not changed.",
  SERVER_GITHUB_UNAVAILABLE: "GitHub could not be reached through the GitHub CLI.",
  SERVER_GITHUB_AUTH_REQUIRED: "Authenticate the GitHub CLI before creating a repository.",
  SERVER_GITHUB_CREATE_FAILED: "The GitHub repository could not be created.",
  SERVER_GITHUB_PUSH_FAILED:
    "The GitHub repository was created, but the initial push did not finish. " +
    "The generated project and local commit are preserved; rerun init to reconcile.",
  SERVER_GITHUB_RECOVERY_CONFLICT:
    "The existing remote does not match the recorded generated project.",
  SERVER_GIT_UNAVAILABLE: "Git is required to initialize a server project.",
  SERVER_GIT_IDENTITY_REQUIRED:
    "Configure git user.name and user.email before initializing a server project.",
  SERVER_GIT_FAILED: "The local Git repository could not be initialized or committed.",
  SERVER_PACKAGE_UNAVAILABLE:
    "The pinned deployment packages could not be installed or were unavailable. " +
    "The generated project was preserved.",
  SERVER_PACKAGE_LOCK_MISSING:
    "Package installation completed without the required package-lock.json.",
  SERVER_RECOVERY_CONFLICT: "The private project recovery record is not usable safely.",
  SERVER_RECOVERY_WRITE_FAILED: "The private project recovery record could not be written.",
  SERVER_PROCESS_TIMEOUT: "An external tool exceeded its bounded execution time.",
  SERVER_PROCESS_OUTPUT_LIMIT: "An external tool exceeded its bounded output size.",
  SERVER_STATE_UNAVAILABLE: "The private server state could not be accessed safely.",
  SERVER_DEPLOY_AUTHORIZATION_REQUIRED: "Deployment requires the explicit --yes flag.",
  SERVER_DEPLOY_FAILED: "The deployment command could not be completed.",
  SERVER_DEPLOY_CLOUDFLARE_AUTH_REQUIRED:
    "Authenticate the project-local Wrangler with Cloudflare before deploying.",
  SERVER_DEPLOY_CLOUDFLARE_AUTH_UNSUPPORTED:
    "This Cloudflare login type is not supported. Use OAuth or an API token.",
  SERVER_DEPLOY_AUTH_OR_PERMISSION:
    "Cloudflare refused the request for the selected account. Check the account and its permissions.",
  SERVER_DEPLOY_ACCOUNT_SELECTION_REQUIRED:
    "The selected Cloudflare account is not one this login can read. Choose an accessible account ID.",
  SERVER_DEPLOY_ACCOUNT_CONFLICT:
    "Only one Cloudflare account may be selected, and every source must agree.",
  SERVER_DEPLOY_OWNERSHIP_UNVERIFIED:
    "Remote resource ownership could not be proven for this project.",
  SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH:
    "A remote resource does not match the recorded project, account, or Worker identity.",
  SERVER_DEPLOY_TARGET_UNVERIFIED:
    "The deployment target could not be verified from machine output.",
  SERVER_DEPLOY_AMBIGUOUS:
    "The deployment outcome is unknown. Inspect the remote state before retrying.",
  SERVER_DEPLOY_RECEIPT_INVALID:
    "The private deployment receipt is not valid machine output.",
  SERVER_DEPLOY_RECEIPT_UNAVAILABLE:
    "The private deployment receipt could not be read.",
  SERVER_DEPLOY_RECEIPT_STALE:
    "The retained receipt belongs to an earlier attempt, not this pending deploy.",
  SERVER_DEPLOY_RECOVERY_REQUIRED:
    "The pending deploy needs verified Worker and version evidence before it can continue.",
  SERVER_DEPLOY_RECOVERY_INVALID: "The deployment recovery document is not valid.",
  SERVER_DEPLOY_CREDENTIAL_RECOVERY_REQUIRED:
    "Existing deployment credentials must be imported through a safe secret input.",
  SERVER_THREADS_DEPLOYMENT_REQUIRED: "Deploy the server before connecting Threads.",
  SERVER_THREADS_DEPLOYMENT_MISMATCH:
    "The configured origin does not match the verified deployment.",
  SERVER_THREADS_ADMIN_RECOVERY_REQUIRED:
    "The deployment admin credential is unavailable for OAuth setup.",
  SERVER_THREADS_APP_ID_REQUIRED: "A Threads App ID is required.",
  SERVER_THREADS_APP_CONFLICT:
    "The requested Threads App ID conflicts with the project configuration.",
  SERVER_THREADS_SECRET_REQUIRED:
    "Provide the Threads App Secret through stdin or a hidden prompt.",
  SERVER_THREADS_SECRET_INVALID: "The Threads App Secret input is not valid.",
  SERVER_THREADS_SECRET_CONFLICT: "Provide the Threads App Secret in one place.",
  SERVER_THREADS_CONFIG_INVALID: "The Threads connection configuration is not valid.",
  SERVER_THREADS_ARGUMENT_INVALID: "The Threads command arguments are not valid.",
  SERVER_THREADS_POST_INVALID: "The Threads post document is not valid.",
  SERVER_THREADS_RESPONSE_INVALID: "The Threads server returned an invalid response.",
  SERVER_THREADS_AUTHORIZATION_EXPIRED:
    "The Threads authorization expired; restart with a new request identity.",
  SERVER_THREADS_CALLBACK_TIMEOUT:
    "Threads authorization did not finish. Reuse the pending request identity.",
  SERVER_THREADS_CREDENTIALS_REQUIRED:
    "Threads requested app credentials again; restart the connection attempt.",
  SERVER_THREADS_RESUME_CONFLICT:
    "The pending Threads connection does not match this request.",
  SERVER_THREADS_RESUME_WRITE_FAILED:
    "The pending Threads connection state could not be updated.",
  SERVER_THREADS_STALE_CONNECT:
    "The pending Threads connection changed before completion; no connection or draft was overwritten.",
  SERVER_THREADS_BINDING_CHANGED:
    "The project deployment binding changed during Threads authorization; the result was not applied.",
  SERVER_THREADS_FAILED: "The Threads connection could not be completed.",
  SERVER_THREADS_AUTHORIZATION_REQUIRED:
    "Threads publication requires the explicit --yes flag.",
  SERVER_THREADS_INPUT_REQUIRED: "A Threads post input file is required.",
  SERVER_THREADS_REQUEST_ID_REQUIRED: "A stable publication request ID is required.",
  SERVER_THREADS_CONNECTION_REQUIRED: "Connect a Threads account first.",
  SERVER_THREADS_TARGET_CONFLICT:
    "The workflow target conflicts with the configured Threads target.",
  SERVER_THREADS_SCOPED_TOKEN_REQUIRED:
    "Provide the scoped SYNDROO_TOKEN used by the CI workflow.",
  SERVER_THREADS_INPUT_UNREADABLE: "The Threads post file could not be read.",
  SERVER_CI_AUTHORIZATION_REQUIRED: "CI setup requires the explicit --yes flag.",
  SERVER_CI_CONNECTION_REQUIRED: "Connect a Threads account before configuring CI.",
  SERVER_CI_PACKAGE_INVALID: "The project dependency pins are not suitable for CI.",
  SERVER_CI_DEPLOYMENT_REQUIRED: "Deploy the server before configuring CI.",
  SERVER_CI_DEPLOYMENT_MISMATCH:
    "The configured project does not match the verified deployment.",
  SERVER_CI_CLOUDFLARE_CONFIG_INVALID:
    "The verified effective Wrangler configuration is unavailable.",
  SERVER_CI_CLOUDFLARE_IDENTITY_MISMATCH:
    "The selected Cloudflare Worker does not match the recorded deployment.",
  SERVER_CI_CLOUDFLARE_UNAVAILABLE:
    "Cloudflare secrets could not be read through Wrangler.",
  SERVER_CI_CLOUDFLARE_RESPONSE_INVALID:
    "Wrangler returned an invalid secret list.",
  SERVER_CI_CLOUDFLARE_WRITE_FAILED:
    "The paired Cloudflare CI secrets could not be updated.",
  SERVER_CI_REMOTE_PAIR_INCONSISTENT:
    "Cloudflare contains only one member of the CI secret pair.",
  SERVER_CI_TOKEN_RECOVERY_REQUIRED:
    "Remote CI secrets exist but their bearer is not in local state. Provide it through safe stdin or environment input.",
  SERVER_CI_STATE_RECOVERY_REQUIRED: "The private CI state is not usable safely.",
  SERVER_CI_STATE_IDENTITY_MISMATCH:
    "The private CI state does not match the verified deployment.",
  SERVER_CI_STATE_WRITE_FAILED: "The private CI state could not be written.",
  SERVER_CI_TOKEN_WRITE_FAILED: "A CI bearer could not be generated.",
  SERVER_CI_BEARER_INVALID: "The supplied CI bearer is not valid.",
  SERVER_CI_BEARER_CONFLICT:
    "The supplied CI bearer conflicts with the existing private CI state.",
  SERVER_CI_WORKFLOW_CONFLICT:
    "The managed CI workflow conflicts with an existing file and was preserved.",
  SERVER_CI_WORKFLOW_WRITE_FAILED: "The managed CI workflow could not be written.",
  SERVER_CI_GITHUB_TARGET_REQUIRED: "Provide or configure an explicit GitHub repository.",
  SERVER_CI_GITHUB_UNAVAILABLE: "GitHub could not be read through the GitHub CLI.",
  SERVER_CI_GITHUB_RESPONSE_INVALID: "The GitHub CLI returned an invalid repository response.",
  SERVER_CI_GITHUB_IDENTITY_MISMATCH:
    "The GitHub repository does not match the verified CI state.",
  SERVER_CI_GITHUB_ENVIRONMENT_FAILED:
    "The GitHub CI environment could not be inspected or created safely.",
  SERVER_CI_GITHUB_VARIABLE_FAILED:
    "The GitHub CI environment variable could not be updated.",
  SERVER_CI_GITHUB_SECRET_FAILED:
    "The GitHub CI secret could not be updated through stdin.",
  SERVER_CI_TOOL_MISSING: "A required CI tool is not installed.",
  CREDENTIAL_SOURCE_MISSING: "This connection needs a credential source.",
  CREDENTIAL_INVALID: "The credential document is not valid.",
  INVALID_INPUT: "The request was rejected as invalid.",
  BODY_TOO_LARGE: "The request body is too large.",
  UNSUPPORTED_MEDIA_TYPE: "The request media type is not supported.",
  UNAUTHORIZED: "Authentication failed.",
  FORBIDDEN: "The request is not permitted.",
  NOT_FOUND: "No record matches the request.",
  TARGET_AMBIGUOUS: "The target connection is ambiguous.",
  DUPLICATE_TARGET: "The same target appears more than once.",
  CONNECTION_IDENTITY_CHANGED: "The connection identity changed.",
  CONNECTION_CAPACITY: "The connection limit was reached.",
  PROVIDER_TRUST_REQUIRED: "The provider is not trusted yet.",
  PROVIDER_INVALID: "The provider is not valid.",
  PROVIDER_UNAVAILABLE: "The provider is not available.",
  PROVIDER_CONFIG_INVALID: "The provider configuration is not valid.",
  PROVIDER_IMPORT_FAILED: "The provider could not be loaded.",
  PROVIDER_RESTART_REQUIRED: "Restart the CLI before using the changed provider.",
  STALE_INTENT: "A newer intent exists for this request.",
  STALE_BINDING: "The connection binding is stale.",
  APPROVAL_INVALID: "The approval token is not valid.",
  APPROVAL_EXPIRED: "The approval window has closed.",
  IDEMPOTENCY_CONFLICT: "The request id was reused with different content.",
  REQUEST_IN_PROGRESS: "The request is still in progress.",
  RETRY_INELIGIBLE: "The target is not eligible for a safe retry.",
  CONNECT_SESSION_EXPIRED: "The connection session has expired.",
  CONNECT_STEP_CONFLICT: "The connection step conflicts with a stored result.",
  CONNECT_STEP_UNKNOWN: "The connection step result is unknown.",
  OAUTH_PROVIDER_UNSUPPORTED: "This provider does not use a local OAuth callback.",
  REDIRECT_URI_INVALID: "The OAuth redirect URI is not valid.",
  CALLBACK_URL_INVALID:
    "The OAuth callback URL is not valid. A delivered callback carries an " +
    "authorization code, so it must be passed on standard input " +
    "(--callback-url -) instead of on the command line.",
  OAUTH_CALLBACK_REJECTED: "The OAuth callback was refused.",
  OAUTH_CALLBACK_TIMEOUT: "No OAuth callback arrived before the attempt expired.",
  OAUTH_CALLBACK_CANCELLED: "The OAuth callback wait was cancelled.",
  OAUTH_ATTEMPT_STORE_UNAVAILABLE: "The local OAuth attempt could not be recorded.",
  OAUTH_LISTENER_UNAVAILABLE: "The loopback OAuth callback address could not be bound.",
  STATE_BUSY: "Another Syndroo write is in progress. Retry shortly.",
  STATE_RECOVERY_REQUIRED: "The local state needs operator recovery.",
  DURABILITY_ERROR: "The local state could not be updated.",
  CANCELLED: "The local call was cancelled.",
};

export function staticMessage(code: string): string {
  return MESSAGES[code] ?? "The command could not be completed.";
}

/**
 * Map any thrown value to a stable code and an exit family.
 *
 * Unknown values collapse to `INTERNAL`/1 rather than leaking a message. Core
 * raises `ProtocolError` for every refusal it makes; those are preflight
 * rejections (exit 2) except a cancelled local call and a damaged or
 * unwritable state root.
 */
export function classify(error: unknown): { code: string; exit: ExitCode } {
  if (error instanceof CliError) {
    return { code: error.code, exit: error.exitCode };
  }

  if (error instanceof ProtocolError) {
    if (error.code === "CANCELLED") {
      return { code: error.code, exit: EXIT_CODE.INTERRUPTED };
    }

    if (
      error.code === "STATE_RECOVERY_REQUIRED" ||
      error.code === "DURABILITY_ERROR"
    ) {
      return { code: error.code, exit: EXIT_CODE.FAILURE };
    }

    return { code: error.code, exit: EXIT_CODE.USAGE };
  }

  return { code: "INTERNAL", exit: EXIT_CODE.FAILURE };
}

export function successEnvelope(operation: Operation, result: unknown): CliEnvelope {
  return { protocolVersion: 1, operation, ok: true, result, error: null };
}

export function failureEnvelope(
  operation: Operation,
  code: string,
  details?: SafeDetails,
): CliEnvelope {
  return {
    protocolVersion: 1,
    operation,
    ok: false,
    result: null,
    error: {
      code,
      message: staticMessage(code),
      ...(details ? { details } : {}),
    },
  };
}

export function serverFailureEnvelope(
  code: string,
  details: ServerFailureDetails,
): ServerEnvelope {
  return {
    protocolVersion: 1,
    operation: "server",
    ok: false,
    result: null,
    error: {
      code,
      message: staticMessage(code),
      details,
    },
  };
}

/** Exit family for a returned execution round (a business result, not an error). */
export function exitForExecution(status: string): ExitCode {
  if (status === "unknown") {
    return EXIT_CODE.AMBIGUOUS;
  }

  if (status === "failed" || status === "partial") {
    return EXIT_CODE.NOT_DELIVERED;
  }

  return EXIT_CODE.SUCCESS;
}
