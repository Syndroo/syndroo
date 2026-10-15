import { promises as fs } from "node:fs";
import path from "node:path";

import type { Clock, Implementation } from "@syndroo/core";
import type {
  AccountPresentation,
  ProviderPlugin,
  ProviderTransport,
} from "@syndroo/provider-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
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
import { FAKE_IMPLEMENTATION, fakeRegistry } from "./support/registry.js";

/**
 * The confirmation contract (design §5–§7, T04, T05, T06, T10).
 *
 * Every call goes through the real `run()` parser, the real filesystem runtime
 * and the real Core use cases. Only the provider registry and the transport are
 * injected, exactly as in the other CLI v1 tests, and the controlling terminal
 * is a scripted double that also records the read deadline of every prompt.
 *
 * The properties proven here are the ones a renderer cannot prove on its own:
 * `--yes` never skips a frozen-intent check, `v` never re-reads the input, never
 * re-prepares and never extends the deadline, a changed file or binding or
 * provider cannot be published under an old authorization, and `--json` stays
 * exactly one machine envelope.
 */

const boxes: Sandbox[] = [];

afterEach(async () => {
  await Promise.all(boxes.splice(0).map((box) => box.cleanup()));
});

const DEFAULT_TEXT = "The confirmation fixture text.";
const LONG_TEXT = "Line one\nLine two\nLine three\nLine four\nLine five";
const LATER = "2026-10-08T01:00:00.000Z";

/**
 * `env` and `rows` are overridable so a test can put the output controller on
 * a redraw-capable terminal without leaving the isolated sandbox environment.
 */
type RunExtra = Partial<Omit<RunOptions, "cwd" | "overrides">>;
type PublishOutcome = "ok" | "rate_limited" | "unknown";

type Hooks = {
  readonly frozenTexts: string[];
  readonly verifyCalls: { count: number };
  readonly outcomes: PublishOutcome[];
  readonly presentation?: AccountPresentation;
};

function buildProvider(hooks: Hooks, version?: string): ProviderPlugin {
  const base = createFakeProvider(version === undefined ? {} : { version });
  let index = 0;

  return {
    ...base,
    connect: {
      ...base.connect,
      async verify(credentials, context) {
        hooks.verifyCalls.count += 1;

        const identity = await base.connect.verify(credentials, context);

        return hooks.presentation === undefined
          ? identity
          : { ...identity, presentation: hooks.presentation };
      },
    },
    async publish(input) {
      hooks.frozenTexts.push(input.frozen.effectiveContent.text ?? "");

      const mode = hooks.outcomes[index] ?? "ok";

      index += 1;

      const response = await input.context.transport.request({
        url: "https://fake.example/v1/publish",
        method: "POST",
        body: JSON.stringify({ submissionId: input.submissionId }),
        signal: input.context.signal,
      });

      if (mode === "unknown") {
        return { status: "unknown", disposition: "unknown", reason: "network" };
      }

      if (mode === "rate_limited") {
        return {
          status: "failed",
          disposition: "not_applied",
          retryable: true,
          reason: "rate_limited",
        };
      }

      if (response.type === "response" && response.status === 200) {
        return {
          status: "succeeded",
          remoteId: `fake_${input.submissionId}`,
          url: `https://fake.example/fake_${input.submissionId}`,
        };
      }

      return { status: "failed", disposition: "not_applied", retryable: true, reason: "network" };
    },
  };
}

type ArrangeOptions = {
  readonly text?: string;
  readonly clock?: Clock;
  readonly outcomes?: readonly PublishOutcome[];
  readonly presentation?: AccountPresentation;
};

type Harness = {
  readonly space: Sandbox;
  readonly document: string;
  readonly connectionId: string;
  readonly credential: string;
  readonly hooks: Hooks;
  readonly sent: () => number;
  readonly overrides: LocalRuntimeOverrides;
  run(argv: readonly string[], extra?: RunExtra): Promise<RunResult>;
  runWith(
    overrides: LocalRuntimeOverrides,
    argv: readonly string[],
    extra?: RunExtra,
  ): Promise<RunResult>;
};

