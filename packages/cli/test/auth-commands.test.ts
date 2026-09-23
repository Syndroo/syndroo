/**
 * Real-process coverage for the 0.5.0 auth command family.
 *
 * Every case runs the built `dist/bin.js` as a subprocess against the loopback
 * fixture, so the exit code, the prompt, and the output are the ones an
 * operator would see. The fixture records every HTTP method: counting post
 * creates alone cannot prove that an auth command wrote nothing.
 */

import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CLI_BIN,
  CLI_ROOT,
  parseJsonObject,
  runCli,
  runCliPty,
  type RunOptions,
  type RunResult,
} from "./support/harness.js";
import { run } from "../src/main.js";
import type { CliIo } from "../src/io.js";
import {
  json,
  startFixtureServer,
  type FixtureHandler,
  type FixtureServer,
  type RecordedRequest,
} from "./support/loopback.js";

const SENTINEL = "sentinel-api-key-0123456789abcdef";
const EXPIRES = "2026-09-20T01:00:00.000Z";

/** The authorization endpoints this repository configures. */
const VALID_URLS: Readonly<Record<string, string>> = {
  x: "https://api.twitter.com/oauth/authorize?oauth_token=tok_1",
  tumblr: "https://www.tumblr.com/oauth/authorize?oauth_token=tok_1",
  linkedin:
    "https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=client_1" +
    "&redirect_uri=https%3A%2F%2Fsyndroo.example.com%2Fauth%2Fcallback&state=state_1&scope=r_liteprofile",
};

const servers: FixtureServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));

  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function server(handler: FixtureHandler): Promise<FixtureServer> {
  const fixture = await startFixtureServer(handler);
  servers.push(fixture);
  return fixture;
}

function fixtureEnv(fixture: FixtureServer): NodeJS.ProcessEnv {
  return { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: SENTINEL };
}

/** The harness options every subprocess run shares. */
function runOptions(fixture: FixtureServer): RunOptions {
  return { env: fixtureEnv(fixture) };
}

/** A secret file in a disposable directory outside the repository. */
function secretFile(name: string, contents: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "syndroo-auth-"));
  tempDirs.push(directory);
  const file = path.join(directory, name);
  writeFileSync(file, contents, "utf8");
  return file;
}

/** Every method the instance actually saw, in order. */
function methods(fixture: FixtureServer): string[] {
  return fixture.requests.map(request => request.method);
}

/** Every request that could have changed server state. */
function writeRequests(fixture: FixtureServer): RecordedRequest[] {
  return fixture.requests.filter(request => request.method !== "GET");
}

function bodyOf(request: RecordedRequest | undefined): Record<string, unknown> {
  if (request === undefined || request.body === "") {
    return {};
  }

  return JSON.parse(request.body) as Record<string, unknown>;
}

function errorCode(payload: Record<string, unknown>): unknown {
  const error = payload["error"] as Record<string, unknown> | undefined;
  return error?.["code"];
}

function errorMessage(payload: Record<string, unknown>): string {
  const error = payload["error"] as Record<string, unknown> | undefined;
  return String(error?.["message"] ?? "");
}

/** The reported read/write counts. Failure payloads add one extra field. */
function counts(payload: Record<string, unknown>): Record<string, unknown> {
  return (payload["authRequests"] ?? {}) as Record<string, unknown>;
}

/** `--json` promises exactly one stdout line, and it has to parse. */
function singleJson(result: RunResult): Record<string, unknown> {
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  return parseJsonObject(result.stdout);
}

/** JSON objects found in a merged terminal stream. */
function jsonLines(text: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const start = line.indexOf("{");

    if (start === -1) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line.slice(start)) as unknown;
    } catch {
      continue;
    }

    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      found.push(parsed as Record<string, unknown>);
    }
  }

  return found;
}

function occurrences(text: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  let count = 0;
  let index = text.indexOf(needle);

  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }

  return count;
}

/** Runs the CLI when a large stdin write may legitimately hit EPIPE. */
function runCliTolerantStdin(
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdin: string; timeoutMs?: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: CLI_ROOT,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // No unbounded close wait: a wedged child is killed so the test fails
    // loudly instead of hanging the suite.
    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 15_000);

    // The CLI stops reading at the secret limit and closes its end, so the
    // parent's remaining write is expected to fail. That is not a test error.
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", error => {
      clearTimeout(watchdog);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(watchdog);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.stdin.end(options.stdin);
  });
}

/** Waits until the fixture has fully received a request, or fails. */
async function waitForRequest(
  fixture: FixtureServer,
  arrived: (request: RecordedRequest) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fixture.requests.some(arrived)) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 20));
  }

  throw new Error("the instance never received the request under test");
}

interface InterruptResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the CLI, waits for the fixture to have the request under test, and then
 * interrupts the client. The wait is event-driven; the watchdog is a failure
 * guard only, so a child that never exits cannot leak or hang the suite.
 */
function interruptAfterRequest(
  args: readonly string[],
  fixture: FixtureServer,
  arrived: (request: RecordedRequest) => boolean,
): Promise<InterruptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: CLI_ROOT,
      env: { ...process.env, ...fixtureEnv(fixture) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (run: () => void): void => {
      if (!settled) {
        settled = true;
        run();
      }
    };

    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
    }, 20_000);

    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", error => {
      clearTimeout(watchdog);
      finish(() => reject(error));
    });
    child.on("close", code => {
      clearTimeout(watchdog);
      finish(() => resolve({ code: code ?? -1, stdout, stderr }));
    });

    void waitForRequest(fixture, arrived).then(
      () => {
        child.kill("SIGINT");
      },
      error => {
        child.kill("SIGKILL");
        finish(() => reject(error as Error));
      },
    );
  });
}

