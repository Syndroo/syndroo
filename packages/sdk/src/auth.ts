/**
 * The auth resource: status reads and the guarded mutation operations.
 *
 * Every method shares the accepted transport, so each one sends exactly one
 * request, never retries a mutation, and reports the fixed `auth.*` operation.
 * A mutation always submits the revision the caller observed; omitting it is a
 * legacy-server compatibility note in the HTTP contract, not a behavior this
 * SDK will take.
 */

import {
  createErrorSink,
  SyndrooConfigError,
  type ErrorSink,
  type SdkOperation,
} from "./errors.js";
import {
  durationError,
  sendRequest,
  type TransportConfig,
} from "./http.js";
import {
  authIdentityError,
  parseAuthOperationStatus,
  parseAuthRefreshReceipt,
  parseAuthRemoveReceipt,
  parseAuthSetReceipt,
  parseAuthStatus,
  parseCompleteReceipt,
  parseConnectReceipt,
  parsePlatformStatus,
  validateCompleteTarget,
  validateCredential,
  validateExpectedRevision,
  validateOperationId,
  validatePlatform,
  type AuthCompleteInput,
  type AuthCredentialInput,
  type AuthMutationOptions,
  type AuthOperationStatus,
  type AuthRefreshReceipt,
  type AuthRemoveReceipt,
  type AuthRequestOptions,
  type AuthSetReceipt,
  type AuthStatus,
  type CompleteReceipt,
  type ConnectReceipt,
  type PlatformStatus,
} from "./auth-types.js";

export class AuthResource {
  readonly #config: TransportConfig;

  constructor(config: TransportConfig) {
    this.#config = config;
  }

  /** `GET /v1/auth`: every platform plus instance readiness. */
  async status(options?: AuthRequestOptions): Promise<AuthStatus>;
  /** `GET /v1/auth/<platform>`: one platform's status. */
  async status(platform: string, options?: AuthRequestOptions): Promise<PlatformStatus>;
  /** `GET /v1/auth`: the documented platform-optional form. */
  async status(
    platform: undefined,
    options?: AuthRequestOptions,
  ): Promise<AuthStatus>;
  /** `GET /v1/auth/<platform>`: one platform's status. */
  async status(
    platform?: string | undefined,
    options?: AuthRequestOptions,
  ): Promise<AuthStatus | PlatformStatus>;
  async status(
    platformOrOptions?: string | AuthRequestOptions,
    options: AuthRequestOptions = {},
  ): Promise<AuthStatus | PlatformStatus> {
    const operation: SdkOperation = "auth.status";
    const errors = createErrorSink();
    const platform = typeof platformOrOptions === "string" ? platformOrOptions : undefined;
    const requestOptions =
      typeof platformOrOptions === "string" || platformOrOptions === undefined
        ? options
        : platformOrOptions;

    validateRequestDuration(requestOptions.timeoutMs, "timeoutMs", operation, errors);

    if (platform === undefined) {
      const response = await sendRequest(
        this.#config,
        {
          method: "GET",
          operation,
          path: "/v1/auth",
          signal: requestOptions.signal,
          timeoutMs: requestOptions.timeoutMs,
        },
        errors,
      );

      return parseAuthStatus(response.body, {
        status: response.status,
        operation,
        errors,
      });
    }

    const name = validatePlatform(platform, operation, errors);
    const status = await this.#readPlatform(name, operation, requestOptions, errors);

    return status;
  }

  /**
   * `POST /v1/auth/<platform>` with the flat direct credential fields. The
   * credential is snapshotted and validated before any request exists.
   */
  async set(
    platform: string,
    credential: AuthCredentialInput,
    options: AuthMutationOptions,
  ): Promise<AuthSetReceipt> {
    const operation: SdkOperation = "auth.set";
    const errors = createErrorSink();
    validateRequestDuration(options.timeoutMs, "timeoutMs", operation, errors);
    const name = validatePlatform(platform, operation, errors);
    const revision = validateExpectedRevision(options.expectedRevision, operation, errors);
    const fields = validateCredential(name, credential, operation, errors);
    const response = await sendRequest(
      this.#config,
      {
        method: "POST",
        operation,
        path: `/v1/auth/${encodeURIComponent(name)}`,
        json: { ...fields, expectedRevision: revision },
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      },
      errors,
    );
    const receipt = parseAuthSetReceipt(response.body, {
      status: response.status,
      operation,
      errors,
      requestMayHaveBeenApplied: true,
    });

    assertSamePlatform(receipt.platform, name, response.status, operation, errors, true);

    return receipt;
  }

