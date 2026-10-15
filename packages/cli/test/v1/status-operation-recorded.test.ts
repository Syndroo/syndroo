import { promises as fs } from "node:fs";
import path from "node:path";

import type { Clock } from "@syndroo/core";
import type { ProviderPlugin, ProviderTransport } from "@syndroo/provider-sdk";
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
  stateTree,
  type Sandbox,
} from "./support/harness.js";
import { fakeRegistry } from "./support/registry.js";

/**
 * `status --operation` is one read of one stored operation (design §8.4, T12).
 *
 * It shares the live publish view but reads in `recorded` mode, so an
 * unfinished stored claim reads as "last recorded status" instead of as a live
 * check. The properties proven here are that the read is genuinely read-only —
 * the state bytes are identical, no provider is loaded or called and the
 * original input file is never consulted again — and that every stored terminal
 * fact renders as itself.
 */

const boxes: Sandbox[] = [];

afterEach(async () => {
  await Promise.all(boxes.splice(0).map((box) => box.cleanup()));
});

const FROZEN = "The frozen recorded text.";
const REPLACED = "A later edit that must never appear in history.";
const START = "2026-10-08T00:00:00.000Z";
const LATER = "2026-10-08T01:00:00.000Z";

type Outcome = "ok" | "failed" | "unknown";

type Arrangement = {
  readonly space: Sandbox;
  readonly document: string;
  readonly overrides: LocalRuntimeOverrides;
  readonly sent: () => number;
  readonly published: () => number;
  readonly loads: () => number;
  readonly verifies: () => number;
  readonly advance: (now: string) => void;
};

async function arrange(
  outcome: Outcome,
  options: { readonly clock?: boolean } = {},
): Promise<Arrangement> {
  const space = await sandbox("syndroo-cli-status-op-");
  const base = createFakeProvider();
  const counters = { sent: 0, published: 0, loads: 0, verifies: 0 };

  const plugin: ProviderPlugin = {
    ...base,
    connect: {
      ...base.connect,
      async verify(credentials, context) {
        counters.verifies += 1;

        return await base.connect.verify(credentials, context);
      },
    },
    async publish(input) {
      counters.published += 1;

      const response = await input.context.transport.request({
        url: "https://fake.example/v1/publish",
        method: "POST",
        body: JSON.stringify({ submissionId: input.submissionId }),
        signal: input.context.signal,
      });

      if (outcome === "unknown") {
        return { status: "unknown", disposition: "unknown", reason: "network" };
      }

      if (outcome === "failed") {
        return {
          status: "failed",
          disposition: "not_applied",
          retryable: true,
          reason: "rate_limited",
        };
      }

      return {
        status: "succeeded",
        remoteId: `fake_${input.submissionId}`,
        url: `https://fake.example/fake_${input.submissionId}`,
      };
    },
  };

  boxes.push(space);

  const registry = fakeRegistry(plugin);
  const counting: typeof registry = {
    ...registry,
    async load(provider, mode) {
      counters.loads += 1;

      return await registry.load(provider, mode);
    },
  };
  const transport: ProviderTransport = {
    async request() {
      counters.sent += 1;

      return { type: "response", status: 200, headers: {}, body: "{}" };
    },
  };
  let now = START;
  const overrides: LocalRuntimeOverrides = {
    providers: counting,
    transport,
    ...(options.clock === false ? {} : { clock: { now: () => now } as Clock }),
  };
  const credential = path.join(space.root, "credential.json");

  await fs.writeFile(credential, JSON.stringify({ canary: FAKE_SECRET_CANARY }));

  const connected = await runCli(
    ["connect", "fake", "--credential-file", credential, "--json"],
    { env: space.env, cwd: space.root, overrides },
  );

  expect(connected.exit).toBe(0);

  const document = path.join(space.root, "document.json");

  await fs.writeFile(
    document,
    JSON.stringify({ content: { text: FROZEN }, targets: [{ provider: "fake" }] }),
  );

  return {
    space,
    document,
    overrides,
    sent: () => counters.sent,
    published: () => counters.published,
    loads: () => counters.loads,
    verifies: () => counters.verifies,
    advance: (next: string) => {
      now = next;
    },
  };
}