async function arrange(options: ArrangeOptions = {}): Promise<Harness> {
  const space = await sandbox("syndroo-cli-confirm-");

  boxes.push(space);

  const hooks: Hooks = {
    frozenTexts: [],
    verifyCalls: { count: 0 },
    outcomes: [...(options.outcomes ?? [])],
    ...(options.presentation === undefined ? {} : { presentation: options.presentation }),
  };
  const plugin = buildProvider(hooks);
  let sent = 0;
  const transport: ProviderTransport = {
    async request() {
      sent += 1;

      return { type: "response", status: 200, headers: {}, body: "{}" };
    },
  };
  const overrides: LocalRuntimeOverrides = {
    providers: fakeRegistry(plugin),
    transport,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  };
  const runWith = (
    current: LocalRuntimeOverrides,
    argv: readonly string[],
    extra: RunExtra = {},
  ): Promise<RunResult> =>
    runCli(argv, { env: space.env, cwd: space.root, overrides: current, ...extra });
  const credential = path.join(space.root, "credential.json");

  await fs.writeFile(credential, JSON.stringify({ canary: FAKE_SECRET_CANARY }));

  const connected = await runWith(overrides, [
    "connect",
    "fake",
    "--credential-file",
    credential,
    "--json",
  ]);
  const connectionId = parseEnvelope(connected)["result"].connection.connectionId as string;
  const document = path.join(space.root, "document.json");

  await fs.writeFile(
    document,
    JSON.stringify({
      content: { text: options.text ?? DEFAULT_TEXT },
      targets: [{ provider: "fake" }],
    }),
  );

  return {
    space,
    document,
    connectionId,
    credential,
    hooks,
    sent: () => sent,
    overrides,
    run: (argv, extra = {}) => runWith(overrides, argv, extra),
    runWith,
  };
}

function implementation(version: string): Implementation {
  return { ...FAKE_IMPLEMENTATION, version };
}

describe("publish --yes", () => {
  it("--yes --json writes exactly one final execution envelope and never a prepared token", async () => {
    const harness = await arrange();
    const result = await harness.run([
      "publish",
      "--input",
      harness.document,
      "--yes",
      "--json",
    ]);

    expect(result.exit).toBe(0);

    const envelope = parseEnvelope(result);

    expect(envelope["operation"]).toBe("publish");
    expect(envelope["result"]).toMatchObject({ phase: "execution", status: "succeeded" });
    expect(result.stdout).not.toContain("approvalToken");
    expect(result.stdout).not.toContain("confirmation_required");
    expect(result.stdout).not.toContain("\u001b[");
    expect(harness.sent()).toBe(1);
    expect(harness.hooks.frozenTexts).toEqual([DEFAULT_TEXT]);
  });

  it("--json without --yes stays prepared, prompts nothing and sends nothing", async () => {
    const harness = await arrange();
    const calls = { tty: 0, hidden: 0 };
    const result = await harness.run(["publish", "--input", harness.document, "--json"], {
      tty: { hasTty: true, lines: ["yes"], calls },
    });

    expect(result.exit).toBe(0);
    expect(calls.tty).toBe(0);
    expect(parseEnvelope(result)["result"]).toMatchObject({ status: "confirmation_required" });
    expect(harness.sent()).toBe(0);
  });

  it("without a confirmable terminal only prepares and prints the later command", async () => {
    const harness = await arrange();
    const calls = { tty: 0, hidden: 0 };
    const result = await harness.run(["publish", "--input", harness.document], {
      tty: { hasTty: false, lines: ["yes"], calls },
    });

    expect(result.exit).toBe(0);
    expect(calls.tty).toBe(0);
    expect(harness.sent()).toBe(0);
    expect(result.stdout).toContain("Review publication — nothing has been sent");
    expect(result.stdout).toContain("no terminal is available: nothing was sent");
    expect(result.stdout).toContain("syndroo publish --input -");
    expect(result.stdout).not.toContain("[y/N/v]");
  });

  it("--dry-run --yes stays offline and never sends", async () => {
    const harness = await arrange();
    const result = await harness.run([
      "publish",
      "--input",
      harness.document,
      "--dry-run",
      "--yes",
    ]);

    expect(result.exit).toBe(0);
    expect(harness.sent()).toBe(0);
    expect(result.stdout).toContain("Preview only");
    expect(harness.hooks.frozenTexts).toEqual([]);
  });

  it("an explicit execute request plus --yes executes the given token without a new prepare", async () => {
    const harness = await arrange();
    const prepared = await harness.run(["publish", "--input", harness.document, "--json"]);
    const token = parseEnvelope(prepared)["result"].approvalToken as string;
    const executed = await harness.run(
      ["publish", "--input", "-", "--json", "--yes"],
      { stdin: JSON.stringify({ type: "execute", approvalToken: token }) },
    );

    expect(executed.exit).toBe(0);
    expect(parseEnvelope(executed)["result"]).toMatchObject({
      phase: "execution",
      status: "succeeded",
    });
    expect(harness.sent()).toBe(1);
    // `--yes` must not add a second prepare: verify runs once, for the prepare.
    expect(harness.hooks.verifyCalls.count).toBe(1);
  });
});

