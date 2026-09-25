/**
 * Drives the documented local workflow through the published library entry
 * point with fake providers.
 *
 * This file is compiled to JavaScript and copied into a throwaway consumer
 * directory, where it is executed against the installed `@syndroo/cli`. It is
 * not part of the published package: it lives in `scripts/` so the gate can
 * exercise real execution, real receipts, and real replay without shipping a
 * fake endpoint or a test seam inside the artifact.
 *
 * The providers are in-process doubles. Nothing opens a socket.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

/**
 * Everything the driver needs from the package under test.
 *
 * These are type-only imports from the repository source, not from
 * `@syndroo/cli`. `scripts` is compiled before the CLI's `dist/` exists on a
 * clean checkout, so a value import of the package would make the scripts build
 * depend on its own downstream output — and would silently type-check against a
 * stale `dist/` when one happened to be present.
 */
import type { CliIo } from "../packages/cli/src/io.js";
import type { LocalProvider, LocalProviderId, ProviderOutcome } from "@syndroo/core";
import type { ExitCode } from "../packages/cli/src/exit-codes.js";
import type { LocalRunOverrides } from "../packages/cli/src/local/composition.js";
import type {
  LocalExecutionResult,
  LocalPreviewResult,
} from "../packages/cli/src/local/results.js";

/**
 * The public API the driver exercises, loaded from the *installed* package at
 * runtime.
 *
 * The specifier is a variable so TypeScript resolves nothing statically: the
 * module that is checked is the emitted public entry point of the artifact
 * under test, and the script build never needs `dist/` to exist.
 */
type DriverApi = {
  readonly run: (
    argv: readonly string[],
    io: CliIo,
    overrides?: LocalRunOverrides,
  ) => Promise<number>;
  readonly EXIT_CODE: {
    readonly SUCCESS: ExitCode;
  };
};

const publicEntrySpecifier: string = "@syndroo/cli";
const driverApi = (await import(publicEntrySpecifier)) as unknown as DriverApi;
const { run, EXIT_CODE } = driverApi;

type JsonObject = Record<string, unknown>;

const failures: string[] = [];
const notes: string[] = [];

function fail(detail: string): void {
  failures.push(detail);
}

function sink(lines: string[]): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
}

/** A provider double: it records every publish call and reaches no network. */
function fakeProvider(provider: LocalProviderId, calls: string[]): LocalProvider {
  const targetId =
    provider === "bluesky"
      ? "did:plc:consumerfixture"
      : "threads-consumerfixture";

  return {
    provider,
    describe: () => ({
      provider,
      maturity: "fixture-tested",
      localPublish: true,
      unavailableReason: null,
    }),
    freeze: (content: string, createdAt: string) => ({
      payloadVersion: 1,
      payload: { text: content, createdAt },
    }),
    verifyIdentity: async () => ({ targetId }),
    prepare: async (_credentials, target) => ({
      target,
      publish: async (delivery): Promise<ProviderOutcome> => {
        calls.push(delivery.deliveryId);

        return {
          kind: "succeeded",
          remoteId: `at://${targetId}/${delivery.deliveryId.slice(0, 8)}`,
          url: null,
        };
      },
    }),
  };
}

const root = mkdtempSync(join(tmpdir(), "syndroo-cli-driver-"));
const stdout: string[] = [];
const stderr: string[] = [];
const publishCalls: string[] = [];

/** One unique sentinel per secret, so any leak into a stream is detectable. */
const SENTINELS: Readonly<Record<string, string>> = {
  BLUESKY_IDENTIFIER: "consumer-fixture.bsky.social",
  BLUESKY_PASSWORD: "sentinel-app-password-000000000000",
  THREADS_ACCESS_TOKEN: "sentinel-threads-token-000000000000",
};

const env: NodeJS.ProcessEnv = {
  HOME: root,
  XDG_CONFIG_HOME: join(root, ".config"),
  XDG_STATE_HOME: join(root, ".local", "state"),
  PATH: process.env["PATH"] ?? "",
  ...SENTINELS,
};

const io: CliIo = {
  stdin: Readable.from([]),
  stdout: sink(stdout),
  stderr: sink(stderr),
  env,
  cwd: root,
  stdinIsTty: false,
  stdoutIsTty: false,
  hasTty: () => false,
  readTtyLine: () => undefined,
  signal: new AbortController().signal,
};

const overrides: LocalRunOverrides = {
  providers: {
    bluesky: fakeProvider("bluesky", publishCalls),
    threads: fakeProvider("threads", publishCalls),
  },
};

function envelopeOf(): JsonObject {
  const text = stdout.join("");
  const parsed: unknown = JSON.parse(text);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`expected one envelope object, received ${text.slice(0, 200)}`);
  }

  return parsed as JsonObject;
}