/* Fixtures ---------------------------------------------------------------- */

interface FixtureState {
  /** The revision every status read answers with. */
  revision: number;
  /** The operation's own expectedRevision; defaults to `revision`. */
  operationRevision?: number | undefined;
  operationPhase?: string | undefined;
  /** The URL the connect receipt carries. */
  connectUrl?: string | undefined;
  /** Answers a request itself when it returns `true`. */
  handle?:
    | ((request: RecordedRequest, response: ServerResponse, path: string) => boolean)
    | undefined;
}

function platformStatus(
  platform: string,
  revision: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    platform,
    configured: true,
    source: "credential",
    oauthSupported: true,
    readiness: "ready",
    missingFields: [],
    expiresAt: null,
    revision,
    ...overrides,
  };
}

function authStatus(revision: number): Record<string, unknown> {
  return {
    instance: { publishingReady: true, missingFields: [] },
    platforms: {
      bluesky: platformStatus("bluesky", revision),
      x: platformStatus("x", revision),
    },
  };
}

function diagnosticsDto(): Record<string, unknown> {
  return {
    observedAt: "2026-09-20T00:00:00.000Z",
    pendingOutbox: 2,
    oldestDueAt: "2026-09-20T00:01:00.000Z",
    oldestAgeSeconds: 30,
    retryScheduled: 1,
    deadLettered: 0,
    latestAttemptArchiveFailures: 0,
    storage: {
      approximateBytes: 1_024,
      limitBytes: 4_096,
      utilization: 0.25,
      reason: null,
      observedAt: "2026-09-20T00:00:00.000Z",
    },
  };
}

function operationStatus(
  platform: string,
  operationId: string,
  state: FixtureState,
): Record<string, unknown> {
  return {
    platform,
    operationId,
    phase: state.operationPhase ?? "awaiting_confirmation",
    expiresAt: EXPIRES,
    expectedRevision: state.operationRevision ?? state.revision,
    missingFields: [],
    candidate: { target: { label: "@alice", source: "provider" } },
    active: platformStatus(platform, state.revision),
  };
}

/**
 * The default 0.5.0 instance: every documented auth route answers with a real
 * DTO, and `handle` overrides one route when a case needs a failure.
 */
function authHandler(state: FixtureState): FixtureHandler {
  return (request, response) => {
    const path = request.url.split("?")[0] ?? "";

    if (state.handle?.(request, response, path) === true) {
      return;
    }

    const body =
      request.body === "" ? {} : (JSON.parse(request.body) as Record<string, unknown>);

    if (path === "/health") {
      json(response, 200, { status: "ok" });
      return;
    }

    if (path === "/v1/auth") {
      json(response, 200, authStatus(state.revision));
      return;
    }

    if (path === "/v1/diagnostics") {
      json(response, 200, diagnosticsDto());
      return;
    }

    if (path === "/v1/posts") {
      json(response, 200, { items: [] });
      return;
    }

    const segments = path.split("/").filter(segment => segment.length > 0);

    if (segments[0] === "v1" && segments[1] === "auth" && segments.length >= 3) {
      const platform = decodeURIComponent(segments[2] as string);

      if (segments.length === 3) {
        if (request.method === "GET") {
          json(response, 200, platformStatus(platform, state.revision));
          return;
        }

        if (request.method === "POST") {
          json(response, 200, {
            platform,
            stored: true,
            revision: state.revision + 1,
            configured: true,
            readiness: "ready",
          });
          return;
        }

        if (request.method === "DELETE") {
          json(response, 200, {
            platform,
            removed: true,
            revision: state.revision + 1,
            configured: false,
            readiness: "missing_credentials",
          });
          return;
        }
      }

      if (segments.length === 4 && segments[3] === "connect" && request.method === "POST") {
        json(response, 200, {
          platform,
          operationId: "op_1",
          url: state.connectUrl ?? VALID_URLS[platform] ?? "",
          expiresAt: EXPIRES,
          expectedRevision: Number(body["expectedRevision"]),
        });
        return;
      }

      if (segments.length === 4 && segments[3] === "refresh" && request.method === "POST") {
        json(response, 200, {
          platform,
          refreshed: true,
          revision: state.revision + 1,
          configured: true,
          readiness: "ready",
          expiresAt: EXPIRES,
        });
        return;
      }

      if (segments.length >= 5 && segments[3] === "operations") {
        const operationId = decodeURIComponent(segments[4] as string);

        if (request.method === "GET" && segments.length === 5) {
          json(response, 200, operationStatus(platform, operationId, state));
          return;
        }

        if (
          request.method === "POST" &&
          segments.length === 6 &&
          segments[5] === "complete"
        ) {
          json(response, 200, {
            platform,
            operationId,
            stored: true,
            revision: state.revision + 1,
            configured: true,
            readiness: "ready",
            replayed: state.operationPhase === "completed",
          });
          return;
        }
      }
    }

    json(response, 404, { error: { code: "NOT_FOUND" } });
  };
}

/** Answers `status` with a fixed failure, so a write or read can fail on purpose. */
function failWith(
  method: string,
  path: string,
  status: number,
  code: string,
): (request: RecordedRequest, response: ServerResponse, candidate: string) => boolean {
  return (request, response, candidate) => {
    if (request.method !== method || candidate !== path) {
      return false;
    }

    json(response, status, { error: { code } });
    return true;
  };
}

/** Holds a response open so a signal arrives while the request is in flight. */
function hang(
  method: string,
  path: string,
): (request: RecordedRequest, response: ServerResponse, candidate: string) => boolean {
  return (request, _response, candidate) => request.method === method && candidate === path;
}

const CREDENTIAL = { identifier: "alice.bsky.social", password: "app-password-1" };

/* Reads ------------------------------------------------------------------- */

