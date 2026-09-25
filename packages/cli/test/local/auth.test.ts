import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { LocalProviderError, type LocalCredentials } from "@syndroo/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CliError } from "../../src/cli-error.js";
import { EXIT_CODE } from "../../src/exit-codes.js";
import {
  bindLocalAccount,
  removeLocalAccount,
  resolveForExecution,
  verifyLocalAccount,
  type LocalAuthPreview,
} from "../../src/local/auth.js";
import {
  credentialFingerprint,
  resolveCredentialSource,
  selectCredentialReference,
} from "../../src/local/credentials.js";
import { canonicalJson } from "../../src/local/document.js";
import type { CredentialReference } from "../../src/local/ports/credentials.js";
import {
  FAKE_BLUESKY_IDENTIFIER,
  FAKE_BLUESKY_PASSWORD,
  FAKE_THREADS_TOKEN,
  FakeLocalProvider,
  FakeLocalStore,
  blueskyCredentialBody,
  threadsCredentialBody,
  writeCredentialFile,
} from "./auth-fixtures.js";

const signal = new AbortController().signal;
const BLUESKY_TARGET = "did:plc:fake-bluesky-account";
const THREADS_TARGET = "fake-threads-user-id";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIFO_CHILD_ENTRY = fileURLToPath(new URL("./auth-fifo-child.ts", import.meta.url));
/** Generous kill bound: the probe must finish long before this. */
const FIFO_CHILD_TIMEOUT_MS = 10_000;

const execFileAsync = promisify(execFile);

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runChild(entry: string, args: readonly string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: PACKAGE_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: FIFO_CHILD_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk as string;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk as string;
    });
    child.on("error", reject);
    child.on("close", (code, closeSignal) =>
      resolve({ code, signal: closeSignal, stdout, stderr }),
    );
  });
}

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  // `realpath` keeps the fixture free of macOS `/var` -> `/private/var`
  // symlinks, which the credential reader deliberately refuses to traverse.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "syndroo-auth-")));
  tempDirs.push(directory);
  return directory;
}

/** The raw `os.tmpdir()` form, still under macOS `/var` on purpose. */
async function rawTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "syndroo-auth-alias-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(directory =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function cliErrorOf(run: () => Promise<unknown>): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }

  throw new Error("expected a CliError");
}

/** Every byte the fake store persisted, so a test can scan the whole state. */
async function readAllFiles(directory: string): Promise<string> {
  const names = await readdir(directory, { recursive: true });
  const bodies = await Promise.all(
    names.map(name => readFile(join(directory, name), "utf8")),
  );
  return bodies.join("\n");
}

function fileReference(path: string): CredentialReference {
  return { kind: "file", provider: "bluesky", path };
}

function envReference(): CredentialReference {
  return { kind: "env", provider: "bluesky" };
}

describe("selectCredentialReference", () => {
  it("rejects a missing or conflicting source without echoing the path", async () => {
    const cwd = await tempDir();

    const missing = await cliErrorOf(async () =>
      selectCredentialReference("bluesky", { fromEnv: false, cwd }),
    );
    expect(missing.code).toBe("USAGE");
    expect(missing.exitCode).toBe(EXIT_CODE.USAGE);

    const conflict = await cliErrorOf(async () =>
      selectCredentialReference("bluesky", {
        fromEnv: true,
        credentialFile: "creds.json",
        cwd,
      }),
    );
    expect(conflict.code).toBe("USAGE");
    expect(conflict.message.includes("creds.json")).toBe(false);
  });

  it("maps exactly one source to a reference with a canonical absolute path", async () => {
    const cwd = await tempDir();

    expect(selectCredentialReference("threads", { fromEnv: true, cwd })).toEqual({
      kind: "env",
      provider: "threads",
    });

    const relative = selectCredentialReference("bluesky", {
      fromEnv: false,
      credentialFile: "./nested/../creds.json",
      cwd,
    });
    expect(relative).toEqual({
      kind: "file",
      provider: "bluesky",
      path: join(cwd, "creds.json"),
    });

    const blank = await cliErrorOf(async () =>
      selectCredentialReference("bluesky", {
        fromEnv: false,
        credentialFile: "   ",
        cwd,
      }),
    );
    expect(blank.code).toBe("USAGE");
  });
});

