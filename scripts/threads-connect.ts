import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Syndroo } from "@syndroo/sdk";
import {
  BOOTSTRAP_USAGE,
  ThreadsCiError,
  parseBootstrapArguments,
  parseCanonicalHttpsOrigin,
  runThreadsBootstrap,
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
    const parsed = parseBootstrapArguments(args);
    if (parsed.help) {
      console.log(BOOTSTRAP_USAGE);
      return 0;
    }

    const syndrooUrl = parseCanonicalHttpsOrigin(requiredEnvironment("SYNDROO_URL"));
    const adminToken = requiredEnvironment("SYNDROO_ADMIN_TOKEN");
    const appId = requiredEnvironment("THREADS_APP_ID");
    const appSecret = requiredEnvironment("THREADS_APP_SECRET");
    const client = new Syndroo({
      baseUrl: syndrooUrl,
      apiKey: adminToken,
    });
    const result = await runThreadsBootstrap({
      client,
      syndrooUrl,
      appId,
      appSecret,
      timeoutMs: parsed.timeoutMs,
      intervalMs: parsed.intervalMs,
      ...(parsed.requestId === undefined ? {} : { requestId: parsed.requestId }),
      onAuthorization: ({ url, expiresAt, callbackUrl }) => {
        console.error(`Open this Threads authorization URL in a browser:\n${url}`);
        console.error(`The authorization expires at ${expiresAt}.`);
        console.error(`The registered callback must be exactly ${callbackUrl}.`);
        console.error("After approving, return to this process while it waits for the verified callback.");
      },
    });
    console.log(JSON.stringify(result));
    return 0;
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
