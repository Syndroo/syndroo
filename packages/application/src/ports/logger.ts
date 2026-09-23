/** Structured event sink. Implementations write to stdout/console, not R2. */

import type { SafeLogEvent } from "../contracts/storage.js";

export interface Logger {
  write(event: SafeLogEvent): void;
}
