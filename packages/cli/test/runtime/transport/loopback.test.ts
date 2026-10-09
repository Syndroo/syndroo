import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createNodeTransport } from "../../../src/runtime/transport/index.js";

let origin: string;
let trapHits = 0;
let received = "";
let closed!: () => void;
const server = createServer((req, res) => {
  if (req.url === "/redirect") {
    res.writeHead(302, { location: origin + "/trap", "set-cookie": "FAKE_COOKIE_CANARY" });
    res.end();
  } else if (req.url === "/trap") {
    trapHits++;
    res.end("redirect followed unexpectedly");
  } else if (req.url === "/oversize") {
    req.socket.once("close", () => closed());
    res.writeHead(200, { "content-length": "1048577" });
    res.flushHeaders(); // Never end: only the client can close this connection.
  } else if (req.url === "/stall") {
    req.socket.once("close", () => closed());
    res.writeHead(200, { "content-length": "100" });
    res.write("x");
  } else {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received = Buffer.concat(chunks).toString("utf8");
      res.setHeader("content-type", "application/json");
      res.setHeader("retry-after", "7");
      res.end('{"accepted":true}');
    });
  }
});

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("expected TCP listener");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function transport(deadlineMs = 1000) {
  return createNodeTransport({ allowedOrigins: [origin], loopbackTestMode: true, deadlineMs });
}

it("uses the real Node connector/parser in explicit loopback HTTP test mode", async () => {
  const result = await transport().request({ url: origin + "/ok", method: "POST", body: "exact 雨\n", signal: new AbortController().signal });
  expect(result).toMatchObject({ type: "response", status: 200, body: '{"accepted":true}', headers: { "retry-after": "7" } });
  expect(received).toBe("exact 雨\n");
});

it("returns a real redirect without following it or exposing its cookie", async () => {
  const result = await transport().request({ url: origin + "/redirect", method: "GET", signal: new AbortController().signal });
  expect(result).toMatchObject({ type: "response", status: 302 });
  expect(JSON.stringify(result)).not.toContain("FAKE_COOKIE_CANARY");
  expect(trapHits).toBe(0);
});

it("rejects a real content-write redirect without following it", async () => {
  const result = await transport().request({
    url: origin + "/redirect", method: "POST", body: "write",
    signal: new AbortController().signal,
  });
  expect(result).toEqual({ type: "transport_error", stage: "possibly_sent", code: "INVALID_RESPONSE" });
  expect(trapHits).toBe(0);
});

it("does not enable loopback HTTP through the origin allowlist alone", async () => {
  const result = await createNodeTransport({ allowedOrigins: [origin] }).request({ url: origin, method: "GET", signal: new AbortController().signal });
  expect(result).toMatchObject({ type: "transport_error", stage: "before_request" });
});

it("destroys a real socket on an oversized declared response before body reading", async () => {
  const shutdown = new Promise<void>(resolve => { closed = resolve; });
  const result = await transport().request({ url: origin + "/oversize", method: "GET", signal: new AbortController().signal });
  expect(result).toEqual({ type: "transport_error", stage: "possibly_sent", code: "RESPONSE_TOO_LARGE" });
  await shutdown;
});

it("overall deadline destroys a real socket with an incomplete body", async () => {
  const shutdown = new Promise<void>(resolve => { closed = resolve; });
  const result = await transport(50).request({ url: origin + "/stall", method: "GET", signal: new AbortController().signal });
  expect(result).toEqual({ type: "transport_error", stage: "possibly_sent", code: "DEADLINE_EXCEEDED" });
  await shutdown;
});
