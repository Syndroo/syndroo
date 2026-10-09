import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import type { ProviderHttpResult, ProviderTransport } from "@syndroo/provider-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { FAKE_ACCOUNT, FAKE_SECRET_CANARY } from "../../../../tests/fixtures/providers/fake.js";
import { CREDENTIAL_ENV } from "../../src/commands/connect.js";
import { parseEnvelope, runCli, sandbox, type RunResult, type Sandbox } from "./support/harness.js";
import { fakeRegistry } from "./support/registry.js";

/**
 * The machine loop end to end through Core.
 *
 * Every call goes through the real `run()` parser, the real filesystem runtime
 * and the real Core use cases. Only two seams are injected, because C3 has not
 * shipped an origin policy yet:
 *
 * - `providers` is a registry over the deterministic fake plugin;
 * - `transport` is a counting fake that never opens a socket.
 *
 * The report records that this loop must be re-run through the real provider
 * runtime once C3 lands. Until then a run with no injection fails closed.
 */

const boxes: Sandbox[] = [];

afterEach(async () => {
  await Promise.all(boxes.splice(0).map((created) => created.cleanup()));
});

type Arrangement = {
  readonly space: Sandbox;
  readonly connectionId: string;
  readonly operationId: string;
  readonly approvalToken: string;
  readonly sent: () => number;
  run(argv: readonly string[], stdin?: string): Promise<RunResult>;
};

type ArrangeOptions = {
  /**
   * Where `connect` imports the credential from. The sandbox owns both: the
   * file lives at `<root>/credential.json` and the env var on `space.env`.
   */
  readonly importSource?: "file" | "env";
};

async function arrange(
  result: ProviderHttpResult,
  options: ArrangeOptions = {},
): Promise<Arrangement> {
  const space = await sandbox("syndroo-cli-loop-");

  boxes.push(space);

  let sent = 0;
  const transport: ProviderTransport = {
    async request(): Promise<ProviderHttpResult> {
      sent += 1;

      return result;
    },
  };
  const overrides = { providers: fakeRegistry(), transport };
  const run = (argv: readonly string[], stdin?: string): Promise<RunResult> =>
    runCli(argv, {
      env: space.env,
      cwd: space.root,
      overrides,
      ...(stdin === undefined ? {} : { stdin }),
    });

  const credential = path.join(space.root, "credential.json");
  const viaEnv = options.importSource === "env";

  if (viaEnv) {
    space.env[CREDENTIAL_ENV] = JSON.stringify({ canary: FAKE_SECRET_CANARY });
  } else {
    await fs.writeFile(credential, JSON.stringify({ canary: FAKE_SECRET_CANARY }));
  }

  const connected = await run(
    viaEnv
      ? ["connect", "fake", "--from-env", "--json"]
      : ["connect", "fake", "--credential-file", credential, "--json"],
  );
  const connectionEnvelope = parseEnvelope(connected);
  const connectionId = connectionEnvelope["result"].connection.connectionId as string;

  const document = path.join(space.root, "document.json");

  await fs.writeFile(
    document,
    JSON.stringify({ content: { text: "The loop fixture text." }, targets: [{ provider: "fake" }] }),
  );

  const prepared = await run(["publish", "--input", document, "--json"]);
  const preparedEnvelope = parseEnvelope(prepared);

  expect(preparedEnvelope["result"].status).toBe("confirmation_required");
  expect(sent).toBe(0);

  return {
    space,
    connectionId,
    operationId: preparedEnvelope["result"].operationId as string,
    approvalToken: preparedEnvelope["result"].approvalToken as string,
    sent: () => sent,
    run,
  };
}

