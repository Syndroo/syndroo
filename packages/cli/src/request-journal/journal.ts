import { randomBytes } from "node:crypto";
import path from "node:path";

import {
  ensureOwnedDirectory,
  ensureStateRoot,
  replaceOwnedFile,
} from "../runtime/filesystem/atomic.js";

/** What a lost response needs to be replayed with the same identity. */
export type JournalEntry = {
  /** The idempotency key the call used. */
  readonly requestId: string;
  /** Non-secret metadata only: never a credential and never content bytes. */
  readonly contentMetadata: {
    readonly family: "connect" | "publish";
    readonly kind: string;
    readonly targets: readonly string[];
    readonly bytes: number;
  };
};

/**
 * The CLI request journal.
 *
 * A machine caller that loses a response must retry with the *same* key, not a
 * new one, or Syndroo may treat one logical call as two. The journal records the
 * key and non-secret metadata before the request is sent so the key can be
 * recovered; it never stores a credential, an approval token or content bytes.
 *
 * Journaling is best effort. The state root is created the same way any other
 * local write creates it, and a journal failure never blocks or rewrites the
 * protocol call.
 */
export class RequestJournal {
  readonly #stateRoot: string;

  constructor(stateRoot: string) {
    this.#stateRoot = stateRoot;
  }

  /** Record one request identity. Resolves whether or not it was written. */
  async record(entry: JournalEntry): Promise<void> {
    try {
      const root = await ensureStateRoot(this.#stateRoot);
      const directory = path.join(root, "journal");
      await ensureOwnedDirectory(directory);

      const name = `${entry.requestId.replace(/[^A-Za-z0-9._:-]/g, "_")}.json`;

      await replaceOwnedFile(
        directory,
        name,
        Buffer.from(`${JSON.stringify(entry)}\n`, "utf8"),
      );
    } catch {
      // A journal that cannot be written must not turn a valid call into a
      // failure; the request identity is still reported to the caller.
    }
  }
}

/**
 * A fresh request id for a machine call that omitted `--request-id`.
 *
 * The shape matches Core's `^[A-Za-z0-9._:-]{1,128}$` key grammar and carries
 * 128 bits of CSPRNG output.
 */
export function mintRequestId(): string {
  return `req_${randomBytes(16).toString("base64url")}`;
}

/** Accept only keys Core will accept, so a bad `--request-id` fails as usage. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
