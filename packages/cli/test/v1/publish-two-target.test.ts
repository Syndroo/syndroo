import { promises as fs } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import type {
  AccountIdentity,
  CredentialBundle,
  ProviderConnectInput,
  ProviderContext,
  ProviderHttpResult,
  ProviderPlugin,
  ProviderTransport,
  VerifiedIdentity,
} from "@syndroo/provider-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { createFakeProvider } from "../../../../tests/fixtures/providers/fake.js";
import { loadConfig, resolveConfigPath } from "../../src/config.js";
import { run } from "../../src/index.js";
import type { CliIo } from "../../src/io.js";
import {
  createLocalRuntime,
  type LocalRuntimeOverrides,
} from "../../src/runtime/local/composition.js";
import { parseEnvelope, runCli, sandbox, type Sandbox } from "./support/harness.js";
import { fakeRegistry } from "./support/registry.js";

/**
 * The real CLI `execute` path with two targets over the filesystem state store.
 *
 * The earlier single-target test proves the notification contract through
 * `core.publish` directly; it cannot prove what the shipped command does. This
 * test drives `syndroo publish --input -` with an execute document, so the whole
 * path is exercised: the approval token, the controller `ctx.output()` builds,
 * the shared renderer and the durable filesystem claims.
 *
 * The fixture returns one constant identity, so an extra provider wrapper
 * derives the account from the credential: only then can two connections exist
 * and the first target be `Publishing` while the second is still `Waiting`.
 */

const ORIGIN = "https://fake.example";
const CANARY_ONE = "two-target-canary-one";
const CANARY_TWO = "two-target-canary-two";
const ACCOUNT_ONE = "acct_two_target_0001";
const ACCOUNT_TWO = "acct_two_target_0002";

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
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (check()) {
      return;
    }

    await new Promise((resolved) => setTimeout(resolved, 1));
  }

  throw new Error("condition was never met");
}

function accountFor(canary: unknown): AccountIdentity {
  return {
    provider: "fake",
    accountId: canary === CANARY_TWO ? ACCOUNT_TWO : ACCOUNT_ONE,
    origin: ORIGIN,
  };
}

/** The fixture identity is a constant; derive it from the credential instead. */
function twoAccountPlugin(): ProviderPlugin {
  const base = createFakeProvider();

  return {
    ...base,
    connect: {
      ...base.connect,
      async run(
        input: ProviderConnectInput,
        context: ProviderContext,
      ): Promise<Awaited<ReturnType<ProviderPlugin["connect"]["run"]>>> {
        const result = await base.connect.run(input, context);

        if (result.status !== "done") {
          return result;
        }

        const canary =
          input.type === "resume" && input.input.type === "credentials"
            ? input.input.credentials["canary"]
            : undefined;

        // The fixture always stores its own constant credential, so the round
        // trip above would lose the discriminator; keep the supplied canary so
        // a later prepare re-verifies against the same account.
        return {
          ...result,
          ...(typeof canary === "string" ? { credentials: { canary } } : {}),
          identity: { ...result.identity, account: accountFor(canary) },
        };
      },
      async verify(
        credentials: CredentialBundle,
        context: ProviderContext,
      ): Promise<VerifiedIdentity> {
        const verified = await base.connect.verify(credentials, context);

        return { ...verified, account: accountFor(credentials["canary"]) };
      },
    },
  };
}

type Capture = {
  readonly io: CliIo;
  readonly text: () => string;
};

/**
 * One controllable in-process invocation.
 *
 * `text()` reads the accumulated stdout while the run is still in flight, which
 * is what lets the test observe the intermediate `Publishing`/`Waiting` block.
 * `failStdout` models a stdout that refuses every write: the controller must
 * mark itself failed without changing the publication.
 */
function makeIo(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdin: string;
  readonly signal: AbortSignal;
  readonly failStdout?: boolean;
}): Capture {
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];

  const collect = (target: Buffer[]) => (chunk: Buffer | string, _encoding: string, done: () => void) => {
    target.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf8"));
    done();
  };

  const stdout = new Writable({ write: collect(outChunks) });
  const stderr = new Writable({ write: collect(errChunks) });

  if (input.failStdout === true) {
    stdout.write = (() => {
      throw new Error("EPIPE");
    }) as typeof stdout.write;
  }

  const io: CliIo = {
    stdin: Readable.from([Buffer.from(input.stdin, "utf8")]),
    stdout,
    stderr,
    env: input.env,
    cwd: input.cwd,
    stdinIsTty: false,
    stdoutIsTty: false,
    hasTty: () => false,
    readTtyLine: () => undefined,
    signal: input.signal,
  };

  return { io, text: () => Buffer.concat(outChunks).toString("utf8") };
}

type ConnectionSetup = {
  readonly space: Sandbox;
  readonly connectionOne: string;
  readonly connectionTwo: string;
  readonly overrides: LocalRuntimeOverrides;
};

/** Two distinct accounts, each connected through the CLI, in one scratch root. */
async function twoConnections(
  transport: ProviderTransport,
): Promise<ConnectionSetup> {
  const space = await sandbox("syndroo-cli-two-target-");

  boxes.push(space);

  const credentialOne = path.join(space.root, "credential-one.json");
  const credentialTwo = path.join(space.root, "credential-two.json");

  await fs.writeFile(credentialOne, JSON.stringify({ canary: CANARY_ONE }));
  await fs.writeFile(credentialTwo, JSON.stringify({ canary: CANARY_TWO }));

  const overrides: LocalRuntimeOverrides = {
    providers: fakeRegistry(twoAccountPlugin()),
    transport,
  };
  const runOptions = { env: space.env, cwd: space.root, overrides };

  const first = await runCli(
    ["connect", "fake", "--credential-file", credentialOne, "--json"],
    runOptions,
  );
  const second = await runCli(
    ["connect", "fake", "--credential-file", credentialTwo, "--json"],
    runOptions,
  );
  const connectionOne = parseEnvelope(first)["result"].connection.connectionId as string;
  const connectionTwo = parseEnvelope(second)["result"].connection.connectionId as string;

  expect(connectionOne).not.toBe(connectionTwo);

  return { space, connectionOne, connectionTwo, overrides };
}

