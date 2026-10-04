import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import {
  LocalProviderError,
  type LocalCredentials,
  type LocalProvider,
} from "@syndroo/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CliError } from "../../src/cli-error.js";
import { run } from "../../src/main.js";
import {
  bindLocalAccount,
  commitLocalBinding,
  commitLocalObservation,
  prepareLocalBindingWithCredentials,
  verifyLocalAccount,
  type PreparedLocalBinding,
} from "../../src/local/auth.js";
import { saveCredentialFile } from "../../src/local/credential-save.js";
import {
  credentialFingerprint,
  resolveCredentialSource,
} from "../../src/local/credentials.js";
import { makeLegacyState, openState, seedConnection, stateSnapshot, type StateFixture } from "./support/plan-fixture.js";
import { FakeLocalStore } from "./auth-fixtures.js";

/**
 * A1: credential-file security, the CAS partial result, canary filtering, and
 * the legacy/schema-2 observation boundary.
 */

const roots: string[] = [];
const cleanups: (() => void)[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));

  roots.push(root);

  return root;
}

async function fixture(): Promise<StateFixture> {
  const state = await openState();

  cleanups.push(state.cleanup);

  return state;
}

const CANARY = "CANARY-SECRET-TOKEN-1234567890";

async function failureOf(run: () => Promise<unknown>): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }

  throw new Error("expected a CliError");
}

const THREADS: LocalCredentials = { provider: "threads", accessToken: CANARY };

function providerReturning(identity: {
  readonly targetId: string;
  readonly displayName?: string;
  readonly scopes?: readonly string[];
  readonly capabilities?: { readonly maxCharacters: number; readonly charactersReservedPerUrl: number };
}): LocalProvider {
  return {
    provider: "threads",
    describe: () => ({
      provider: "threads",
      maturity: "fixture-tested",
      localPublish: true,
      unavailableReason: null,
    }),
    freeze: (content, createdAt) => ({
      payloadVersion: 1,
      payload: { text: content, createdAt },
    }),
    verifyIdentity: async () => ({
      targetId: identity.targetId,
      ...(identity.displayName === undefined
        ? {}
        : { displayName: identity.displayName }),
      ...(identity.scopes === undefined ? {} : { scopes: identity.scopes }),
      ...(identity.capabilities === undefined
        ? {}
        : { capabilities: identity.capabilities }),
    }),
    prepare: async (_credentials, target) => ({
      target,
      publish: async () => ({ kind: "succeeded", remoteId: "fixture", url: null }),
    }),
  };
}

