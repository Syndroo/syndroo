/**
 * Transport-level failures.
 *
 * Messages are fixed and safe: no provider text, header value, body, URL
 * credential, or raw cause is ever attached. Platform adapters translate these
 * codes into their own `PublishError` classification so provider semantics stay
 * with the provider.
 */
export type TransportFailureCode =
  | "invalid_target"
  | "network"
  | "timeout"
  | "redirect"
  | "response_too_large"
  | "aborted";

const MESSAGES: Record<TransportFailureCode, string> = {
  invalid_target: "Outbound request target is not an allowed HTTPS URL",
  network: "Outbound request failed before a response was received",
  timeout: "Outbound request exceeded its deadline",
  redirect: "Provider answered with a redirect, which is never followed",
  response_too_large: "Provider response exceeded the configured size limit",
  aborted: "Outbound request was aborted by the caller",
};

export class TransportError extends Error {
  readonly code: TransportFailureCode;

  /**
   * Records that `fetch` was invoked for this attempt. It is an observable
   * fact about the runtime call only: it does not prove that any byte reached
   * the provider, and it is never used as proof of a remote side effect.
   */
  readonly requestDispatched: boolean;

  constructor(code: TransportFailureCode, requestDispatched: boolean) {
    super(MESSAGES[code]);
    this.name = "TransportError";
    this.code = code;
    this.requestDispatched = requestDispatched;
  }
}
