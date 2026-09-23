/**
 * Fail-closed egress canary.
 *
 * Runs inside workerd under the main project's real miniflare options and
 * installs no global fetch mock, so these assertions exercise the configured
 * outbound handler itself. A rejected outbound request only proves the fixture
 * behaviour; it does not prove live provider compatibility.
 *
 * The expected message is an independent literal: this file imports no host
 * tooling (`node:path`, `@cloudflare/vitest-plugin`) into workerd, and the
 * assertion cannot pass by reading the handler's own constant.
 */
import { expect, it } from "vitest";

const EXPECTED_REJECTION = "outbound network access is disabled in Worker tests";

const SENTINEL_PATH = "canary-v050-sentinel-path";
const SENTINEL_TOKEN = "canary-v050-sentinel-token";
const SENTINEL_BODY = "canary-v050-sentinel-body";

it("rejects an outbound GET with the fixed message", async () => {
  const response = await fetch(
    `https://egress-canary.invalid/${SENTINEL_PATH}?token=${SENTINEL_TOKEN}`,
  );

  expect(response.status).toBe(500);
  await expect(response.text()).resolves.toBe(EXPECTED_REJECTION);
});

it("does not echo the request line, headers or body", async () => {
  const response = await fetch("https://egress-canary.invalid/upload", {
    method: "POST",
    headers: {
      authorization: `Bearer ${SENTINEL_TOKEN}`,
      "content-type": "text/plain",
      "x-canary-sentinel": SENTINEL_PATH,
    },
    body: SENTINEL_BODY,
  });

  const body = await response.text();

  expect(response.status).toBe(500);
  expect(body).toBe(EXPECTED_REJECTION);
  expect(body).not.toContain(SENTINEL_PATH);
  expect(body).not.toContain(SENTINEL_TOKEN);
  expect(body).not.toContain(SENTINEL_BODY);
  expect(body).not.toContain("egress-canary.invalid");
});

it("rejects the Cloudflare metadata endpoint as well", async () => {
  const response = await fetch(
    "https://cloudflare.com/cdn-cgi/trace?canary-v050-sentinel=1",
  );

  expect(response.status).toBe(500);
  await expect(response.text()).resolves.toBe(EXPECTED_REJECTION);
});
