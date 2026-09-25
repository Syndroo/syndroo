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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CliError } from "../../src/cli-error.js";
import {
  DEFAULT_LOCAL_NAMESPACE,
  createLocalConfig,
  initLocalConfig,
  localConfigDir,
  localConfigPath,
  parseLocalConfig,
  readLocalConfig,
  resolveStateHome,
  writeLocalConfig,
  type LocalConfig,
} from "../../src/local/config.js";

/**
 * T07 config adapter: the local config file is read through the same controlled
 * path and file helpers as the state records, so an unsafe directory, an unsafe
 * or non-regular file, a malformed document, or a symlinked parent fails closed
 * instead of being treated as "no config".
 *
 * Every case uses a disposable temp directory; nothing here touches real user
 * state, and no case makes a network request.
 */

const ROOTS: string[] = [];

afterEach(() => {
  for (const root of ROOTS.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "syndroo-t07-config-")),
  );

  ROOTS.push(root);

  return root;
}

/** Absolute XDG locations under one disposable root. */
function envFor(root: string): NodeJS.ProcessEnv {
  return {
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
  };
}

async function expectCliError(action: () => Promise<unknown>): Promise<CliError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);

    return error as CliError;
  }

  throw new Error("expected a CliError");
}

function modeOf(target: string): number {
  return lstatSync(target).mode & 0o777;
}

function exists(target: string): boolean {
  return lstatSync(target, { throwIfNoEntry: false }) !== undefined;
}

/** A directory listing of the disposable root, so "created nothing" is provable. */
function treeOf(root: string): string[] {
  const seen: string[] = [];

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const rel = prefix === "" ? entry : `${prefix}/${entry}`;

      seen.push(`${rel}:${lstatSync(full).isDirectory() ? "d" : "f"}`);

      if (lstatSync(full).isDirectory()) {
        walk(full, rel);
      }
    }
  };

  walk(root, "");

  return seen.sort();
}

/** Creates the controlled config directory without going through the adapter. */
function makeConfigDir(env: NodeJS.ProcessEnv): string {
  const dir = localConfigDir(env);

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  return dir;
}

function writeRawConfig(env: NodeJS.ProcessEnv, text: string): string {
  const dir = makeConfigDir(env);
  const file = path.join(dir, "config.json");

  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);

  return file;
}

describe("config read is read-only and never invents history", () => {
  it("returns null and creates nothing when the config directory is absent", async () => {
    const root = makeRoot();
    const env = envFor(root);
    const before = treeOf(root);

    expect(await readLocalConfig(env)).toBeNull();
    expect(treeOf(root)).toEqual(before);
    expect(exists(localConfigDir(env))).toBe(false);
  });

  it("returns null and creates nothing when the directory exists without a file", async () => {
    const root = makeRoot();
    const env = envFor(root);

    makeConfigDir(env);
    const before = treeOf(root);

    expect(await readLocalConfig(env)).toBeNull();
    expect(treeOf(root)).toEqual(before);
    expect(exists(localConfigPath(env))).toBe(false);
  });
});

describe("config write and init", () => {
  it("writes a 0700 directory and 0600 file", async () => {
    const root = makeRoot();
    const env = envFor(root);
    const config: LocalConfig = { schemaVersion: 1, namespace: "default" };

    await writeLocalConfig(config, env);

    expect(modeOf(localConfigDir(env))).toBe(0o700);
    expect(modeOf(localConfigPath(env))).toBe(0o600);
    expect(await readLocalConfig(env)).toEqual(config);
  });

  it("is idempotent for the same namespace and refuses a different one", async () => {
    const root = makeRoot();
    const env = envFor(root);

    const first = await initLocalConfig(undefined, env);

    expect(first.created).toBe(true);
    expect(first.config).toEqual({
      schemaVersion: 1,
      namespace: DEFAULT_LOCAL_NAMESPACE,
    });

    const original = readFileSync(localConfigPath(env), "utf8");
    const same = await initLocalConfig(DEFAULT_LOCAL_NAMESPACE, env);

    expect(same.created).toBe(false);
    expect(same.config).toEqual(first.config);

    const noNamespace = await initLocalConfig(undefined, env);

    expect(noNamespace.created).toBe(false);
    expect(noNamespace.config).toEqual(first.config);

    const refused = await expectCliError(() =>
      initLocalConfig("other", env),
    );

    expect(refused.code).toBe("CONFIG");
    expect(readFileSync(localConfigPath(env), "utf8")).toBe(original);
  });

  it("refuses a requested namespace that is not usable", async () => {
    const root = makeRoot();
    const env = envFor(root);
    const refused = await expectCliError(() =>
      initLocalConfig("../escape", env),
    );

    expect(refused.code).toBe("CONFIG");
    expect(exists(localConfigDir(env))).toBe(false);
  });
});

