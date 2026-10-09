import { randomBytes } from "node:crypto";

import type * as T from "@syndroo/core";

import { FilesystemCredentials } from "./credentials.js";
import type { FaultInjector } from "./database.js";
import { fail } from "./errors.js";
import { defaultStateRoot } from "./paths.js";
import { FilesystemState } from "./state.js";

/**
 * The local runtime: filesystem state, filesystem credentials, a clock and an
 * entropy source. Command composition (B3) wires these into Core; nothing here
 * reads a configuration file, touches the current working directory or performs
 * network I/O.
 */

export class SystemClock implements T.Clock {
  now(): T.IsoTime {
    return new Date().toISOString();
  }
}

const PREFIX = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;

export class CryptoEntropy implements T.Entropy {
  /** `prefix_<256 bits>`, base64url, for every opaque id Core allocates. */
  id(prefix: string): string {
    if (!PREFIX.test(prefix)) {
      fail("INVALID_INPUT");
    }

    return `${prefix}_${randomBytes(32).toString("base64url")}`;
  }

  /** 256 bits of CSPRNG output for approval tokens and other bearers. */
  token(): string {
    return randomBytes(32).toString("base64url");
  }
}

export type RuntimeOptions = {
  /** Absolute state root. Defaults to the XDG/HOME location for this user. */
  readonly root?: string;
  readonly fault?: FaultInjector;
  readonly now?: () => string;
  readonly scope?: string;
};

export type FilesystemRuntime = {
  readonly root: string;
  readonly state: FilesystemState;
  readonly credentials: FilesystemCredentials;
  readonly clock: T.Clock;
  readonly entropy: T.Entropy;
};

export function createFilesystemRuntime(
  options: RuntimeOptions = {},
): FilesystemRuntime {
  const root = options.root ?? defaultStateRoot();
  const now = options.now;
  const state = new FilesystemState({
    root,
    ...(options.fault ? { fault: options.fault } : {}),
    ...(now ? { now } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
  });
  const credentials = new FilesystemCredentials({
    root,
    ...(options.fault ? { fault: options.fault } : {}),
    ...(now ? { now } : {}),
  });

  return {
    root,
    state,
    credentials,
    clock: new SystemClock(),
    entropy: new CryptoEntropy(),
  };
}