describe("resolveCredentialSource from the environment", () => {
  it("resolves a complete Bluesky group and defaults the trusted host", async () => {
    const credentials = await resolveCredentialSource(envReference(), {
      env: {
        BLUESKY_IDENTIFIER: FAKE_BLUESKY_IDENTIFIER,
        BLUESKY_PASSWORD: FAKE_BLUESKY_PASSWORD,
      },
    });

    expect(credentials).toEqual({
      provider: "bluesky",
      identifier: FAKE_BLUESKY_IDENTIFIER,
      password: FAKE_BLUESKY_PASSWORD,
      host: "bsky.social",
    });
  });

  it("accepts the documented trusted host and rejects every other host", async () => {
    const withHost = async (host: string): Promise<unknown> =>
      resolveCredentialSource(envReference(), {
        env: {
          BLUESKY_IDENTIFIER: FAKE_BLUESKY_IDENTIFIER,
          BLUESKY_PASSWORD: FAKE_BLUESKY_PASSWORD,
          BLUESKY_HOST: host,
        },
      });

    await expect(withHost("bsky.social")).resolves.toMatchObject({
      host: "bsky.social",
    });

    for (const host of [
      "https://bsky.social",
      "bsky.social:443",
      "127.0.0.1",
      "localhost",
      "example.com",
      "user:pass@bsky.social",
    ]) {
      const error = await cliErrorOf(async () => withHost(host));
      expect(error.code).toBe("AUTH_SOURCE_UNAVAILABLE");
    }
  });

  it("refuses an incomplete group and never mixes providers", async () => {
    const onlyIdentifier = await cliErrorOf(async () =>
      resolveCredentialSource(envReference(), {
        env: { BLUESKY_IDENTIFIER: FAKE_BLUESKY_IDENTIFIER },
      }),
    );
    expect(onlyIdentifier.code).toBe("AUTH_SOURCE_UNAVAILABLE");

    const otherProvider = await cliErrorOf(async () =>
      resolveCredentialSource(envReference(), {
        env: { THREADS_ACCESS_TOKEN: FAKE_THREADS_TOKEN },
      }),
    );
    expect(otherProvider.code).toBe("AUTH_SOURCE_UNAVAILABLE");
    expect(otherProvider.message.includes(FAKE_THREADS_TOKEN)).toBe(false);

    const blank = await cliErrorOf(async () =>
      resolveCredentialSource(envReference(), {
        env: {
          BLUESKY_IDENTIFIER: "   ",
          BLUESKY_PASSWORD: FAKE_BLUESKY_PASSWORD,
        },
      }),
    );
    expect(blank.code).toBe("AUTH_SOURCE_UNAVAILABLE");
  });

  it("rejects control characters in the identifier and host", async () => {
    const controlIdentifier = await cliErrorOf(async () =>
      resolveCredentialSource(envReference(), {
        env: {
          BLUESKY_IDENTIFIER: `fake\u0007handle`,
          BLUESKY_PASSWORD: FAKE_BLUESKY_PASSWORD,
        },
      }),
    );
    expect(controlIdentifier.code).toBe("AUTH_SOURCE_UNAVAILABLE");

    const controlHost = await cliErrorOf(async () =>
      resolveCredentialSource(envReference(), {
        env: {
          BLUESKY_IDENTIFIER: FAKE_BLUESKY_IDENTIFIER,
          BLUESKY_PASSWORD: FAKE_BLUESKY_PASSWORD,
          BLUESKY_HOST: "bsky.social\u0000",
        },
      }),
    );
    expect(controlHost.code).toBe("AUTH_SOURCE_UNAVAILABLE");
  });

  it("rejects C1 control characters, not just the ASCII range", async () => {
    const c1Identifier = await cliErrorOf(async () =>
      resolveCredentialSource(envReference(), {
        env: {
          BLUESKY_IDENTIFIER: `fake\u0085handle`,
          BLUESKY_PASSWORD: FAKE_BLUESKY_PASSWORD,
        },
      }),
    );
    expect(c1Identifier.code).toBe("AUTH_SOURCE_UNAVAILABLE");

    const c1Host = await cliErrorOf(async () =>
      resolveCredentialSource(envReference(), {
        env: {
          BLUESKY_IDENTIFIER: FAKE_BLUESKY_IDENTIFIER,
          BLUESKY_PASSWORD: FAKE_BLUESKY_PASSWORD,
          BLUESKY_HOST: `\u009B${"bsky.social"}`,
        },
      }),
    );
    expect(c1Host.code).toBe("AUTH_SOURCE_UNAVAILABLE");
  });

  it("refuses a present but blank host instead of defaulting it", async () => {
    for (const host of ["", "   ", "\t"]) {
      const error = await cliErrorOf(async () =>
        resolveCredentialSource(envReference(), {
          env: {
            BLUESKY_IDENTIFIER: FAKE_BLUESKY_IDENTIFIER,
            BLUESKY_PASSWORD: FAKE_BLUESKY_PASSWORD,
            BLUESKY_HOST: host,
          },
        }),
      );
      expect(error.code).toBe("AUTH_SOURCE_UNAVAILABLE");
    }
  });

  it("resolves a complete Threads group and refuses a partial one", async () => {
    const credentials = await resolveCredentialSource(
      { kind: "env", provider: "threads" },
      { env: { THREADS_ACCESS_TOKEN: FAKE_THREADS_TOKEN } },
    );
    expect(credentials).toEqual({
      provider: "threads",
      accessToken: FAKE_THREADS_TOKEN,
    });

    const empty = await cliErrorOf(async () =>
      resolveCredentialSource(
        { kind: "env", provider: "threads" },
        { env: { BLUESKY_PASSWORD: FAKE_BLUESKY_PASSWORD } },
      ),
    );
    expect(empty.code).toBe("AUTH_SOURCE_UNAVAILABLE");
  });
});

