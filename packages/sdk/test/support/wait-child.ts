/**
 * Child-process fixture for `wait()`.
 *
 * This runs in a real Node process, bundled and spawned by `wait-process.test.ts`;
 * the test runner never imports it. It exists because an injected sleep cannot
 * prove that a real process stays alive between polls: a sleep timer that is
 * unreferenced lets Node exit (code 13) with the wait still pending.
 *
 * The script polls once, lets the default 250 ms sleep elapse for real, polls
 * again and prints `WAIT_DONE`. Any early exit fails the parent test.
 *
 * It first awaits the exported `defaultSleep` on its own. At that point no
 * other timer exists, so an unreferenced sleep timer makes Node exit (13)
 * immediately - a sharper check than the wait, which also arms its own deadline
 * timer.
 */

import { Syndroo, defaultSleep } from "../../src/index.js";

await defaultSleep(50);
console.log("SLEEP_DONE");

const ACCOUNT = { provider: "bluesky", accountId: "did:plc:fake", origin: "https://bsky.social" };

function operationEnvelope(operation: unknown): Record<string, unknown> {
  return { protocolVersion: 1, operation: "status", ok: true, result: { type: "operation", operation }, error: null };
}

const PENDING = operationEnvelope({
  phase: "execution",
  operationId: "op_1",
  status: "pending",
  deliveries: [],
});

const SUCCEEDED = operationEnvelope({
  phase: "execution",
  operationId: "op_1",
  status: "succeeded",
  deliveries: [
    {
      deliveryId: "delivery_1",
      connectionId: "conn_1",
      account: ACCOUNT,
      attempts: 1,
      outcome: { status: "succeeded", remoteId: "at://fake", url: "https://bsky.app/fake" },
    },
  ],
});

function respond(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let calls = 0;
const fetchImpl = async (): Promise<Response> => {
  calls += 1;
  return calls === 1 ? respond(PENDING) : respond(SUCCEEDED);
};

const syndroo = new Syndroo({ baseUrl: "https://syndroo.example", apiKey: "child-test-key", fetch: fetchImpl });
const round = await syndroo.wait("op_1", { intervalMs: 250, timeoutMs: 5000 });

if (round.status !== "succeeded") {
  console.error(`unexpected round status: ${round.status}`);
  process.exit(3);
}
console.log(`WAIT_DONE calls=${calls}`);
