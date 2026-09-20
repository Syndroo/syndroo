import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * The published version. Read from the package manifest at runtime so the
 * version reported by `syndroo version` cannot drift from the tarball.
 */
export function cliVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { version?: unknown };

    if (typeof manifest.version === "string" && manifest.version.length > 0) {
      return manifest.version;
    }
  } catch {
    // A missing or unreadable manifest is not worth failing a command over.
  }

  return "0.0.0-unknown";
}
