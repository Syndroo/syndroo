import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Syndroo } from "@syndroo/sdk";
import {
  PUBLISH_USAGE,
  ThreadsCiError,
  parseCanonicalHttpsOrigin,
  parsePublishArguments,
  parseThreadsPostBytes,
  runThreadsPublish,
  safeCliError,
} from "./lib/threads-ci.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new ThreadsCiError("INVALID_CONFIGURATION", `${name} is missing.`);
  }
  return value;
}

async function main(args: readonly string[]): Promise<number> {
  try {
    const parsed = parsePublishArguments(args);
    if (parsed.help) {
      console.log(PUBLISH_USAGE);
      return 0;
    }

    const syndrooUrl = parseCanonicalHttpsOrigin(requiredEnvironment("SYNDROO_URL"));
    const token = requiredEnvironment("SYNDROO_TOKEN");
    const connectionId = requiredEnvironment("SYNDROO_CONNECTION_ID");
    const inputPath = resolve(parsed.input ?? "");
    let postBytes: Uint8Array;
    try {
      postBytes = await readFile(inputPath);
    } catch {
      throw new ThreadsCiError("INVALID_POST", "The post file could not be read.");
    }
    const text = parseThreadsPostBytes(postBytes);
    const client = new Syndroo({
      baseUrl: syndrooUrl,
      apiKey: token,
    });
    const result = await runThreadsPublish({
      client,
      connectionId,
      requestId: parsed.requestId ?? "",
      text,
      yes: parsed.yes,
      waitTimeoutMs: parsed.waitTimeoutMs,
      pollIntervalMs: parsed.pollIntervalMs,
    });
    console.log(JSON.stringify(result));
    return result.exitCode;
  } catch (error) {
    const failure = safeCliError(error);
    console.error(JSON.stringify(failure.body));
    return failure.exitCode;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  process.exitCode = await main(process.argv.slice(2));
}
