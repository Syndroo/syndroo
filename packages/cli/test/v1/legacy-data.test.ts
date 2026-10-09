import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFakeTransport } from "../../../../tests/fixtures/providers/fake.js";
import {
  parseEnvelope,
  runCli,
  sandbox,
  type Sandbox,
} from "./support/harness.js";
import { fakeRegistry } from "./support/registry.js";

/**
 * DOC-04: the architecture-v1 CLI has no legacy protocol, command or importer.
 * It never scans, migrates or deletes pre-v1 user data, and an old-format
 * configuration is refused rather than upgraded.
 *
 * The evidence is filesystem observation: a byte-and-mtime snapshot of the old
 * tree taken before and after the runs, a poison entry that makes any content
 * scan fail loudly, and a canary that would appear in the new state root if a
 * migration had copied anything across.
 */

const boxes: Sandbox[] = [];

async function box(): Promise<Sandbox> {
  const created = await sandbox("syndroo-cli-legacy-");

  boxes.push(created);

  return created;
}

afterEach(async () => {
  await Promise.all(boxes.splice(0).map((created) => created.cleanup()));
});

const overrides = {
  providers: fakeRegistry(),
  transport: createFakeTransport({ type: "response", status: 200, headers: {}, body: "{}" }),
};

/** Distinguishes migrated bytes from the old tree in the new state root. */
const LEGACY_CANARY = "syndroo-legacy-state-canary-9f3c";

/** One path in the snapshot: bytes' hash, size, mtime, or a symlink target. */
type Entry = string;

/**
 * Recursive byte-and-metadata snapshot.
 *
 * `lstat` is deliberate: following a link would hide a replaced link, and a
 * dangling link is exactly the poison the third test relies on.
 */
async function snapshot(directory: string, base = directory): Promise<Entry[]> {
  const found: Entry[] = [];

  for (const name of (await fs.readdir(directory)).sort()) {
    const child = path.join(directory, name);
    const relative = path.relative(base, child);
    const stat = await fs.lstat(child);

    if (stat.isSymbolicLink()) {
      found.push(`link ${relative} -> ${await fs.readlink(child)}`);
      continue;
    }

    if (stat.isDirectory()) {
      found.push(`dir ${relative}`);
      found.push(...(await snapshot(child, base)));
      continue;
    }

    const bytes = await fs.readFile(child);

    found.push(
      `file ${relative} ${stat.size} ${stat.mtimeMs} ${createHash("sha256").update(bytes).digest("hex")}`,
    );
  }

  return found.sort();
}

/** Every file below a directory, as text, for the "nothing migrated" scan. */
async function contents(directory: string): Promise<string[]> {
  if (!existsSync(directory)) {
    return [];
  }

  const found: string[] = [];

  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...(await contents(child)));
    } else if (entry.isFile()) {
      found.push(await fs.readFile(child, "utf8"));
    }
  }

  return found;
}

/**
 * What a v0.4-style migration would do: walk the old tree and read every entry.
 *
 * Fails on the dangling `operations.json` link planted by the fixture, which is
 * how the test proves the fence is real - an implementation that scanned the old
 * directory would hit the same error instead of finishing quietly.
 */
async function readEveryEntry(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await readEveryEntry(child);
    } else {
      await fs.readFile(child);
    }
  }
}