describe("resolveCredentialSource from a credential file", () => {
  it("reads one strict snapshot and defaults the trusted host", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );

    await expect(
      resolveCredentialSource(fileReference(path), { env: {} }),
    ).resolves.toEqual({
      provider: "bluesky",
      identifier: FAKE_BLUESKY_IDENTIFIER,
      password: FAKE_BLUESKY_PASSWORD,
      host: "bsky.social",
    });
  });

  it("reads a Threads file and rejects a provider mismatch", async () => {
    const directory = await tempDir();
    const threadsPath = await writeCredentialFile(
      directory,
      "threads.json",
      JSON.stringify(threadsCredentialBody()),
    );

    await expect(
      resolveCredentialSource(
        { kind: "file", provider: "threads", path: threadsPath },
        { env: {} },
      ),
    ).resolves.toEqual({
      provider: "threads",
      accessToken: FAKE_THREADS_TOKEN,
    });

    const mismatch = await cliErrorOf(async () =>
      resolveCredentialSource(fileReference(threadsPath), { env: {} }),
    );
    expect(mismatch.code).toBe("AUTH_SOURCE_UNAVAILABLE");
  });

  it("rejects unknown fields, a wrong schema, and missing or blank values", async () => {
    const directory = await tempDir();
    const cases: readonly Record<string, unknown>[] = [
      { ...blueskyCredentialBody(), extra: 1 },
      { ...blueskyCredentialBody(), schemaVersion: 2 },
      { ...blueskyCredentialBody(), schemaVersion: "1" },
      blueskyCredentialBody({ nickname: "nope" }),
      blueskyCredentialBody({ identifier: undefined }),
      blueskyCredentialBody({ password: "   " }),
      blueskyCredentialBody({ host: "example.com" }),
    ];

    for (const [index, body] of cases.entries()) {
      const path = await writeCredentialFile(
        directory,
        `case-${index}.json`,
        JSON.stringify(body),
      );
      const error = await cliErrorOf(async () =>
        resolveCredentialSource(fileReference(path), { env: {} }),
      );
      expect(error.code).toBe("AUTH_SOURCE_UNAVAILABLE");
      expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    }
  });

  it("rejects invalid JSON, duplicate keys, invalid UTF-8, and oversized files", async () => {
    const directory = await tempDir();
    const bodies: readonly (string | Uint8Array)[] = [
      "{",
      '{"schemaVersion":1,"provider":"bluesky","credentials":{"identifier":"a","identifier":"b","password":"p"}}',
      new Uint8Array([0x7b, 0xff, 0x7d]),
      JSON.stringify({ ...blueskyCredentialBody(), pad: "x".repeat(65_536) }),
    ];

    for (const [index, body] of bodies.entries()) {
      const path = await writeCredentialFile(
        directory,
        `broken-${index}.json`,
        typeof body === "string" ? body : Buffer.from(body).toString("latin1"),
      );

      if (typeof body !== "string") {
        await (await import("node:fs/promises")).writeFile(path, body, {
          mode: 0o600,
        });
      }

      const error = await cliErrorOf(async () =>
        resolveCredentialSource(fileReference(path), { env: {} }),
      );
      expect(error.code).toBe("AUTH_SOURCE_UNAVAILABLE");
    }
  });

  it("rejects a file that is missing, group-readable, or a symlink", async () => {
    const directory = await tempDir();
    const body = JSON.stringify(blueskyCredentialBody());

    const missing = await cliErrorOf(async () =>
      resolveCredentialSource(fileReference(join(directory, "absent.json")), {
        env: {},
      }),
    );
    expect(missing.code).toBe("AUTH_SOURCE_UNAVAILABLE");

    const loose = await writeCredentialFile(
      directory,
      "loose.json",
      body,
      0o644,
    );
    const looseError = await cliErrorOf(async () =>
      resolveCredentialSource(fileReference(loose), { env: {} }),
    );
    expect(looseError.code).toBe("AUTH_SOURCE_UNAVAILABLE");

    const real = await writeCredentialFile(directory, "real.json", body);
    const link = join(directory, "link.json");
    await symlink(real, link);
    const linkError = await cliErrorOf(async () =>
      resolveCredentialSource(fileReference(link), { env: {} }),
    );
    expect(linkError.code).toBe("AUTH_SOURCE_UNAVAILABLE");
  });

  it("never echoes the path or the secret in an error message", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "loose.json",
      JSON.stringify(blueskyCredentialBody()),
      0o644,
    );

    const error = await cliErrorOf(async () =>
      resolveCredentialSource(fileReference(path), { env: {} }),
    );
    expect(error.message.includes(directory)).toBe(false);
    expect(error.message.includes(FAKE_BLUESKY_PASSWORD)).toBe(false);
  });

  it("reads a file under a known system alias but still refuses a user symlink", async () => {
    // `os.tmpdir()` is `/var/folders/...` on macOS: a trusted alias prefix.
    const directory = await rawTempDir();
    const body = JSON.stringify(blueskyCredentialBody());
    const path = await writeCredentialFile(directory, "bluesky.json", body);

    await expect(
      resolveCredentialSource(fileReference(path), { env: {} }),
    ).resolves.toMatchObject({ provider: "bluesky" });

    // A directory the caller controls must not be reached through a symlink.
    const real = join(directory, "real");
    await mkdir(real, { mode: 0o700 });
    await writeCredentialFile(real, "bluesky.json", body);
    const link = join(directory, "linked");
    await symlink(real, link);

    const error = await cliErrorOf(async () =>
      resolveCredentialSource(fileReference(join(link, "bluesky.json")), {
        env: {},
      }),
    );
    expect(error.code).toBe("AUTH_SOURCE_UNAVAILABLE");
  });

  it("reports an unusable path as a safe CliError, never a raw filesystem error", async () => {
    const directory = await tempDir();

    const asDirectory = await cliErrorOf(async () =>
      resolveCredentialSource(fileReference(directory), { env: {} }),
    );
    expect(asDirectory.code).toBe("AUTH_SOURCE_UNAVAILABLE");

    const parent = join(directory, "missing");
    const missingParent = await cliErrorOf(async () =>
      resolveCredentialSource(fileReference(join(parent, "creds.json")), {
        env: {},
      }),
    );
    expect(missingParent.code).toBe("AUTH_SOURCE_UNAVAILABLE");
  });

  it("refuses a FIFO promptly in a bounded child process, never hanging", async () => {
    const directory = await tempDir();
    const fifo = join(directory, "creds.fifo");
    await execFileAsync("/usr/bin/mkfifo", [fifo]);

    const started = Date.now();
    const result = await runChild(FIFO_CHILD_ENTRY, [fifo]);
    const elapsed = Date.now() - started;

    // A killed child means the regular-file policy did not stop the open.
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith("REJECTED AUTH_SOURCE_UNAVAILABLE")).toBe(true);
    expect(result.stdout.includes("regular file")).toBe(true);
    expect(elapsed).toBeLessThan(FIFO_CHILD_TIMEOUT_MS);
  });

  it("refuses a file owned by a different user, using real file metadata", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const actualUid = (await stat(path)).uid;

    // Baseline: the same real file is accepted while the uid matches.
    await expect(
      resolveCredentialSource(fileReference(path), { env: {} }),
    ).resolves.toMatchObject({ provider: "bluesky" });

    // Controlled uid seam instead of a privileged chown: the metadata stays
    // real, only the process's own uid differs.
    const processWithUid = process as unknown as { getuid: () => number };
    const spy = vi.spyOn(processWithUid, "getuid").mockReturnValue(actualUid + 1);

    try {
      const error = await cliErrorOf(async () =>
        resolveCredentialSource(fileReference(path), { env: {} }),
      );
      expect(error.code).toBe("AUTH_SOURCE_UNAVAILABLE");
      expect(error.message.includes(directory)).toBe(false);
    } finally {
      spy.mockRestore();
    }

    // Restoring the seam restores the original verdict.
    await expect(
      resolveCredentialSource(fileReference(path), { env: {} }),
    ).resolves.toMatchObject({ provider: "bluesky" });
  });
});