async function prepareTwoTargets(setup: ConnectionSetup): Promise<{
  operationId: string;
  approvalToken: string;
}> {
  const config = await loadConfig(resolveConfigPath(setup.space.env), setup.space.env);
  const runtime = createLocalRuntime(config, setup.overrides);

  return (await runtime.core.publish(
    {
      type: "prepare",
      content: { text: "two targets, one round" },
      targets: [
        { provider: "fake", connection: setup.connectionOne },
        { provider: "fake", connection: setup.connectionTwo },
      ],
    },
    { principalId: "local", idempotencyKey: "prepare-two", signal: new AbortController().signal },
  )) as { operationId: string; approvalToken: string };
}

async function statusOperation(
  setup: ConnectionSetup,
  operationId: string,
): Promise<Record<string, any>> {
  const result = await runCli(
    ["status", "--operation", operationId, "--json"],
    { env: setup.space.env, cwd: setup.space.root, overrides: setup.overrides },
  );

  return parseEnvelope(result)["result"].operation as Record<string, any>;
}

describe("publish execute with two targets over the filesystem runtime", () => {
  it("shows the first target publishing and the second waiting, then finishes both serially", async () => {
    const gate = deferred<void>();
    const ok: ProviderHttpResult = { type: "response", status: 200, headers: {}, body: "{}" };
    let sent = 0;
    let blockNext = false;
    const transport: ProviderTransport = {
      async request() {
        sent += 1;

        if (blockNext) {
          blockNext = false;
          await gate.promise;
        }

        return ok;
      },
    };
    const setup = await twoConnections(transport);
    const prepared = await prepareTwoTargets(setup);

    blockNext = true;

    const capture = makeIo({
      env: setup.space.env,
      cwd: setup.space.root,
      signal: new AbortController().signal,
      stdin: JSON.stringify({ type: "execute", approvalToken: prepared.approvalToken }),
    });
    const running = run(["publish", "--input", "-"], capture.io, setup.overrides);

    // The first provider request is in flight: the round must already have both
    // statuses on screen, and the durable record must match it exactly.
    await waitFor(() => capture.text().includes("Publishing"));

    expect(capture.text()).toContain("Waiting");
    // The intermediate block is pre-completion: no target reads as finished.
    expect(capture.text()).not.toContain("Successful");
    expect(sent).toBe(1);

    const mid = await statusOperation(setup, prepared.operationId);

    expect(mid.deliveries).toHaveLength(2);
    expect(mid.deliveries[0].state).toBe("in_flight");
    expect(mid.deliveries[0].attempts).toBe(1);
    expect(mid.deliveries[0].outcome).toBeNull();
    expect(mid.deliveries[1].state).toBe("ready");
    expect(mid.deliveries[1].attempts).toBe(0);
    expect(mid.status).toBe("running");

    // Reading the stored claim never calls the provider, and the second target
    // was not claimed while the first was blocked: the claims are serial.
    expect(sent).toBe(1);

    gate.resolve();

    expect(await running).toBe(0);
    expect(sent).toBe(2);

    const finalText = capture.text();

    // The appended log prints changed lines as they happen and the complete
    // final result once, so both targets read as successful at the end.
    expect(finalText.match(/Successful/g)?.length).toBeGreaterThanOrEqual(2);
    expect(finalText).toContain("Summary: 2 successful");

    const after = await statusOperation(setup, prepared.operationId);

    expect(after.status).toBe("succeeded");
    expect(after.deliveries.map((delivery: Record<string, any>) => delivery.attempts)).toEqual([1, 1]);
    expect(after.deliveries.map((delivery: Record<string, any>) => delivery.outcome.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
  });

  it("keeps the durable outcome when stdout fails and never sends a target twice", async () => {
    const ok: ProviderHttpResult = { type: "response", status: 200, headers: {}, body: "{}" };
    let sent = 0;
    const transport: ProviderTransport = {
      async request() {
        sent += 1;

        return ok;
      },
    };
    const setup = await twoConnections(transport);
    const prepared = await prepareTwoTargets(setup);

    const capture = makeIo({
      env: setup.space.env,
      cwd: setup.space.root,
      signal: new AbortController().signal,
      stdin: JSON.stringify({ type: "execute", approvalToken: prepared.approvalToken }),
      failStdout: true,
    });
    const exit = await run(["publish", "--input", "-"], capture.io, setup.overrides);

    // A broken output channel is an output failure, never a publication fact:
    // the exit is non-zero, but exactly one request reached each target.
    expect(exit).toBe(1);
    expect(sent).toBe(2);
    expect(capture.text()).toBe("");

    const after = await statusOperation(setup, prepared.operationId);

    expect(after.status).toBe("succeeded");
    expect(after.deliveries.map((delivery: Record<string, any>) => delivery.attempts)).toEqual([1, 1]);
    expect(after.deliveries.map((delivery: Record<string, any>) => delivery.outcome.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
  });
});