describe("credential file creation", () => {
  it("creates a 0700 directory and a 0600 file that round-trips", async () => {
    const root = tempRoot("syndroo-save-");
    const target = path.join(root, "private", "threads.json");

    const saved = await saveCredentialFile({
      file: target,
      cwd: root,
      credentials: THREADS,
    });

    expect(saved.path).toBe(
      path.join(realpathSync(root), "private", "threads.json"),
    );
    expect(statSync(path.dirname(target)).mode & 0o777).toBe(0o700);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    await expect(
      resolveCredentialSource(
        { kind: "file", provider: "threads", path: target },
        { env: {} },
      ),
    ).resolves.toEqual(THREADS);
  });

  it("refuses an existing file and leaves its bytes unchanged", async () => {
    const root = tempRoot("syndroo-save-");
    const target = path.join(root, "threads.json");

    writeFileSync(target, "keep me\n", { mode: 0o600 });

    await expect(
      saveCredentialFile({ file: target, cwd: root, credentials: THREADS }),
    ).rejects.toBeInstanceOf(CliError);
    expect(readFileSync(target, "utf8")).toBe("keep me\n");
  });

  it("refuses a symlinked parent and a group-writable parent", async () => {
    const root = tempRoot("syndroo-save-");
    const real = path.join(root, "real");
    const link = path.join(root, "link");

    await saveCredentialFile({
      file: path.join(real, "a.json"),
      cwd: root,
      credentials: THREADS,
    });
    symlinkSync(real, link);

    await expect(
      saveCredentialFile({
        file: path.join(link, "b.json"),
        cwd: root,
        credentials: THREADS,
      }),
    ).rejects.toBeInstanceOf(CliError);

    const open = path.join(root, "open");
    await saveCredentialFile({
      file: path.join(open, "c.json"),
      cwd: root,
      credentials: THREADS,
    });
    // A wider directory is refused without being chmodded.
    chmodSync(open, 0o755);

    await expect(
      saveCredentialFile({
        file: path.join(open, "d.json"),
        cwd: root,
        credentials: THREADS,
      }),
    ).rejects.toBeInstanceOf(CliError);
    expect(statSync(open).mode & 0o777).toBe(0o755);
  });

  it("never writes the secret into a substituted parent", async () => {
    const root = tempRoot("syndroo-save-");
    const vault = path.join(root, "vault");
    const moved = path.join(root, "vault-moved");
    const target = path.join(vault, "threads.json");

    mkdirSync(vault, { mode: 0o700 });
    chmodSync(vault, 0o700);

    const error = await failureOf(() =>
      saveCredentialFile({
        file: target,
        cwd: root,
        credentials: THREADS,
        fault: point => {
          if (point === "after-open") {
            // Swap the validated parent for a fresh one while the descriptor is
            // open and before the secret is written.
            renameSync(vault, moved);
            mkdirSync(vault, { mode: 0o700 });
            chmodSync(vault, 0o700);
          }
        },
      }),
    );

    expect(error).toBeInstanceOf(CliError);
    // The substituted location has no file at all...
    expect(existsSync(target)).toBe(false);
    // ...and the only artifact is an empty file in the directory that was
    // validated, so no secret byte was written anywhere.
    expect(readFileSync(path.join(moved, "threads.json")).byteLength).toBe(0);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  });

  it("reports a partial save when the parent moves after the write", async () => {
    const root = tempRoot("syndroo-save-");
    const vault = path.join(root, "vault");
    const moved = path.join(root, "vault-moved");
    const target = path.join(vault, "threads.json");

    mkdirSync(vault, { mode: 0o700 });
    chmodSync(vault, 0o700);

    const error = await failureOf(() =>
      saveCredentialFile({
        file: target,
        cwd: root,
        credentials: THREADS,
        fault: point => {
          if (point === "after-write") {
            renameSync(vault, moved);
          }
        },
      }),
    );

    expect(error).toBeInstanceOf(CliError);
    expect(error.details).toMatchObject({
      credentialFileSaved: true,
      durable: false,
      bindingChanged: false,
    });
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(path.join(moved, "threads.json")).byteLength).toBeGreaterThan(0);
  });

  it("reports a partial save when the directory sync fails", async () => {
    const root = tempRoot("syndroo-save-");
    const vault = path.join(root, "vault");
    const target = path.join(vault, "threads.json");

    mkdirSync(vault, { mode: 0o700 });
    chmodSync(vault, 0o700);

    const error = await failureOf(() =>
      saveCredentialFile({
        file: target,
        cwd: root,
        credentials: THREADS,
        fault: point => {
          if (point === "before-directory-sync") {
            throw new Error("injected fsync failure");
          }
        },
      }),
    );

    expect(error).toBeInstanceOf(CliError);
    expect(error.details).toMatchObject({ credentialFileSaved: true, durable: false });
    expect(existsSync(target)).toBe(true);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  });

  it("never deletes a replacement file during cleanup", async () => {
    const root = tempRoot("syndroo-save-");
    const vault = path.join(root, "vault");
    const target = path.join(vault, "threads.json");

    mkdirSync(vault, { mode: 0o700 });
    chmodSync(vault, 0o700);

    const error = await failureOf(() =>
      saveCredentialFile({
        file: target,
        cwd: root,
        credentials: THREADS,
        fault: point => {
          if (point === "after-write") {
            // A racing writer replaces the path before cleanup runs.
            rmSync(target);
            writeFileSync(target, "REPLACEMENT\n", { mode: 0o600 });
            chmodSync(target, 0o600);
            throw new Error("injected write failure");
          }
        },
      }),
    );

    expect(error).toBeInstanceOf(CliError);
    expect(readFileSync(target, "utf8")).toBe("REPLACEMENT\n");
  });

  it("never echoes the secret or the path in a refusal", async () => {
    const root = tempRoot("syndroo-save-");
    const target = path.join(root, "nested", "threads.json");

    await saveCredentialFile({ file: target, cwd: root, credentials: THREADS });

    try {
      await saveCredentialFile({ file: target, cwd: root, credentials: THREADS });
      throw new Error("expected a refusal");
    } catch (error) {
      const text = `${(error as Error).message} ${JSON.stringify((error as CliError).details ?? {})}`;

      expect(text).not.toContain(CANARY);
      expect(text).not.toContain(target);
    }
  });
});

