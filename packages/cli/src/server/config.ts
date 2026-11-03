import { randomBytes } from "node:crypto";
import { constants as FS, promises as fs } from "node:fs";
import path from "node:path";

import {
  applyEdits,
  modify,
  parse,
  parseTree,
  type Node,
} from "jsonc-parser/lib/esm/main.js";

import { CliError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";

export const SERVER_CONFIG_FILE = "syndroo.config.jsonc";
export const SERVER_CONFIG_VERSION = 1;
export const DEFAULT_SERVER_SCOPE = "default";
export const MAX_SERVER_CONFIG_BYTES = 65_536;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCOPE = /^[A-Za-z0-9._:-]{1,128}$/;
const CONNECTION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const APP_ID = /^[0-9]{1,64}$/;
const SECRET_KEY =
  /(?:token|secret|password|passwd|api[_-]?key|credential|private[_-]?key)/i;
const SECRET_VALUE =
  /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/;

export type ServerThreadsConfig = {
  readonly appId?: string;
  readonly connectionId?: string;
};

export type ServerConfig = {
  readonly version: 1;
  readonly projectId: string;
  readonly scope: string;
  readonly publicOrigin?: string;
  readonly threads?: ServerThreadsConfig;
};

export type LoadedServerConfig = {
  readonly projectDirectory: string;
  readonly configFile: string;
  readonly config: ServerConfig;
};

export type ServerConfigUpdate = {
  readonly scope?: string;
  readonly publicOrigin?: string | null;
  readonly threads?: {
    readonly appId?: string | null;
    readonly connectionId?: string | null;
  };
};

function configError(
  code: string,
  nextAction?: string,
): CliError {
  return new CliError(code, {
    code,
    exitCode: EXIT_CODE.USAGE,
    details: nextAction === undefined ? {} : { nextAction },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictString(
  value: unknown,
  pattern: RegExp,
): value is string {
  return typeof value === "string" && pattern.test(value);
}

function canonicalHttpsOrigin(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname === "/" &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

function propertyName(node: Node): string | undefined {
  const key = node.children?.[0];
  return typeof key?.value === "string" ? key.value : undefined;
}

function inspectJsonTree(node: Node, depth = 0): void {
  if (depth > 32) {
    throw configError("SERVER_CONFIG_INVALID");
  }

  if (node.type === "object") {
    const seen = new Set<string>();

    for (const child of node.children ?? []) {
      if (child.type !== "property") {
        throw configError("SERVER_CONFIG_INVALID");
      }

      const key = propertyName(child);
      if (key === undefined) {
        throw configError("SERVER_CONFIG_INVALID");
      }
      if (SECRET_KEY.test(key)) {
        throw configError("SERVER_CONFIG_SECRET_REJECTED");
      }
      if (seen.has(key)) {
        throw configError("SERVER_CONFIG_DUPLICATE_KEY");
      }
      seen.add(key);

      const value = child.children?.[1];
      if (value === undefined) {
        throw configError("SERVER_CONFIG_INVALID");
      }
      inspectJsonTree(value, depth + 1);
    }
    return;
  }

  if (node.type === "array") {
    for (const child of node.children ?? []) {
      inspectJsonTree(child, depth + 1);
    }
    return;
  }

  if (node.type === "string" && SECRET_VALUE.test(node.value)) {
    throw configError("SERVER_CONFIG_SECRET_REJECTED");
  }
}

function validateConfig(value: unknown): ServerConfig {
  if (!isRecord(value)) {
    throw configError("SERVER_CONFIG_INVALID");
  }

  const allowed = new Set(["version", "projectId", "scope", "publicOrigin", "threads"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw configError("SERVER_CONFIG_UNKNOWN_KEY");
    }
  }

  if (value["version"] !== SERVER_CONFIG_VERSION) {
    throw configError("SERVER_CONFIG_VERSION_UNSUPPORTED");
  }
  if (!strictString(value["projectId"], UUID)) {
    throw configError("SERVER_CONFIG_INVALID");
  }
  if (!strictString(value["scope"], SCOPE)) {
    throw configError("SERVER_CONFIG_INVALID");
  }
  if (value["publicOrigin"] !== undefined && !canonicalHttpsOrigin(value["publicOrigin"])) {
    throw configError("SERVER_CONFIG_INVALID");
  }

  let threads: ServerThreadsConfig | undefined;
  if (value["threads"] !== undefined) {
    const raw = value["threads"];
    if (!isRecord(raw)) {
      throw configError("SERVER_CONFIG_INVALID");
    }
    for (const key of Object.keys(raw)) {
      if (key !== "appId" && key !== "connectionId") {
        throw configError("SERVER_CONFIG_UNKNOWN_KEY");
      }
    }
    if (raw["appId"] !== undefined && !strictString(raw["appId"], APP_ID)) {
      throw configError("SERVER_CONFIG_INVALID");
    }
    if (
      raw["connectionId"] !== undefined &&
      !strictString(raw["connectionId"], CONNECTION_ID)
    ) {
      throw configError("SERVER_CONFIG_INVALID");
    }
    threads = {
      ...(raw["appId"] === undefined ? {} : { appId: raw["appId"] as string }),
      ...(raw["connectionId"] === undefined
        ? {}
        : { connectionId: raw["connectionId"] as string }),
    };
  }

  return {
    version: 1,
    projectId: value["projectId"] as string,
    scope: value["scope"] as string,
    ...(value["publicOrigin"] === undefined
      ? {}
      : { publicOrigin: value["publicOrigin"] as string }),
    ...(threads === undefined ? {} : { threads }),
  };
}

export function resolveServerProject(
  cwd: string,
  project?: string,
): string {
  if (
    project !== undefined &&
    (project.length === 0 ||
      project.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(project))
  ) {
    throw new CliError("USAGE", { code: "USAGE", exitCode: EXIT_CODE.USAGE });
  }

  const resolved = path.resolve(cwd, project ?? ".");
  if (resolved === path.parse(resolved).root) {
    throw new CliError("USAGE", { code: "USAGE", exitCode: EXIT_CODE.USAGE });
  }
  return resolved;
}

async function readText(file: string, missingCode: string): Promise<string> {
  let handle;

  try {
    handle = await fs.open(file, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw configError(missingCode, "INITIALIZE_PROJECT");
    }
    throw configError("SERVER_CONFIG_INVALID", "INSPECT_PROJECT_FILES");
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SERVER_CONFIG_BYTES) {
      throw configError("SERVER_CONFIG_INVALID", "INSPECT_PROJECT_FILES");
    }
    const bytes = await handle.readFile();
    if (bytes.length > MAX_SERVER_CONFIG_BYTES) {
      throw configError("SERVER_CONFIG_INVALID", "INSPECT_PROJECT_FILES");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw configError("SERVER_CONFIG_INVALID", "INSPECT_PROJECT_FILES");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseStrictJsonc(text: string): ServerConfig {
  const errors: Parameters<typeof parse>[1] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw configError("SERVER_CONFIG_INVALID", "FIX_SERVER_CONFIG");
  }

  const tree = parseTree(text, [], {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (tree === undefined) {
    throw configError("SERVER_CONFIG_INVALID", "FIX_SERVER_CONFIG");
  }
  inspectJsonTree(tree);

  return validateConfig(parsed);
}

export async function loadServerConfig(
  projectDirectory: string,
): Promise<LoadedServerConfig> {
  const resolvedProject = path.resolve(projectDirectory);
  const configFile = path.join(resolvedProject, SERVER_CONFIG_FILE);
  const text = await readText(configFile, "SERVER_CONFIG_NOT_FOUND");

  return {
    projectDirectory: resolvedProject,
    configFile,
    config: parseStrictJsonc(text),
  };
}

function applyModification(
  text: string,
  location: readonly (string | number)[],
  value: unknown,
): string {
  const edits = modify(text, [...location], value, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol: "\n",
    },
  });
  return applyEdits(text, edits);
}

async function replaceConfigAtomically(file: string, text: string): Promise<void> {
  const directory = path.dirname(file);
  const temporary = path.join(
    directory,
    `.${SERVER_CONFIG_FILE}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;

  try {
    handle = await fs.open(
      temporary,
      FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | FS.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    handle = undefined;

    const existing = await fs.lstat(file).catch(() => undefined);
    if (existing?.isSymbolicLink() === true || existing?.isFile() === false) {
      throw configError("SERVER_CONFIG_INVALID", "INSPECT_PROJECT_FILES");
    }

    await fs.rename(temporary, file);
    const directoryHandle = await fs.open(directory, FS.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof CliError) {
      throw error;
    }
    throw configError("SERVER_CONFIG_WRITE_FAILED", "INSPECT_PROJECT_FILES");
  }
}

export async function updateServerConfig(
  projectDirectory: string,
  update: ServerConfigUpdate,
): Promise<ServerConfig> {
  const loaded = await loadServerConfig(projectDirectory);
  let text = await readText(loaded.configFile, "SERVER_CONFIG_NOT_FOUND");

  if (update.scope !== undefined) {
    text = applyModification(text, ["scope"], update.scope);
  }
  if (update.publicOrigin !== undefined) {
    text = applyModification(
      text,
      ["publicOrigin"],
      update.publicOrigin === null ? undefined : update.publicOrigin,
    );
  }
  if (update.threads?.appId !== undefined) {
    text = applyModification(
      text,
      ["threads", "appId"],
      update.threads.appId === null ? undefined : update.threads.appId,
    );
  }
  if (update.threads?.connectionId !== undefined) {
    text = applyModification(
      text,
      ["threads", "connectionId"],
      update.threads.connectionId === null ? undefined : update.threads.connectionId,
    );
  }

  const next = parseStrictJsonc(text);
  await replaceConfigAtomically(loaded.configFile, text);
  return next;
}
