/**
 * Exit codes are part of the CLI contract: agents and scripts branch on them
 * instead of parsing English.
 *
 * `0` never means a platform published anything. It means the protocol call was
 * handled: a connection action may still be required, a preview may still need
 * explicit confirmation, or an execution may still be pending. An agent reads
 * the JSON envelope, not the exit code alone.
 */
export const EXIT_CODE = {
  /** The command finished and Syndroo answered as documented. */
  SUCCESS: 0,
  /** Internal or durability failure. Side effects are unknown. */
  FAILURE: 1,
  /** Usage, configuration, authentication or preflight rejection. Nothing was sent. */
  USAGE: 2,
  /** A write may have reached the provider and no result is known. */
  AMBIGUOUS: 4,
  /** A human explicitly declined at the confirmation step. Nothing was sent. */
  CANCELLED: 5,
  /** Execution finished and is known not to be fully successful. */
  NOT_DELIVERED: 6,
  /** The local process stopped on a signal. Server-side work was not cancelled. */
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];
