/**
 * Instrumentation self-check.
 *
 * Runs under the same preload as the CLI children and proves the harness is not
 * vacuously green: a `fetch` request and a production-style `node:https` request
 * with a pinned lookup both reach the real loopback TLS fixture, over real TLS,
 * with the original hostname preserved.
 *
 * It is test-only and never part of the tarball.
 */

import { lookup } from "node:dns/promises";
import { request } from "node:https";

if (process.env["SYNDROO_L1_PROBE_DENY"] === "1") {
  // Negative control: the instrumentation must reject a disallowed destination
  // and record it, so a "zero events" result is meaningful.
  let rejected = false;

  try {
    await fetch("https://evil.example/");
  } catch {
    rejected = true;
  }

  if (!rejected) {
    throw new Error("L1 probe: a disallowed fetch was not rejected");
  }

  process.stdout.write("L1 deny probe ok\n");
  process.exit(0);
}

const fetchResponse = await fetch("https://dev.to/api/users/me", {
  headers: { "api-key": "l1-probe-key", accept: "application/vnd.forem.api-v1+json" },
});
const fetchBody = (await fetchResponse.json()) as { id?: unknown };

if (fetchResponse.status !== 200 || fetchBody.id !== 1234567) {
  throw new Error("L1 probe: fetch path did not reach the fixture");
}

const resolved = await lookup("mastodon.test", { all: true, verbatim: true });

if (resolved.length !== 1 || resolved[0]?.address !== "93.184.216.34") {
  throw new Error("L1 probe: DNS shim did not return the synthetic public address");
}

const pinned = (
  _hostname: string,
  options: unknown,
  callback: (...args: unknown[]) => void,
): void => {
  const wantsAll =
    typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;

  if (wantsAll) {
    callback(null, [{ address: resolved[0]!.address, family: 4 }]);
  } else {
    callback(null, resolved[0]!.address, 4);
  }
};

const status = await new Promise<number | undefined>((resolve, reject) => {
  const probe = request(
    {
      hostname: "mastodon.test",
      port: 443,
      path: "/api/v2/instance",
      method: "GET",
      servername: "mastodon.test",
      lookup: pinned as never,
    },
    response => {
      response.resume();
      resolve(response.statusCode);
    },
  );

  probe.on("error", reject);
  probe.end();
});

if (status !== 200) {
  throw new Error("L1 probe: https path did not reach the fixture");
}

process.stdout.write("L1 probe ok\n");
