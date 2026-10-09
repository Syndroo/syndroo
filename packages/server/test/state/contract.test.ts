import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from 'node:sqlite';
import { stateStoreContract } from "../../../../tests/contracts/state-store.js";
import { fixture } from "./support.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())); });
stateStoreContract("SQLite", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  return { state: f.state, credentials: f.credentials };
});

it('a fresh verified connect reuses the durable connection identity', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const first = await f.connect('first');
  const second = await f.connect('second');
  expect(second.connectionId).toBe(first.connectionId);
  expect(await f.state.listConnections('fake')).toHaveLength(1);
  expect((await f.state.getConnection(first.connectionId))?.credentialRevision).toBe(2);
});

it('status and ordinary state reads make no SQLite writes', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  await f.connect();
  const observer = new DatabaseSync(f.options.statePath);
  try {
    const before = observer.prepare('PRAGMA data_version').get()!.data_version;
    await f.state.listConnections();
    await f.state.getConnection('missing');
    await f.h.runtime().core.status({ type: 'connections' }, f.h.ctx());
    const after = observer.prepare('PRAGMA data_version').get()!.data_version;
    expect(after).toBe(before);
  } finally { observer.close(); }
});