function assertEnvelope(command: string): JsonObject {
  const envelope = envelopeOf();

  if (envelope["schemaVersion"] !== 1) fail(`${command}: schemaVersion is not 1`);
  if (envelope["command"] !== command) {
    fail(`${command}: command field is ${String(envelope["command"])}`);
  }
  if (envelope["mode"] !== "local") {
    fail(`${command}: mode field is ${String(envelope["mode"])}`);
  }
  if (!Object.hasOwn(envelope, "result")) fail(`${command}: envelope has no result`);
  if (!Object.hasOwn(envelope, "error")) fail(`${command}: envelope has no error`);

  return envelope;
}

function resultOf(envelope: JsonObject): JsonObject {
  const result = envelope["result"];

  return typeof result === "object" && result !== null
    ? (result as JsonObject)
    : {};
}

/**
 * Every byte the driver ever produced, so the secret scan covers the whole run
 * instead of whichever command happened to run last.
 */
const transcript: string[] = [];

function capture(): string {
  return `${stdout.join("")}${stderr.join("")}`;
}

async function invoke(
  argv: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  stdout.length = 0;
  stderr.length = 0;

  const code = await run(argv, io, overrides);

  const output = { code, stdout: stdout.join(""), stderr: stderr.join("") };

  transcript.push(capture());

  return output;
}

