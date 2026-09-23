/** Read-only operational projection. Must never perform a write or provider call. */

import type { SafeDiagnostics } from "../contracts/storage.js";

export interface DiagnosticsReader {
  readSnapshot(): Promise<SafeDiagnostics>;
}