describe("auth status", () => {
  it("reads the whole instance once and lists every platform", async () => {
    const fixture = await server(authHandler({ revision: 4 }));
    const result = await runCli(["auth", "status", "--json"], runOptions(fixture));
    const payload = singleJson(result);

    expect(result.code).toBe(0);
    expect(payload["command"]).toBe("auth.status");
    expect(payload["ok"]).toBe(true);
    expect(
      (payload["instance"] as Record<string, unknown>)["publishingReady"],
    ).toBe(true);
    expect(Object.keys(payload["platforms"] as Record<string, unknown>)).toEqual([
      "bluesky",
      "x",
    ]);
    expect(counts(payload)).toMatchObject({ read: 1, write: 0 });
    expect(methods(fixture)).toEqual(["GET"]);
    expect(fixture.requests[0]?.url).toBe("/v1/auth");
  });

  it("reads one platform", async () => {
    const fixture = await server(authHandler({ revision: 4 }));
    const result = await runCli(
      ["auth", "status", "bluesky", "--json"],
      runOptions(fixture),
    );
    const payload = singleJson(result);

    expect(result.code).toBe(0);
    expect(payload["platform"]).toBe("bluesky");
    expect((payload["status"] as Record<string, unknown>)["revision"]).toBe(4);
    expect(methods(fixture)).toEqual(["GET"]);
    expect(fixture.requests[0]?.url).toBe("/v1/auth/bluesky");
  });
});

describe("auth operation", () => {
  it("reads one operation without writing", async () => {
    const fixture = await server(authHandler({ revision: 4 }));
    const result = await runCli(
      ["auth", "operation", "x", "op_1", "--json"],
      runOptions(fixture),
    );
    const payload = singleJson(result);
    const operation = payload["operation"] as Record<string, unknown>;

    expect(result.code).toBe(0);
    expect(operation["phase"]).toBe("awaiting_confirmation");
    expect(operation["expectedRevision"]).toBe(4);
    expect(counts(payload)).toMatchObject({ read: 1, write: 0 });
    expect(methods(fixture)).toEqual(["GET"]);
    expect(fixture.requests[0]?.url).toBe("/v1/auth/x/operations/op_1");
  });
});

describe("diagnostics", () => {
  it("reads diagnostics once and never writes", async () => {
    const fixture = await server(authHandler({ revision: 4 }));
    const result = await runCli(["diagnostics", "--json"], runOptions(fixture));
    const payload = singleJson(result);

    expect(result.code).toBe(0);
    expect(payload["command"]).toBe("diagnostics");
    expect((payload["diagnostics"] as Record<string, unknown>)["pendingOutbox"]).toBe(2);
    expect(counts(payload)).toMatchObject({ read: 1, write: 0 });
    expect(methods(fixture)).toEqual(["GET"]);
    expect(fixture.requests[0]?.url).toBe("/v1/diagnostics");
  });
});

describe("doctor readiness", () => {
  it("reads health, the auth status projection, and posts without writing", async () => {
    const fixture = await server(authHandler({ revision: 4 }));
    const result = await runCli(["doctor", "--json"], runOptions(fixture));
    const payload = singleJson(result);

    expect(result.code).toBe(0);
    expect(payload["authReadiness"]).toBe("available");
    expect(
      (payload["instance"] as Record<string, unknown>)["publishingReady"],
    ).toBe(true);
    expect(methods(fixture)).toEqual(["GET", "GET", "GET"]);
    expect(writeRequests(fixture)).toHaveLength(0);
  });
});

/* auth set ---------------------------------------------------------------- */

describe("auth set", () => {
  it("stores a credential read from a file", async () => {
    const fixture = await server(authHandler({ revision: 4 }));
    const file = secretFile("credential.json", JSON.stringify(CREDENTIAL));
    const result = await runCli(
      ["auth", "set", "bluesky", "--file", file, "--yes", "--json"],
      runOptions(fixture),
    );
    const payload = singleJson(result);

    expect(result.code).toBe(0);
    expect(payload["stored"]).toBe(true);
    expect(payload["credentialFields"]).toEqual(["identifier", "password"]);
    expect(counts(payload)).toMatchObject({ read: 1, write: 1 });
    expect(bodyOf(writeRequests(fixture)[0])).toEqual({
      identifier: CREDENTIAL.identifier,
      password: CREDENTIAL.password,
      expectedRevision: 4,
    });
    expect(result.stdout).not.toContain(CREDENTIAL.password);
    expect(result.stderr).not.toContain(CREDENTIAL.password);
  });

  it("stores a credential piped on stdin", async () => {
    const fixture = await server(authHandler({ revision: 4 }));
    const result = await runCli(["auth", "set", "bluesky", "--yes", "--json"], {
      ...runOptions(fixture),
      stdin: JSON.stringify(CREDENTIAL),
    });
    const payload = singleJson(result);

    expect(result.code).toBe(0);
    expect(payload["stored"]).toBe(true);
    expect(bodyOf(writeRequests(fixture)[0])).toEqual({
      identifier: CREDENTIAL.identifier,
      password: CREDENTIAL.password,
      expectedRevision: 4,
    });
    expect(result.stdout).not.toContain(CREDENTIAL.password);
    expect(result.stderr).not.toContain(CREDENTIAL.password);
  });

  it("covers a short secret without corrupting the JSON object", async () => {
    const fixture = await server(authHandler({ revision: 4 }));
    const short = "zq7";
    const result = await runCli(["auth", "set", "bluesky", "--yes", "--json"], {
      ...runOptions(fixture),
      stdin: JSON.stringify({ identifier: "alice", password: short }),
    });
    const payload = singleJson(result);

    expect(result.code).toBe(0);
    // Structural keys and documented field names survive redaction.
    expect(Object.keys(payload)).toContain("credentialFields");
    expect(payload["credentialFields"]).toEqual(["identifier", "password"]);
    expect(result.stdout).not.toContain(short);
    expect(bodyOf(writeRequests(fixture)[0])["password"]).toBe(short);
  });

  it("covers a secret that carries JSON escape characters", async () => {
    const fixture = await server(authHandler({ revision: 4 }));
    const escaped = 'pa"ss\\word\nline2';
    const result = await runCli(["auth", "set", "bluesky", "--yes", "--json"], {
      ...runOptions(fixture),
      stdin: JSON.stringify({ identifier: "alice", password: escaped }),
    });
    const payload = singleJson(result);

    expect(result.code).toBe(0);
    expect(payload["stored"]).toBe(true);
    // The raw value, and its escaped wire form, stay out of both streams.
    expect(result.stdout).not.toContain(escaped);
    expect(result.stdout).not.toContain('pa\\"ss');
    expect(result.stderr).not.toContain(escaped);
    expect(bodyOf(writeRequests(fixture)[0])["password"]).toBe(escaped);
  });

  it("never echoes an unsupported secret flag value", async () => {
    const fixture = await server(authHandler({ revision: 4 }));
    const result = await runCli(
      ["auth", "set", "bluesky", "--token=sentinel-secret-value", "--yes", "--json"],
      { ...runOptions(fixture), stdin: JSON.stringify(CREDENTIAL) },
    );
    const payload = singleJson(result);

    expect(result.code).toBe(2);
    expect(errorCode(payload)).toBe("USAGE");
    expect(result.stdout).not.toContain("sentinel-secret-value");
    expect(result.stderr).not.toContain("sentinel-secret-value");
    expect(fixture.requestCount()).toBe(0);
  });
});