describe("credentialFingerprint", () => {
  const credentials: LocalCredentials = {
    provider: "bluesky",
    identifier: FAKE_BLUESKY_IDENTIFIER,
    password: FAKE_BLUESKY_PASSWORD,
    host: "bsky.social",
  };

  it("is the installation HMAC of the documented domain and group", async () => {
    const store = new FakeLocalStore();
    const expected = await store.authenticate(
      `credential:v1:${canonicalJson({
        provider: "bluesky",
        identifier: FAKE_BLUESKY_IDENTIFIER,
        password: FAKE_BLUESKY_PASSWORD,
        host: "bsky.social",
      })}`,
    );

    const fingerprint = await credentialFingerprint(credentials, store);
    expect(fingerprint).toBe(expected);
    expect(fingerprint).not.toBe(sha256Hex(FAKE_BLUESKY_PASSWORD));
    expect(await credentialFingerprint(credentials, store)).toBe(fingerprint);
  });

  it("changes with the secret, the host, and the provider", async () => {
    const store = new FakeLocalStore();
    const base = await credentialFingerprint(credentials, store);

    expect(
      await credentialFingerprint(
        { ...credentials, password: `${FAKE_BLUESKY_PASSWORD}-rotated` },
        store,
      ),
    ).not.toBe(base);

    expect(
      await credentialFingerprint(
        { ...credentials, host: "other.example" },
        store,
      ),
    ).not.toBe(base);

    expect(
      await credentialFingerprint(
        { provider: "threads", accessToken: FAKE_THREADS_TOKEN },
        store,
      ),
    ).not.toBe(base);
  });
});