describe("config read fails closed", () => {
  const malformed: ReadonlyArray<[string, string, string]> = [
    ["invalid JSON", "{not json", "STATE_CORRUPT"],
    ["empty file", "", "STATE_CORRUPT"],
    ["JSON array root", "[]\n", "CONFIG"],
    ["JSON null root", "null\n", "CONFIG"],
    ["extra field", '{"schemaVersion":1,"namespace":"a","extra":true}\n', "CONFIG"],
    ["missing namespace", '{"schemaVersion":1}\n', "CONFIG"],
    ["newer schema version", '{"schemaVersion":2,"namespace":"a"}\n', "CONFIG"],
    ["string schema version", '{"schemaVersion":"1","namespace":"a"}\n', "CONFIG"],
    ["unusable namespace", '{"schemaVersion":1,"namespace":"../x"}\n', "CONFIG"],
    ["blank namespace", '{"schemaVersion":1,"namespace":""}\n', "CONFIG"],
  ];

  for (const [name, text, code] of malformed) {
    it(`refuses a malformed config (${name}) instead of returning null`, async () => {
      const root = makeRoot();
      const env = envFor(root);

      writeRawConfig(env, text);

      const refused = await expectCliError(() => readLocalConfig(env));

      expect(refused.code).toBe(code);
      expect(readFileSync(localConfigPath(env), "utf8")).toBe(text);
    });
  }

  it("refuses an unsafe directory mode and never repairs it", async () => {
    const root = makeRoot();
    const env = envFor(root);

    await initLocalConfig(undefined, env);
    chmodSync(localConfigDir(env), 0o755);

    const refused = await expectCliError(() => readLocalConfig(env));

    expect(refused.code).toBe("STATE_CORRUPT");
    expect(modeOf(localConfigDir(env))).toBe(0o755);
  });

  it("refuses an unsafe file mode and never repairs it", async () => {
    const root = makeRoot();
    const env = envFor(root);

    await initLocalConfig(undefined, env);
    chmodSync(localConfigPath(env), 0o644);

    const refused = await expectCliError(() => readLocalConfig(env));

    expect(refused.code).toBe("STATE_CORRUPT");
    expect(modeOf(localConfigPath(env))).toBe(0o644);

    // `init` reaches the same refusal through its initial read and must not
    // repair, replace, or delete the unsafe file.
    const initRefused = await expectCliError(() =>
      initLocalConfig(undefined, env),
    );

    expect(initRefused.code).toBe("STATE_CORRUPT");
    expect(modeOf(localConfigPath(env))).toBe(0o644);
    expect(readFileSync(localConfigPath(env), "utf8")).toBe(
      '{\n  "schemaVersion": 1,\n  "namespace": "default"\n}\n',
    );
  });

  it("refuses a non-regular config file", async () => {
    const root = makeRoot();
    const env = envFor(root);

    mkdirSync(path.join(makeConfigDir(env), "config.json"), { mode: 0o700 });

    const refused = await expectCliError(() => readLocalConfig(env));

    expect(refused.code).toBe("STATE_CORRUPT");
  });

  it("refuses an oversized config file", async () => {
    const root = makeRoot();
    const env = envFor(root);

    writeRawConfig(env, `{"schemaVersion":1,"namespace":"${"a".repeat(1_048_576)}"}`);

    const refused = await expectCliError(() => readLocalConfig(env));

    expect(refused.code).toBe("STATE_CORRUPT");
  });
});