  /** `POST /v1/auth/<platform>/connect`: start one guarded OAuth operation. */
  async connect(
    platform: string,
    options: AuthMutationOptions,
  ): Promise<ConnectReceipt> {
    const operation: SdkOperation = "auth.connect";
    const errors = createErrorSink();
    validateRequestDuration(options.timeoutMs, "timeoutMs", operation, errors);
    const name = validatePlatform(platform, operation, errors);
    const revision = validateExpectedRevision(options.expectedRevision, operation, errors);
    const response = await sendRequest(
      this.#config,
      {
        method: "POST",
        operation,
        path: `/v1/auth/${encodeURIComponent(name)}/connect`,
        json: { expectedRevision: revision },
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      },
      errors,
    );
    const receipt = parseConnectReceipt(response.body, {
      status: response.status,
      operation,
      errors,
      requestMayHaveBeenApplied: true,
    });

    assertSamePlatform(receipt.platform, name, response.status, operation, errors, true);

    if (receipt.expectedRevision !== revision) {
      throw authIdentityError(
        "The connect receipt did not carry the revision this caller submitted.",
        {
          status: response.status,
          operation,
          errors,
          requestMayHaveBeenApplied: true,
        },
      );
    }

    return receipt;
  }

  /** `GET /v1/auth/<platform>/operations/<id>`: one operation's phase. */
  async operation(
    platform: string,
    id: string,
    options: AuthRequestOptions = {},
  ): Promise<AuthOperationStatus> {
    const operation: SdkOperation = "auth.operation";
    const errors = createErrorSink();
    validateRequestDuration(options.timeoutMs, "timeoutMs", operation, errors);
    const name = validatePlatform(platform, operation, errors);
    const operationId = validateOperationId(id, operation, errors);
    const response = await sendRequest(
      this.#config,
      {
        method: "GET",
        operation,
        path: `/v1/auth/${encodeURIComponent(name)}/operations/${encodeURIComponent(operationId)}`,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      },
      errors,
    );
    const status = parseAuthOperationStatus(response.body, {
      status: response.status,
      operation,
      errors,
    });

    assertSamePlatform(status.platform, name, response.status, operation, errors, false);

    if (status.operationId !== operationId) {
      throw authIdentityError(
        "The auth operation read answered about a different operation id.",
        { status: response.status, operation, errors, requestMayHaveBeenApplied: false },
      );
    }

    // The nested projections describe the same operation, so they must agree.
    if (status.active.platform !== status.platform) {
      throw authIdentityError(
        "The auth operation active status describes a different platform.",
        { status: response.status, operation, errors, requestMayHaveBeenApplied: false },
      );
    }

    if (
      status.receipt !== undefined &&
      (status.receipt.platform !== status.platform ||
        status.receipt.operationId !== status.operationId)
    ) {
      throw authIdentityError(
        "The auth operation receipt describes a different operation.",
        { status: response.status, operation, errors, requestMayHaveBeenApplied: false },
      );
    }

    return status;
  }

  /**
   * `POST /v1/auth/<platform>/operations/<id>/complete`. A completed operation
   * may be replayed explicitly under the server contract; the SDK never
   * replays it for the caller.
   */
  async complete(
    platform: string,
    id: string,
    input: AuthCompleteInput,
    options: AuthRequestOptions = {},
  ): Promise<CompleteReceipt> {
    const operation: SdkOperation = "auth.complete";
    const errors = createErrorSink();
    validateRequestDuration(options.timeoutMs, "timeoutMs", operation, errors);
    const name = validatePlatform(platform, operation, errors);
    const operationId = validateOperationId(id, operation, errors);
    const revision = validateExpectedRevision(input.expectedRevision, operation, errors);
    const target = validateCompleteTarget(name, input.target, operation, errors);
    const response = await sendRequest(
      this.#config,
      {
        method: "POST",
        operation,
        path: `/v1/auth/${encodeURIComponent(name)}/operations/${encodeURIComponent(operationId)}/complete`,
        json:
          target === undefined
            ? { expectedRevision: revision }
            : { expectedRevision: revision, target },
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      },
      errors,
    );
    const receipt = parseCompleteReceipt(response.body, {
      status: response.status,
      operation,
      errors,
      requestMayHaveBeenApplied: true,
    });

    assertSamePlatform(receipt.platform, name, response.status, operation, errors, true);

    if (receipt.operationId !== operationId) {
      throw authIdentityError(
        "The completion receipt answered about a different operation id.",
        { status: response.status, operation, errors, requestMayHaveBeenApplied: true },
      );
    }

    return receipt;
  }

