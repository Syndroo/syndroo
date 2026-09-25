/// <reference types="node" />

import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CliError } from "../../src/cli-error.js";
import { EXIT_CODE } from "../../src/exit-codes.js";
import {
  atomicCreateFile,
  atomicWriteFile,
  readControlledFile,
} from "../../src/local/state/atomic.js";

/**
 * The create-only atomic primitive.
 *
 * It reuses the replacement writer's temporary-file pipeline and publishes the
 * authoritative name with `link`, so a name that another writer already
 * published is never replaced. The replacement writer must keep behaving
 * exactly as before.
 */

const ROOTS: string[] = [];

afterEach(() => {
  for (const root of ROOTS.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A controlled 0700 directory, the only kind either primitive accepts. */
function makeDirectory(): string {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "syndroo-atomic-")),
  );

  ROOTS.push(root);

  const dir = path.join(root, "controlled");

  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);

  return dir;
}

async function expectCommitFailure(
  action: () => Promise<unknown>,
): Promise<CliError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);

    const cli = error as CliError;

    expect(cli.code).toBe("STATE_COMMIT_FAILED");
    expect(cli.exitCode).toBe(EXIT_CODE.FAILURE);

    return cli;
  }

  throw new Error("expected a commit failure");
}

function temporaryFiles(dir: string): string[] {
  return readdirSync(dir).filter(name => name.startsWith(".tmp-"));
}

function injectAt(point: string) {
  return (injected: string): void => {
    if (injected === point) {
      throw new Error(`injected:${point}`);
    }
  };
}

describe("atomicCreateFile", () => {
  it("creates a controlled file and reports that it created it", async () => {
    const dir = makeDirectory();
    const bytes = Buffer.from('{"schemaVersion":1,"namespace":"default"}\n', "utf8");

    await expect(atomicCreateFile(dir, "config.json", bytes, undefined)).resolves.toBe(
      true,
    );

    const file = path.join(dir, "config.json");
    const stat = lstatSync(file);

    expect(stat.isFile()).toBe(true);
    expect(stat.nlink).toBe(1);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe(bytes.toString("utf8"));
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it("never overwrites an existing file and reports that it did not create one", async () => {
    const dir = makeDirectory();
    const file = path.join(dir, "config.json");

    writeFileSync(file, "first\n", { mode: 0o600 });
    chmodSync(file, 0o600);

    await expect(
      atomicCreateFile(dir, "config.json", Buffer.from("second\n"), undefined),
    ).resolves.toBe(false);

    expect(readFileSync(file, "utf8")).toBe("first\n");
    expect(lstatSync(file).nlink).toBe(1);
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it("leaves an unsafe existing target untouched when the name is taken", async () => {
    const dir = makeDirectory();
    const file = path.join(dir, "config.json");

    writeFileSync(file, "first\n", { mode: 0o644 });
    chmodSync(file, 0o644);

    // The create-only primitive must not repair or replace an unsafe file that
    // another writer published; the caller's read is what fails closed.
    await expect(
      atomicCreateFile(dir, "config.json", Buffer.from("second\n"), undefined),
    ).resolves.toBe(false);

    expect(readFileSync(file, "utf8")).toBe("first\n");
    expect(lstatSync(file).mode & 0o777).toBe(0o644);
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it("refuses an unsafe directory instead of writing into it", async () => {
    const dir = makeDirectory();

    chmodSync(dir, 0o755);

    await expect(
      atomicCreateFile(dir, "config.json", Buffer.from("x"), undefined),
    ).rejects.toMatchObject({ code: "STATE_CORRUPT" });

    expect(lstatSync(dir).mode & 0o777).toBe(0o755);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each(["before-temp-write", "after-file-sync", "before-rename"])(
    "creates nothing when %s fails",
    async point => {
      const dir = makeDirectory();

      const failure = await expectCommitFailure(() =>
        atomicCreateFile(
          dir,
          "config.json",
          Buffer.from("x"),
          injectAt(point),
        ),
      );

      expect(failure.details).toMatchObject({ committed: false });
      expect(readdirSync(dir)).toEqual([]);
    },
  );

  it.each(["after-rename", "before-directory-sync"])(
    "reports a committed file when %s fails",
    async point => {
      const dir = makeDirectory();

      const failure = await expectCommitFailure(() =>
        atomicCreateFile(
          dir,
          "config.json",
          Buffer.from("x"),
          injectAt(point),
        ),
      );

      expect(failure.details).toMatchObject({ committed: true });
      expect(readFileSync(path.join(dir, "config.json"), "utf8")).toBe("x");
      expect(temporaryFiles(dir)).toEqual([]);
    },
  );

  it("leaves a two-link target that readers refuse instead of repairing it", async () => {
    const dir = makeDirectory();
    const file = path.join(dir, "config.json");

    await atomicCreateFile(dir, "config.json", Buffer.from("x"), undefined);

    // A crash between the link and the removal of the creator's own temporary
    // name looks exactly like this.
    linkSync(file, path.join(dir, ".tmp-0000000000000000"));

    expect(lstatSync(file).nlink).toBe(2);
    await expect(readControlledFile(file)).rejects.toMatchObject({
      code: "STATE_CORRUPT",
    });
    expect(lstatSync(file).nlink).toBe(2);
  });
});

describe("atomicWriteFile replacement semantics are unchanged", () => {
  it("replaces an existing file", async () => {
    const dir = makeDirectory();
    const file = path.join(dir, "config.json");

    writeFileSync(file, "first\n", { mode: 0o600 });
    chmodSync(file, 0o600);

    await atomicWriteFile(dir, "config.json", Buffer.from("second\n"), undefined);

    expect(readFileSync(file, "utf8")).toBe("second\n");
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(lstatSync(file).nlink).toBe(1);
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it("keeps the previous file when a pre-rename fault fires", async () => {
    const dir = makeDirectory();
    const file = path.join(dir, "config.json");

    writeFileSync(file, "first\n", { mode: 0o600 });
    chmodSync(file, 0o600);

    const failure = await expectCommitFailure(() =>
      atomicWriteFile(
        dir,
        "config.json",
        Buffer.from("second\n"),
        injectAt("before-rename"),
      ),
    );

    expect(failure.details).toMatchObject({ committed: false });
    expect(readFileSync(file, "utf8")).toBe("first\n");
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it("refuses an unsafe existing target instead of replacing it", async () => {
    const dir = makeDirectory();
    const file = path.join(dir, "config.json");

    writeFileSync(file, "first\n", { mode: 0o644 });
    chmodSync(file, 0o644);

    await expect(
      atomicWriteFile(dir, "config.json", Buffer.from("second\n"), undefined),
    ).rejects.toMatchObject({ code: "STATE_CORRUPT" });

    expect(readFileSync(file, "utf8")).toBe("first\n");
    expect(lstatSync(file).mode & 0o777).toBe(0o644);
  });
});
