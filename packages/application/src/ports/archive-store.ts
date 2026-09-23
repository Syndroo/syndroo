/** Private, bounded, redacted diagnostic archive. */

import type { ArchiveKey, SanitizedArchive } from "../contracts/storage.js";

export interface ArchiveStore {
  put(key: ArchiveKey, payload: SanitizedArchive): Promise<void>;
  /** Missing or expired objects return null; they are never fabricated. */
  get(key: ArchiveKey): Promise<SanitizedArchive | null>;
  delete(key: ArchiveKey): Promise<void>;
}
