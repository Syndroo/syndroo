import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path of the Skill that ships inside this package.
 *
 * The Skill is authored in the CLI package so the documented workflow and the
 * installed binary cannot drift apart. The directory is added by a later
 * subtask; `skill path` reports the path either way.
 */
export function resolveSkillDirectory(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "skills",
    "syndroo",
  );
}