describe("auth set secret boundaries", () => {
  const rejected: readonly { name: string; stdin: string }[] = [
    {
      name: "an own __proto__ key",
      stdin: '{"identifier":"alice","password":"pw","__proto__":{"polluted":true}}',
    },
    {
      name: "an own constructor key",
      stdin: '{"identifier":"alice","password":"pw","constructor":"polluted"}',
    },
    { name: "malformed JSON", stdin: '{"identifier":"alice","password":' },
    {
      name: "an unknown credential field",
      stdin: '{"identifier":"alice","password":"pw","token":"nope"}',
    },
    {
      name: "a caller-supplied expectedRevision",
      stdin: '{"identifier":"alice","password":"pw","expectedRevision":99}',
    },
    { name: "a JSON array", stdin: '["identifier","password"]' },
    { name: "a JSON primitive", stdin: '"identifier"' },
  ];

  for (const testCase of rejected) {
    it(`rejects ${testCase.name} with zero writes`, async () => {
      const fixture = await server(authHandler({ revision: 4 }));
      const result = await runCli(["auth", "set", "bluesky", "--yes", "--json"], {
        ...runOptions(fixture),
        stdin: testCase.stdin,
      });
      const payload = singleJson(result);

      expect(result.code).toBe(2);
      expect(errorCode(payload)).toBe("INVALID_SECRET");
      // Nothing was read from the instance, so no method of any kind was sent.
      expect(fixture.requestCount()).toBe(0);
      expect(methods(fixture)).toEqual([]);
      // Malformed input is never echoed back.
      expect(result.stdout).not.toContain(testCase.stdin);
      expect(result.stderr).not.toContain(testCase.stdin);
    });
  }

  it("rejects a secret document larger than 64KiB with zero writes", async () => {
    const fixture = await server(authHandler({ revision: 4 }));
    const oversized = JSON.stringify({
      identifier: "alice",
      password: "a".repeat(70 * 1_024),
    });
    const result = await runCliTolerantStdin(["auth", "set", "bluesky", "--yes", "--json"], {
      timeoutMs: 15_000,
      env: fixtureEnv(fixture),
      stdin: oversized,
    });
    const payload = singleJson(result);

    expect(result.code).toBe(2);
    expect(errorCode(payload)).toBe("INVALID_SECRET");
    expect(errorMessage(payload)).toContain("65536");
    expect(fixture.requestCount()).toBe(0);
  });
});

/* Confirmation ------------------------------------------------------------ */

describe("non-interactive confirmation", () => {
  it("auth set without --yes writes nothing", async () => {
    const fixture = await server(authHandler({ revision: 4 }));
    const result = await runCli(["auth", "set", "bluesky", "--json"], {
      ...runOptions(fixture),
      stdin: JSON.stringify(CREDENTIAL),
    });
    const payload = singleJson(result);

    expect(result.code).toBe(2);
    expect(errorCode(payload)).toBe("CONFIRMATION_REQUIRED");
    expect(counts(payload)).toMatchObject({ read: 0, write: 0 });
    expect(fixture.requestCount()).toBe(0);
  });

  it("auth complete without --yes writes nothing", async () => {
    const fixture = await server(authHandler({ revision: 4 }));
    const result = await runCli(
      ["auth", "complete", "x", "op_1", "--json"],
      runOptions(fixture),
    );
    const payload = singleJson(result);

    expect(result.code).toBe(2);
    expect(errorCode(payload)).toBe("CONFIRMATION_REQUIRED");
    expect(counts(payload)).toMatchObject({ read: 0, write: 0 });
    expect(fixture.requestCount()).toBe(0);
  });

  it("auth remove without --yes writes nothing", async () => {
    const fixture = await server(authHandler({ revision: 4 }));
    const result = await runCli(["auth", "remove", "x", "--json"], runOptions(fixture));
    const payload = singleJson(result);

    expect(result.code).toBe(2);
    expect(errorCode(payload)).toBe("CONFIRMATION_REQUIRED");
    expect(counts(payload)).toMatchObject({ read: 0, write: 0 });
    expect(fixture.requestCount()).toBe(0);
  });
});

