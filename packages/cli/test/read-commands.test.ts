import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";

import { CLI_BIN, parseJsonObject, runCli } from "./support/harness.js";
import {
  json,
  startFixtureServer,
  type FixtureServer,
} from "./support/loopback.js";

const servers: FixtureServer[] = [];
const SENTINEL = "sentinel-api-key-0123456789abcdef";

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
});

async function server(
  handler: Parameters<typeof startFixtureServer>[0],
): Promise<FixtureServer> {
  const fixture = await startFixtureServer(handler);
  servers.push(fixture);
  return fixture;
}

function post(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "post_1",
    content: "hello",
    platforms: ["bluesky"],
    status: "published",
    createdAt: "2026-09-20T00:00:00.000Z",
    publications: [
      {
        id: "pub_1",
        postId: "post_1",
        platform: "bluesky",
        provider: "bluesky",
        content: "hello",
        status: "published",
        attempts: 1,
        errorAmbiguous: false,
      },
    ],
    ...overrides,
  };
}

describe("doctor", () => {
  it("fails as a usage problem when nothing is configured", async () => {
    const fixture = await server((_request, response) => {
      json(response, 200, { status: "ok" });
    });
    const result = await runCli(["doctor", "--json"], { env: {} });

    expect(result.code).toBe(2);
    const payload = parseJsonObject(result.stdout);

    expect(payload["ok"]).toBe(false);
    expect(fixture.requestCount()).toBe(0);
  });

  it("checks reachability and credentials without writing or printing the key", async () => {
    const fixture = await server((request, response) => {
      if (request.url === "/health") {
        json(response, 200, { status: "ok" });
        return;
      }

      expect(request.headers["authorization"]).toBe(`Bearer ${SENTINEL}`);
      json(response, 200, { items: [] });
    });
    const result = await runCli(["doctor", "--json"], {
      env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: SENTINEL },
    });

    expect(result.code).toBe(0);
    const payload = parseJsonObject(result.stdout);

    expect(payload["ok"]).toBe(true);
    expect(payload["createRequests"]).toBe(0);
    expect((payload["health"] as Record<string, unknown>)["reachable"]).toBe(true);
    expect((payload["credentials"] as Record<string, unknown>)["ok"]).toBe(true);
    expect(fixture.requestCount()).toBe(2);
    expect(fixture.requests.map(request => request.method)).toEqual(["GET", "GET"]);
    expect(result.stdout).not.toContain(SENTINEL);
    expect(result.stderr).not.toContain(SENTINEL);
    expect(result.stdout).not.toContain("apiKey:");
  });

  it("fails when the instance rejects the API key, and still hides the key", async () => {
    const fixture = await server((request, response) => {
      if (request.url === "/health") {
        json(response, 200, { status: "ok" });
        return;
      }

      json(response, 401, { code: "UNAUTHORIZED", message: "missing or invalid API key" });
    });
    const result = await runCli(["doctor", "--json"], {
      env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: SENTINEL },
    });
    const payload = parseJsonObject(result.stdout);

    expect(result.code).toBe(1);
    expect(payload["ok"]).toBe(false);
    expect(String((payload["error"] as Record<string, unknown>)["code"])).toBe("AUTH_REJECTED");
    expect(result.stdout).not.toContain(SENTINEL);
    expect(result.stderr).not.toContain(SENTINEL);
  });

  it("fails when the instance is unreachable", async () => {
    const fixture = await server((_request, response) => {
      json(response, 200, { status: "ok" });
    });
    const url = fixture.url;
    await fixture.close();
    servers.length = 0;

    const result = await runCli(["doctor", "--json"], {
      env: { SYNDROO_BASE_URL: url, SYNDROO_API_KEY: SENTINEL },
    });

    expect(result.code).toBe(1);
    expect(parseJsonObject(result.stdout)["ok"]).toBe(false);
  });
});