try {
  const init = await invoke(["init", "--namespace", "consumer", "--json"]);

  if (init.code !== EXIT_CODE.SUCCESS) {
    fail(
      `init exited ${init.code}: ${init.stdout.slice(0, 200)}${init.stderr.slice(0, 200)}`,
    );
  } else {
    const envelope = assertEnvelope("init");
    const result = resultOf(envelope);

    if (result["namespace"] !== "consumer") {
      fail("init did not report the requested namespace");
    }
    if (
      typeof result["configPath"] !== "string" ||
      typeof result["stateHome"] !== "string"
    ) {
      fail("init result is missing configPath or stateHome");
    }
    if (envelope["ok"] !== true) fail("init did not report ok");
  }

  const providers = await invoke(["providers", "list", "--json"]);

  if (providers.code !== EXIT_CODE.SUCCESS) {
    fail(`providers list exited ${providers.code}`);
  } else {
    const listed = resultOf(assertEnvelope("providers.list"))["providers"];
    const names = Array.isArray(listed)
      ? listed
          .map((entry) =>
            typeof entry === "object" && entry !== null
              ? String((entry as JsonObject)["provider"])
              : "",
          )
          .sort()
      : [];

    if (names.join(",") !== "bluesky,threads") {
      fail(`providers list reported ${names.join(",")}`);
    }
  }

  const doctor = await invoke(["doctor", "--local", "--json"]);
  const checks = resultOf(envelopeOf())["checks"];
  const runtimeCheck = Array.isArray(checks)
    ? checks.find(
        (check) =>
          typeof check === "object" &&
          check !== null &&
          (check as JsonObject)["name"] === "runtime",
      )
    : undefined;

  if (doctor.code !== EXIT_CODE.SUCCESS) {
    fail(`doctor --local exited ${doctor.code}`);
  } else if (runtimeCheck === undefined) {
    fail("doctor --local reported no runtime check");
  } else if ((runtimeCheck as JsonObject)["status"] !== "ok") {
    fail(
      `doctor --local runtime check is ${String((runtimeCheck as JsonObject)["status"])}`,
    );
  }

  // Empty stdin is a real rejection, never a pending state.
  const malformed = await invoke(["publish", "--input", "-", "--dry-run", "--json"]);

  if (malformed.code === EXIT_CODE.SUCCESS) {
    fail("an empty document previewed with exit 0");
  } else if (!/INVALID_JSON|INVALID_DOCUMENT/u.test(malformed.stdout)) {
    fail(
      `empty document failed without a document error: ${malformed.stdout.slice(0, 200)}`,
    );
  }

  const documentPath = join(root, "post.json");
  const content = "Consumer fixture text for the packaged CLI.";

  writeFileSync(
    documentPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        key: "consumer-fixture-001",
        content,
        platforms: ["bluesky"],
      },
      null,
      2,
    )}\n`,
  );

  // A valid document with no bound account is an admission failure, not a plan.
  const unbound = await invoke([
    "publish",
    "--input",
    documentPath,
    "--dry-run",
    "--json",
  ]);

  if (unbound.code === EXIT_CODE.SUCCESS) {
    fail("a valid preview without an account binding reported success");
  } else if (!/AUTH_SOURCE_UNAVAILABLE|ACCOUNT_MISMATCH/u.test(unbound.stdout)) {
    fail(
      `an unbound preview failed without an account error: ${unbound.stdout.slice(0, 200)}`,
    );
  }

  // The documented workflow binds the account through the public command
  // surface, exactly as an operator would.
  const authSet = await invoke([
    "auth",
    "set",
    "bluesky",
    "--local",
    "--from-env",
    "--expect-account",
    "did:plc:consumerfixture",
    "--yes",
    "--no-input",
    "--json",
  ]);

  if (authSet.code !== EXIT_CODE.SUCCESS) {
    fail(
      `auth set exited ${authSet.code}: ${authSet.stdout.slice(0, 300)}`,
    );
  } else {
    const result = resultOf(assertEnvelope("auth.set"));

    if (result["targetId"] !== "did:plc:consumerfixture") {
      fail(`auth set bound ${String(result["targetId"])}`);
    }
    if (result["verified"] !== true) fail("auth set did not report a verified binding");
  }

  const preview = await invoke([
    "publish",
    "--input",
    documentPath,
    "--dry-run",
    "--json",
  ]);
  let planId: string | undefined;

  if (preview.code !== EXIT_CODE.SUCCESS) {
    fail(`preview exited ${preview.code}: ${preview.stdout.slice(0, 300)}`);
  } else {
    const result = resultOf(assertEnvelope("publish"));
    const items = result["items"];

    planId = typeof result["planId"] === "string" ? result["planId"] : undefined;

    if (planId === undefined) fail("preview did not return a planId");
    if (!Array.isArray(items) || items.length !== 1) {
      fail("preview did not freeze exactly one target");
    } else if ((items[0] as JsonObject)["content"] !== content) {
      fail("preview did not freeze the document content");
    }
    if (publishCalls.length !== 0) fail("preview executed a content request");
  }

  if (planId !== undefined) {
    const executed = await invoke([
      "publish",
      "--plan",
      planId,
      "--yes",
      "--no-input",
      "--json",
    ]);

    if (executed.code !== EXIT_CODE.SUCCESS) {
      fail(`execute exited ${executed.code}: ${executed.stdout.slice(0, 300)}`);
    } else {
      const result = resultOf(assertEnvelope("publish"));
      const results = result["results"];

      if (result["status"] !== "succeeded") {
        fail(`execute status is ${String(result["status"])}`);
      }
      if (result["durability"] !== "committed") {
        fail(`execute durability is ${String(result["durability"])}`);
      }
      if (
        !Array.isArray(results) ||
        (results[0] as JsonObject | undefined)?.["status"] !== "succeeded"
      ) {
        fail("execute did not report a succeeded target");
      }
      if (publishCalls.length !== 1) {
        fail(`execute made ${publishCalls.length} content request(s)`);
      }
    }

    const replay = await invoke([
      "publish",
      "--plan",
      planId,
      "--yes",
      "--no-input",
      "--json",
    ]);

    if (replay.code !== EXIT_CODE.SUCCESS) {
      fail(`replay exited ${replay.code}: ${replay.stdout.slice(0, 300)}`);
    } else if (publishCalls.length !== 1) {
      fail(`replay made ${publishCalls.length} content request(s)`);
    }
  }

  const receipts = await invoke(["receipts", "list", "--json"]);

  if (receipts.code !== EXIT_CODE.SUCCESS) {
    fail(`receipts list exited ${receipts.code}`);
  } else {
    const operations = resultOf(assertEnvelope("receipts.list"))["operations"];

    if (!Array.isArray(operations) || operations.length !== 1) {
      fail(
        `receipts list reported ${Array.isArray(operations) ? operations.length : "no"} operation(s)`,
      );
    } else if ((operations[0] as JsonObject)["admissionState"] !== "ready") {
      fail(
        `receipt admissionState is ${String((operations[0] as JsonObject)["admissionState"])}`,
      );
    }
  }

  // A local command must refuse the remote endpoint flag.
  const baseUrl = await invoke([
    "publish",
    "--input",
    "-",
    "--dry-run",
    "--base-url",
    "https://example.invalid",
    "--json",
  ]);

  if (baseUrl.code === EXIT_CODE.SUCCESS) {
    fail("a local command accepted --base-url");
  }

  const combined = transcript.join("");

  for (const [name, value] of Object.entries(SENTINELS)) {
    if (combined.includes(value)) {
      fail(`a credential value from ${name} appeared in command output`);
    }
  }

  notes.push(`content requests: ${publishCalls.length}`);
} catch (error) {
  fail(`driver threw: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: failures.length === 0, failures, notes }, null, 2));

if (failures.length > 0) {
  process.exitCode = 1;
}