describe("TTY confirmation", () => {
  it("writes once when the operator accepts the preview", async () => {
    const fixture = await server(authHandler({ revision: 4 }));
    const file = secretFile("credential.json", JSON.stringify(CREDENTIAL));
    const result = await runCliPty(["auth", "set", "bluesky", "--file", file, "--json"], {
      env: fixtureEnv(fixture),
      trigger: "Store this credential? [y/N]",
      answer: "y\n",
    });
    const objects = jsonLines(result.output);

    expect(result.code).toBe(0);
    expect(writeRequests(fixture)).toHaveLength(1);
    expect(bodyOf(writeRequests(fixture)[0])["expectedRevision"]).toBe(4);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.["stored"]).toBe(true);
    expect(result.output).not.toContain(CREDENTIAL.password);
  });

  it("writes nothing when the operator declines", async () => {
    const fixture = await server(authHandler({ revision: 4 }));
    const file = secretFile("credential.json", JSON.stringify(CREDENTIAL));
    const result = await runCliPty(["auth", "set", "bluesky", "--file", file, "--json"], {
      env: fixtureEnv(fixture),
      trigger: "Store this credential? [y/N]",
      answer: "n\n",
    });
    const objects = jsonLines(result.output);

    expect(result.code).toBe(5);
    expect(methods(fixture)).toEqual(["GET"]);
    expect(writeRequests(fixture)).toHaveLength(0);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.["cancelled"]).toBe(true);
    expect(counts(objects[0] ?? {})).toMatchObject({ read: 1, write: 0 });
    // The decline is reported on the terminal, and the payload says why.
    expect(result.output).toContain("Cancelled. Nothing was sent.");
    expect(JSON.stringify(objects[0]?.["notes"])).toContain("declined");
  });
});

describe("revision handling", () => {
  it("submits the revision read before the prompt even when the instance moved on", async () => {
    const state: FixtureState = { revision: 7 };
    const fixture = await server(authHandler(state));
    const file = secretFile("credential.json", JSON.stringify(CREDENTIAL));
    const result = await runCliPty(["auth", "set", "bluesky", "--file", file, "--json"], {
      env: fixtureEnv(fixture),
      trigger: "Store this credential? [y/N]",
      beforeAnswer: () => {
        state.revision = 9;
      },
      answer: "y\n",
    });

    expect(result.code).toBe(0);
    expect(methods(fixture)).toEqual(["GET", "POST"]);
    expect(bodyOf(writeRequests(fixture)[0])["expectedRevision"]).toBe(7);
  });

  it("keeps the pre-prompt revision and surfaces the server conflict without retrying", async () => {
    const state: FixtureState = {
      revision: 7,
      operationRevision: 7,
      handle: failWith("POST", "/v1/auth/x/operations/op_1/complete", 409, "AUTH_CONFLICT"),
    };
    const fixture = await server(authHandler(state));
    const result = await runCliPty(["auth", "complete", "x", "op_1", "--json"], {
      env: fixtureEnv(fixture),
      trigger: "Complete this authorization? [y/N]",
      beforeAnswer: () => {
        state.revision = 9;
      },
      answer: "y\n",
    });
    const objects = jsonLines(result.output);

    expect(result.code).toBe(1);
    // Exactly one completion attempt: a conflict is reported, never retried.
    expect(writeRequests(fixture)).toHaveLength(1);
    expect(bodyOf(writeRequests(fixture)[0])["expectedRevision"]).toBe(7);
    expect(objects).toHaveLength(1);
    expect(errorCode(objects[0] ?? {})).toBe("AUTH_CONFLICT");
    expect(counts(objects[0] ?? {})).toMatchObject({ read: 2, write: 1 });
  });

  it("replays a completed operation under its historical revision", async () => {
    const fixture = await server(
      authHandler({ revision: 7, operationRevision: 3, operationPhase: "completed" }),
    );
    const result = await runCli(
      ["auth", "complete", "x", "op_1", "--yes", "--json"],
      runOptions(fixture),
    );
    const payload = singleJson(result);

    expect(result.code).toBe(0);
    expect(payload["replayed"]).toBe(true);
    // The active slot moved on, but the replay keeps the operation's revision.
    expect(bodyOf(writeRequests(fixture)[0])["expectedRevision"]).toBe(3);
  });
});

describe("auth refresh", () => {
  it("refreshes under the observed revision and writes once", async () => {
    const fixture = await server(authHandler({ revision: 4 }));
    const result = await runCli(["auth", "refresh", "x", "--json"], runOptions(fixture));
    const payload = singleJson(result);

    expect(result.code).toBe(0);
    expect(payload["refreshed"]).toBe(true);
    expect(counts(payload)).toMatchObject({ read: 1, write: 1 });
    expect(methods(fixture)).toEqual(["GET", "POST"]);
    expect(bodyOf(writeRequests(fixture)[0])["expectedRevision"]).toBe(4);
  });
});

/* Failures ---------------------------------------------------------------- */

