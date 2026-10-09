/**
 * One typed refusal from the local OAuth adapter.
 *
 * Every code here is static and pre-declared; the command layer maps one onto a
 * usage failure (exit 2), because a refused callback means nothing was sent to a
 * provider. A `code` that reaches the CLI's classifier unchanged is what makes
 * "fail closed" observable instead of a generic internal error.
 */
export class OAuthError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "OAuthError";
    this.code = code;
  }
}
