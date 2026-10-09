import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFakeTransport, FAKE_ACCOUNT } from "../../../../tests/fixtures/providers/fake.js";
import {
  parseEnvelope,
  runCli,
  sandbox,
  stateRootExists,
  stateTree,
  type Sandbox,
} from "./support/harness.js";
import { fakeRegistry } from "./support/registry.js";

/**
 * The lazy-init boundary.
 *
 * `createLocalRuntime` records the state root but performs no filesystem work,
 * so the commands that need no local write must leave the machine exactly as
 * they found it. A first business write (here, a connect) is what creates the
 * root. The assertions are filesystem observations, not intent.
 */

const boxes: Sandbox[] = [];

async function box(): Promise<Sandbox> {
  const created = await sandbox("syndroo-cli-lazy-");

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

describe("lazy local initialization", () => {
  it("--help, --version and a bare invocation create no state", async () => {
    const space = await box();

    for (const argv of [["--help"], ["--version"], []]) {
      const result = await runCli(argv, { env: space.env, cwd: space.root });

      expect(result.exit).toBe(0);
      expect(stateRootExists(space)).toBe(false);
      expect(existsSync(space.configRoot)).toBe(false);
    }
  });

  it("status is read-only and creates no state on a machine that never used Syndroo", async () => {
    const space = await box();
    const result = await runCli(["status", "--json"], {
      env: space.env,
      cwd: space.root,
      overrides,
    });

    expect(result.exit).toBe(0);
    expect(parseEnvelope(result)["result"]).toMatchObject({ type: "overview", initialized: false });
    expect(stateRootExists(space)).toBe(false);
    expect(existsSync(space.configRoot)).toBe(false);
  });

  it("publish --dry-run previews without mutating an existing state root", async () => {
    const space = await box();
    const credential = path.join(space.root, "credential.json");

    await fs.writeFile(credential, JSON.stringify({ canary: "dry-run-canary" }));

    const connected = await runCli(
      ["connect", "fake", "--credential-file", credential, "--json"],
      { env: space.env, cwd: space.root, overrides },
    );

    expect(connected.exit).toBe(0);

    const before = await stateTree(space);
    const document = path.join(space.root, "document.json");

    await fs.writeFile(
      document,
      JSON.stringify({ content: { text: "Dry run only." }, targets: [{ provider: "fake" }] }),
    );

    const result = await runCli(["publish", "--input", document, "--dry-run", "--json"], {
      env: space.env,
      cwd: space.root,
      overrides,
    });

    expect(result.exit).toBe(0);
    const envelope = parseEnvelope(result);

    expect(envelope["result"]).toMatchObject({ status: "preview" });
    expect(envelope["result"].preview).toHaveLength(1);
    expect(envelope["result"].preview[0].account).toEqual(FAKE_ACCOUNT);
    expect(await stateTree(space)).toEqual(before);
  });

  it("a connect is the first write that creates the state root", async () => {
    const space = await box();
    const credential = path.join(space.root, "credential.json");

    await fs.writeFile(credential, JSON.stringify({ canary: "lazy-init-canary" }));

    const result = await runCli(
      ["connect", "fake", "--credential-file", credential, "--json"],
      { env: space.env, cwd: space.root, overrides },
    );

    expect(result.exit).toBe(0);
    expect(parseEnvelope(result)["result"]).toMatchObject({ status: "done" });
    expect(stateRootExists(space)).toBe(true);
  });
});