describe("posts validate", () => {
  it("validates a document from stdin without contacting any instance", async () => {
    const fixture = await server((_request, response) => {
      json(response, 200, { items: [] });
    });
    const result = await runCli(["posts", "validate", "--json"], {
      env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: SENTINEL },
      stdin: JSON.stringify({ content: "from stdin", platforms: ["bluesky"] }),
    });
    const payload = parseJsonObject(result.stdout);

    expect(result.code).toBe(0);
    expect(payload["valid"]).toBe(true);
    expect(payload["createRequests"]).toBe(0);
    expect(result.stderr).toContain("Syndroo post preview");
    expect(fixture.requestCount()).toBe(0);
  });

  it("reports an invalid document as exit 2 with every issue", async () => {
    const result = await runCli(["posts", "validate", "--json"], {
      env: {},
      stdin: JSON.stringify({ content: "ok", platforms: ["myspace"] }),
    });
    const payload = parseJsonObject(result.stdout);

    expect(result.code).toBe(2);
    expect(payload["valid"]).toBe(false);
    expect((payload["issues"] as unknown[]).length).toBe(1);
  });
});

describe("posts list", () => {
  it("returns one JSON object and never writes", async () => {
    const fixture = await server((_request, response) => {
      json(response, 200, { items: [post()] });
    });
    const result = await runCli(["posts", "list", "--json"], {
      env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: SENTINEL },
    });
    const payload = parseJsonObject(result.stdout);

    expect(result.code).toBe(0);
    expect(payload["count"]).toBe(1);
    expect(payload["createRequests"]).toBe(0);
    expect(fixture.createCount()).toBe(0);
  });

  it("rejects an out-of-range limit before contacting the instance", async () => {
    const fixture = await server((_request, response) => {
      json(response, 200, { items: [] });
    });
    const result = await runCli(["posts", "list", "--limit", "1000"], {
      env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: SENTINEL },
    });

    expect(result.code).toBe(2);
    expect(fixture.requestCount()).toBe(0);
  });
});

describe("posts get", () => {
  it("reports delivery without inventing it", async () => {
    const fixture = await server((_request, response) => {
      json(response, 200, post());
    });
    const result = await runCli(["posts", "get", "post_1", "--json"], {
      env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: SENTINEL },
    });
    const payload = parseJsonObject(result.stdout);

    expect(result.code).toBe(0);
    expect(payload["delivered"]).toBe(true);
    expect(fixture.createCount()).toBe(0);
  });

  it("does not call a queued post delivered", async () => {
    const fixture = await server((_request, response) => {
      json(response, 200, post({ status: "queued", publications: [] }));
    });
    const result = await runCli(["posts", "get", "post_1", "--json"], {
      env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: SENTINEL },
    });

    expect(result.code).toBe(0);
    expect(parseJsonObject(result.stdout)["delivered"]).toBe(false);
  });
});

