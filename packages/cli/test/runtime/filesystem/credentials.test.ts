import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { layoutOf } from "../../../src/runtime/filesystem/index.js";
import {
  FIXED_NOW,
  connected,
  connectionRecord,
  fixtureAt,
  makeRoot,
  rejectionOf,
  startConnect,
  tree,
} from "./support.js";

const SECRET = "FAKE_SECRET_CANARY_7c1f2a";

const rootAt = async (): Promise<string> =>
  path.join(await makeRoot(), "runtime-v1");

const ownerAt = (
  ownerId: string,
  version = 1,
): { kind: "credential"; ownerId: string; version: number } => ({
  kind: "credential",
  ownerId,
  version,
});

describe("filesystem credentials", () => {
  it("stages durably, is idempotent, and refuses a second value", async () => {
    const root = await rootAt();
    const fixture = fixtureAt(root);
    const stage = await fixture.credentials.put({
      creationId: "one",
      owner: ownerAt("conn_one"),
      value: { token: SECRET },
    });

    expect(stage.ref).toBe("secret_one");
    expect(
      await fixture.credentials.get({
        ref: stage.ref,
        owner: ownerAt("conn_one"),
      }),
    ).toEqual({ token: SECRET });

    // The blob is owned directory/file state, not encrypted.
    expect((await fs.stat(layoutOf(root).blobs)).mode & 0o777).toBe(0o700);
    const blob = (await tree(layoutOf(root).blobs))[0];

    expect(blob?.mode).toBe(0o600);

    // Re-staging the identical blob is idempotent.
    expect(
      (
        await fixture.credentials.put({
          creationId: "one",
          owner: ownerAt("conn_one"),
          value: { token: SECRET },
        })
      ).ref,
    ).toBe(stage.ref);

    // A different value under the same creation id is durability, not an
    // overwrite.
    expect(
      (
        await rejectionOf(
          fixture.credentials.put({
            creationId: "one",
            owner: ownerAt("conn_one"),
            value: { token: "other" },
          }),
        )
      ).code,
    ).toBe("DURABILITY_ERROR");
    expect(blob?.text).toContain(SECRET);
  });

  it("binds reads to the exact owner revision", async () => {
    const root = await rootAt();
    const fixture = fixtureAt(root);
    const stage = await fixture.credentials.put({
      creationId: "one",
      owner: ownerAt("conn_one"),
      value: { token: SECRET },
    });

    for (const owner of [
      ownerAt("conn_one", 2),
      ownerAt("conn_two", 1),
      { kind: "approval" as const, ownerId: "conn_one", version: 1 },
    ]) {
      expect(
        (await rejectionOf(fixture.credentials.get({ ref: stage.ref, owner })))
          .code,
      ).toBe("DURABILITY_ERROR");
    }

    expect(
      (await rejectionOf(
        fixture.credentials.get({
          ref: "secret_missing",
          owner: ownerAt("conn_one"),
        }),
      )).code,
    ).toBe("DURABILITY_ERROR");
  });

  it("never writes a credential into the business generation tree", async () => {
    const root = await rootAt();
    const fixture = fixtureAt(root);
    const { connectionId, claim } = await startConnect(fixture);
    const stage = await fixture.credentials.put({
      creationId: "canary",
      owner: ownerAt(connectionId),
      value: { token: SECRET },
    });

    await fixture.state.commitConnection({
      claim,
      expectedConnectionRevision: null,
      connection: connectionRecord(connectionId, stage.ref),
      stagedCredential: stage,
      now: FIXED_NOW,
    });

    const business = [
      ...(await tree(path.join(root, "generations"))),
      ...(await tree(layoutOf(root).secrets)).filter(
        file => !file.path.includes(`${path.sep}blobs${path.sep}`),
      ),
    ];

    expect(business.length).toBeGreaterThan(0);

    for (const file of business) {
      expect(file.text, file.path).not.toContain(SECRET);
    }

    expect((await tree(layoutOf(root).blobs)).length).toBe(1);
  });

  it("fences a retired reference and deletes only against its proof", async () => {
    const root = await rootAt();
    const fixture = fixtureAt(root);
    const stage = await fixture.credentials.put({
      creationId: "retire",
      owner: ownerAt("conn_retire"),
      value: { token: SECRET },
    });

    // Deletion without a fence is never allowed.
    expect(
      (
        await rejectionOf(
          fixture.credentials.delete({
            stage,
            unreferencedProof: "invented",
          }),
        )
      ).code,
    ).toBe("DURABILITY_ERROR");

    const retired = await fixture.state.retireUnreferenced(stage);

    expect(retired?.proof).toBeTruthy();

    expect(
      (
        await rejectionOf(
          fixture.credentials.delete({
            stage,
            unreferencedProof: "wrong",
          }),
        )
      ).code,
    ).toBe("DURABILITY_ERROR");

    await fixture.credentials.delete({
      stage,
      unreferencedProof: retired?.proof as string,
    });

    expect(
      (await rejectionOf(
        fixture.credentials.get({ ref: stage.ref, owner: stage.owner }),
      )).code,
    ).toBe("DURABILITY_ERROR");
  });

  it("does not fence a referenced blob and blocks a later reference", async () => {
    const root = await rootAt();
    const fixture = fixtureAt(root);
    const { stage } = await connected(fixture);

    expect(await fixture.state.retireUnreferenced(stage)).toBeNull();

    const { connectionId, claim } = await startConnect(fixture, "two");
    const second = await fixture.credentials.put({
      creationId: "credential_two",
      owner: ownerAt(connectionId),
      value: { token: SECRET },
    });

    await fixture.state.retireUnreferenced(second);

    expect(
      (
        await rejectionOf(
          fixture.state.commitConnection({
            claim,
            expectedConnectionRevision: null,
            connection: connectionRecord(connectionId, second.ref, "two"),
            stagedCredential: second,
            now: FIXED_NOW,
          }),
        )
      ).code,
    ).toBe("DURABILITY_ERROR");
    // A refused commit leaves no connection behind.
    expect(await fixture.state.getConnection(connectionId)).toBeNull();
    expect((await fixture.state.listConnections()).length).toBe(1);
  });

  it("keeps values, owners and refs out of every failure", async () => {
    const root = await rootAt();
    const fixture = fixtureAt(root);
    const stage = await fixture.credentials.put({
      creationId: "quiet",
      owner: ownerAt("conn_quiet"),
      value: { token: SECRET },
    });
    const failure = await rejectionOf(
      fixture.credentials.get({
        ref: stage.ref,
        owner: ownerAt("conn_quiet", 9),
      }),
    );

    expect(failure.code).toBe("DURABILITY_ERROR");
    expect(failure.message).toBe("DURABILITY_ERROR");
    expect(String(failure.stack)).not.toContain(SECRET);
    expect(String(failure.stack)).not.toContain("conn_quiet");
    expect(String(failure.stack)).not.toContain(root);
  });
});