describe("config path safety", () => {
  it("refuses a symlinked config directory that holds a config", async () => {
    const root = makeRoot();
    const real = path.join(root, "real-config");
    const link = path.join(root, "link-config");

    mkdirSync(path.join(real, "syndroo"), { recursive: true, mode: 0o700 });
    chmodSync(path.join(real, "syndroo"), 0o700);
    writeFileSync(
      path.join(real, "syndroo", "config.json"),
      '{"schemaVersion":1,"namespace":"real"}\n',
      { mode: 0o600 },
    );
    symlinkSync(real, link, "dir");

    const env: NodeJS.ProcessEnv = { HOME: path.join(root, "home"), XDG_CONFIG_HOME: link };
    const refused = await expectCliError(() => readLocalConfig(env));

    expect(refused.code).toBe("STATE_CORRUPT");
  });

  it("refuses a symlinked ancestor above the config home", async () => {
    const root = makeRoot();
    const real = path.join(root, "real-parent");
    const link = path.join(root, "link-parent");

    mkdirSync(path.join(real, "config", "syndroo"), { recursive: true, mode: 0o700 });
    chmodSync(path.join(real, "config"), 0o700);
    chmodSync(path.join(real, "config", "syndroo"), 0o700);
    writeFileSync(
      path.join(real, "config", "syndroo", "config.json"),
      '{"schemaVersion":1,"namespace":"real"}\n',
      { mode: 0o600 },
    );
    symlinkSync(real, link, "dir");

    const env: NodeJS.ProcessEnv = {
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(link, "config"),
    };
    const refused = await expectCliError(() => readLocalConfig(env));

    expect(refused.code).toBe("STATE_CORRUPT");
  });

  it("never writes a config through a symlinked parent", async () => {
    const root = makeRoot();
    const real = path.join(root, "real-parent");
    const link = path.join(root, "link-parent");

    mkdirSync(real, { recursive: true, mode: 0o700 });
    symlinkSync(real, link, "dir");

    const env: NodeJS.ProcessEnv = { HOME: path.join(root, "home"), XDG_CONFIG_HOME: link };

    // The read reports "no config" because the resolved target holds no
    // Syndroo directory; the write must still refuse the symlinked parent.
    expect(await readLocalConfig(env)).toBeNull();

    const refused = await expectCliError(() =>
      initLocalConfig(undefined, env),
    );

    expect(refused.code).toBe("STATE_CORRUPT");
    expect(exists(path.join(real, "syndroo"))).toBe(false);
  });
});

describe("config shape parsing and state-home resolution", () => {
  it("accepts only the frozen config shape", () => {
    expect(parseLocalConfig({ schemaVersion: 1, namespace: "a.b-c_d" })).toEqual({
      schemaVersion: 1,
      namespace: "a.b-c_d",
    });

    for (const value of [
      null,
      [],
      "config",
      1,
      { schemaVersion: 1 },
      { schemaVersion: 1, namespace: "a", extra: 1 },
      { schemaVersion: 1, namespace: "a".repeat(65) },
      { schemaVersion: 1, namespace: "-leading" },
    ]) {
      expect(() => parseLocalConfig(value)).toThrow(CliError);
    }
  });

  it("resolves the state home from an explicit override or XDG_STATE_HOME", () => {
    const root = makeRoot();
    const env = envFor(root);

    expect(resolveStateHome(env, undefined, root)).toBe(
      path.join(root, "state", "syndroo"),
    );
    expect(resolveStateHome(env, "custom", root)).toBe(
      path.join(root, "custom"),
    );
    expect(resolveStateHome(env, "/absolute/state", root)).toBe(
      "/absolute/state",
    );
    expect(resolveStateHome({ HOME: path.join(root, "home") }, undefined, root)).toBe(
      path.join(root, "home", ".local", "state", "syndroo"),
    );
  });

  it("ignores a relative XDG base directory instead of resolving it per cwd", () => {
    const root = makeRoot();
    const home = path.join(root, "home");

    // A relative value must not make the location depend on the caller's cwd.
    expect(localConfigDir({ HOME: home, XDG_CONFIG_HOME: "cfg" })).toBe(
      path.join(home, ".config", "syndroo"),
    );
    expect(resolveStateHome({ HOME: home, XDG_STATE_HOME: "st" }, undefined, root)).toBe(
      path.join(home, ".local", "state", "syndroo"),
    );

    // An absolute value, including a whitespace-padded one, still wins.
    expect(localConfigDir({ HOME: home, XDG_CONFIG_HOME: " /abs/cfg " })).toBe(
      path.join("/abs/cfg", "syndroo"),
    );
    expect(
      resolveStateHome({ HOME: home, XDG_STATE_HOME: " /abs/state " }, undefined, root),
    ).toBe(path.join("/abs/state", "syndroo"));
  });
});