describe("posts wait", () => {
  it("exits 0 only for a published post", async () => {
    const fixture = await server((_request, response) => {
      json(response, 200, post());
    });
    const result = await runCli(["posts", "wait", "post_1", "--timeout", "5s", "--json"], {
      env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: SENTINEL },
    });

    expect(result.code).toBe(0);
    expect(parseJsonObject(result.stdout)["delivered"]).toBe(true);
    expect(fixture.createCount()).toBe(0);
  });

  it("exits 6 for a partial post", async () => {
    const fixture = await server((_request, response) => {
      json(
        response,
        200,
        post({
          status: "partial",
          publications: [
            {
              id: "pub_1",
              postId: "post_1",
              platform: "bluesky",
              provider: "bluesky",
              content: "hello",
              status: "published",
              attempts: 1,
            },
            {
              id: "pub_2",
              postId: "post_1",
              platform: "threads",
              provider: "threads",
              content: "hello",
              status: "failed",
              attempts: 2,
              errorCode: "PROVIDER_UNAVAILABLE",
            },
          ],
        }),
      );
    });
    const result = await runCli(["posts", "wait", "post_1", "--timeout", "5s", "--json"], {
      env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: SENTINEL },
    });

    expect(result.code).toBe(6);
    expect(parseJsonObject(result.stdout)["delivered"]).toBe(false);
  });

  it("exits 4 when a terminal post has an ambiguous publication", async () => {
    const fixture = await server((_request, response) => {
      json(
        response,
        200,
        post({
          status: "failed",
          publications: [
            {
              id: "pub_1",
              postId: "post_1",
              platform: "bluesky",
              provider: "bluesky",
              content: "hello",
              status: "failed",
              attempts: 1,
              errorAmbiguous: true,
            },
          ],
        }),
      );
    });
    const result = await runCli(["posts", "wait", "post_1", "--timeout", "5s", "--json"], {
      env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: SENTINEL },
    });

    expect(result.code).toBe(4);
    expect(parseJsonObject(result.stdout)["ambiguous"]).toBe(true);
  });

  it("exits 3 on timeout and never resends", async () => {
    const fixture = await server((_request, response) => {
      json(response, 200, post({ status: "publishing", publications: [] }));
    });
    const result = await runCli(["posts", "wait", "post_1", "--timeout", "700ms", "--json"], {
      env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: SENTINEL },
    });
    const payload = parseJsonObject(result.stdout);

    expect(result.code).toBe(3);
    expect(payload["timedOut"]).toBe(true);
    expect(payload["lastStatus"]).toBe("publishing");
    expect(payload["createRequests"]).toBe(0);
    expect(fixture.createCount()).toBe(0);
    expect(fixture.requests.every(request => request.method === "GET")).toBe(true);
  });

  it("stops cleanly on SIGINT without cancelling server-side work", async () => {
    const fixture = await server((_request, response) => {
      json(response, 200, post({ status: "publishing", publications: [] }));
    });
    const child = spawn(
      process.execPath,
      [CLI_BIN, "posts", "wait", "post_1", "--timeout", "30s", "--json"],
      {
        env: {
          ...process.env,
          SYNDROO_BASE_URL: fixture.url,
          SYNDROO_API_KEY: SENTINEL,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
    });

    // Let the wait reach the polling loop before interrupting it.
    await new Promise(resolve => setTimeout(resolve, 400));
    child.kill("SIGINT");

    const code = await new Promise<number>(resolve => {
      child.on("close", status => resolve(status ?? -1));
    });

    expect(code).toBe(130);
    expect(stderr).toContain("Stopped locally");
    expect(fixture.createCount()).toBe(0);
    expect(fixture.requests.every(request => request.method === "GET")).toBe(true);

    // `--json` still gets exactly one JSON object, and it reports no delivery.
    const payload = parseJsonObject(stdout);
    expect(payload["ok"]).toBe(false);
    expect(payload["exitCode"]).toBe(130);
  });
});

describe("skill path", () => {
  it("prints the bundled Skill directory and reports whether it exists yet", async () => {
    const result = await runCli(["skill", "path", "--json"], { env: {} });
    const payload = parseJsonObject(result.stdout);

    expect(String(payload["path"])).toMatch(
      /packages[\\/]cli[\\/]skills[\\/]syndroo$/u,
    );
    expect(typeof payload["exists"]).toBe("boolean");
    expect(result.code).toBe(payload["exists"] === true ? 0 : 1);
  });
});

describe("help and version", () => {
  it("prints help without touching the network", async () => {
    const result = await runCli(["help"], { env: {} });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("posts create");
    expect(result.stdout).toContain("Exit codes");
  });

  it("prints a command's help with --help", async () => {
    const result = await runCli(["posts", "create", "--help"], { env: {} });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--idempotency-key");
  });

  it("prints the version as JSON", async () => {
    const result = await runCli(["version", "--json"], { env: {} });
    const payload = parseJsonObject(result.stdout);

    expect(result.code).toBe(0);
    expect(payload["name"]).toBe("@syndroo/cli");
    expect(payload["version"]).toBe("0.4.0-rc.1");
  });
});