describe("machine loop through Core", () => {
  it("connect -> prepare -> execute -> status round-trips without leaking the credential", async () => {
    const loop = await arrange({ type: "response", status: 200, headers: {}, body: "{}" });
    const connection = await loop.run(["status", "--connections", "--json"]);
    const connectionEnvelope = parseEnvelope(connection);

    expect(connectionEnvelope["result"]).toMatchObject({ type: "connections" });
    expect(connectionEnvelope["result"].connections).toHaveLength(1);
    expect(connectionEnvelope["result"].connections[0].account).toEqual(FAKE_ACCOUNT);
    expect(connectionEnvelope["result"].connections[0].connectionId).toBe(loop.connectionId);

    const execute = await loop.run(
      ["publish", "--input", "-", "--json"],
      JSON.stringify({ type: "execute", approvalToken: loop.approvalToken }),
    );

    expect(execute.exit).toBe(0);
    const executed = parseEnvelope(execute);

    expect(executed["result"]).toMatchObject({
      phase: "execution",
      operationId: loop.operationId,
      status: "succeeded",
    });
    expect(executed["result"].deliveries).toHaveLength(1);
    expect(executed["result"].deliveries[0]).toMatchObject({
      connectionId: loop.connectionId,
      outcome: { status: "succeeded" },
    });
    expect(String(executed["result"].deliveries[0].outcome.remoteId)).toContain("fake_");
    expect(loop.sent()).toBe(1);

    const status = await loop.run(["status", "--operation", loop.operationId, "--json"]);

    expect(status.exit).toBe(0);
    expect(parseEnvelope(status)["result"]).toMatchObject({
      type: "operation",
      operation: { phase: "execution", operationId: loop.operationId, status: "succeeded" },
    });

    for (const text of [connection.stdout, execute.stdout, status.stdout, execute.stderr]) {
      expect(text).not.toContain(FAKE_SECRET_CANARY);
    }
  });

  it("re-using the same approval token replays the stored execution without a second send", async () => {
    const loop = await arrange({ type: "response", status: 200, headers: {}, body: "{}" });
    const first = await loop.run(
      ["publish", "--input", "-", "--json"],
      JSON.stringify({ type: "execute", approvalToken: loop.approvalToken }),
    );
    const second = await loop.run(
      ["publish", "--input", "-", "--json"],
      JSON.stringify({ type: "execute", approvalToken: loop.approvalToken }),
    );

    expect(first.exit).toBe(0);
    expect(second.exit).toBe(0);
    expect(parseEnvelope(second)["result"]).toMatchObject({ status: "succeeded" });
    expect(loop.sent()).toBe(1);
  });

  it("a possibly-sent transport error stays unknown and exits ambiguous", async () => {
    const loop = await arrange({
      type: "transport_error",
      stage: "possibly_sent",
      code: "ECONNRESET",
    });
    const execute = await loop.run(
      ["publish", "--input", "-", "--json"],
      JSON.stringify({ type: "execute", approvalToken: loop.approvalToken }),
    );

    expect(execute.exit).toBe(4);
    const executed = parseEnvelope(execute);

    expect(executed["result"]).toMatchObject({ phase: "execution", status: "unknown" });
    expect(executed["result"].deliveries[0].outcome).toMatchObject({
      status: "unknown",
      disposition: "unknown",
    });
    expect(loop.sent()).toBe(1);
  });

  // CON-01: an already-verified credential is carried by the Core credential
  // store, so removing the import source after `connect` must not affect a
  // later execute. The file path and the environment path are separate cases.
  it("an execute still succeeds after the credential import file is deleted", async () => {
    const loop = await arrange({ type: "response", status: 200, headers: {}, body: "{}" });
    const credential = path.join(loop.space.root, "credential.json");

    await fs.rm(credential);
    expect(existsSync(credential)).toBe(false);

    const execute = await loop.run(
      ["publish", "--input", "-", "--json"],
      JSON.stringify({ type: "execute", approvalToken: loop.approvalToken }),
    );

    expect(execute.exit).toBe(0);
    const executed = parseEnvelope(execute);

    expect(executed["result"]).toMatchObject({
      phase: "execution",
      operationId: loop.operationId,
      status: "succeeded",
    });
    expect(executed["result"].deliveries[0].outcome).toMatchObject({ status: "succeeded" });
    expect(loop.sent()).toBe(1);
  });

  it("an execute still succeeds after SYNDROO_CREDENTIALS is removed from the environment", async () => {
    const loop = await arrange(
      { type: "response", status: 200, headers: {}, body: "{}" },
      { importSource: "env" },
    );

    delete loop.space.env[CREDENTIAL_ENV];
    expect(loop.space.env[CREDENTIAL_ENV]).toBeUndefined();

    const execute = await loop.run(
      ["publish", "--input", "-", "--json"],
      JSON.stringify({ type: "execute", approvalToken: loop.approvalToken }),
    );

    expect(execute.exit).toBe(0);
    const executed = parseEnvelope(execute);

    expect(executed["result"]).toMatchObject({
      phase: "execution",
      operationId: loop.operationId,
      status: "succeeded",
    });
    expect(executed["result"].deliveries[0].outcome).toMatchObject({ status: "succeeded" });
    expect(loop.sent()).toBe(1);
  });
});