describe("auth set failures", () => {
  it("reports an ambiguous write with auth advice and never a post key", async () => {
    const fixture = await server(
      authHandler({
        revision: 4,
        handle: failWith("POST", "/v1/auth/bluesky", 500, "INTERNAL_ERROR"),
      }),
    );
    const file = secretFile("credential.json", JSON.stringify(CREDENTIAL));
    const result = await runCli(
      ["auth", "set", "bluesky", "--file", file, "--yes", "--json"],
      runOptions(fixture),
    );
    const payload = singleJson(result);
    const message = errorMessage(payload);

    expect(result.code).toBe(4);
    expect(errorCode(payload)).toBe("AMBIGUOUS_DELIVERY");
    expect(counts(payload)).toMatchObject({ read: 1, write: 1 });
    expect(message).toContain("auth.status");
    expect(message).not.toContain("Idempotency-Key");
    expect(message).not.toContain("posts");
    expect(result.stderr).not.toContain("Idempotency-Key");
  });

  it("surfaces a server conflict once, with the write count it actually made", async () => {
    const fixture = await server(
      authHandler({
        revision: 4,
        handle: failWith("POST", "/v1/auth/bluesky", 409, "AUTH_CONFLICT"),
      }),
    );
    const file = secretFile("credential.json", JSON.stringify(CREDENTIAL));
    const result = await runCli(
      ["auth", "set", "bluesky", "--file", file, "--yes", "--json"],
      runOptions(fixture),
    );
    const payload = singleJson(result);

    expect(result.code).toBe(1);
    expect(errorCode(payload)).toBe("AUTH_CONFLICT");
    expect(counts(payload)).toMatchObject({ read: 1, write: 1 });
    expect(writeRequests(fixture)).toHaveLength(1);
  });

  it("keeps auth advice on an interrupted write, never a post key", async () => {
    const fixture = await server(
      authHandler({ revision: 4, handle: hang("POST", "/v1/auth/bluesky") }),
    );
    const file = secretFile("credential.json", JSON.stringify(CREDENTIAL));
    const result = await interruptAfterRequest(
      ["auth", "set", "bluesky", "--file", file, "--yes", "--json"],
      fixture,
      request => request.method === "POST" && request.url === "/v1/auth/bluesky",
    );
    const payload = singleJson({
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: false,
    });
    const message = errorMessage(payload);

    // A write that was interrupted after it was sent is an ambiguous outcome,
    // and its advice follows the auth command rather than a post.
    expect(result.code).toBe(4);
    expect(errorCode(payload)).toBe("AMBIGUOUS_DELIVERY");
    expect(message).toContain("auth.status");
    expect(message).not.toContain("Idempotency-Key");
    expect(message).not.toContain("posts");
    expect(`${result.stdout}${result.stderr}`).not.toContain("Idempotency-Key");
    expect(payload["ok"]).toBe(false);
    expect(counts(payload)["write"]).toBe(1);
  });
});

describe("read-only commands interrupted", () => {
  it("tells a diagnostics operator that only reads happened", async () => {
    const fixture = await server(
      authHandler({ revision: 4, handle: hang("GET", "/v1/diagnostics") }),
    );
    const result = await interruptAfterRequest(
      ["diagnostics", "--json"],
      fixture,
      request => request.url === "/v1/diagnostics",
    );
    const payload = singleJson({
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: false,
    });

    expect(result.code).toBe(130);
    expect(result.stderr).toContain("Stopped locally");
    expect(result.stderr).not.toContain("posts");
    expect(payload["exitCode"]).toBe(130);
    expect(counts(payload)["write"]).toBe(0);
  });

  it("tells a doctor operator that only reads happened", async () => {
    const fixture = await server(authHandler({ revision: 4, handle: hang("GET", "/health") }));
    const result = await interruptAfterRequest(
      ["doctor", "--json"],
      fixture,
      request => request.url === "/health",
    );
    const payload = singleJson({
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: false,
    });

    expect(result.code).toBe(130);
    expect(result.stderr).toContain("Stopped locally");
    expect(`${result.stdout}${result.stderr}`).not.toContain("posts");
    expect(payload["exitCode"]).toBe(130);
  });
});

/* Authorization URL ------------------------------------------------------- */

describe("auth connect", () => {
  it("prints each configured provider URL exactly once", async () => {
    for (const platform of ["x", "tumblr", "linkedin"] as const) {
      const fixture = await server(authHandler({ revision: 4 }));
      const url = VALID_URLS[platform] as string;
      const result = await runCli(
        ["auth", "connect", platform, "--json"],
        runOptions(fixture),
      );
      const payload = singleJson(result);

      expect(result.code).toBe(0);
      expect(payload["authorizationUrl"]).toBe(url);
      expect(occurrences(result.stdout, url)).toBe(1);
      expect(occurrences(result.stderr, url)).toBe(0);
      expect(counts(payload)).toMatchObject({ read: 1, write: 1 });
      expect(writeRequests(fixture)).toHaveLength(1);
    }
  });

  const rejected: readonly { name: string; platform: string; url: string }[] = [
    {
      name: "a path that is not the configured endpoint",
      platform: "x",
      url: "https://api.twitter.com/oauth/authorize/extra?oauth_token=tok",
    },
    {
      name: "a host that is not the configured endpoint",
      platform: "x",
      url: "https://evil.example.com/oauth/authorize?oauth_token=tok",
    },
    {
      name: "a non-default port",
      platform: "x",
      url: "https://api.twitter.com:8443/oauth/authorize?oauth_token=tok",
    },
    {
      name: "userinfo",
      platform: "x",
      url: "https://user:secret@api.twitter.com/oauth/authorize?oauth_token=tok",
    },
    {
      name: "a fragment",
      platform: "x",
      url: "https://api.twitter.com/oauth/authorize?oauth_token=tok#section",
    },
    {
      name: "a plaintext scheme",
      platform: "x",
      url: "http://api.twitter.com/oauth/authorize?oauth_token=tok",
    },
    {
      name: "a duplicate query key",
      platform: "x",
      url: "https://api.twitter.com/oauth/authorize?oauth_token=a&oauth_token=b",
    },
    {
      name: "an unknown query key",
      platform: "x",
      url: "https://api.twitter.com/oauth/authorize?oauth_token=tok&extra=1",
    },
    {
      name: "an empty query value",
      platform: "x",
      url: "https://api.twitter.com/oauth/authorize?oauth_token=",
    },
    {
      name: "a missing protocol-required key",
      platform: "x",
      url: "https://api.twitter.com/oauth/authorize",
    },
    {
      name: "a control character",
      platform: "x",
      url: "https://api.twitter.com/oauth/authorize?oauth_token=a\u0001b",
    },
    {
      name: "an overlong URL",
      platform: "x",
      url: `https://api.twitter.com/oauth/authorize?oauth_token=${"a".repeat(2_100)}`,
    },
    {
      name: "a LinkedIn response_type that is not code",
      platform: "linkedin",
      url:
        "https://www.linkedin.com/oauth/v2/authorization?response_type=token&client_id=c" +
        "&redirect_uri=https%3A%2F%2Fcb.example.com%2Fcb&state=s&scope=r",
    },
    {
      name: "a LinkedIn callback that is not HTTPS",
      platform: "linkedin",
      url:
        "https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=c" +
        "&redirect_uri=http%3A%2F%2Fcb.example.com%2Fcb&state=s&scope=r",
    },
  ];

  for (const testCase of rejected) {
    it(`refuses to display ${testCase.name}`, async () => {
      const fixture = await server(
        authHandler({ revision: 4, connectUrl: testCase.url }),
      );
      const result = await runCli(
        ["auth", "connect", testCase.platform, "--json"],
        runOptions(fixture),
      );
      const payload = singleJson(result);

      expect(result.code).toBe(1);
      expect(errorCode(payload)).toBe("UNSAFE_AUTHORIZATION_URL");
      // Zero display writes: the rejected value reaches neither stream.
      expect(occurrences(result.stdout, testCase.url)).toBe(0);
      expect(occurrences(result.stderr, testCase.url)).toBe(0);
      // The connect request itself was sent and accepted, and the count says so.
      expect(counts(payload)).toMatchObject({ read: 1, write: 1 });
      expect(writeRequests(fixture)).toHaveLength(1);
    });
  }
});