describe("bindLocalAccount", () => {
  it("binds a new account and persists only the reference and fingerprint", async () => {
    const directory = await tempDir();
    const stateDir = join(directory, "state");
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const store = new FakeLocalStore({ auditDir: stateDir });
    const provider = new FakeLocalProvider("bluesky", BLUESKY_TARGET);
    const previews: LocalAuthPreview[] = [];

    const result = await bindLocalAccount(fileReference(path), {
      store,
      provider,
      env: {},
      signal,
      confirm: async preview => {
        previews.push(preview);
        return true;
      },
    });

    expect(result).toEqual({
      provider: "bluesky",
      targetId: BLUESKY_TARGET,
      connectionId: expect.stringMatching(/^conn_[0-9a-f]{32}$/) as unknown as string,
      bindingRevision: 1,
      verified: true,
    });
    expect(provider.verifyIdentityCalls).toHaveLength(1);
    expect(store.putConnectionCalls[0]?.expectedRevision).toBeNull();

    const record = store.connections.get("bluesky");
    expect(record?.removed).toBe(false);
    expect(record?.source).toEqual(fileReference(path));
    expect(record?.fingerprint).toBe(
      await credentialFingerprint(
        {
          provider: "bluesky",
          identifier: FAKE_BLUESKY_IDENTIFIER,
          password: FAKE_BLUESKY_PASSWORD,
          host: "bsky.social",
        },
        store,
      ),
    );

    // The confirmation sees the identity that will be written and nothing else.
    expect(Object.keys(previews[0] ?? {}).sort()).toEqual([
      "bindingRevision",
      "connectionId",
      "provider",
      "targetId",
    ]);
    expect(previews[0]?.bindingRevision).toBe(1);

    const persisted = await readAllFiles(stateDir);
    expect(persisted.includes(FAKE_BLUESKY_PASSWORD)).toBe(false);
    expect(persisted.includes(sha256Hex(FAKE_BLUESKY_PASSWORD))).toBe(false);
    expect(JSON.stringify(result).includes(FAKE_BLUESKY_PASSWORD)).toBe(false);
    expect(JSON.stringify(previews[0]).includes(FAKE_BLUESKY_PASSWORD)).toBe(
      false,
    );
  });

  it("refuses a mismatched expected account before writing", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const store = new FakeLocalStore();
    const provider = new FakeLocalProvider("bluesky", BLUESKY_TARGET);
    let confirmed = 0;

    const error = await cliErrorOf(async () =>
      bindLocalAccount(fileReference(path), {
        store,
        provider,
        env: {},
        signal,
        expectedTargetId: "did:plc:a-different-account",
        confirm: async () => {
          confirmed += 1;
          return true;
        },
      }),
    );

    expect(error.code).toBe("ACCOUNT_MISMATCH");
    expect(confirmed).toBe(0);
    expect(store.writes).toBe(0);
    expect(provider.verifyIdentityCalls).toHaveLength(1);
  });

  it("activates nothing when the operator declines", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const store = new FakeLocalStore();
    const provider = new FakeLocalProvider("bluesky", BLUESKY_TARGET);

    const error = await cliErrorOf(async () =>
      bindLocalAccount(fileReference(path), {
        store,
        provider,
        env: {},
        signal,
        confirm: async () => false,
      }),
    );

    expect(error.exitCode).toBe(EXIT_CODE.CANCELLED);
    expect(store.writes).toBe(0);
  });

  it("reuses the connection slot and bumps the revision on rotation", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const store = new FakeLocalStore();
    const provider = new FakeLocalProvider("bluesky", BLUESKY_TARGET);

    const first = await bindLocalAccount(fileReference(path), {
      store,
      provider,
      env: {},
      signal,
      confirm: async () => true,
    });
    const firstFingerprint = store.connections.get("bluesky")?.fingerprint;

    await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(
        blueskyCredentialBody({ password: `${FAKE_BLUESKY_PASSWORD}-rotated` }),
      ),
    );

    const second = await bindLocalAccount(fileReference(path), {
      store,
      provider,
      env: {},
      signal,
      confirm: async () => true,
    });

    expect(second.connectionId).toBe(first.connectionId);
    expect(second.bindingRevision).toBe(2);
    expect(store.putConnectionCalls[1]?.expectedRevision).toBe(1);
    expect(store.connections.get("bluesky")?.fingerprint).not.toBe(
      firstFingerprint,
    );
  });

  it("binds the stable target, not the handle", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const store = new FakeLocalStore();
    const provider = new FakeLocalProvider("bluesky", BLUESKY_TARGET);

    const first = await bindLocalAccount(fileReference(path), {
      store,
      provider,
      env: {},
      signal,
      confirm: async () => true,
    });

    // Same handle, different account: the binding must follow the DID.
    provider.targetId = "did:plc:someone-else";
    const second = await bindLocalAccount(fileReference(path), {
      store,
      provider,
      env: {},
      signal,
      confirm: async () => true,
    });

    expect(second.connectionId).toBe(first.connectionId);
    expect(second.targetId).toBe("did:plc:someone-else");
    expect(store.connections.get("bluesky")?.target.targetId).toBe(
      "did:plc:someone-else",
    );
  });

  it("rejects a binding that another writer changed during confirmation", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const store = new FakeLocalStore();
    const provider = new FakeLocalProvider("bluesky", BLUESKY_TARGET);

    store.beforePutConnection = () => {
      store.connections.set("bluesky", {
        schemaVersion: 1,
        target: {
          provider: "bluesky",
          targetId: "did:plc:other-writer",
          connectionId: "conn_00000000000000000000000000000000",
          bindingRevision: 7,
        },
        source: { kind: "env", provider: "bluesky" },
        fingerprint: "other-writer-fingerprint",
        removed: false,
      });
    };

    const error = await cliErrorOf(async () =>
      bindLocalAccount(fileReference(path), {
        store,
        provider,
        env: {},
        signal,
        confirm: async () => true,
      }),
    );

    expect(error.code).toBe("STATE_BUSY");
    expect(store.connections.get("bluesky")?.target.bindingRevision).toBe(7);
  });

  it("maps provider failures to safe static CLI errors", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const store = new FakeLocalStore();
    const provider = new FakeLocalProvider("bluesky", BLUESKY_TARGET);
    provider.failure = new LocalProviderError("AUTH");

    const error = await cliErrorOf(async () =>
      bindLocalAccount(fileReference(path), {
        store,
        provider,
        env: {},
        signal,
        confirm: async () => true,
      }),
    );

    expect(error.code).toBe("AUTH_SOURCE_UNAVAILABLE");
    expect(error.message.includes(FAKE_BLUESKY_PASSWORD)).toBe(false);
    expect(store.writes).toBe(0);
  });

  it("maps an aborted provider call to a runtime failure, not a user interrupt", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const store = new FakeLocalStore();
    const provider = new FakeLocalProvider("bluesky", BLUESKY_TARGET);
    provider.failure = new LocalProviderError("ABORTED");

    const error = await cliErrorOf(async () =>
      bindLocalAccount(fileReference(path), {
        store,
        provider,
        env: {},
        signal,
        confirm: async () => true,
      }),
    );

    // A command timeout also aborts the signal; the auth layer must not claim
    // that the operator pressed Ctrl-C. The composition decides that.
    expect(error.code).toBe("ABORTED");
    expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
    expect(store.writes).toBe(0);
  });

  it("does not write a binding after the caller signal is already aborted", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const store = new FakeLocalStore();
    const provider = new FakeLocalProvider("bluesky", BLUESKY_TARGET);
    const controller = new AbortController();
    controller.abort();

    const error = await cliErrorOf(async () =>
      bindLocalAccount(fileReference(path), {
        store,
        provider,
        env: {},
        signal: controller.signal,
        confirm: async () => true,
      }),
    );

    expect(error.code).toBe("ABORTED");
    expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
    expect(store.writes).toBe(0);
    expect(store.connections.get("bluesky")).toBeUndefined();
  });
});

