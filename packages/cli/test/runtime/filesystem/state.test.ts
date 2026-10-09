import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  RUNTIME_FORMAT,
  layoutOf,
} from "../../../src/runtime/filesystem/index.js";
import type { FilesystemState } from "../../../src/runtime/filesystem/index.js";
import {
  FIXED_NOW,
  connected,
  fixtureAt,
  makeRoot,
  rejectionOf,
  tree,
  type Fixture,
} from "./support.js";

const rootAt = async (): Promise<string> =>
  path.join(await makeRoot(), "runtime-v1");

const update = (
  label: string,
  key: string,
): Parameters<FilesystemState["updateConnection"]>[0] => ({
  request: {
    principalId: "owner",
    family: "connect",
    key,
    digest: key,
  },
  connectionId: "conn_one",
  expectedRevision: 1,
  changes: { label },
  now: FIXED_NOW,
});

const claimNotifications = (
  fixture: Fixture,
  now: string,
): Promise<readonly unknown[]> =>
  fixture.state.claimNotifications({ ownerId: "notify", now, limit: 5 });

describe("filesystem state root", () => {
  it("creates nothing while the runtime is state-free", async () => {
    const root = await rootAt();
    const fixture = fixtureAt(root);

    expect(await fixture.state.listConnections()).toEqual([]);
    expect(await fixture.state.getOperation("op_missing", "owner")).toBeNull();
    expect(
      await fixture.state.listOperations({ principalId: "owner", limit: 20 }),
    ).toEqual({ operations: [] });
    expect(await fixture.state.getConnectSession("cs_x", "owner")).toBeNull();

    await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes owned directories and files on the first commit", async () => {
    const root = await rootAt();
    const fixture = fixtureAt(root);

    await connected(fixture);

    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(layoutOf(root).generations)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(layoutOf(root).secrets)).mode & 0o777).toBe(0o700);

    const files = await tree(root);

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      expect(file.mode, file.path).toBe(0o600);
    }

    // The first generation is the empty initialization the runtime publishes
    // before it accepts any business action.
    const generations = (await fs.readdir(layoutOf(root).generations)).sort();

    expect(generations[0]).toBe("gen-000001");
    expect(generations[1]).toBe("gen-000002");
  });

  it("refuses a root whose format marker names another format", async () => {
    const root = await rootAt();

    await fs.mkdir(root, { mode: 0o700 });
    await fs.chmod(root, 0o700);
    await fs.writeFile(
      layoutOf(root).format,
      JSON.stringify({ format: "syndroo-local-v0" }),
      { mode: 0o600 },
    );
    const fixture = fixtureAt(root);

    expect((await rejectionOf(fixture.state.listConnections())).code).toBe(
      "STATE_RECOVERY_REQUIRED",
    );
    expect(
      (
        await rejectionOf(
          fixture.state.claimNotifications({
            ownerId: "notify",
            now: FIXED_NOW,
            limit: 5,
          }),
        )
      ).code,
    ).toBe("STATE_RECOVERY_REQUIRED");
    expect(await fs.readFile(layoutOf(root).format, "utf8")).toContain(
      "syndroo-local-v0",
    );
  });

  it("fails closed when the published generation has no journal", async () => {
    const root = await rootAt();
    const fixture = fixtureAt(root);

    await connected(fixture);

    const current = (
      await fs.readFile(layoutOf(root).current, "utf8")
    ).trim();

    await fs.rm(path.join(layoutOf(root).generations, current, "journal.json"));

    expect((await rejectionOf(fixture.state.listConnections())).code).toBe(
      "STATE_RECOVERY_REQUIRED",
    );
    expect((await rejectionOf(claimNotifications(fixture, FIXED_NOW))).code).toBe(
      "STATE_RECOVERY_REQUIRED",
    );
    // A read never repairs the damage it reports.
    expect(
      (await fs.stat(path.join(layoutOf(root).generations, current))).isDirectory(),
    ).toBe(true);
  });

  it("keeps the previous generation when a commit dies before the pointer", async () => {
    const root = await rootAt();
    const first = fixtureAt(root);

    await connected(first);

    const currentBefore = (
      await fs.readFile(layoutOf(root).current, "utf8")
    ).trim();
    const unpublished = `gen-${String(
      Number(currentBefore.slice(4)) + 1,
    ).padStart(6, "0")}`;
    let armed = true;
    const crashing = fixtureAt(root, point => {
      if (armed && point === "before-current-replace") {
        armed = false;
        throw new Error("simulated crash");
      }
    });
    const error = await rejectionOf(
      crashing.state.updateConnection(update("primary", "update_one")),
    );

    expect(error.message).toBe("simulated crash");
    // The old generation is authoritative: the label never became durable.
    expect((await first.state.getConnection("conn_one"))?.label).toBeUndefined();
    // The pointer never moved, and the unpublished generation directory is
    // still on disk without being read.
    expect((await fs.readFile(layoutOf(root).current, "utf8")).trim()).toBe(
      currentBefore,
    );
    const afterCrash = (await fs.readdir(layoutOf(root).generations)).sort();

    expect(afterCrash).toContain(unpublished);

    // The next write reclaims the unpublished generation and republishes it.
    const applied = await first.state.updateConnection(
      update("primary", "update_one"),
    );

    expect(applied.type).toBe("applied");
    expect((await first.state.getConnection("conn_one"))?.label).toBe("primary");
    expect((await fs.readFile(layoutOf(root).current, "utf8")).trim()).not.toBe(
      currentBefore,
    );
    expect((await fs.readdir(layoutOf(root).generations)).sort()).toEqual(
      afterCrash,
    );
  });

  it("keeps the new generation when a commit dies after the pointer", async () => {
    const root = await rootAt();
    let armed = false;
    const crashing = fixtureAt(root, point => {
      if (armed && point === "after-current-replace") {
        armed = false;
        throw new Error("simulated crash");
      }
    });

    await connected(crashing);

    armed = true;

    const error = await rejectionOf(
      crashing.state.updateConnection(update("primary", "update_two")),
    );

    expect(error.message).toBe("simulated crash");
    expect((await fixtureAt(root).state.getConnection("conn_one"))?.label).toBe(
      "primary",
    );
  });

  it("never steals a writer lock and never repairs a damaged one", async () => {
    const root = await rootAt();
    const fixture = fixtureAt(root);

    await connected(fixture);

    const { lock, lockOwner } = layoutOf(root);

    await fs.mkdir(lock, { mode: 0o700 });
    await fs.chmod(lock, 0o700);
    await fs.writeFile(
      lockOwner,
      JSON.stringify({
        format: RUNTIME_FORMAT,
        token: "t".repeat(32),
        pid: process.pid,
        hostname: "fixture",
        createdAt: FIXED_NOW,
      }),
      { mode: 0o600 },
    );

    const busy = await rejectionOf(claimNotifications(fixture, FIXED_NOW));

    expect(busy.code).toBe("STATE_BUSY");

    // A later clock is not evidence that the writer stopped.
    expect(
      (
        await rejectionOf(
          claimNotifications(fixture, "2030-01-01T00:00:00.000Z"),
        )
      ).code,
    ).toBe("STATE_BUSY");

    await fs.rm(lockOwner);

    const damaged = await rejectionOf(claimNotifications(fixture, FIXED_NOW));

    expect(damaged.code).toBe("STATE_RECOVERY_REQUIRED");
    expect((await fs.stat(lock)).isDirectory()).toBe(true);
  });

  it("refuses a symlinked state root and a symlinked record file", async () => {
    const base = await makeRoot();
    const real = path.join(base, "real");
    const link = path.join(base, "link");

    await fs.mkdir(real, { mode: 0o700 });
    await fs.chmod(real, 0o700);
    await fs.symlink(real, link);

    expect((await rejectionOf(fixtureAt(link).state.listConnections())).code).toBe(
      "STATE_RECOVERY_REQUIRED",
    );

    const root = await rootAt();
    const fixture = fixtureAt(root);

    await connected(fixture);

    const record = (await tree(root)).find(file =>
      file.path.includes(`${path.sep}records${path.sep}`),
    );

    expect(record).toBeDefined();
    await fs.rm(record?.path as string);
    await fs.symlink(`${record?.path}.elsewhere`, record?.path as string);

    expect((await rejectionOf(fixture.state.listConnections())).code).toBe(
      "STATE_RECOVERY_REQUIRED",
    );
  });

  it("performs no repair on a read-only path", async () => {
    const root = await rootAt();
    const fixture = fixtureAt(root);

    await connected(fixture);

    const garbage = path.join(layoutOf(root).generations, "gen-000099");
    const stray = path.join(root, ".tmp-stray");

    await fs.mkdir(garbage, { mode: 0o700 });
    await fs.chmod(garbage, 0o700);
    await fs.writeFile(stray, "leftover", { mode: 0o600 });

    await fixture.state.listConnections();
    await fixture.state.getOperation("op_missing", "owner");
    await fixture.state.listOperations({ principalId: "owner", limit: 5 });

    expect((await fs.stat(garbage)).isDirectory()).toBe(true);
    expect((await fs.stat(stray)).isFile()).toBe(true);
  });

  it("shares committed state between instances and rejects tampered cursors", async () => {
    const root = await rootAt();
    const first = fixtureAt(root);

    await connected(first);

    const second = fixtureAt(root);

    expect((await second.state.listConnections()).length).toBe(1);
    expect((await second.state.getConnection("conn_one"))?.account.accountId).toBe(
      "alice",
    );
    expect(
      (
        await rejectionOf(
          second.state.listOperations({
            principalId: "owner",
            limit: 5,
            cursor: "not.a.cursor",
          }),
        )
      ).code,
    ).toBe("INVALID_INPUT");
  });
});
