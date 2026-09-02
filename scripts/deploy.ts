import { spawn } from "node:child_process";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { applyEdits, modify, parse } from "jsonc-parser";

const root = process.cwd();
const sourceConfigPath = resolve(root, "wrangler.jsonc");
const deployConfigPath = resolve(root, ".wrangler.deploy.jsonc");

type D1Binding = {
  binding: string;
  database_name?: string;
  database_id?: string;
};

type WranglerConfig = {
  d1_databases?: D1Binding[];
};

type D1Database = {
  name: string;
  uuid: string;
};

function wranglerCommand(): string {
  return process.platform === "win32" ? "wrangler.cmd" : "wrangler";
}

async function run(
  args: string[],
  options: { capture?: boolean } = {},
): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const capture = options.capture ?? false;
    const child = spawn(wranglerCommand(), args, {
      cwd: root,
      env: process.env,
      stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
    });

    let stdout = "";
    if (capture) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
    }

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }

      reject(
        new Error(
          signal === null
            ? `wrangler ${args.join(" ")} exited with code ${String(code)}`
            : `wrangler ${args.join(" ")} exited after signal ${signal}`,
        ),
      );
    });
  });
}

function isD1Database(value: unknown): value is D1Database {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === "string" && typeof candidate.uuid === "string";
}

async function listDatabases(): Promise<D1Database[]> {
  const output = await run(["d1", "list", "--json"], { capture: true });
  const value: unknown = JSON.parse(output);

  if (!Array.isArray(value) || !value.every(isD1Database)) {
    throw new Error("Wrangler returned an unexpected response for `d1 list --json`.");
  }

  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

async function findDatabase(
  binding: D1Binding,
  attempts = 1,
): Promise<D1Database | undefined> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const databases = await listDatabases();
    const database = databases.find(
      (candidate) =>
        candidate.uuid === binding.database_id ||
        candidate.name === binding.database_name,
    );

    if (database !== undefined || attempt === attempts) {
      return database;
    }

    await delay(2_000);
  }

  return undefined;
}

async function ensureDatabase(binding: D1Binding): Promise<D1Database> {
  const existing = await findDatabase(binding);
  if (existing !== undefined) {
    return existing;
  }

  if (binding.database_name === undefined) {
    throw new Error(
      `D1 binding ${binding.binding} has no database_name and could not be provisioned.`,
    );
  }

  console.log(
    `D1 database ${binding.database_name} is missing; creating it before deployment.`,
  );
  await run(["d1", "create", binding.database_name]);

  const created = await findDatabase(binding, 10);
  if (created === undefined) {
    throw new Error(
      `D1 database ${binding.database_name} was created but did not become visible.`,
    );
  }

  return created;
}

async function writeDeployConfig(
  bindingIndex: number,
  databaseId: string,
): Promise<void> {
  const source = await readFile(sourceConfigPath, "utf8");
  const edits = modify(
    source,
    ["d1_databases", bindingIndex, "database_id"],
    databaseId,
    {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    },
  );

  await writeFile(deployConfigPath, applyEdits(source, edits), "utf8");
}

async function main(): Promise<void> {
  await copyFile(sourceConfigPath, deployConfigPath);

  const source = await readFile(sourceConfigPath, "utf8");
  const config = parse(source) as WranglerConfig;
  const bindingIndex = config.d1_databases?.findIndex(
    (binding) => binding.binding === "DB",
  );

  if (bindingIndex === undefined || bindingIndex < 0) {
    throw new Error("Wrangler configuration does not define the DB D1 binding.");
  }

  const binding = config.d1_databases?.[bindingIndex];
  if (binding === undefined) {
    throw new Error("Wrangler configuration contains an invalid DB D1 binding.");
  }

  const database = await ensureDatabase(binding);
  if (database.uuid !== binding.database_id) {
    console.log(`Using D1 database ${database.name} (${database.uuid}).`);
  }

  await writeDeployConfig(bindingIndex, database.uuid);
  await run([
    "d1",
    "migrations",
    "apply",
    "DB",
    "--remote",
    "--config",
    deployConfigPath,
  ]);
  await run(["deploy", "--config", deployConfigPath]);
}

try {
  await main();
} finally {
  await rm(deployConfigPath, { force: true });
}