describe("verifyLocalAccount", () => {
  it("verifies the stable identity without writing state", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const store = new FakeLocalStore();
    const provider = new FakeLocalProvider("bluesky", BLUESKY_TARGET);

    await bindLocalAccount(fileReference(path), {
      store,
      provider,
      env: {},
      signal,
      confirm: async () => true,
    });
    const writesAfterBind = store.writes;

    const result = await verifyLocalAccount(
      store.connections.get("bluesky")!,
      { store, provider, env: {}, signal },
    );

    expect(result.verified).toBe(true);
    expect(result.targetId).toBe(BLUESKY_TARGET);
    expect(store.writes).toBe(writesAfterBind);
  });

  it("refuses a removed binding and a changed credential source", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const store = new FakeLocalStore();
    const provider = new FakeLocalProvider("bluesky", BLUESKY_TARGET);

    await bindLocalAccount(fileReference(path), {
      store,
      provider,
      env: {},
      signal,
      confirm: async () => true,
    });
    const record = store.connections.get("bluesky")!;

    const removed = await cliErrorOf(async () =>
      verifyLocalAccount({ ...record, removed: true }, {
        store,
        provider,
        env: {},
        signal,
      }),
    );
    expect(removed.code).toBe("BINDING_CHANGED");

    await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(
        blueskyCredentialBody({ password: `${FAKE_BLUESKY_PASSWORD}-other` }),
      ),
    );
    const changed = await cliErrorOf(async () =>
      verifyLocalAccount(record, { store, provider, env: {}, signal }),
    );
    expect(changed.code).toBe("AUTH_SOURCE_CHANGED");
  });

  it("refuses an account that is no longer the bound one", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const store = new FakeLocalStore();
    const provider = new FakeLocalProvider("bluesky", BLUESKY_TARGET);

    await bindLocalAccount(fileReference(path), {
      store,
      provider,
      env: {},
      signal,
      confirm: async () => true,
    });

    provider.targetId = "did:plc:someone-else";
    const error = await cliErrorOf(async () =>
      verifyLocalAccount(store.connections.get("bluesky")!, {
        store,
        provider,
        env: {},
        signal,
      }),
    );
    expect(error.code).toBe("ACCOUNT_MISMATCH");
  });
});