describe("interactive confirmation", () => {
  it("v shows the full frozen preview, an unknown answer re-asks, and only y publishes once", async () => {
    const harness = await arrange({ text: LONG_TEXT });
    const writes = { text: "" };
    const limits: number[] = [];
    const snapshots: number[] = [];
    const result = await harness.run(["publish", "--input", harness.document], {
      tty: {
        hasTty: true,
        lines: ["v", "maybe", "view", "y"],
        writes,
        limits,
        onRead: () => {
          snapshots.push(writes.text.length);
        },
      },
    });

    expect(result.exit).toBe(0);
    expect(harness.sent()).toBe(1);
    expect(harness.hooks.frozenTexts).toEqual([LONG_TEXT]);
    expect(snapshots).toHaveLength(4);

    const shortened = writes.text.slice(0, snapshots[0]);
    const expanded = writes.text.slice(snapshots[0], snapshots[1]);

    expect(shortened).toContain("Review publication — nothing has been sent");
    expect(shortened).toContain("Some content is shortened");
    expect(shortened).not.toContain("Line five");
    expect(expanded).toContain("Line five");
    expect(expanded).toContain("Publish to 1 account? [y/N/v]");

    // `v` never refreshes the read deadline. The remaining time is computed
    // from one fixed instant, so it can only shrink by elapsed milliseconds,
    // never jump back up to a fresh window.
    expect(limits.length).toBeGreaterThan(1);
    expect(limits[0]).toBeGreaterThan(0);
    for (let index = 1; index < limits.length; index += 1) {
      expect(limits[index]).toBeLessThanOrEqual(limits[index - 1] as number);
    }

    // The machine answer is the executed round only, never the prompt.
    expect(result.stdout).not.toContain("[y/N/v]");
    expect(result.stdout).toContain("Status:");
    expect(result.stdout).toContain("Successful");
  });

  it("cancels on an empty answer, on n, and at end of input without sending", async () => {
    for (const answers of [[""], ["n"], ["no"], []]) {
      const harness = await arrange();
      const result = await harness.run(["publish", "--input", harness.document], {
        tty: { hasTty: true, lines: answers, writes: { text: "" } },
      });

      expect(result.exit).toBe(5);
      expect(result.stdout).toContain("declined: nothing was sent");
      expect(result.stdout).toContain("syndroo publish --input -");
      expect(harness.sent()).toBe(0);
    }
  });

  it("keeps the frozen payload when the input file changes while the human decides", async () => {
    const harness = await arrange({ text: DEFAULT_TEXT });
    const result = await harness.run(["publish", "--input", harness.document], {
      tty: {
        hasTty: true,
        lines: ["v", "y"],
        writes: { text: "" },
        onRead: (index) => {
          if (index === 0) {
            void fs.writeFile(
              harness.document,
              JSON.stringify({ content: { text: "tampered" }, targets: [{ provider: "fake" }] }),
            );
          }
        },
      },
    });

    expect(result.exit).toBe(0);
    expect(harness.sent()).toBe(1);
    expect(harness.hooks.frozenTexts).toEqual([DEFAULT_TEXT]);
  });

  it("refuses an expired approval after v and y without sending", async () => {
    let now = "2026-10-08T00:00:00.000Z";
    const clock: Clock = { now: () => now };
    const harness = await arrange({ clock });
    const result = await harness.run(["publish", "--input", harness.document], {
      tty: {
        hasTty: true,
        lines: ["v", "y"],
        writes: { text: "" },
        onRead: (index) => {
          if (index === 0) {
            now = LATER;
          }
        },
      },
    });

    expect(result.exit).toBe(2);
    expect(harness.sent()).toBe(0);
    expect(result.stdout).toContain("the approval window has closed");
    expect(result.stderr).toContain("The approval window has closed.");
  });
});

