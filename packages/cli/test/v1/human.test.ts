import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ProviderConnectResult,
  ProviderHttpRequest,
  ProviderPlugin,
  ProviderTransport,
} from "@syndroo/provider-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  FAKE_ACCOUNT,
  FAKE_SECRET_CANARY,
  createFakeProvider,
} from "../../../../tests/fixtures/providers/fake.js";
import type { LocalRuntimeOverrides } from "../../src/runtime/local/composition.js";
import {
  parseEnvelope,
  runCli,
  sandbox,
  type RunOptions,
  type RunResult,
  type Sandbox,
} from "./support/harness.js";
import { fakeRegistry } from "./support/registry.js";

/**
 * The human interactive paths B3b adds on top of the machine surface.
 *
 * Every call goes through the real `run()` parser, the real filesystem runtime
 * and the real Core use cases, driven by a scripted fake controlling terminal.
 * Only two seams are injected, exactly as in `loop.test.ts`: a registry over
 * the deterministic fake plugin and a transport that records requests and never
 * opens a socket. The terminal double records how many times each reader ran,
 * so a test can prove a prompt did *not* happen rather than only that its text
 * is absent.
 */

const boxes: Sandbox[] = [];

afterEach(async () => {
  await Promise.all(boxes.splice(0).map((created) => created.cleanup()));
});

type RunExtra = Partial<Omit<RunOptions, "cwd" | "overrides">>;

type Harness = {
  readonly space: Sandbox;
  readonly overrides: LocalRuntimeOverrides;
  readonly sent: () => number;
  readonly requests: () => readonly ProviderHttpRequest[];
  run(argv: readonly string[], extra?: RunExtra): Promise<RunResult>;
};

async function makeHarness(plugin: ProviderPlugin = createFakeProvider()): Promise<Harness> {
  const space = await sandbox("syndroo-cli-human-");

  boxes.push(space);

  const captured: ProviderHttpRequest[] = [];
  const transport: ProviderTransport = {
    async request(input) {
      captured.push(input);

      return { type: "response", status: 200, headers: {}, body: "{}" };
    },
  };
  const overrides: LocalRuntimeOverrides = { providers: fakeRegistry(plugin), transport };
  const run = (argv: readonly string[], extra: RunExtra = {}): Promise<RunResult> =>
    runCli(argv, { env: space.env, cwd: space.root, overrides, ...extra });

  return { space, overrides, sent: () => captured.length, requests: () => captured, run };
}

type Arrangement = Harness & {
  readonly connectionId: string;
  readonly document: string;
};

async function arrange(plugin: ProviderPlugin = createFakeProvider()): Promise<Arrangement> {
  const harness = await makeHarness(plugin);
  const credential = path.join(harness.space.root, "credential.json");

  await fs.writeFile(credential, JSON.stringify({ canary: FAKE_SECRET_CANARY }));

  const connected = await harness.run([
    "connect",
    "fake",
    "--credential-file",
    credential,
    "--json",
  ]);
  const connectionId = parseEnvelope(connected)["result"].connection.connectionId as string;
  const document = path.join(harness.space.root, "document.json");

  await fs.writeFile(
    document,
    JSON.stringify({ content: { text: "Human path fixture text." }, targets: [{ provider: "fake" }] }),
  );

  return { ...harness, connectionId, document };
}

describe("human connect", () => {
  it("prompts each credential field and never prints the typed secret", async () => {
    const typedSecret = "typed-secret-canary-4f2a9c";
    const base = createFakeProvider();
    const plugin: ProviderPlugin = {
      ...base,
      connect: {
        ...base.connect,
        async run(input, context): Promise<ProviderConnectResult> {
          if (input.type === "start") {
            return {
              status: "action_required",
              action: {
                type: "credential_input",
                fields: [
                  { name: "handle", label: "Handle", secret: false },
                  { name: "canary", label: "Access token", secret: true },
                ],
              },
              privateState: {},
            };
          }

          return {
            status: "done",
            credentials: { canary: FAKE_SECRET_CANARY },
            identity: {
              account: FAKE_ACCOUNT,
              evidence: [
                {
                  capability: "identity",
                  value: "supported",
                  source: "fake.example",
                  verifiedAt: context.now,
                },
              ],
            },
          };
        },
      },
    };
    const harness = await makeHarness(plugin);
    const calls = { tty: 0, hidden: 0 };
    const result = await harness.run(["connect", "fake"], {
      tty: { hasTty: true, lines: ["alice"], hiddenLines: [typedSecret], calls },
    });

    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("Connection ready");
    expect(result.stdout).toContain("Handle: ");
    expect(result.stdout).toContain("Access token (secret): ");
    expect(calls.tty).toBe(1);
    expect(calls.hidden).toBe(1);

    for (const text of [result.stdout, result.stderr]) {
      expect(text).not.toContain(typedSecret);
      expect(text).not.toContain(FAKE_SECRET_CANARY);
    }

    const view = await harness.run(["status", "--connections", "--json"]);
    const envelope = parseEnvelope(view);

    expect(envelope["result"].connections).toHaveLength(1);
    expect(JSON.stringify(envelope)).not.toContain(typedSecret);
    expect(JSON.stringify(envelope)).not.toContain(FAKE_SECRET_CANARY);
  });

  it("does not prompt and reports the pending action in --json", async () => {
    const harness = await makeHarness();
    const calls = { tty: 0, hidden: 0 };
    const result = await harness.run(["connect", "fake", "--json"], {
      tty: { hasTty: true, lines: ["alice"], hiddenLines: ["typed-secret"], calls },
    });

    expect(result.exit).toBe(0);
    expect(calls.tty).toBe(0);
    expect(calls.hidden).toBe(0);
    expect(parseEnvelope(result)["result"]).toMatchObject({
      status: "action_required",
      action: { type: "credential_input" },
    });
    expect(result.stdout).not.toContain("[y/N]");
  });

  it("does not prompt and reports the pending action without a terminal", async () => {
    const harness = await makeHarness();
    const calls = { tty: 0, hidden: 0 };
    const result = await harness.run(["connect", "fake"], {
      tty: { hasTty: false, lines: ["alice"], hiddenLines: ["typed-secret"], calls },
    });

    expect(result.exit).toBe(0);
    expect(calls.tty).toBe(0);
    expect(calls.hidden).toBe(0);
    expect(result.stdout).toContain("Connection action required");
    expect(result.stdout).not.toContain("Access token (secret):");
  });
});

