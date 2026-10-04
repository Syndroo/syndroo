import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import {
  type FrozenDelivery,
  type LocalCredentials,
  type LocalProvider,
  type LocalProviderDescription,
  type LocalProviderId,
  type ProviderOutcome,
  type TargetBinding,
} from "@syndroo/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CliIo } from "../../src/io.js";
import { buildLocalPublishIntent } from "../../src/local/plan.js";
import { run } from "../../src/main.js";
import {
  documentOf,
  openState,
  providerSet,
  seedConnection,
  testClock,
} from "./support/plan-fixture.js";


const BLUESKY_TARGET = "did:plc:directfixture";
const THREADS_TARGET = "threads-directfixture";

function succeeded(remoteId = "at://direct/1"): ProviderOutcome {
  return { kind: "succeeded", remoteId, url: null };
}

function notApplied(): ProviderOutcome {
  return {
    kind: "failed",
    code: "RATE_LIMIT",
    writeDisposition: "not_applied",
    retryable: true,
    retryNotBefore: null,
  };
}

function unknownOutcome(): ProviderOutcome {
  return { kind: "unknown", code: "NETWORK", writeDisposition: "unknown" };
}

interface FakeProvider {
  readonly provider: LocalProvider;
  readonly calls: {
    freeze: number;
    prepare: number;
    publish: number;
    verifyIdentity: number;
  };
  readonly published: FrozenDelivery[];
  queue(...items: readonly (ProviderOutcome | Error)[]): void;
}

function fakeProvider(id: LocalProviderId, targetId: string): FakeProvider {
  const calls = { freeze: 0, prepare: 0, publish: 0, verifyIdentity: 0 };
  const queued: (ProviderOutcome | Error)[] = [];
  const published: FrozenDelivery[] = [];

  return {
    calls,
    published,
    queue: (...items) => {
      queued.push(...items);
    },
    provider: {
      provider: id,
      describe: (): LocalProviderDescription => ({
        provider: id,
        maturity: "fixture-tested",
        localPublish: true,
        unavailableReason: null,
      }),
      freeze: (content, createdAt) => {
        calls.freeze++;
        return { payloadVersion: 1, payload: { text: content, createdAt } };
      },
      verifyIdentity: async (credentials: LocalCredentials) => {
        calls.verifyIdentity++;

        if (credentials.provider !== id) {
          throw new Error("wrong provider");
        }

        return { targetId };
      },
      prepare: async (credentials: LocalCredentials, target: TargetBinding) => {
        calls.prepare++;

        if (credentials.provider !== id) {
          throw new Error("wrong provider");
        }

        return {
          target: { ...target },
          publish: async (delivery: FrozenDelivery) => {
            calls.publish++;
            published.push(delivery);
            const item = queued.shift();

            if (item === undefined) {
              throw new Error("no queued outcome");
            }

            if (item instanceof Error) {
              throw item;
            }

            return item;
          },
        };
      },
    },
  };
}

interface Harness {
  readonly home: string;
  readonly cwd: string;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly writes: { stdout: number };
  readonly io: CliIo;
  readonly stateHome: string;
  readonly bluesky: FakeProvider;
  readonly threads: FakeProvider;
  run(argv: readonly string[]): Promise<number>;
  lastEnvelope(): Record<string, unknown>;
  cleanup(): void;
}

const harnesses: Harness[] = [];

