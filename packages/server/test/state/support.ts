import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSqliteStorage } from "../../src/state/index.js";
import { harness } from "../../../../tests/fixtures/state/harness.js";

export const KEY = "07".repeat(32);
export const NOW = "2026-10-08T00:00:00.000Z";
export async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "syndroo-sqlite-")));
  const options = { statePath: path.join(root, "state.db"), secretsPath: path.join(root, "secrets.db"), scope: "fixture", key: KEY };
  const storage = createSqliteStorage(options);
  const h = harness();
  h.deps.state = storage.state;
  h.deps.credentials = storage.credentials;
  async function connect(key = "connect") {
    const core = h.runtime().core;
    const start = await core.connect({ type: "start", provider: "fake" }, h.ctx(key));
    if (start.status !== "action_required") throw new Error("expected credential action");
    const done = await core.connect({ type: "resume", connectSessionId: start.connectSessionId,
      stepRevision: start.stepRevision, input: { type: "credentials", credentials: { token: "PRIVATE_FIXTURE_SECRET" } } }, h.ctx());
    if (done.status !== "done") throw new Error("expected connection");
    return done.connection;
  }
  async function prepared(key = "publish") {
    const result = await h.runtime().core.publish({ type: "prepare", content: { text: "fixture content" }, targets: [{ provider: "fake" }] }, h.ctx(key));
    if (result.status !== "confirmation_required") throw new Error("expected prepared intent");
    const intent = await storage.state.getIntent({ operationId: result.operationId, executionRevision: 0 }, "owner");
    const operation = await storage.state.getOperation(result.operationId, "owner");
    if (!intent || !operation) throw new Error("expected saved state");
    return { result, intent, operation, admission: { principalId: "owner", approvalDigest: intent.approvalDigest,
      intentDigest: intent.intentDigest, expectedVersion: operation.version, bindings: intent.targets.map(t => t.binding), now: NOW } };
  }
  return { ...storage, options, root, h, connect, prepared, cleanup: async () => { storage.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