describe("stale authorization", () => {
  it("refuses an execute token after the connection was reconnected", async () => {
    const harness = await arrange();
    const prepared = await harness.run(["publish", "--input", harness.document, "--json"]);
    const token = parseEnvelope(prepared)["result"].approvalToken as string;

    const again = await harness.run([
      "connect",
      "fake",
      "--credential-file",
      harness.credential,
      "--json",
    ]);

    // The stable identity is unchanged; only the binding revision rotated, and
    // the execute below is what proves the old authorization no longer binds.
    expect(parseEnvelope(again)["result"].connection.connectionId).toBe(harness.connectionId);

    const executed = await harness.run(
      ["publish", "--input", "-", "--json"],
      { stdin: JSON.stringify({ type: "execute", approvalToken: token }) },
    );

    expect(executed.exit).toBe(2);
    expect(parseEnvelope(executed)["error"].code).toBe("STALE_BINDING");
    expect(harness.sent()).toBe(0);
  });

  it("refuses an execute token after the provider implementation changed", async () => {
    const harness = await arrange();
    const prepared = await harness.run(["publish", "--input", harness.document, "--json"]);
    const token = parseEnvelope(prepared)["result"].approvalToken as string;
    const bumped: LocalRuntimeOverrides = {
      ...harness.overrides,
      providers: fakeRegistry(
        buildProvider(harness.hooks, "2.0.0"),
        implementation("2.0.0"),
      ),
    };
    const executed = await harness.runWith(
      bumped,
      ["publish", "--input", "-", "--json"],
      { stdin: JSON.stringify({ type: "execute", approvalToken: token }) },
    );

    expect(executed.exit).toBe(2);
    expect(parseEnvelope(executed)["error"].code).toBe("STALE_INTENT");
    expect(harness.sent()).toBe(0);
  });
});

describe("confirmation window visibility", () => {
  it("hides the expiry in the plain preview and shows it in verbose and JSON", async () => {
    const harness = await arrange();
    const plainWrites = { text: "" };
    const verboseWrites = { text: "" };
    const plain = await harness.run(["publish", "--input", harness.document], {
      tty: { hasTty: true, lines: ["n"], writes: plainWrites },
    });
    const verbose = await harness.run(
      ["publish", "--input", harness.document, "--verbose"],
      { tty: { hasTty: true, lines: ["n"], writes: verboseWrites } },
    );
    const machine = await harness.run(["publish", "--input", harness.document, "--json"]);
    const expiresAt = parseEnvelope(machine)["result"].expiresAt as string;

    expect(plain.exit).toBe(5);
    expect(plainWrites.text).not.toContain("Expires:");
    expect(plainWrites.text).toContain("Awaiting confirmation");
    expect(verboseWrites.text).toContain("Expires:");
    expect(verboseWrites.text).toMatch(/Expires: 20\d\d-\d\d-\d\dT/);
    expect(verboseWrites.text).toContain("minutes remaining");
    expect(expiresAt).toMatch(/^20\d\d-\d\d-\d\dT/);
    expect(expiresAt).toBeDefined();
    expect(harness.sent()).toBe(0);
  });
});