describe("counts describe dispatched attempts only", () => {
  it("reports zero counts when the platform is not one this CLI documents", async () => {
    const fixture = await server((_request, response) => {
      json(response, 200, {});
    });
    const file = secretFile("secret.json", JSON.stringify({ access_token: "tok_1" }));

    const result = await runCli(
      ["auth", "set", "constructor", "--file", file, "--yes", "--json"],
      { ...runOptions(fixture), timeoutMs: 15_000 },
    );

    expect(result.code).toBe(2);
    expect(counts(singleJson(result))).toEqual({ read: 0, write: 0 });
    // The local rejection never reached the instance.
    expect(fixture.requests).toHaveLength(0);
  });

  it(
    "aborts a held-open secret read with exit 130, zero counts, and a natural exit",
    async () => {
      const fixture = await server((_request, response) => {
        json(response, 200, {});
      });
      const child = spawn(
        process.execPath,
        [CLI_BIN, "auth", "set", "bluesky", "--file", "-", "--yes", "--json"],
        {
          cwd: CLI_ROOT,
          env: { ...process.env, ...fixtureEnv(fixture) },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 8_000);

      child.stdout.on("data", chunk => {
        stdout += chunk.toString("utf8");
      });

      // Let the CLI arm its stdin read, then interrupt while the parent keeps
      // the pipe open: the reader must not wait for a hang to be cleaned up.
      await new Promise(resolve => setTimeout(resolve, 300));
      child.kill("SIGINT");

      const code = await new Promise<number | null>(resolve => {
        child.on("close", value => {
          resolve(value);
        });
      });

      clearTimeout(timer);
      child.stdin.destroy();

      expect(timedOut).toBe(false);
      expect(code).toBe(130);
      expect(counts(singleJson({ code: 0, stdout, stderr: "" } as RunResult))).toEqual({
        read: 0,
        write: 0,
      });
      expect(fixture.requests).toHaveLength(0);
    },
    20_000,
  );
});

/** An io for the in-process entry point: no tty, capture both streams. */
function offlineIo(
  fixture: FixtureServer,
  signal: AbortSignal,
  stdinText = "",
): { io: CliIo; stdout: () => string; stderr: () => string } {
  const input = new PassThrough();
  const out = new PassThrough();
  const err = new PassThrough();
  let stdout = "";
  let stderr = "";

  out.on("data", chunk => {
    stdout += chunk.toString("utf8");
  });
  err.on("data", chunk => {
    stderr += chunk.toString("utf8");
  });

  if (stdinText.length > 0) {
    input.end(stdinText);
  }

  return {
    io: {
      stdin: input,
      stdout: out,
      stderr: err,
      env: fixtureEnv(fixture),
      cwd: CLI_ROOT,
      stdinIsTty: false,
      stdoutIsTty: false,
      hasTty: () => false,
      readTtyLine: () => undefined,
      signal,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("pre-aborted commands dispatch nothing and count nothing", () => {
  it("reports {read:0,write:0} for status, operation, and diagnostics", async () => {
    const fixture = await server((_request, response) => {
      json(response, 200, authStatus(1));
    });
    const cases: ReadonlyArray<readonly string[]> = [
      ["auth", "status", "x", "--json"],
      ["auth", "operation", "x", "op_1", "--json"],
      ["diagnostics", "--json"],
    ];

    for (const argv of cases) {
      const harness = offlineIo(fixture, AbortSignal.abort());
      const code = await run(argv, harness.io);
      const payload = parseJsonObject(harness.stdout()) as Record<string, unknown>;

      expect(code).toBe(130);
      expect(counts(payload)).toEqual({ read: 0, write: 0 });
    }

    // A pre-aborted read never opened a socket.
    expect(fixture.requests).toHaveLength(0);
  });
});

describe("secret input boundaries", () => {
  it("rejects an unreadable path without echoing it, with zero counts", async () => {
    const fixture = await server((_request, response) => {
      json(response, 200, authStatus(1));
    });
    const missing = path.join(
      tmpdir(),
      `syndroo-missing-${String(process.pid)}-${String(Date.now())}`,
      "secret.json",
    );

    const result = await runCli(
      ["auth", "set", "bluesky", "--file", missing, "--yes", "--json"],
      { ...runOptions(fixture), timeoutMs: 15_000 },
    );

    expect(result.code).toBe(2);
    expect(counts(singleJson(result))).toEqual({ read: 0, write: 0 });
    expect(result.stdout).not.toContain("secret.json");
    expect(result.stderr).not.toContain("secret.json");
    expect(fixture.requests).toHaveLength(0);
  });

  it("rejects nested and prototype-nested secret documents with zero requests", async () => {
    const fixture = await server((_request, response) => {
      json(response, 200, authStatus(1));
    });
    const documents = [
      JSON.stringify({ access_token: { nested: "value" } }),
      `{"outer":{"__proto__":{"access_token":"fake-sentinel"}}}`,
    ];

    for (const document of documents) {
      const file = secretFile("secret.json", document);
      const result = await runCli(
        ["auth", "set", "threads", "--file", file, "--yes", "--json"],
        { ...runOptions(fixture), timeoutMs: 15_000 },
      );
      const payload = singleJson(result);

      expect(result.code).toBe(2);
      expect(counts(payload)).toEqual({ read: 0, write: 0 });
      expect(result.stdout + result.stderr).not.toContain("fake-sentinel");
    }

    expect(fixture.requests).toHaveLength(0);
  });
});

describe("doctor readiness boundaries", () => {
  it("treats 405 as legacy compatibility and refuses malformed readiness", async () => {
    const legacy = await server((request, response) => {
      if (request.url === "/health") {
        json(response, 200, { status: "ok" });
        return;
      }

      if (request.url === "/v1/auth") {
        json(response, 405, { error: { code: "INVALID_REQUEST", message: "method" } });
        return;
      }

      json(response, 200, { items: [] });
    });

    const legacyResult = await runCli(["doctor", "--json"], {
      ...runOptions(legacy),
      timeoutMs: 15_000,
    });

    expect(legacyResult.code).toBe(0);
    expect(singleJson(legacyResult)["authReadiness"]).toContain("does not expose");

    const malformed = await server((request, response) => {
      if (request.url === "/health") {
        json(response, 200, { status: "ok" });
        return;
      }

      if (request.url === "/v1/auth") {
        json(response, 200, { instance: {}, platforms: {} });
        return;
      }

      json(response, 200, { items: [] });
    });

    const malformedResult = await runCli(["doctor", "--json"], {
      ...runOptions(malformed),
      timeoutMs: 15_000,
    });

    expect(malformedResult.code).toBe(1);
    expect(singleJson(malformedResult)["ok"]).toBe(false);
  });

  it("keeps a pre-aborted doctor as ABORTED with exit 130", async () => {
    const fixture = await server((_request, response) => {
      json(response, 200, { status: "ok" });
    });
    const harness = offlineIo(fixture, AbortSignal.abort());

    const code = await run(["doctor", "--json"], harness.io);

    expect(code).toBe(130);
  });
});

describe("remove and complete succeed with exact bodies", () => {
  it("removes with the observed revision", async () => {
    const fixture = await server((request, response) => {
      if (request.method === "GET") {
        json(response, 200, platformStatus("bluesky", 4));
        return;
      }

      json(response, 200, {
        platform: "bluesky",
        removed: true,
        revision: 5,
        configured: false,
        readiness: "missing_credentials",
      });
    });

    const result = await runCli(["auth", "remove", "bluesky", "--yes", "--json"], {
      ...runOptions(fixture),
      timeoutMs: 15_000,
    });
    const payload = singleJson(result);

    expect(result.code).toBe(0);
    expect(payload["removed"]).toBe(true);
    expect(methods(fixture)).toEqual(["GET", "DELETE"]);
    expect(bodyOf(writeRequests(fixture)[0])).toEqual({ expectedRevision: 4 });
    expect(counts(payload)).toEqual({ read: 1, write: 1 });
  });

  it("completes with explicit public target flags", async () => {
    const fixture = await server((request, response) => {
      if (request.method === "POST") {
        json(response, 200, {
          platform: "linkedin",
          operationId: "op_1",
          stored: true,
          revision: 4,
          configured: true,
          readiness: "ready",
        });
        return;
      }

      if (request.url.includes("/operations/")) {
        json(response, 200, {
          platform: "linkedin",
          operationId: "op_1",
          phase: "awaiting_confirmation",
          expiresAt: EXPIRES,
          expectedRevision: 3,
          missingFields: [],
          candidate: { target: { label: "urn:li:person:new", source: "user" } },
          active: platformStatus("linkedin", 3, {
            target: { label: "urn:li:person:old", source: "user" },
          }),
        });
        return;
      }

      json(response, 200, platformStatus("linkedin", 3));
    });

    const result = await runCli(
      [
        "auth",
        "complete",
        "linkedin",
        "op_1",
        "--author",
        "urn:li:person:new",
        "--api-version",
        "202604",
        "--yes",
        "--json",
      ],
      { ...runOptions(fixture), timeoutMs: 15_000 },
    );
    const payload = singleJson(result);

    expect(result.code).toBe(0);
    expect(payload["stored"]).toBe(true);
    expect(counts(payload)).toEqual({ read: 2, write: 1 });
    expect(bodyOf(writeRequests(fixture)[0])).toEqual({
      expectedRevision: 3,
      target: { author: "urn:li:person:new", api_version: "202604" },
    });
  });
});