describe("human publish", () => {
  it("executes only after an explicit yes and renders the execution result", async () => {
    const arrangement = await arrange();
    const calls = { tty: 0, hidden: 0 };
    const result = await arrangement.run(["publish", "--input", arrangement.document], {
      tty: { hasTty: true, lines: ["yes"], calls },
    });

    expect(result.exit).toBe(0);
    expect(calls.tty).toBe(1);
    expect(arrangement.sent()).toBe(1);
    expect(result.stdout).toContain("Confirm this publication?");
    expect(result.stdout).toContain("Execution");
    expect(result.stdout).toContain("succeeded");
  });

  it("declines anything but an unambiguous yes, prints the later command and sends nothing", async () => {
    const arrangement = await arrange();

    for (const answer of ["", "n", "no", "yep", "sure"]) {
      const result = await arrangement.run(["publish", "--input", arrangement.document], {
        tty: { hasTty: true, lines: [answer] },
      });

      expect(result.exit).toBe(5);
      expect(result.stdout).toContain("operation:");
      expect(result.stdout).toContain("syndroo publish --input -");
    }

    expect(arrangement.sent()).toBe(0);
  });

  it("prints the preview and the later command without executing on a non-TTY", async () => {
    const arrangement = await arrange();
    const calls = { tty: 0, hidden: 0 };
    const result = await arrangement.run(["publish", "--input", arrangement.document], {
      tty: { hasTty: false, lines: ["yes"], calls },
    });

    expect(result.exit).toBe(0);
    expect(calls.tty).toBe(0);
    expect(arrangement.sent()).toBe(0);
    expect(result.stdout).toContain("Confirm this publication");
    expect(result.stdout).toContain("nothing was sent");
    expect(result.stdout).toContain("syndroo publish --input -");
    expect(result.stdout).not.toContain("[y/N]");
  });

  it("never prompts in --json and keeps the confirmation envelope", async () => {
    const arrangement = await arrange();
    const calls = { tty: 0, hidden: 0 };
    const result = await arrangement.run(["publish", "--input", arrangement.document, "--json"], {
      tty: { hasTty: true, lines: ["yes"], calls },
    });

    expect(result.exit).toBe(0);
    expect(calls.tty).toBe(0);
    expect(calls.hidden).toBe(0);
    expect(arrangement.sent()).toBe(0);
    expect(result.stdout).not.toContain("[y/N]");
    expect(parseEnvelope(result)["result"]).toMatchObject({ status: "confirmation_required" });
  });

  it("emits no ANSI in --json even when colour would otherwise be enabled", async () => {
    const arrangement = await arrange();
    const env = { ...arrangement.space.env };

    delete env["NO_COLOR"];

    const result = await arrangement.run(["publish", "--input", arrangement.document, "--json"], {
      env,
      stdoutIsTty: true,
      tty: { hasTty: true, lines: ["yes"] },
    });

    expect(result.exit).toBe(0);
    expect(result.stdout).not.toContain("\u001b[");
  });

  it("colours human output only when stdout is a TTY and NO_COLOR is absent", async () => {
    const arrangement = await arrange();
    const coloredEnv = { ...arrangement.space.env };

    delete coloredEnv["NO_COLOR"];

    const colored = await arrangement.run(["publish", "--input", arrangement.document], {
      env: coloredEnv,
      stdoutIsTty: true,
      tty: { hasTty: false },
    });

    expect(colored.exit).toBe(0);
    expect(colored.stdout).toContain("\u001b[1m");

    const plain = await arrangement.run(["publish", "--input", arrangement.document], {
      env: arrangement.space.env,
      stdoutIsTty: true,
      tty: { hasTty: false },
    });

    expect(plain.exit).toBe(0);
    expect(plain.stdout).not.toContain("\u001b[");
  });

  it("escapes control characters in the preview while the frozen payload is unchanged", async () => {
    const raw = "line\u0007esc\u001b[31m data";
    const base = createFakeProvider();
    const plugin: ProviderPlugin = {
      ...base,
      async publish(input) {
        await input.context.transport.request({
          url: "https://fake.example/v1/publish",
          method: "POST",
          body: input.frozen.effectiveContent.text ?? "",
          signal: input.context.signal,
        });

        return { status: "succeeded", remoteId: "fake_control" };
      },
    };
    const arrangement = await arrange(plugin);

    await fs.writeFile(
      arrangement.document,
      JSON.stringify({ content: { text: raw }, targets: [{ provider: "fake" }] }),
    );

    const result = await arrangement.run(["publish", "--input", arrangement.document], {
      tty: { hasTty: true, lines: ["yes"] },
    });

    expect(result.exit).toBe(0);
    expect(arrangement.sent()).toBe(1);
    expect(result.stdout).toContain("\\x07");
    expect(result.stdout).toContain("\\x1b");
    expect(result.stdout).not.toContain("\u0007");
    expect(result.stdout).not.toContain("\u001b");
    expect(arrangement.requests()[0]?.body).toBe(raw);
  });
});