describe("config creation is create-only", () => {
  it("creates once and never replaces an existing config", async () => {
    const root = makeRoot();
    const env = envFor(root);
    const first: LocalConfig = { schemaVersion: 1, namespace: "first" };

    await expect(createLocalConfig(first, env)).resolves.toBe(true);

    const original = readFileSync(localConfigPath(env), "utf8");

    await expect(
      createLocalConfig({ schemaVersion: 1, namespace: "second" }, env),
    ).resolves.toBe(false);

    expect(readFileSync(localConfigPath(env), "utf8")).toBe(original);
    expect((await readLocalConfig(env))?.namespace).toBe("first");
    expect(readdirSync(localConfigDir(env))).toEqual(["config.json"]);
  });

  it("keeps exactly one namespace when many inits race for the same config", async () => {
    const root = makeRoot();
    const env = envFor(root);

    for (let round = 0; round < 3; round += 1) {
      const namespaces = Array.from(
        { length: 8 },
        (_value, index) => `race${round}-${index}`,
      );
      const outcomes = await Promise.all(
        namespaces.map(async namespace => {
          try {
            return {
              ok: true as const,
              namespace,
              result: await initLocalConfig(namespace, env),
            };
          } catch (error) {
            return { ok: false as const, namespace, error };
          }
        }),
      );

      const created: string[] = [];
      const accepted: Array<{ requested: string; persisted: string }> = [];

      for (const outcome of outcomes) {
        if (!outcome.ok) {
          // A contender is never a success. It is either refused as a config
          // conflict, or it conservatively refuses while the winner's link
          // count is transiently two. Neither outcome overwrites anything.
          expect(outcome.error).toBeInstanceOf(CliError);
          expect(["CONFIG", "STATE_CORRUPT"]).toContain(
            (outcome.error as CliError).code,
          );

          continue;
        }

        if (outcome.result.created) {
          created.push(outcome.result.config.namespace);
        } else {
          accepted.push({
            requested: outcome.namespace,
            persisted: outcome.result.config.namespace,
          });
        }
      }

      expect(created).toHaveLength(1);

      const winner = created[0] as string;

      expect(namespaces).toContain(winner);

      // No successful return may disagree with the persisted namespace, and the
      // only caller that may be accepted without creating is the one that asked
      // for the winner's namespace.
      expect(accepted.length).toBeLessThanOrEqual(1);

      for (const entry of accepted) {
        expect(entry.persisted).toBe(winner);
        expect(entry.requested).toBe(winner);
      }

      // Exactly one namespace is persisted, with no leftover temporary name.
      expect((await readLocalConfig(env))?.namespace).toBe(winner);
      expect(readdirSync(localConfigDir(env))).toEqual(["config.json"]);

      rmSync(localConfigDir(env), { recursive: true, force: true });
    }
  });

  it("refuses a config with an extra link instead of repairing it", async () => {
    const root = makeRoot();
    const env = envFor(root);

    await initLocalConfig(undefined, env);
    linkSync(
      localConfigPath(env),
      path.join(localConfigDir(env), ".tmp-0000000000000000"),
    );

    const refused = await expectCliError(() => readLocalConfig(env));

    expect(refused.code).toBe("STATE_CORRUPT");
    expect(lstatSync(localConfigPath(env)).nlink).toBe(2);
  });
});
