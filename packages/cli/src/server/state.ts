import path from "node:path";

import { CliError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import {
  createOwnedFile,
  ensureStateRoot,
  readOwnedFile,
  replaceOwnedFile,
  requireStateRoot,
  resolveStateRootPath,
} from "../runtime/filesystem/atomic.js";

export const SERVER_STATE_DIRECTORY = "serverctl-v1";
export const MAX_SERVER_STATE_FILE_BYTES = 1_048_576;

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function defaultServerStateRoot(env: NodeJS.ProcessEnv): string {
  const xdg = env["XDG_STATE_HOME"];
  if (xdg !== undefined && path.isAbsolute(xdg)) {
    return path.join(xdg, "syndroo", SERVER_STATE_DIRECTORY);
  }

  const home = env["HOME"];
  if (home === undefined || !path.isAbsolute(home)) {
    throw new CliError("SERVER_STATE_UNAVAILABLE", {
      code: "SERVER_STATE_UNAVAILABLE",
      exitCode: EXIT_CODE.FAILURE,
    });
  }
  return path.join(home, ".local", "state", "syndroo", SERVER_STATE_DIRECTORY);
}

function checkedName(name: string): string {
  if (!SAFE_NAME.test(name)) {
    throw new CliError("SERVER_STATE_UNAVAILABLE", {
      code: "SERVER_STATE_UNAVAILABLE",
      exitCode: EXIT_CODE.FAILURE,
    });
  }
  return name;
}

export async function readPrivateStateFile(
  stateRoot: string,
  name: string,
): Promise<Buffer | null> {
  const resolved = await resolveStateRootPath(stateRoot);
  if (resolved.missing.length > 0) {
    return null;
  }
  const root = await requireStateRoot(resolved.resolved);
  return await readOwnedFile(path.join(root, checkedName(name)));
}

export async function writePrivateStateFile(
  stateRoot: string,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.length > MAX_SERVER_STATE_FILE_BYTES) {
    throw new CliError("SERVER_STATE_UNAVAILABLE", {
      code: "SERVER_STATE_UNAVAILABLE",
      exitCode: EXIT_CODE.FAILURE,
    });
  }
  const root = await ensureStateRoot(stateRoot);
  await replaceOwnedFile(root, checkedName(name), bytes);
}

export async function createPrivateStateFile(
  stateRoot: string,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.length > MAX_SERVER_STATE_FILE_BYTES) {
    throw new CliError("SERVER_STATE_UNAVAILABLE", {
      code: "SERVER_STATE_UNAVAILABLE",
      exitCode: EXIT_CODE.FAILURE,
    });
  }
  const root = await ensureStateRoot(stateRoot);
  await createOwnedFile(root, checkedName(name), bytes);
}