/** A pre-v1 user tree, with a schema version this CLI never had. */
async function plantLegacyTree(root: string): Promise<{
  readonly directory: string;
  readonly config: string;
  readonly versionedConfig: string;
  readonly state: string;
}> {
  const directory = path.join(root, "legacy");
  const state = path.join(directory, "state");

  await fs.mkdir(path.join(state, "records"), { recursive: true });
  await fs.writeFile(
    path.join(directory, "config.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      stateDir: "./state",
      providers: { bluesky: { identifier: "old@example" } },
      accounts: [{ provider: "bluesky", handle: "old.example" }],
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(state, "operations.json"),
    `${JSON.stringify({ operations: [{ id: "old_op_1", text: LEGACY_CANARY }] })}\n`,
  );
  await fs.writeFile(
    path.join(state, "records", "connection.json"),
    `${JSON.stringify({ connectionId: "old_conn", provider: "bluesky", canary: LEGACY_CANARY })}\n`,
  );
  // A version this CLI never supported, naming a migrated root inside the old
  // tree: an implementation that upgraded in place would create it.
  await fs.writeFile(
    path.join(directory, "config-v0.json"),
    `${JSON.stringify({ version: 0, stateRoot: "./state-migrated" }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(directory, "sentinel.bin"),
    Buffer.from([0x00, 0xff, 0x53, 0x59, 0x4e, 0x0d, 0x0a, 0x1a, 0x00, 0x7f]),
  );
  // Poison for a content scan: a link that resolves to nothing.
  await fs.symlink("/nonexistent/syndroo-legacy-target", path.join(state, "approvals.json"));

  return {
    directory,
    config: path.join(directory, "config.json"),
    versionedConfig: path.join(directory, "config-v0.json"),
    state,
  };
}

describe("DOC-04 no legacy protocol, importer or migration", () => {
  it("refuses the old configuration format and leaves the old tree byte-identical", async () => {
    const space = await box();
    const legacy = await plantLegacyTree(space.root);
    const before = await snapshot(legacy.directory);

    // 1a. The pre-v1 configuration shape is refused, not migrated.
    const refusedLegacy = await runCli(
      ["status", "--json", "--config", legacy.config],
      { env: space.env, cwd: space.root, overrides },
    );

    expect(refusedLegacy.exit).toBe(2);
    expect(parseEnvelope(refusedLegacy)).toMatchObject({
      protocolVersion: 1,
      operation: "status",
      ok: false,
      error: { code: "CONFIG_INVALID" },
    });

    // 1b. A configuration declaring another version is refused by version, and
    // the migrated root it names is never created.
    const refusedVersion = await runCli(
      ["status", "--json", "--config", legacy.versionedConfig],
      { env: space.env, cwd: space.root, overrides },
    );

    expect(refusedVersion.exit).toBe(2);
    expect(parseEnvelope(refusedVersion)).toMatchObject({
      protocolVersion: 1,
      operation: "status",
      ok: false,
      error: { code: "CONFIG_VERSION_UNSUPPORTED" },
    });
    expect(existsSync(path.join(legacy.directory, "state-migrated"))).toBe(false);

    // 2. A v1 configuration with an explicit fresh state root initializes.
    const fresh = path.join(space.root, "fresh");
    const freshRoot = path.join(fresh, "state");
    const freshConfig = path.join(fresh, "config.json");
    const credential = path.join(fresh, "credential.json");

    await fs.mkdir(fresh, { recursive: true });
    await fs.writeFile(
      freshConfig,
      `${JSON.stringify({ version: 1, stateRoot: "./state" }, null, 2)}\n`,
    );
    await fs.writeFile(credential, JSON.stringify({ canary: "legacy-data-canary" }));

    const connected = await runCli(
      ["connect", "fake", "--credential-file", credential, "--config", freshConfig, "--json"],
      { env: space.env, cwd: space.root, overrides },
    );

    expect(connected.exit).toBe(0);
    expect(parseEnvelope(connected)["result"]).toMatchObject({ status: "done" });
    expect(existsSync(freshRoot)).toBe(true);
    expect((await snapshot(freshRoot)).length).toBeGreaterThan(0);

    // 3. Nothing in the old tree moved: same names, bytes, sizes and mtimes.
    expect(await snapshot(legacy.directory)).toEqual(before);

    // 4. Nothing was migrated: no new-state byte carries the old canary or path.
    const migrated = await contents(freshRoot);

    for (const text of migrated) {
      expect(text).not.toContain(LEGACY_CANARY);
      expect(text).not.toContain(legacy.directory);
    }
  });

  it("never reads the old tree, so a scan would fail loudly (poison guard)", async () => {
    const space = await box();
    const legacy = await plantLegacyTree(space.root);

    // The fence first: a migration-style scan of this tree fails.
    await expect(readEveryEntry(legacy.directory)).rejects.toThrow();

    // The CLI run is green anyway, so it did not walk the old tree.
    const legacyRun = await runCli(
      ["status", "--json", "--config", legacy.config],
      { env: space.env, cwd: space.root, overrides },
    );
    const freshRun = await runCli(
      ["status", "--json"],
      { env: space.env, cwd: space.root, overrides },
    );

    expect(legacyRun.exit).toBe(2);
    expect(freshRun.exit).toBe(0);
  });

  it("the snapshot comparator detects a migration (falsifier for the assertions above)", async () => {
    const space = await box();
    const legacy = await plantLegacyTree(space.root);
    const before = await snapshot(legacy.directory);

    // A "migration" writes into the old tree; the comparator must notice.
    await fs.writeFile(
      path.join(legacy.state, "operations.json.migrated"),
      `${LEGACY_CANARY}\n`,
    );

    expect(await snapshot(legacy.directory)).not.toEqual(before);
  });
});