describe("removeLocalAccount", () => {
  it("writes a tombstone, keeps the source file, and never revokes remotely", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const store = new FakeLocalStore();
    const provider = new FakeLocalProvider("bluesky", BLUESKY_TARGET);

    const bound = await bindLocalAccount(fileReference(path), {
      store,
      provider,
      env: {},
      signal,
      confirm: async () => true,
    });
    const previews: LocalAuthPreview[] = [];

    const result = await removeLocalAccount("bluesky", {
      store,
      signal,
      expectedTargetId: BLUESKY_TARGET,
      confirm: async preview => {
        previews.push(preview);
        return true;
      },
    });

    expect(result).toEqual({
      provider: "bluesky",
      targetId: BLUESKY_TARGET,
      removed: true,
      bindingRevision: 2,
    });
    expect(previews[0]?.connectionId).toBe(bound.connectionId);

    const record = store.connections.get("bluesky");
    expect(record?.removed).toBe(true);
    expect(record?.target.connectionId).toBe(bound.connectionId);
    expect(record?.source).toEqual(fileReference(path));
    expect((await stat(path)).isFile()).toBe(true);
    // No source read, no provider session, no remote revoke.
    expect(provider.verifyIdentityCalls).toHaveLength(1);
    expect(provider.prepareCalls).toHaveLength(0);
  });

  it("refuses a mismatched expectation, a decline, and an absent binding", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const store = new FakeLocalStore();
    const provider = new FakeLocalProvider("bluesky", BLUESKY_TARGET);

    const absent = await cliErrorOf(async () =>
      removeLocalAccount("bluesky", {
        store,
        signal,
        confirm: async () => true,
      }),
    );
    expect(absent.code).toBe("BINDING_CHANGED");

    await bindLocalAccount(fileReference(path), {
      store,
      provider,
      env: {},
      signal,
      confirm: async () => true,
    });
    const writesAfterBind = store.writes;

    const mismatch = await cliErrorOf(async () =>
      removeLocalAccount("bluesky", {
        store,
        signal,
        expectedTargetId: "did:plc:someone-else",
        confirm: async () => true,
      }),
    );
    expect(mismatch.code).toBe("ACCOUNT_MISMATCH");

    const declined = await cliErrorOf(async () =>
      removeLocalAccount("bluesky", {
        store,
        signal,
        confirm: async () => false,
      }),
    );
    expect(declined.exitCode).toBe(EXIT_CODE.CANCELLED);
    expect(store.writes).toBe(writesAfterBind);
    expect(store.connections.get("bluesky")?.removed).toBe(false);
  });

  it("does not write a tombstone after the caller signal is already aborted", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const store = new FakeLocalStore();
    const provider = new FakeLocalProvider("bluesky", BLUESKY_TARGET);

    await bindLocalAccount(fileReference(path), {
      store,
      provider,
      env: {},
      signal,
      confirm: async () => true,
    });
    const writesAfterBind = store.writes;
    const controller = new AbortController();
    controller.abort();

    const error = await cliErrorOf(async () =>
      removeLocalAccount("bluesky", {
        store,
        signal: controller.signal,
        confirm: async () => true,
      }),
    );

    expect(error.code).toBe("ABORTED");
    expect(error.exitCode).toBe(EXIT_CODE.FAILURE);
    expect(store.writes).toBe(writesAfterBind);
    expect(store.connections.get("bluesky")?.removed).toBe(false);
  });
});