describe("retry with --yes", () => {
  it("retries only the selected not_applied target and never the unknown one", async () => {
    const retryable = await arrange({ outcomes: ["rate_limited", "ok"] });
    const first = await retryable.run([
      "publish",
      "--input",
      retryable.document,
      "--yes",
      "--json",
    ]);
    const operationId = parseEnvelope(first)["result"].operationId as string;

    expect(parseEnvelope(first)["result"].status).toBe("failed");
    expect(retryable.sent()).toBe(1);

    const retried = await retryable.run(
      ["publish", "--retry", operationId, "--to", retryable.connectionId, "--yes", "--json"],
    );

    expect(retried.exit).toBe(0);
    expect(parseEnvelope(retried)["result"]).toMatchObject({ status: "succeeded" });
    expect(retryable.sent()).toBe(2);

    const unknown = await arrange({ outcomes: ["unknown"] });
    const attempted = await unknown.run([
      "publish",
      "--input",
      unknown.document,
      "--yes",
      "--json",
    ]);
    const unknownId = parseEnvelope(attempted)["result"].operationId as string;

    expect(parseEnvelope(attempted)["result"].status).toBe("unknown");

    const refused = await unknown.run(
      ["publish", "--retry", unknownId, "--to", unknown.connectionId, "--json"],
    );

    expect(refused.exit).toBe(2);
    expect(parseEnvelope(refused)["error"].code).toBe("RETRY_INELIGIBLE");
    expect(unknown.sent()).toBe(1);
  });
});

describe("confirmation display failures", () => {
  /**
   * A terminal that refuses a write cannot be asked a question.
   *
   * The first two writes are the shortened preview and its prompt; the third
   * and fourth belong to the `v` re-display. Whatever fails, the command must
   * stop before it reads an answer that was never shown, must not consume a
   * scripted `y`, and must send nothing.
   */
  it("stops before reading when the first preview write fails", async () => {
    const harness = await arrange();
    const calls = { tty: 0, hidden: 0 };
    const result = await harness.run(["publish", "--input", harness.document], {
      tty: {
        hasTty: true,
        lines: ["y"],
        writes: { text: "" },
        writeFailsAt: 0,
        calls,
      },
    });

    expect(calls.tty).toBe(0);
    expect(harness.sent()).toBe(0);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("the confirmation could not be shown on a terminal: nothing was sent");
    expect(result.stdout).toContain("syndroo publish --input -");
  });

  it("stops before reading when the prompt write fails", async () => {
    const harness = await arrange();
    const calls = { tty: 0, hidden: 0 };
    const result = await harness.run(["publish", "--input", harness.document], {
      tty: {
        hasTty: true,
        lines: ["y"],
        writes: { text: "" },
        writeFailsAt: 1,
        calls,
      },
    });

    expect(calls.tty).toBe(0);
    expect(harness.sent()).toBe(0);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("nothing was sent");
  });

  it("stops before reading when the v-expanded preview write fails", async () => {
    const harness = await arrange({ text: LONG_TEXT });
    const calls = { tty: 0, hidden: 0 };
    const result = await harness.run(["publish", "--input", harness.document], {
      tty: {
        hasTty: true,
        lines: ["v", "y"],
        writes: { text: "" },
        writeFailsAt: 2,
        calls,
      },
    });

    // The first answer was read (the shortened preview and its prompt were
    // shown); the expanded re-display failed, so nothing may be read after it.
    expect(calls.tty).toBe(1);
    expect(harness.sent()).toBe(0);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("nothing was sent");
  });
});