  /**
   * `POST /v1/auth/<platform>/refresh`. An unknown refresh outcome requires a
   * reconnect; the SDK never repeats the exchange automatically.
   */
  async refresh(
    platform: string,
    options: AuthMutationOptions,
  ): Promise<AuthRefreshReceipt> {
    const operation: SdkOperation = "auth.refresh";
    const errors = createErrorSink();
    validateRequestDuration(options.timeoutMs, "timeoutMs", operation, errors);
    const name = validatePlatform(platform, operation, errors);
    const revision = validateExpectedRevision(options.expectedRevision, operation, errors);
    const response = await sendRequest(
      this.#config,
      {
        method: "POST",
        operation,
        path: `/v1/auth/${encodeURIComponent(name)}/refresh`,
        json: { expectedRevision: revision },
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      },
      errors,
    );
    const receipt = parseAuthRefreshReceipt(response.body, {
      status: response.status,
      operation,
      errors,
      requestMayHaveBeenApplied: true,
    });

    assertSamePlatform(receipt.platform, name, response.status, operation, errors, true);

    return receipt;
  }

  /** `DELETE /v1/auth/<platform>` with the observed revision. */
  async remove(
    platform: string,
    options: AuthMutationOptions,
  ): Promise<AuthRemoveReceipt> {
    const operation: SdkOperation = "auth.remove";
    const errors = createErrorSink();
    validateRequestDuration(options.timeoutMs, "timeoutMs", operation, errors);
    const name = validatePlatform(platform, operation, errors);
    const revision = validateExpectedRevision(options.expectedRevision, operation, errors);
    const response = await sendRequest(
      this.#config,
      {
        method: "DELETE",
        operation,
        path: `/v1/auth/${encodeURIComponent(name)}`,
        json: { expectedRevision: revision },
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      },
      errors,
    );
    const receipt = parseAuthRemoveReceipt(response.body, {
      status: response.status,
      operation,
      errors,
      requestMayHaveBeenApplied: true,
    });

    assertSamePlatform(receipt.platform, name, response.status, operation, errors, true);

    return receipt;
  }

  async #readPlatform(
    name: string,
    operation: SdkOperation,
    options: AuthRequestOptions,
    errors: ReturnType<typeof createErrorSink>,
  ): Promise<PlatformStatus> {
    const response = await sendRequest(
      this.#config,
      {
        method: "GET",
        operation,
        path: `/v1/auth/${encodeURIComponent(name)}`,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      },
      errors,
    );
    const status = parsePlatformStatus(response.body, "auth status", {
      status: response.status,
      operation,
      errors,
    });

    assertSamePlatform(status.platform, name, response.status, operation, errors, false);

    return status;
  }
}

/**
 * The shared duration rule, checked before any request or timer exists. It
 * mirrors the client's helper so the auth methods cannot drift from the posts
 * methods.
 */
function validateRequestDuration(
  value: number | undefined,
  label: string,
  operation: SdkOperation,
  errors: ErrorSink,
): void {
  if (value === undefined) {
    return;
  }

  const message = durationError(value, label);

  if (message !== undefined) {
    throw errors.mark(new SyndrooConfigError(message, { operation }));
  }
}

/** A response that names a different platform than the request is a contract failure. */
function assertSamePlatform(
  answered: string,
  requested: string,
  status: number,
  operation: SdkOperation,
  errors: ReturnType<typeof createErrorSink>,
  requestMayHaveBeenApplied: boolean,
): void {
  if (answered !== requested) {
    throw authIdentityError(
      "The auth response identified a different platform than the request.",
      { status, operation, errors, requestMayHaveBeenApplied },
    );
  }
}
