import path from 'node:path';
import type * as T from '@syndroo/core';
import { EncryptedCredentials, deploymentKey } from '../secrets/encrypted.js';
import { fail } from './errors.js';
import { SQLiteState } from './state.js';

export type SqliteStorageOptions = {
  statePath: string;
  secretsPath: string;
  scope: string;
  key: string | Uint8Array;
  busyTimeoutMs?: number;
};

export function createSqliteStorage(options: SqliteStorageOptions): {
  state: SQLiteState & T.StateStore;
  credentials: EncryptedCredentials & T.CredentialStore;
  close(): void;
} {
  // Reject key failures and path aliasing before any file is created.
  const key = deploymentKey(options.key);
  if (typeof options.statePath !== 'string' || typeof options.secretsPath !== 'string'
    || path.resolve(options.statePath) === path.resolve(options.secretsPath)) {
    fail('STORAGE_CONFIG_INVALID');
  }
  try {
    const state = new SQLiteState({
      databasePath: options.statePath, scope: options.scope,
      ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    });
    try {
      const credentials = new EncryptedCredentials({
        databasePath: options.secretsPath, scope: options.scope, key, state,
        ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
      });
      return {
        state, credentials,
        close() { credentials.close(); state.close(); },
      };
    } catch (error) {
      state.close();
      throw error;
    }
  } finally {
    key.fill(0);
  }
}
