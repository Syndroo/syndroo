import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../src/document.js";
import { parseJsonObject, runCli } from "./support/harness.js";
import {
  json,
  startFixtureServer,
  type FixtureServer,
} from "./support/loopback.js";

const servers: FixtureServer[] = [];

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

function receipt(options: { id?: string; status?: string; replayed?: boolean } = {}) {
  return {
    id: options.id ?? "post_00000000-0000-4000-8000-000000000001",
    status: options.status ?? "queued",
    ...(options.replayed === undefined ? {} : { replayed: options.replayed }),
  };
}

function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(path.join(tmpdir(), "syndroo-cli-"));

  return run(directory).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

function writePost(directory: string, document: unknown, name = "post.json"): string {
  const file = path.join(directory, name);
  writeFileSync(file, JSON.stringify(document));
  return file;
}

const DOCUMENT = {
  content: "We just shipped a new release.",
  platforms: ["bluesky", "threads"],
};

describe("posts create without a terminal", () => {
  it("refuses to run without --yes and never sends anything", async () => {
    await withTempDir(async directory => {
      const fixture = await server((_request, response) => {
        json(response, 202, receipt());
      });
      const file = writePost(directory, DOCUMENT);
      const result = await runCli(["posts", "create", "--file", file], {
        env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: "k".repeat(24) },
      });

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--yes");
      expect(fixture.requestCount()).toBe(0);
    });
  });

  it("refuses --yes without an idempotency key", async () => {
    await withTempDir(async directory => {
      const fixture = await server((_request, response) => {
        json(response, 202, receipt());
      });
      const file = writePost(directory, DOCUMENT);
      const result = await runCli(["posts", "create", "--file", file, "--yes"], {
        env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: "k".repeat(24) },
      });

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--idempotency-key");
      expect(fixture.requestCount()).toBe(0);
    });
  });

  it("submits exactly one request with a complete invocation", async () => {
    await withTempDir(async directory => {
      const fixture = await server((_request, response) => {
        json(response, 202, receipt());
      });
      const file = writePost(directory, DOCUMENT);
      const result = await runCli(
        [
          "posts",
          "create",
          "--file",
          file,
          "--yes",
          "--idempotency-key",
          "release-announcement-001",
          "--json",
        ],
        { env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: "k".repeat(24) } },
      );

      expect(result.code).toBe(0);
      expect(fixture.createCount()).toBe(1);
      expect(fixture.requestCount()).toBe(1);

      const request = fixture.requests[0];
      expect(request?.method).toBe("POST");
      expect(request?.url).toBe("/v1/posts");
      expect(request?.headers["idempotency-key"]).toBe("release-announcement-001");
      expect(request?.headers["authorization"]).toBe(`Bearer ${"k".repeat(24)}`);

      const payload = parseJsonObject(result.stdout);
      expect(payload["ok"]).toBe(true);
      expect(payload["accepted"]).toBe(true);
      expect(payload["delivered"]).toBe(false);
      expect(payload["createRequests"]).toBe(1);
      expect(payload["exitCode"]).toBe(0);
      expect(payload["requestSha256"]).toBe(sha256(request?.body as string));

      // The preview is a diagnostic, so it belongs on stderr.
      expect(result.stderr).toContain("Syndroo post preview");
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
    });
  });

  it("reports a missing document as a usage problem without a request", async () => {
    const fixture = await server((_request, response) => {
      json(response, 202, receipt());
    });
    const result = await runCli(["posts", "create", "--file", "/nope.json"], {
      env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: "k".repeat(24) },
    });

    // A missing document is a usage problem, and it is caught before any prompt.
    expect(result.code).toBe(2);
    expect(fixture.requestCount()).toBe(0);
  });

  it("sends the same body from a file and from stdin", async () => {
    await withTempDir(async directory => {
      const fixture = await server((_request, response) => {
        json(response, 202, receipt());
      });
      const file = writePost(directory, DOCUMENT);
      const env = { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: "k".repeat(24) };

      const fromFile = await runCli(
        ["posts", "create", "--file", file, "--yes", "--idempotency-key", "same-key", "--json"],
        { env },
      );
      const fromStdin = await runCli(
        ["posts", "create", "--yes", "--idempotency-key", "same-key", "--json"],
        { env, stdin: JSON.stringify(DOCUMENT) },
      );

      expect(fromFile.code).toBe(0);
      expect(fromStdin.code).toBe(0);
      expect(fixture.createCount()).toBe(2);
      expect(fixture.requests[0]?.body).toBe(fixture.requests[1]?.body);
      expect(parseJsonObject(fromFile.stdout)["requestSha256"]).toBe(
        parseJsonObject(fromStdin.stdout)["requestSha256"],
      );
    });
  });

  it("never sends post content through a shell", async () => {
    await withTempDir(async directory => {
      const fixture = await server((_request, response) => {
        json(response, 202, receipt());
      });
      const content =
        'quotes " and \'single\' and `backticks` and $(touch /tmp/syndroo-should-not-exist) and spaces   and \u4e2d\u6587 \u{1f600}';
      const file = writePost(directory, { content, platforms: ["bluesky"] });
      const before = readdirSync(directory).sort();
      const result = await runCli(
        ["posts", "create", "--file", file, "--yes", "--idempotency-key", "inject-1", "--json"],
        { env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: "k".repeat(24) }, cwd: directory },
      );

      expect(result.code).toBe(0);
      expect(fixture.createCount()).toBe(1);
      expect(JSON.parse(fixture.requests[0]?.body as string)).toEqual({
        content,
        platforms: ["bluesky"],
      });
      expect(readdirSync(directory).sort()).toEqual(before);
    });
  });

  it("reports an ambiguous create as exit 4 and reuses the same key on a resume", async () => {
    await withTempDir(async directory => {
      const file = writePost(directory, DOCUMENT);
      let attempt = 0;
      const fixture = await server((request, response) => {
        attempt += 1;

        if (attempt === 1) {
          // The instance received the request and died before answering.
          response.socket?.destroy();
          return;
        }

        json(response, 202, receipt({ replayed: true }));
      });
      const env = { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: "k".repeat(24) };
      const args = [
        "posts",
        "create",
        "--file",
        file,
        "--yes",
        "--idempotency-key",
        "ambiguous-1",
        "--json",
      ];
      const first = await runCli(args, { env });

      expect(first.code).toBe(4);
      const payload = parseJsonObject(first.stdout);
      expect(payload["ambiguous"]).toBe(true);
      expect(payload["idempotencyKey"]).toBe("ambiguous-1");
      expect(String((payload["error"] as Record<string, unknown>)["code"])).toBe(
        "AMBIGUOUS_DELIVERY",
      );

      const second = await runCli(args, { env });

      expect(second.code).toBe(0);
      expect(fixture.createCount()).toBe(2);
      expect(fixture.requests.map(request => request.headers["idempotency-key"])).toEqual([
        "ambiguous-1",
        "ambiguous-1",
      ]);
      expect(parseJsonObject(second.stdout)["replayed"]).toBe(true);
    });
  });

  it("reports a rejected create as exit 1 without leaking the key", async () => {
    await withTempDir(async directory => {
      const sentinel = "sentinel-key-do-not-print-0123456789";
      const fixture = await server((_request, response) => {
        json(response, 401, { code: "UNAUTHORIZED", message: "missing or invalid API key" });
      });
      const file = writePost(directory, DOCUMENT);
      const result = await runCli(
        ["posts", "create", "--file", file, "--yes", "--idempotency-key", "denied-1", "--json"],
        { env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: sentinel } },
      );

      expect(result.code).toBe(1);
      expect(fixture.createCount()).toBe(1);
      expect(result.stdout).not.toContain(sentinel);
      expect(result.stderr).not.toContain(sentinel);
      expect(parseJsonObject(result.stdout)["ok"]).toBe(false);
    });
  });

  it("validates and previews with --dry-run without sending anything", async () => {
    await withTempDir(async directory => {
      const fixture = await server((_request, response) => {
        json(response, 202, receipt());
      });
      const file = writePost(directory, DOCUMENT);
      const result = await runCli(
        ["posts", "create", "--file", file, "--dry-run", "--json"],
        { env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: "k".repeat(24) } },
      );

      expect(result.code).toBe(0);
      expect(fixture.requestCount()).toBe(0);
      expect(parseJsonObject(result.stdout)["dryRun"]).toBe(true);
    });
  });

  it("rejects an invalid document as exit 2 with every issue listed", async () => {
    await withTempDir(async directory => {
      const fixture = await server((_request, response) => {
        json(response, 202, receipt());
      });
      const file = writePost(directory, { content: "", platforms: [] });
      const result = await runCli(
        ["posts", "create", "--file", file, "--yes", "--idempotency-key", "bad-1", "--json"],
        { env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: "k".repeat(24) } },
      );
      const payload = parseJsonObject(result.stdout);

      expect(result.code).toBe(2);
      expect(fixture.requestCount()).toBe(0);
      expect(payload["valid"]).toBe(false);
      expect((payload["issues"] as unknown[]).length).toBe(2);
    });
  });

  it("does not re-read a source file between preview and send", async () => {
    await withTempDir(async directory => {
      const fixture = await server((_request, response) => {
        json(response, 202, receipt());
      });
      const file = writePost(directory, DOCUMENT);
      // Touch the file after the CLI started reading it: the request must still
      // carry the bytes that were previewed.
      utimesSync(file, new Date(), new Date());
      const result = await runCli(
        ["posts", "create", "--file", file, "--yes", "--idempotency-key", "frozen-1", "--json"],
        { env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: "k".repeat(24) } },
      );

      expect(result.code).toBe(0);
      expect(parseJsonObject(result.stdout)["requestSha256"]).toBe(
        sha256(fixture.requests[0]?.body as string),
      );
    });
  });
});