function harness(
  options: {
    readonly stdin?: Readable;
    readonly stdinIsTty?: boolean;
    readonly stdoutIsTty?: boolean;
  } = {},
): Harness {
  const home = mkdtempSync(path.join(tmpdir(), "syndroo-direct-"));
  const cwd = path.join(home, "cwd");

  mkdirSync(cwd, { recursive: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const bluesky = fakeProvider("bluesky", BLUESKY_TARGET);
  const threads = fakeProvider("threads", THREADS_TARGET);
  const writes = { stdout: 0 };

  const sink = (into: string[]): Writable =>
    new Writable({
      write(chunk, _encoding, callback) {
        into.push(String(chunk));
        callback();
      },
    });

  const stdoutStream = {
    write(chunk: unknown): boolean {
      writes.stdout++;
      stdout.push(String(chunk));
      return true;
    },
  } as unknown as Writable;

  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_STATE_HOME: path.join(home, "state"),
    BLUESKY_IDENTIFIER: "fixture-handle",
    BLUESKY_PASSWORD: "fixture-password",
    THREADS_ACCESS_TOKEN: "fixture-token",
  };

  const io: CliIo = {
    stdin: options.stdin ?? new Readable({ read() {} }),
    stdout: stdoutStream,
    stderr: sink(stderr),
    env,
    cwd,
    stdinIsTty: options.stdinIsTty ?? false,
    stdoutIsTty: options.stdoutIsTty ?? false,
    hasTty: () => options.stdinIsTty === true,
    readTtyLine: () => undefined,
    signal: new AbortController().signal,
  };

  const value: Harness = {
    home,
    cwd,
    stdout,
    stderr,
    writes,
    io,
    stateHome: path.join(home, "state", "syndroo"),
    bluesky,
    threads,
    run: argv =>
      run(argv, io, {
        providers: { bluesky: bluesky.provider, threads: threads.provider, linkedin: fakeProvider("linkedin", "urn:li:person:fixturealice").provider },
      }),
    lastEnvelope: () => {
      const lines = stdout.join("").split("\n").filter(line => line.length > 0);
      const last = lines[lines.length - 1];

      if (last === undefined) {
        throw new Error("no envelope was written");
      }

      return JSON.parse(last) as Record<string, unknown>;
    },
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };

  harnesses.push(value);

  return value;
}

afterEach(() => {
  for (const value of harnesses.splice(0)) {
    value.cleanup();
  }

  vi.unstubAllGlobals();
});

function envelopeResult(envelope: Record<string, unknown>): Record<string, unknown> {
  const result = envelope["result"];

  if (typeof result !== "object" || result === null) {
    throw new Error(`expected a result object, got ${JSON.stringify(envelope)}`);
  }

  return result as Record<string, unknown>;
}

function envelopeError(envelope: Record<string, unknown>): Record<string, unknown> {
  const error = envelope["error"];

  if (typeof error !== "object" || error === null) {
    throw new Error(`expected an error object, got ${JSON.stringify(envelope)}`);
  }

  return error as Record<string, unknown>;
}

function documentJson(
  fields: {
    readonly key?: string;
    readonly content?: string;
    readonly platforms?: readonly string[];
    readonly schemaVersion?: number;
  } = {},
): string {
  return JSON.stringify({
    ...(fields.schemaVersion === undefined
      ? {}
      : { schemaVersion: fields.schemaVersion }),
    key: fields.key ?? "direct-001",
    content: fields.content ?? "direct inline content",
    platforms: fields.platforms ?? ["bluesky"],
  });
}

async function ready(fixture: Harness): Promise<void> {
  expect(await fixture.run(["init", "--json"])).toBe(0);
  expect(
    await fixture.run([
      "auth",
      "set",
      "bluesky",
      "--local",
      "--from-env",
      "--yes",
      "--no-input",
      "--expect-account",
      BLUESKY_TARGET,
      "--json",
    ]),
  ).toBe(0);
}

function stateSnapshot(stateHome: string): readonly string[] {
  const lines: string[] = [];

  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        lines.push(`${relative}/`);
        walk(absolute, relative);
        continue;
      }

      lines.push(`${relative}:${readFileSync(absolute).toString("hex")}`);
    }
  };

  walk(stateHome, "");

  return lines.sort();
}