describe("resolveForExecution", () => {
  it("returns the resolved snapshot in memory and refuses a changed source", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const store = new FakeLocalStore();
    const provider = new FakeLocalProvider("bluesky", BLUESKY_TARGET);

    await bindLocalAccount(fileReference(path), {
      store,
      provider,
      env: {},
      signal,
      confirm: async () => true,
    });
    const record = store.connections.get("bluesky")!;

    const snapshot = await resolveForExecution(record, {
      store,
      provider: "bluesky",
      env: {},
    });
    expect(snapshot).toEqual({
      provider: "bluesky",
      identifier: FAKE_BLUESKY_IDENTIFIER,
      password: FAKE_BLUESKY_PASSWORD,
      host: "bsky.social",
    });

    // The snapshot is a copy: an external change cannot rewrite it.
    await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(
        blueskyCredentialBody({ password: `${FAKE_BLUESKY_PASSWORD}-new` }),
      ),
    );
    expect(snapshot).toMatchObject({ password: FAKE_BLUESKY_PASSWORD });

    const changed = await cliErrorOf(async () =>
      resolveForExecution(record, { store, provider: "bluesky", env: {} }),
    );
    expect(changed.code).toBe("AUTH_SOURCE_CHANGED");
  });

  it("refuses a removed binding", async () => {
    const directory = await tempDir();
    const path = await writeCredentialFile(
      directory,
      "bluesky.json",
      JSON.stringify(blueskyCredentialBody()),
    );
    const store = new FakeLocalStore();
    const provider = new FakeLocalProvider("bluesky", BLUESKY_TARGET);

    await bindLocalAccount(fileReference(path), {
      store,
      provider,
      env: {},
      signal,
      confirm: async () => true,
    });
    const record = store.connections.get("bluesky")!;

    const error = await cliErrorOf(async () =>
      resolveForExecution(
        { ...record, removed: true },
        { store, provider: "bluesky", env: {} },
      ),
    );
    expect(error.code).toBe("BINDING_CHANGED");
  });
});
