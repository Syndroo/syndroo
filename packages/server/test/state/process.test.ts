import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { fixture } from './support.js';

const execute = promisify(execFile);

it('two independent writers preserve every row and admit/claim only once', async () => {
  const f = await fixture();
  try {
    const childPath = path.join(f.root, 'writer-child.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./writer-child.ts', import.meta.url))],
      outfile: childPath, bundle: true, platform: 'node', format: 'esm',
      external: ['node:*'], logLevel: 'silent',
    });
    const run = async (mode: string, payload: object) => {
      const { stdout, stderr } = await execute(process.execPath, [
        childPath, JSON.stringify(f.options), mode, JSON.stringify(payload),
      ], { timeout: 20_000, maxBuffer: 1024 });
      expect(stderr).toBe('');
      return JSON.parse(stdout) as { type: string; count?: number };
    };

    const distinct = await Promise.all([
      run('distinct', { prefix: 'left' }),
      run('distinct', { prefix: 'right' }),
    ]);
    expect(distinct.map(result => result.count)).toEqual([20, 20]);
    const db = new DatabaseSync(f.options.statePath);
    try {
      expect(db.prepare("SELECT count(*) AS n FROM records WHERE kind='operation'").get()!.n).toBe(40);
      const meta = JSON.parse(db.prepare(
        "SELECT value FROM records WHERE kind='meta' AND id='runtime'",
      ).get()!.value as string) as { sequence: number };
      expect(meta.sequence).toBe(40);
    } finally { db.close(); }

    await f.connect();
    const prepared = await f.prepared('parallel-admit');
    const admissions = await Promise.all([
      run('admit', { input: prepared.admission }),
      run('admit', { input: prepared.admission }),
    ]);
    expect(admissions.map(result => result.type).sort()).toEqual(['applied', 'replay']);

    const operation = await f.state.getOperation(prepared.result.operationId, 'owner');
    expect(operation).not.toBeNull();
    const base = {
      work: { operationId: prepared.result.operationId, executionRevision: 0 },
      deliveryId: prepared.intent.targets[0]!.deliveryId,
      expectedVersion: operation!.version,
      now: '2026-10-08T00:00:00.000Z',
    };
    const claims = await Promise.all([
      run('claim', { input: { ...base, claimId: 'claim_left', ownerId: 'left', submissionId: 'submit_left' } }),
      run('claim', { input: { ...base, claimId: 'claim_right', ownerId: 'right', submissionId: 'submit_right' } }),
    ]);
    expect(claims.map(result => result.type).sort()).toEqual(['blocked', 'claimed']);
    expect((await f.state.getOperation(prepared.result.operationId, 'owner'))?.deliveries[0]?.attempts).toBe(1);
  } finally {
    await f.cleanup();
  }
}, 30_000);
