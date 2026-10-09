import path from "node:path";

import {
  CURRENT_FILE_NAME,
  FORMAT_FILE_NAME,
  GENERATIONS_DIRECTORY_NAME,
  JOURNAL_FILE_NAME,
  LOCK_DIRECTORY_NAME,
  LOCK_OWNER_FILE_NAME,
  RECORDS_DIRECTORY_NAME,
  SECRETS_DIRECTORY_NAME,
  TOMBSTONES_DIRECTORY_NAME,
} from "./atomic.js";
import { fail } from "./errors.js";

/**
 * The single format marker of the architecture-v1 local state root.
 *
 * The root is new (`runtime-v1`), so a marker that is missing where a root is
 * expected, or that names any other format, is refused. Legacy local state is
 * never probed, migrated or read: it lives under a different root this runtime
 * does not open.
 */
export const RUNTIME_FORMAT = "syndroo-runtime-v1";

export type Layout = {
  readonly root: string;
  readonly format: string;
  readonly current: string;
  readonly generations: string;
  readonly lock: string;
  readonly lockOwner: string;
  readonly secrets: string;
  readonly blobs: string;
  readonly tombstones: string;
};

export function layoutOf(root: string): Layout {
  return {
    root,
    format: path.join(root, FORMAT_FILE_NAME),
    current: path.join(root, CURRENT_FILE_NAME),
    generations: path.join(root, GENERATIONS_DIRECTORY_NAME),
    lock: path.join(root, LOCK_DIRECTORY_NAME),
    lockOwner: path.join(root, LOCK_DIRECTORY_NAME, LOCK_OWNER_FILE_NAME),
    secrets: path.join(root, SECRETS_DIRECTORY_NAME),
    blobs: path.join(root, SECRETS_DIRECTORY_NAME, "blobs"),
    tombstones: path.join(
      root,
      SECRETS_DIRECTORY_NAME,
      TOMBSTONES_DIRECTORY_NAME,
    ),
  };
}

export function generationName(generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    fail("DURABILITY_ERROR");
  }

  return `gen-${String(generation).padStart(6, "0")}`;
}

export function generationDirectory(root: string, generation: number): string {
  return path.join(layoutOf(root).generations, generationName(generation));
}

export function journalPath(root: string, generation: number): string {
  return path.join(
    generationDirectory(root, generation),
    JOURNAL_FILE_NAME,
  );
}

export function recordsDirectory(
  root: string,
  generation: number,
  kind: string,
): string {
  return path.join(
    generationDirectory(root, generation),
    RECORDS_DIRECTORY_NAME,
    kind,
  );
}

export function generationRecordsDirectory(
  root: string,
  generation: number,
): string {
  return path.join(
    generationDirectory(root, generation),
    RECORDS_DIRECTORY_NAME,
  );
}

export function secretBlobPath(root: string, name: string): string {
  return path.join(layoutOf(root).blobs, name);
}

export function secretBlobDirectory(root: string): string {
  return layoutOf(root).blobs;
}

export function tombstoneDirectory(root: string): string {
  return layoutOf(root).tombstones;
}

export function tombstonePath(root: string, name: string): string {
  return path.join(layoutOf(root).tombstones, name);
}

/**
 * Default state root: `$XDG_STATE_HOME/syndroo/runtime-v1`, else
 * `$HOME/.local/state/syndroo/runtime-v1`.
 *
 * A relative `XDG_STATE_HOME` is ignored, as the XDG base directory
 * specification requires. A configuration path selects configuration and never
 * stands in for the state root, and the current working directory is never
 * scanned.
 */
export function defaultStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env["XDG_STATE_HOME"];

  if (xdg !== undefined && path.isAbsolute(xdg)) {
    return path.join(xdg, "syndroo", "runtime-v1");
  }

  const home = env["HOME"];

  if (home === undefined || !path.isAbsolute(home)) {
    fail("DURABILITY_ERROR");
  }

  return path.join(home, ".local", "state", "syndroo", "runtime-v1");
}
