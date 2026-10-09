import { createSqliteStorage, type SqliteStorageOptions } from '../../src/state/index.js';
import type * as T from '@syndroo/core';

const options = JSON.parse(process.argv[2]!) as SqliteStorageOptions;
const mode = process.argv[3];
const payload = JSON.parse(process.argv[4]!) as Record<string, unknown>;
const storage = createSqliteStorage(options);

try {
  if (mode === 'distinct') {
    const prefix = payload.prefix as string;
    for (let n = 0; n < 20; n++) {
      const suffix = `${prefix}_${n}`;
      const result = await storage.state.reservePreparation({
        request: { principalId: 'owner', family: 'publish', key: suffix, digest: suffix },
        canonical: { type: 'prepare', content: { text: suffix }, targets: [{ provider: 'fake' }] },
        operationId: `op_${suffix}`, ownerId: prefix, now: '2026-10-08T00:00:00.000Z',
      });
      if (result.type !== 'owned') throw Error('unexpected reservation');
    }
    process.stdout.write(JSON.stringify({ type: 'distinct', count: 20 }));
  } else if (mode === 'admit') {
    const result = await storage.state.admitExecution(payload.input as Parameters<T.StateStore['admitExecution']>[0]);
    process.stdout.write(JSON.stringify({ type: result.type }));
  } else if (mode === 'claim') {
    const result = await storage.state.claimDelivery(payload.input as Parameters<T.StateStore['claimDelivery']>[0]);
    process.stdout.write(JSON.stringify({ type: result ? 'claimed' : 'blocked' }));
  } else {
    throw Error('unknown test mode');
  }
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'WORKER_ERROR';
  process.stderr.write(code);
  process.exitCode = 1;
} finally {
  storage.close();
}
