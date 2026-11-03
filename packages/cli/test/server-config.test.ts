import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SERVER_CONFIG_FILE,
  loadServerConfig,
  updateServerConfig,
} from "../src/server/config.js";

const roots: string[] = [];

async function project(): Promise<string> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "syndroo-server-config-")),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("server JSONC configuration", () => {
  it("loads the strict versioned project config", async () => {
    const root = await project();
    await fs.writeFile(
      path.join(root, SERVER_CONFIG_FILE),
      `{
  // Project settings only. Secrets never belong here.
  "version": 1,
  "projectId": "f0c4f706-25a4-4df7-a84c-3b247c64abfe",
  "scope": "threads-production",
  "publicOrigin": "https://syndroo.example",
  "threads": {
    "appId": "123456789",
    "connectionId": "threads:one"
  }
}
`,
    );

    const loaded = await loadServerConfig(root);

    expect(loaded.config).toEqual({
      version: 1,
      projectId: "f0c4f706-25a4-4df7-a84c-3b247c64abfe",
      scope: "threads-production",
      publicOrigin: "https://syndroo.example",
      threads: {
        appId: "123456789",
        connectionId: "threads:one",
      },
    });
    expect(loaded.configFile).toBe(path.join(root, SERVER_CONFIG_FILE));
  });

  it.each([
    ["malformed", `{"version":1`, "SERVER_CONFIG_INVALID"],
    [
      "duplicate",
      `{"version":1,"version":1,"projectId":"f0c4f706-25a4-4df7-a84c-3b247c64abfe"}`,
      "SERVER_CONFIG_DUPLICATE_KEY",
    ],
    [
      "unknown",
      `{"version":1,"projectId":"f0c4f706-25a4-4df7-a84c-3b247c64abfe","provider":"threads"}`,
      "SERVER_CONFIG_UNKNOWN_KEY",
    ],
    [
      "secret",
      `{"version":1,"projectId":"f0c4f706-25a4-4df7-a84c-3b247c64abfe","threads":{"appSecret":"canary"}}`,
      "SERVER_CONFIG_SECRET_REJECTED",
    ],
    [
      "secret value",
      `{"version":1,"projectId":"f0c4f706-25a4-4df7-a84c-3b247c64abfe","scope":"ghp_abcdefghijklmnopqrstuvwx"}`,
      "SERVER_CONFIG_SECRET_REJECTED",
    ],
  ])("rejects %s input with a static code", async (_label, text, code) => {
    const root = await project();
    await fs.writeFile(path.join(root, SERVER_CONFIG_FILE), text);

    await expect(loadServerConfig(root)).rejects.toMatchObject({ code });
  });

  it("updates values atomically without removing unrelated comments", async () => {
    const root = await project();
    const file = path.join(root, SERVER_CONFIG_FILE);
    await fs.writeFile(
      file,
      `{
  // Keep this project note.
  "version": 1,
  "projectId": "f0c4f706-25a4-4df7-a84c-3b247c64abfe",
  "scope": "default" // deployment namespace
}
`,
    );

    const updated = await updateServerConfig(root, {
      publicOrigin: "https://syndroo.example",
      threads: { appId: "123456789" },
    });
    const text = await fs.readFile(file, "utf8");

    expect(updated.publicOrigin).toBe("https://syndroo.example");
    expect(updated.threads).toEqual({ appId: "123456789" });
    expect(text).toContain("// Keep this project note.");
    expect(text).toContain("// deployment namespace");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("removes optional values while preserving the rest of the document", async () => {
    const root = await project();
    const file = path.join(root, SERVER_CONFIG_FILE);
    await fs.writeFile(
      file,
      `{
  "version": 1,
  "projectId": "f0c4f706-25a4-4df7-a84c-3b247c64abfe",
  "scope": "default",
  "publicOrigin": "https://syndroo.example",
  "threads": { "appId": "123", "connectionId": "threads:one" }
}
`,
    );

    const updated = await updateServerConfig(root, {
      publicOrigin: null,
      threads: { connectionId: null },
    });

    expect(updated).toEqual({
      version: 1,
      projectId: "f0c4f706-25a4-4df7-a84c-3b247c64abfe",
      scope: "default",
      threads: { appId: "123" },
    });
  });
});
