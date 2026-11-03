import { randomBytes } from "node:crypto";
import { constants as FS, promises as fs } from "node:fs";
import path from "node:path";

import { CliError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import { cliVersion } from "../version.js";

export const SERVER_DEPENDENCY_VERSIONS = {
  cli: cliVersion(),
  cloudflare: cliVersion(),
  wrangler: "4.132.0",
} as const;

export const SERVER_CONFIG_FILE_NAME = "syndroo.config.jsonc";

export const GENERATED_FILES = [
  ".gitignore",
  "package.json",
  "package-lock.json",
  SERVER_CONFIG_FILE_NAME,
  "wrangler.jsonc",
  "posts/hello.json",
] as const;

export const GENERATED_MARKER = {
  generated: true,
  server: 1,
} as const;

export const MAX_PROJECT_FILE_BYTES = 1_048_576;

function projectError(code: string, nextAction: string): CliError {
  return new CliError(code, {
    code,
    exitCode: EXIT_CODE.USAGE,
    details: { nextAction },
  });
}

export async function readProjectFile(
  file: string,
): Promise<Buffer | null> {
  let handle;

  try {
    handle = await fs.open(file, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw projectError("SERVER_PROJECT_UNREADABLE", "INSPECT_PROJECT_FILES");
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_PROJECT_FILE_BYTES) {
      throw projectError("SERVER_PROJECT_UNREADABLE", "INSPECT_PROJECT_FILES");
    }
    const bytes = await handle.readFile();
    if (bytes.length > MAX_PROJECT_FILE_BYTES) {
      throw projectError("SERVER_PROJECT_UNREADABLE", "INSPECT_PROJECT_FILES");
    }
    return bytes;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readProjectText(file: string): Promise<string | null> {
  const bytes = await readProjectFile(file);
  if (bytes === null) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw projectError("SERVER_PROJECT_UNREADABLE", "INSPECT_PROJECT_FILES");
  }
}

export async function ensureProjectDirectory(directory: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw projectError("SERVER_PROJECT_UNREADABLE", "INSPECT_PROJECT_FILES");
    }
    await fs.mkdir(directory, { mode: 0o700 });
    stat = await fs.lstat(directory);
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw projectError("SERVER_PROJECT_CONFLICT", "CHOOSE_EMPTY_DIRECTORY");
  }
}

export async function writeNewProjectFile(
  projectDirectory: string,
  relative: string,
  text: string,
): Promise<void> {
  if (
    relative.startsWith("/") ||
    relative.split("/").includes("..") ||
    path.isAbsolute(relative)
  ) {
    throw projectError("SERVER_PROJECT_WRITE_FAILED", "INSPECT_PROJECT_FILES");
  }
  const target = path.join(projectDirectory, relative);
  const directory = path.dirname(target);
  const directoryStat = await fs.lstat(directory).catch(() => undefined);
  if (
    directoryStat === undefined ||
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory()
  ) {
    throw projectError("SERVER_PROJECT_WRITE_FAILED", "INSPECT_PROJECT_FILES");
  }
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${randomBytes(8).toString("hex")}.tmp`,
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
    await fs.rename(temporary, target);
    const directory = await fs.open(path.dirname(target), FS.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw projectError("SERVER_PROJECT_WRITE_FAILED", "INSPECT_PROJECT_FILES");
  }
}