async function run(
  arrangement: Arrangement,
  argv: readonly string[],
): Promise<{ exit: number; stdout: string; stderr: string }> {
  return await runCli(argv, {
    env: arrangement.space.env,
    cwd: arrangement.space.root,
    overrides: arrangement.overrides,
  });
}

type Scenario = {
  readonly name: string;
  readonly outcome: Outcome;
  /** `execute` finishes the operation; `prepare` leaves it awaiting approval. */
  readonly mode: "execute" | "prepare";
  readonly expire?: boolean;
  readonly usingClock?: boolean;
  readonly expected: string;
};

const scenarios: readonly Scenario[] = [
  { name: "a finished success", outcome: "ok", mode: "execute", expected: "Successful" },
  { name: "a recorded failure", outcome: "failed", mode: "execute", expected: "Failed" },
  { name: "an unknown outcome", outcome: "unknown", mode: "execute", expected: "Unknown" },
  { name: "a still awaiting operation", outcome: "ok", mode: "prepare", expected: "Awaiting confirmation" },
  {
    name: "an expired approval",
    outcome: "ok",
    mode: "prepare",
    expire: true,
    usingClock: true,
    expected: "Expired",
  },
];

describe("status --operation reads the recorded projection", () => {
  it.each(scenarios)(
    "renders $name and changes nothing",
    async (scenario) => {
      const arrangement = await arrange(scenario.outcome, {
        ...(scenario.usingClock === true ? {} : { clock: false }),
      });
      const published = await run(arrangement, [
        "publish",
        "--input",
        arrangement.document,
        ...(scenario.mode === "execute" ? ["--yes"] : []),
        "--json",
      ]);

      // A prepared result exits 0; a failed or unknown round exits with its
      // documented business code. Either way the envelope is the operation.
      expect([0, 4, 6]).toContain(published.exit);

      const operationId = parseEnvelope(published)["result"].operationId as string;

      if (scenario.expire === true) {
        // Time moves past the 15-minute approval window without executing.
        arrangement.advance(LATER);
      }

      // The input file is edited after the fact: a recorded read must show the
      // frozen snapshot, never the file as it is now.
      await fs.writeFile(
        arrangement.document,
        JSON.stringify({ content: { text: REPLACED }, targets: [{ provider: "fake" }] }),
      );

      const before = await stateTree(arrangement.space);
      const counters = {
        sent: arrangement.sent(),
        published: arrangement.published(),
        loads: arrangement.loads(),
        verifies: arrangement.verifies(),
      };

      const result = await run(arrangement, ["status", "--operation", operationId]);

      expect(result.exit).toBe(0);
      expect(result.stdout).toContain("Status:");
      expect(result.stdout).toContain(scenario.expected);
      expect(result.stdout).toContain(FROZEN);
      expect(result.stdout).not.toContain(REPLACED);
      // Nothing below is a live check, so no target claims to be publishing.
      expect(result.stdout).not.toContain("Publishing");

      // A read changes no byte, loads no provider and calls nothing.
      expect(await stateTree(arrangement.space)).toEqual(before);
      expect(arrangement.sent()).toBe(counters.sent);
      expect(arrangement.published()).toBe(counters.published);
      expect(arrangement.loads()).toBe(counters.loads);
      expect(arrangement.verifies()).toBe(counters.verifies);
    },
  );

  it("shares the same projection with the machine surface", async () => {
    const arrangement = await arrange("ok", { clock: false });
    const published = await run(arrangement, [
      "publish",
      "--input",
      arrangement.document,
      "--yes",
      "--json",
    ]);
    const operationId = parseEnvelope(published)["result"].operationId as string;
    const before = await stateTree(arrangement.space);
    const result = await run(arrangement, ["status", "--operation", operationId, "--json"]);
    const operation = parseEnvelope(result)["result"].operation;

    expect(result.exit).toBe(0);
    expect(operation).toMatchObject({ phase: "execution", status: "succeeded" });
    expect(operation.deliveries[0].outcome.status).toBe("succeeded");
    expect(operation.deliveries[0].preview.content.text).toBe(FROZEN);
    expect(await stateTree(arrangement.space)).toEqual(before);
  });
});