describe("machine output with --verbose", () => {
  it("keeps exactly one stdout envelope and only the fixed safe diagnostic on stderr", async () => {
    const harness = await arrange();
    const result = await harness.run([
      "publish",
      "--input",
      harness.document,
      "--yes",
      "--json",
      "--verbose",
    ]);

    expect(result.exit).toBe(0);

    const envelope = parseEnvelope(result);

    expect(envelope["result"]).toMatchObject({ phase: "execution", status: "succeeded" });
    // One machine document: no progress, no prompt, no prepared handoff, no
    // control sequence, no second envelope.
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(result.stdout).not.toContain("\u001b[");
    expect(result.stdout).not.toContain("[y/N/v]");
    expect(result.stdout).not.toContain("confirmation_required");

    // The one stderr line is the reviewed execution-process diagnostic. It
    // carries neither the approval token nor the credential canary.
    expect(result.stderr).toMatch(/^syndroo: prepared [A-Za-z0-9_.:-]+; awaiting confirmation\n$/);
    expect(result.stderr).not.toContain("approvalToken");
    expect(result.stderr).not.toContain(FAKE_SECRET_CANARY);
    expect(result.stderr).not.toContain("\u001b[");
    expect(harness.sent()).toBe(1);
  });

  it("--json --verbose without --yes still writes one envelope and sends nothing", async () => {
    const harness = await arrange();
    const result = await harness.run(["publish", "--input", harness.document, "--json", "--verbose"]);

    expect(result.exit).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(result.stdout).not.toContain("\u001b[");
    expect(parseEnvelope(result)["result"]).toMatchObject({ status: "confirmation_required" });
    // The diagnostic names the operation and nothing else.
    expect(result.stderr).toBe(
      `syndroo: prepared ${parseEnvelope(result)["result"].operationId}; awaiting confirmation\n`,
    );
    expect(harness.sent()).toBe(0);
  });

  it("a dry run with --verbose stays one envelope and writes no diagnostic", async () => {
    const harness = await arrange();
    const result = await harness.run([
      "publish",
      "--input",
      harness.document,
      "--dry-run",
      "--json",
      "--verbose",
    ]);

    expect(result.exit).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(result.stdout).not.toContain("\u001b[");
    expect(parseEnvelope(result)["result"]).toMatchObject({ status: "preview" });
    expect(result.stderr).toBe("");
    expect(harness.sent()).toBe(0);
  });
});

describe("dynamic output on a redraw-capable terminal", () => {
  it("keeps the v-expanded preview and starts the live block below it", async () => {
    const harness = await arrange({ text: LONG_TEXT });
    const writes = { text: "" };
    const result = await harness.run(["publish", "--input", harness.document], {
      env: { ...harness.space.env, TERM: "xterm-256color" },
      stdoutIsTty: true,
      columns: 80,
      rows: 40,
      tty: { hasTty: true, lines: ["v", "y"], writes },
    });

    expect(result.exit).toBe(0);
    expect(harness.sent()).toBe(1);

    // The full preview the human asked for is written to the terminal once and
    // never carries a control sequence, so nothing the later block does can
    // erase the text that was already shown.
    expect(writes.text).toContain("Line five");
    expect(writes.text).not.toContain("\u001b[");

    // stdout is that same terminal: the live round repaints in place and
    // restores the cursor...
    expect(result.stdout).toContain("\u001b[?25l");
    expect(result.stdout).toContain("\u001b[?25h");
    // ...but the first paint rewinds over nothing, so it is drawn below
    // whatever was already on screen. Only later paints move the cursor up.
    expect(result.stdout.indexOf("-> fake · acct_fake_0001")).toBeGreaterThan(-1);
    expect(result.stdout.search(/\u001b\[\d+A/)).toBeGreaterThan(
      result.stdout.indexOf("-> fake · acct_fake_0001"),
    );
    expect(result.stdout).toContain("Status:\n  Successful");
  });
});