function formatDir(stateHome: string, name: string): readonly string[] {
  const dir = path.join(stateHome, name);

  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("help and bare invocation", () => {
  it("answers bare, help, --help, and -h with general help and zero effects", async () => {
    for (const argv of [[], ["help"], ["--help"], ["-h"]] as const) {
      const fixture = harness();
      const code = await fixture.run(argv);
      const label = argv.join(" ") || "bare";

      expect(code, label).toBe(0);

      const text = fixture.stdout.join("");

      expect(text, label).toContain("local-first");
      expect(text, label).toContain("publish");
      expect(existsSync(path.join(fixture.home, "config")), label).toBe(false);
      expect(existsSync(path.join(fixture.home, "state")), label).toBe(false);
      expect(fixture.bluesky.calls.prepare, label).toBe(0);
      expect(fixture.bluesky.calls.publish, label).toBe(0);
      expect(fixture.threads.calls.publish, label).toBe(0);
    }
  });

  it("keeps genuine command errors failing instead of printing help", async () => {
    const fixture = harness();

    expect(await fixture.run(["unknown-command", "--json"])).toBe(2);
    expect(await fixture.run(["publish", "--json"])).toBe(2);
    expect(envelopeError(fixture.lastEnvelope())["code"]).toBe("USAGE");
  });
});

describe("direct input adapters", () => {
  it("publishes inline --data in one command and omits the public plan", async () => {
    const fixture = harness();

    vi.stubGlobal("fetch", () => {
      throw new Error("a local run must not use fetch");
    });

    await ready(fixture);
    fixture.bluesky.queue(succeeded());

    expect(
      await fixture.run([
        "publish",
        "--data",
        documentJson({ content: "inline hello" }),
        "--yes",
        "--no-input",
        "--json",
      ]),
    ).toBe(0);

    const result = envelopeResult(fixture.lastEnvelope());

    expect(result["status"]).toBe("succeeded");
    expect(result["planId"]).toBeUndefined();
    expect(result["results"]).toEqual([
      expect.objectContaining({ provider: "bluesky", status: "succeeded" }),
    ]);
    expect(fixture.bluesky.published).toHaveLength(1);
    expect(fixture.bluesky.published[0]?.content).toBe("inline hello");
  });

  it("publishes a file document, then replays the same content without resending", async () => {
    const fixture = harness();

    await ready(fixture);
    fixture.bluesky.queue(succeeded());

    const file = path.join(fixture.cwd, "post.json");

    writeFileSync(file, documentJson({ content: "file hello" }), "utf8");

    expect(
      await fixture.run([
        "publish",
        "--input",
        file,
        "--yes",
        "--no-input",
        "--json",
      ]),
    ).toBe(0);
    expect(fixture.bluesky.published).toHaveLength(1);
    expect(
      await fixture.run([
        "publish",
        "--input",
        file,
        "--yes",
        "--no-input",
        "--json",
      ]),
    ).toBe(0);
    expect(fixture.bluesky.published).toHaveLength(1);
  });

  it("reads --input - from stdin", async () => {
    const fixture = harness({ stdin: Readable.from([documentJson()]) });

    await ready(fixture);
    fixture.bluesky.queue(succeeded());

    expect(
      await fixture.run([
        "publish",
        "--input",
        "-",
        "--yes",
        "--no-input",
        "--json",
      ]),
    ).toBe(0);
    expect(fixture.bluesky.published[0]?.content).toBe("direct inline content");
  });

  it("accepts an omitted schemaVersion and a v2 text document", async () => {
    const fixture = harness();

    await ready(fixture);
    fixture.bluesky.queue(succeeded());

    expect(
      await fixture.run([
        "publish",
        "--data",
        documentJson({ content: "no schema" }),
        "--yes",
        "--no-input",
        "--json",
      ]),
    ).toBe(0);

    // v2 is a valid explicit version; a text-only v2 document is still text.
    fixture.bluesky.queue(succeeded());

    expect(
      await fixture.run([
        "publish",
        "--data",
        documentJson({ schemaVersion: 2, key: "direct-v2", content: "v2 text" }),
        "--yes",
        "--no-input",
        "--json",
      ]),
    ).toBe(0);
  });

  it("refuses an unsupported schemaVersion", async () => {
    const fixture = harness();

    await ready(fixture);

    for (const bad of [null, 3, "1"]) {
      const code = await fixture.run([
        "publish",
        "--data",
        JSON.stringify({
          schemaVersion: bad,
          key: "direct-bad",
          content: "x",
          platforms: ["bluesky"],
        }),
        "--yes",
        "--no-input",
        "--json",
      ]);

      expect(code, String(bad)).toBe(2);
      expect(envelopeError(fixture.lastEnvelope())["code"]).toBe("INVALID_DOCUMENT");
    }
  });

  it("refuses two input methods before reading anything", async () => {
    const fixture = harness({ stdin: Readable.from([documentJson()]) });

    const code = await fixture.run([
      "publish",
      "--data",
      documentJson(),
      "--input",
      "-",
      "--yes",
      "--no-input",
      "--json",
    ]);

    expect(code).toBe(2);
    expect(envelopeError(fixture.lastEnvelope())["code"]).toBe("USAGE");
    expect(existsSync(path.join(fixture.home, "state"))).toBe(false);
    expect(fixture.bluesky.calls.prepare).toBe(0);
    expect(fixture.bluesky.calls.publish).toBe(0);
  });

  it("treats --data - as literal invalid JSON, not another stdin alias", async () => {
    const fixture = harness({ stdin: Readable.from([documentJson()]) });

    await ready(fixture);

    const code = await fixture.run([
      "publish",
      "--data",
      "-",
      "--yes",
      "--no-input",
      "--json",
    ]);

    expect(code).toBe(2);
    expect(envelopeError(fixture.lastEnvelope())["code"]).toBe("INVALID_JSON");
    expect(fixture.bluesky.calls.publish).toBe(0);
  });
});

describe("pure dry run", () => {
  it("previews without a lock, an intent, an operation, or a provider call", async () => {
    const fixture = harness();

    await ready(fixture);

    const before = stateSnapshot(fixture.stateHome);
    const code = await fixture.run([
      "publish",
      "--data",
      documentJson(),
      "--dry-run",
      "--json",
    ]);

    expect(code).toBe(0);

    const result = envelopeResult(fixture.lastEnvelope());

    expect(result["planId"]).toBeUndefined();
    expect(result["expiresAt"]).toBeUndefined();
    expect(result["items"]).toEqual([
      expect.objectContaining({
        provider: "bluesky",
        action: "publish",
        content: "direct inline content",
      }),
    ]);

    expect(fixture.bluesky.calls.prepare).toBe(0);
    expect(fixture.bluesky.calls.publish).toBe(0);
    expect(stateSnapshot(fixture.stateHome)).toEqual(before);
    expect(formatDir(fixture.stateHome, "intents")).toEqual([]);
    expect(formatDir(fixture.stateHome, "plans")).toEqual([]);
    expect(existsSync(path.join(fixture.stateHome, ".write-lock"))).toBe(false);
  });

  it("fails read-only with an actionable error when no local config exists", async () => {
    const fixture = harness();

    const code = await fixture.run([
      "publish",
      "--data",
      documentJson(),
      "--dry-run",
      "--json",
    ]);

    expect(code).toBe(2);
    expect(envelopeError(fixture.lastEnvelope())["code"]).toBe("CONFIG");
    expect(existsSync(path.join(fixture.home, "state"))).toBe(false);
  });
});

describe("source mutation safety", () => {
  it("sends the parsed snapshot even when the file changes during confirmation", async () => {
    const file = path.join(tmpdir(), `syndroo-mutation-${Date.now()}.json`);

    writeFileSync(file, documentJson({ content: "original content" }), "utf8");

    const stdin = new Readable({
      read() {
        writeFileSync(file, documentJson({ content: "mutated content" }), "utf8");
        this.push("y\n");
        this.push(null);
      },
    });
    const fixture = harness({ stdin, stdinIsTty: true, stdoutIsTty: true });

    try {
      await ready(fixture);
      fixture.bluesky.queue(succeeded());

      expect(await fixture.run(["publish", "--input", file, "--json"])).toBe(0);
      expect(fixture.bluesky.published).toHaveLength(1);
      expect(fixture.bluesky.published[0]?.content).toBe("original content");
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("leaves no intent, lock, or operation when the operator declines", async () => {
    const fixture = harness({
      stdin: Readable.from(["n\n"]),
      stdinIsTty: true,
      stdoutIsTty: true,
    });

    await ready(fixture);

    const before = stateSnapshot(fixture.stateHome);
    const code = await fixture.run([
      "publish",
      "--data",
      documentJson(),
      "--json",
    ]);

    expect(code).toBe(5);
    expect(fixture.bluesky.calls.publish).toBe(0);
    expect(stateSnapshot(fixture.stateHome)).toEqual(before);
    expect(formatDir(fixture.stateHome, "intents")).toEqual([]);
    expect(existsSync(path.join(fixture.stateHome, ".write-lock"))).toBe(false);
  });
});

describe("public Plan removal", () => {
  it("refuses the removed --plan forms on publish and retry", async () => {
    const fixture = harness();
    const plan = `plan_${"a".repeat(32)}`;

    for (const argv of [
      ["publish", "--plan", plan, "--yes", "--no-input", "--json"],
      ["publish", "--input", "x.json", "--plan", plan, "--json"],
      ["retry", "--plan", plan, "--yes", "--no-input", "--json"],
    ] as const) {
      const code = await fixture.run(argv);

      expect(code, argv.join(" ")).toBe(2);
      expect(envelopeError(fixture.lastEnvelope())["code"]).toBe("USAGE");
    }
  });

  it("keeps planId and expiry out of publish, retry, and receipts JSON", async () => {
    const fixture = harness();

    await ready(fixture);
    fixture.bluesky.queue(notApplied());

    expect(
      await fixture.run([
        "publish",
        "--data",
        documentJson(),
        "--yes",
        "--no-input",
        "--json",
      ]),
    ).toBe(6);

    const operationId = envelopeResult(fixture.lastEnvelope())["operationId"] as string;

    await fixture.run(["receipts", "show", operationId, "--json"]);
    await fixture.run(["receipts", "list", "--json"]);
    await fixture.run(["publish", "--data", documentJson(), "--dry-run", "--json"]);
    await fixture.run([
      "retry",
      operationId,
      "--to",
      "bluesky",
      "--dry-run",
      "--json",
    ]);

    const json = fixture.stdout.join("");

    expect(json).not.toContain("planId");
    expect(json).not.toContain("plan_");
    expect(json).not.toContain("expiresAt");
    expect(json).not.toContain("--plan");
  });
});

describe("direct retry", () => {
  it("retries a confirmed not-sent operation directly and previews read-only", async () => {
    const fixture = harness();

    await ready(fixture);
    fixture.bluesky.queue(notApplied());

    expect(
      await fixture.run([
        "publish",
        "--data",
        documentJson(),
        "--yes",
        "--no-input",
        "--json",
      ]),
    ).toBe(6);

    const operationId = envelopeResult(fixture.lastEnvelope())["operationId"] as string;

    const before = stateSnapshot(fixture.stateHome);
    const preview = await fixture.run([
      "retry",
      operationId,
      "--to",
      "bluesky",
      "--dry-run",
      "--json",
    ]);

    expect(preview).toBe(0);
    expect(envelopeResult(fixture.lastEnvelope())["items"]).toEqual([
      expect.objectContaining({ provider: "bluesky", action: "retry" }),
    ]);
    expect(stateSnapshot(fixture.stateHome)).toEqual(before);
    expect(fixture.bluesky.calls.publish).toBe(1);

    fixture.bluesky.queue(succeeded("at://direct/retry"));

    expect(
      await fixture.run([
        "retry",
        operationId,
        "--to",
        "bluesky",
        "--yes",
        "--no-input",
        "--json",
      ]),
    ).toBe(0);
    expect(fixture.bluesky.calls.publish).toBe(2);
  });

  it("still refuses to retry an unknown outcome", async () => {
    const fixture = harness();

    await ready(fixture);
    fixture.bluesky.queue(unknownOutcome());

    expect(
      await fixture.run([
        "publish",
        "--data",
        documentJson(),
        "--yes",
        "--no-input",
        "--json",
      ]),
    ).toBe(4);

    const operationId = envelopeResult(fixture.lastEnvelope())["operationId"] as string;

    expect(
      await fixture.run([
        "retry",
        operationId,
        "--to",
        "bluesky",
        "--yes",
        "--no-input",
        "--json",
      ]),
    ).toBe(2);
    expect(envelopeError(fixture.lastEnvelope())["code"]).toBe("OUTCOME_UNKNOWN");
    expect(fixture.bluesky.calls.publish).toBe(1);
  });
});

describe("internal intents and legacy plans", () => {
  it("writes new publishing state under intents/ without creating plans/", async () => {
    const fixture = harness();

    await ready(fixture);
    fixture.bluesky.queue(succeeded());

    expect(
      await fixture.run([
        "publish",
        "--data",
        documentJson(),
        "--yes",
        "--no-input",
        "--json",
      ]),
    ).toBe(0);

    const intents = formatDir(fixture.stateHome, "intents");

    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatch(/^plan_[0-9a-f]{32}\.json$/u);
    expect(formatDir(fixture.stateHome, "plans")).toEqual([]);
    expect(existsSync(path.join(fixture.stateHome, "plans"))).toBe(false);
  });

  it("inspects, recovers, and retries a legacy-only state without rewriting it", async () => {
    const fixture = harness();

    await ready(fixture);
    fixture.bluesky.queue(notApplied());
    expect(await fixture.run([
      "publish", "--data", documentJson(), "--yes", "--no-input", "--json",
    ])).toBe(6);
    const operationId = envelopeResult(fixture.lastEnvelope())["operationId"] as string;
    renameSync(path.join(fixture.stateHome, "intents"), path.join(fixture.stateHome, "plans"));
    const before = stateSnapshot(fixture.stateHome);

    expect(await fixture.run(["state", "inspect", "--json"])).toBe(0);
    expect(envelopeResult(fixture.lastEnvelope())["safe"]).toBe(true);
    expect(await fixture.run([
      "retry", operationId, "--to", "bluesky", "--dry-run", "--json",
    ])).toBe(0);
    expect(stateSnapshot(fixture.stateHome)).toEqual(before);
    expect(await fixture.run([
      "state", "recover", "--confirm-no-writers", "--yes", "--json",
    ])).toBe(0);
    expect(stateSnapshot(fixture.stateHome)).toEqual(before);

    fixture.bluesky.queue(succeeded());
    expect(await fixture.run([
      "retry", operationId, "--to", "bluesky", "--yes", "--no-input", "--json",
    ])).toBe(0);
    expect(fixture.bluesky.calls.publish).toBe(2);
    expect(formatDir(fixture.stateHome, "plans")).toHaveLength(1);
    expect(formatDir(fixture.stateHome, "intents")).toHaveLength(1);
  });

  it("reads a legacy plans/ record but never falls back past a corrupt intent", async () => {
    const state = await openState(testClock());

    try {
      await seedConnection(state.store, { provider: "bluesky" });

      const set = providerSet();
      const intent = await buildLocalPublishIntent(
        documentOf({ content: "legacy compat" }),
        {
          store: state.store,
          providers: set.providers,
          namespace: "default",
          now: state.clock.now,
        },
      );
      mkdirSync(path.join(state.stateHome, "plans"), { mode: 0o700 });
      writeFileSync(
        path.join(state.stateHome, "plans", `${intent.planId}.json`),
        `${JSON.stringify(intent, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );

      expect(await state.store.getPlan(intent.planId)).not.toBeNull();
      mkdirSync(path.join(state.stateHome, "intents"), { mode: 0o700, recursive: true });
      writeFileSync(
        path.join(state.stateHome, "intents", `${intent.planId}.json`),
        "{ not json\n",
        { encoding: "utf8", mode: 0o600 },
      );

      await expect(state.store.getPlan(intent.planId)).rejects.toMatchObject({
        code: "STATE_CORRUPT",
      });
    } finally {
      state.cleanup();
    }
  });
});
