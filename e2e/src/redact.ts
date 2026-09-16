/**
 * Fake credentials for the local Mock SNS harness. Every value is synthetic and
 * is only ever sent to the loopback Mock SNS server started by these tests.
 * Tests assert on these exact values, so keep them stable.
 */
export const MOCK_CREDENTIALS = {
  apiKey: "e2e-api-key-not-a-real-secret",
  threadsAccessToken: "e2e-threads-access-token-not-a-real-secret",
  blueskyIdentifier: "e2e-mock-sns.invalid",
  blueskyPassword: "e2e-bluesky-app-password-not-a-real-secret",
} as const;

const SECRET_VALUES: readonly string[] = Object.values(MOCK_CREDENTIALS);

/**
 * Removes known credential values and bearer tokens from text that may be
 * printed or attached to a test failure.
 */
export function redact(value: string): string {
  let output = value;

  for (const secret of SECRET_VALUES) {
    output = output.split(secret).join("[redacted]");
  }

  return output.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]");
}

/** Single-line, redacted description of a thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause === undefined ? "" : ` (cause: ${describeError(error.cause)})`;
    return redact(`${error.name}: ${error.message}${cause}`);
  }

  return redact(String(error));
}
