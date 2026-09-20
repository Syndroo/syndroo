/**
 * Exit codes are part of the CLI contract: scripts and agents branch on them
 * instead of parsing English.
 *
 * One distinction carries most of the weight. For `posts create`, `0` means
 * Syndroo accepted the request. It never means a platform published anything,
 * and it is deliberately not the same number as a confirmed delivery.
 */
export const EXIT_CODE = {
  /** The command finished and Syndroo answered as documented. */
  SUCCESS: 0,
  /** The command failed: unreachable instance, rejected request, unexpected error. */
  FAILURE: 1,
  /** Usage, configuration, or post-document problem. Nothing was sent. */
  USAGE: 2,
  /** `posts wait` reached its deadline. Waiting only reads; the post still exists. */
  WAIT_TIMEOUT: 3,
  /** A write may have reached Syndroo and no result is known. Reuse the same idempotency key. */
  AMBIGUOUS: 4,
  /** The operator declined the preview. Nothing was sent. */
  CANCELLED: 5,
  /** The post reached a terminal state without full delivery (`failed` or `partial`). */
  NOT_DELIVERED: 6,
  /** The local process stopped on a signal. Server-side work was not cancelled. */
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];
