/**
 * Child process entry for the FIFO credential-file probe.
 *
 * A blocking `open()` regression must not be able to hang the suite, so the
 * probe runs in its own process and the test owns a bounded kill timer. Node's
 * type stripping cannot rewrite this repository's `.js` import specifiers, so
 * this entry registers a synchronous resolve hook that retries them as `.ts`.
 *
 * It prints exactly one line:
 *   `REJECTED <code> <message>` when resolution refuses the file
 *   `RESOLVED <provider>` when it unexpectedly accepts it
 *
 * Both the code and the message are static, non-secret text.
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }

      throw error;
    }
  },
});

const target = process.argv[2] ?? "";

try {
  const credentialsModule = await import("../../src/local/credentials.js");
  const credentials = await credentialsModule.resolveCredentialSource(
    { kind: "file", provider: "bluesky", path: target },
    { env: {} },
  );

  console.log(`RESOLVED ${credentials.provider}`);
} catch (error) {
  const code = (error as { readonly code?: unknown }).code;
  const message = error instanceof Error ? error.message : "NO_MESSAGE";
  console.log(`REJECTED ${typeof code === "string" ? code : "NO_CODE"} ${message}`);
}
