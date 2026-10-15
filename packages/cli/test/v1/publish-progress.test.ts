import { promises as fs } from "node:fs";
import path from "node:path";

import type { ProviderHttpResult, ProviderTransport } from "@syndroo/provider-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { FAKE_SECRET_CANARY } from "../../../../tests/fixtures/providers/fake.js";
import { loadConfig, resolveConfigPath } from "../../src/config.js";
import { createLocalRuntime } from "../../src/runtime/local/composition.js";
import { parseEnvelope, runCli, sandbox, type Sandbox } from "./support/harness.js";
import { fakeRegistry } from "./support/registry.js";

/**
 * Post-commit progress over the real filesystem state store.
 *
 * The memory-state unit test proves the notification contract; this test proves
 * the same contract survives the real filesystem adapter: while the provider
 * call is blocked, the claim is durably `in_flight` on disk and a separate
 * `status` read sees it, then the recorded event and final result arrive.
 */

const boxes: Sandbox[] = [];

afterEach(async () => {
  await Promise.all(boxes.splice(0).map((box) => box.cleanup()));
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolved) => {
    resolve = resolved;
  });

  return { promise, resolve };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (check()) {
      return;
    }

    await new Promise((resolved) => setTimeout(resolved, 1));
  }

  throw new Error("condition was never met");
}

describe("publish progress through the filesystem runtime", () => {
  it("records the claim before the provider answers and completes the round", async () => {
    const space = await sandbox("syndroo-cli-progress-");

    boxes.push(space);

    const credential = path.join(space.root, "credential.json");

    await fs.writeFile(credential, JSON.stringify({ canary: FAKE_SECRET_CANARY }));

    const ok: ProviderHttpResult = { type: "response", status: 200, headers: {}, body: "{}" };
    const gate = deferred<void>();
    let blocking = false;
    let sent = 0;
    const transport: ProviderTransport = {
      async request() {
        sent += 1;

        if (blocking) {
          await gate.promise;
        }

        return ok;
      },
    };
    const overrides = { providers: fakeRegistry(), transport };
    const connected = await runCli(
      ["connect", "fake", "--credential-file", credential, "--json"],
      { env: space.env, cwd: space.root, overrides },
    );
    const connectionId = parseEnvelope(connected)["result"].connection.connectionId as string;
    const config = await loadConfig(resolveConfigPath(space.env), space.env);
    const runtime = createLocalRuntime(config, overrides);
    const prepared = await runtime.core.publish({
      type: "prepare",
      content: { text: "hello" },
      targets: [{ provider: "fake", connection: connectionId }],
    }, {
      principalId: "local", idempotencyKey: "prepare-1", signal: new AbortController().signal,
    }) as { operationId: string; approvalToken: string };

    blocking = true;

    const events: { type: string; execution: any }[] = [];
    const running = runtime.core.publish({
      type: "execute", approvalToken: prepared.approvalToken,
    }, {
      principalId: "local",
      signal: new AbortController().signal,
      onProgress: (event) => events.push(event as never),
    });

    await waitFor(() => events.some((event) => event.type === "claimed"));

    expect(events.map((event) => event.type)).toEqual(["admitted", "claimed"]);
    expect(events.at(-1)!.execution.deliveries[0].state).toBe("in_flight");

    // A separate read-only CLI invocation over the same state root sees the
    // durable claim: the progress is not an in-process illusion.
    const status = await runCli(
      ["status", "--operation", prepared.operationId, "--json"],
      { env: space.env, cwd: space.root, overrides },
    );
    const view = parseEnvelope(status)["result"].operation;

    expect(view.phase).toBe("execution");
    expect(view.status).toBe("running");
    expect(view.deliveries[0].state).toBe("in_flight");
    expect(sent).toBe(1);

    // The same read in human mode names the state honestly: an unfinished
    // stored claim is a recorded fact, never "currently publishing".
    const human = await runCli(
      ["status", "--operation", prepared.operationId],
      { env: space.env, cwd: space.root, overrides },
    );

    expect(human.exit).toBe(0);
    expect(human.stdout).toContain("Status:\n  Last recorded status: Publishing");
    // Reading the recorded claim made no provider request of its own.
    expect(sent).toBe(1);

    gate.resolve();

    const result = await running as { status: string; deliveries: readonly { outcome?: { status?: string } }[] };

    expect(events.map((event) => event.type)).toEqual(["admitted", "claimed", "recorded", "finished"]);
    expect(result.status).toBe("succeeded");
    expect(result.deliveries[0]?.outcome?.status).toBe("succeeded");
    expect(sent).toBe(1);
  });
});