describe("CAS partial result", () => {
  it("rejects a reconnect that landed while the operator was waiting", async () => {
    const state = await fixture();
    const root = tempRoot("syndroo-race-");
    const target = path.join(root, "threads.json");

    await seedConnection(state.store, { provider: "threads" });

    const snapshot = await state.store.getConnection("threads");
    // Snapshot taken before the wait; the operator is still confirming.
    const { prepared, credentials } = await prepareLocalBindingWithCredentials(
      THREADS,
      {
        store: state.store,
        provider: providerReturning({ targetId: "threads-1" }),
        env: {},
        signal: new AbortController().signal,
        confirm: async () => true,
        clock: state.clock.now,
        current: snapshot,
      },
    );

    // A concurrent reconnect commits a newer revision while the first run is
    // still in its browser/menu wait.
    await seedConnection(state.store, {
      provider: "threads",
      bindingRevision: 2,
      expectedRevision: 1,
    });

    let failure: CliError | undefined;

    try {
      await commitLocalBinding(prepared, {
        store: state.store,
        credentials,
        source: { kind: "env", provider: "threads" },
        saveCredentialFile: { file: target, cwd: root },
      });
    } catch (error) {
      failure = error as CliError;
    }

    expect(failure).toBeInstanceOf(CliError);

    if (failure === undefined) {
      throw new Error("expected a CliError");
    }

    expect(failure.code).toBe("BINDING_CHANGED");
    expect(failure.details).toMatchObject({
      credentialFileSaved: true,
      bindingChanged: false,
    });
    // The newer binding is preserved and the file is a partial result.
    expect((await state.store.getConnection("threads"))?.target.bindingRevision).toBe(2);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("keeps the saved file and reports the partial binding without a path", async () => {
    const root = tempRoot("syndroo-cas-");
    const target = path.join(root, "threads.json");
    const store = new FakeLocalStore();

    store.putConnection = async () => {
      throw new CliError("BINDING_CHANGED: changed", {
        code: "BINDING_CHANGED",
        exitCode: 2,
      });
    };

    const prepared: PreparedLocalBinding = {
      provider: "threads",
      preview: {
        provider: "threads",
        targetId: "threads-1",
        connectionId: `conn_${"a".repeat(32)}`,
        bindingRevision: 1,
      },
      record: {
        schemaVersion: 1,
        target: {
          provider: "threads",
          targetId: "threads-1",
          connectionId: `conn_${"a".repeat(32)}`,
          bindingRevision: 1,
        },
        fingerprint: "b".repeat(64),
        removed: false,
      },
      expectedRevision: null,
      verification: { displayName: null, lastVerifiedAt: "2026-10-04T00:00:00.000Z" },
      observation: undefined,
    };

    try {
      await commitLocalBinding(prepared, {
        store,
        credentials: THREADS,
        source: { kind: "env", provider: "threads" },
        saveCredentialFile: { file: target, cwd: root },
      });
      throw new Error("expected a refusal");
    } catch (error) {
      const failure = error as CliError;

      expect(failure.code).toBe("BINDING_CHANGED");
      expect(failure.details).toMatchObject({
        credentialFileSaved: true,
        bindingChanged: false,
      });
      expect(failure.message).not.toContain(CANARY);
      expect(failure.message).not.toContain(target);
    }

    // The saved file is kept; it was created only after the confirmation.
    expect(statSync(target).mode & 0o777).toBe(0o600);
    await expect(
      resolveCredentialSource(
        { kind: "file", provider: "threads", path: target },
        { env: {} },
      ),
    ).resolves.toEqual(THREADS);
  });
});

describe("identity canary filtering", () => {
  it("never stores or reports a secret a provider reflected back", async () => {
    const state = await fixture();
    const store = new FakeLocalStore({ installationSchemaVersion: 2 });

    const result = await bindLocalAccount(
      { kind: "env", provider: "threads" },
      {
        store,
        provider: providerReturning({
          targetId: "threads-1",
          displayName: `Verified ${CANARY}`,
          scopes: [`read ${CANARY}`, "write"],
        }),
        env: { THREADS_ACCESS_TOKEN: CANARY },
        signal: new AbortController().signal,
        confirm: async () => true,
      },
    );

    expect(result.displayName).toBeNull();
    const record = await store.getConnection("threads");

    expect(record?.verification?.displayName).toBeNull();
    expect(record?.observation?.scopes).toEqual(["write"]);
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(JSON.stringify(record)).not.toContain(CANARY);
    void state;
  });
});

describe("observation schema boundary", () => {
  it("keeps a schema-1 legacy binding legacy-compatible", async () => {
    const state = await fixture();

    makeLegacyState(state);

    await bindLocalAccount(
      { kind: "env", provider: "threads" },
      {
        store: state.store,
        provider: providerReturning({
          targetId: "threads-legacy",
          scopes: ["read", "write"],
          capabilities: { maxCharacters: 500, charactersReservedPerUrl: 23 },
        }),
        env: { THREADS_ACCESS_TOKEN: CANARY },
        signal: new AbortController().signal,
        confirm: async () => true,
      },
    );

    const record = await state.store.getConnection("threads");

    // No implicit migration: the record stays schema 1 with no observation.
    expect(record?.schemaVersion).toBe(1);
    expect(record?.observation).toBeUndefined();
  });

  it("refreshes a schema-2 observation under CAS without moving the revision", async () => {
    const state = await fixture();
    const fingerprint = await credentialFingerprint(THREADS, state.store);

    await state.store.putConnection(
      {
        schemaVersion: 1,
        target: {
          provider: "threads",
          targetId: "threads-1",
          connectionId: `conn_${"a".repeat(32)}`,
          bindingRevision: 1,
        },
        source: { kind: "env", provider: "threads" },
        fingerprint,
        removed: false,
      },
      null,
    );

    const before = await state.store.getConnection("threads");
    const checked = await verifyLocalAccount(before!, {
      store: state.store,
      provider: providerReturning({
        targetId: before!.target.targetId,
        capabilities: { maxCharacters: 500, charactersReservedPerUrl: 23 },
      }),
      env: { THREADS_ACCESS_TOKEN: CANARY },
      signal: new AbortController().signal,
      clock: state.clock.now,
    });

    expect(checked.observation?.capabilities).toEqual({
      maxCharacters: 500,
      charactersReservedPerUrl: 23,
    });

    const saved = await commitLocalObservation(
      state.store,
      "threads",
      checked.observation!,
      before!.target.bindingRevision,
    );
    const after = await state.store.getConnection("threads");

    expect(saved).toBe(true);
    expect(after?.observation?.capabilities).toEqual({
      maxCharacters: 500,
      charactersReservedPerUrl: 23,
    });
    expect(after?.target.bindingRevision).toBe(before?.target.bindingRevision);
    expect(after?.fingerprint).toBe(before?.fingerprint);
  });

  it("does not persist an observation on a schema-1 state", async () => {
    const state = await fixture();
    const fingerprint = await credentialFingerprint(THREADS, state.store);

    makeLegacyState(state);
    await state.store.putConnection(
      {
        schemaVersion: 1,
        target: {
          provider: "threads",
          targetId: "threads-1",
          connectionId: `conn_${"a".repeat(32)}`,
          bindingRevision: 1,
        },
        source: { kind: "env", provider: "threads" },
        fingerprint,
        removed: false,
      },
      null,
    );

    const before = stateSnapshot(state.stateHome);
    const connection = await state.store.getConnection("threads");
    const checked = await verifyLocalAccount(connection!, {
      store: state.store,
      provider: providerReturning({
        targetId: connection!.target.targetId,
        scopes: ["read", "write"],
      }),
      env: { THREADS_ACCESS_TOKEN: CANARY },
      signal: new AbortController().signal,
    });

    expect(checked.observation).toBeDefined();

    const saved = await commitLocalObservation(
      state.store,
      "threads",
      checked.observation!,
      connection!.target.bindingRevision,
    );

    expect(saved).toBe(false);
    expect(stateSnapshot(state.stateHome)).toEqual(before);
  });
});

describe("connect OAuth flag guards", () => {
  function harness() {
    const root = tempRoot("syndroo-oauth-guard-");
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
    };

    return {
      root,
      env,
      async command(argv: string[]): Promise<{ code: number; output: string }> {
        const output: string[] = [];
        const sink = () =>
          new Writable({
            write(chunk, _encoding, done) {
              output.push(String(chunk));
              done();
            },
          });
        const code = await run([...argv, "--json"], {
          stdin: Readable.from([]),
          stdout: sink(),
          stderr: sink(),
          env,
          cwd: root,
          stdinIsTty: false,
          stdoutIsTty: false,
          hasTty: () => false,
          readTtyLine: () => undefined,
          signal: new AbortController().signal,
        });

        return { code, output: output.join("") };
      },
    };
  }

  it("rejects incoherent OAuth flags before any effect", async () => {
    const h = harness();
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));

    for (const argv of [
      ["connect", "mastodon", "--oauth"],
      ["connect", "mastodon", "--oauth", "--instance", "https://example.social"],
      ["connect", "bluesky", "--oauth", "--instance", "https://example.social", "--save-credential-file", path.join(h.root, "b.json")],
      ["connect", "threads", "--instance", "https://example.social"],
      ["connect", "threads", "--credential-file", path.join(h.root, "in.json"), "--save-credential-file", path.join(h.root, "out.json")],
    ]) {
      const result = await h.command(argv);

      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.output).not.toContain("example.social");
    }

    expect(network).not.toHaveBeenCalled();
  });

  it("refuses Mastodon OAuth on schema 1 before any app registration", async () => {
    const h = harness();

    expect((await h.command(["init"])).code).toBe(0);

    const installation = path.join(h.env["XDG_STATE_HOME"] as string, "syndroo", "installation.json");
    const parsed = JSON.parse(readFileSync(installation, "utf8")) as { installationId: string };

    writeFileSync(
      installation,
      `${JSON.stringify({ schemaVersion: 1, installationId: parsed.installationId })}\n`,
      { mode: 0o600 },
    );

    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
    const result = await h.command([
      "connect",
      "mastodon",
      "--oauth",
      "--instance",
      "https://example.social",
      "--save-credential-file",
      path.join(h.root, "mastodon.json"),
      "--yes",
      "--no-input",
      "--expect-account",
      "mastodon:abc:1",
    ]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("STATE_VERSION_UNSUPPORTED");
    expect(network).not.toHaveBeenCalled();
  });
});
