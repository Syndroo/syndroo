import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../src/document.js";
import { parseJsonObject, runCliPty } from "./support/harness.js";
import {
  json,
  startFixtureServer,
  type FixtureServer,
} from "./support/loopback.js";

const servers: FixtureServer[] = [];

const PROMPT = "Create this post? [y/N]";

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

function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(path.join(tmpdir(), "syndroo-tty-"));

  return run(directory).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

const CONTENT_BEFORE = "Content approved in the preview.";
const CONTENT_AFTER = "Content written after the preview was approved.";

describe("posts create on a terminal", () => {
  it("sends nothing when the operator declines the preview", async () => {
    await withTempDir(async directory => {
      const fixture = await server((_request, response) => {
        json(response, 202, { id: "post_should_not_exist", status: "queued" });
      });
      const file = path.join(directory, "post.json");
      writeFileSync(file, JSON.stringify({ content: CONTENT_BEFORE, platforms: ["bluesky"] }));

      const result = await runCliPty(["posts", "create", "--file", file, "--json"], {
        env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: "k".repeat(24) },
        cwd: directory,
        trigger: PROMPT,
        answer: "n\n",
      });
      const payload = parseJsonObject(lastJsonObject(result.output));

      expect(result.code).toBe(5);
      expect(payload["cancelled"]).toBe(true);
      expect(payload["createRequests"]).toBe(0);
      expect(fixture.requestCount()).toBe(0);
      expect(fixture.createCount()).toBe(0);
    });
  });

  it("sends the previewed bytes even when the file changes after the preview", async () => {
    await withTempDir(async directory => {
      const fixture = await server((_request, response) => {
        json(response, 202, { id: "post_frozen", status: "queued" });
      });
      const file = path.join(directory, "post.json");
      writeFileSync(file, JSON.stringify({ content: CONTENT_BEFORE, platforms: ["bluesky"] }));

      const result = await runCliPty(["posts", "create", "--file", file, "--json"], {
        env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: "k".repeat(24) },
        cwd: directory,
        trigger: PROMPT,
        answer: "y\n",
        beforeAnswer: () => {
          // The operator edits the file while the prompt is on screen.
          writeFileSync(
            file,
            JSON.stringify({ content: CONTENT_AFTER, platforms: ["threads"] }),
          );
        },
      });

      expect(result.code).toBe(0);
      expect(fixture.createCount()).toBe(1);

      const body = fixture.requests[0]?.body as string;
      const sent = JSON.parse(body) as { content: string; platforms: string[] };

      expect(sent.content).toBe(CONTENT_BEFORE);
      expect(sent.platforms).toEqual(["bluesky"]);
      expect(body).not.toContain(CONTENT_AFTER);

      // The published receipt hash matches the bytes the operator approved.
      const payload = parseJsonObject(lastJsonObject(result.output));
      expect(payload["requestSha256"]).toBe(sha256(body));
      expect(payload["accepted"]).toBe(true);
      expect(payload["delivered"]).toBe(false);
      expect(result.output).toContain(CONTENT_BEFORE);
    });
  });

  it("treats an empty answer as a refusal", async () => {
    await withTempDir(async directory => {
      const fixture = await server((_request, response) => {
        json(response, 202, { id: "post_unused", status: "queued" });
      });
      const file = path.join(directory, "post.json");
      writeFileSync(file, JSON.stringify({ content: CONTENT_BEFORE, platforms: ["bluesky"] }));

      const result = await runCliPty(["posts", "create", "--file", file, "--json"], {
        env: { SYNDROO_BASE_URL: fixture.url, SYNDROO_API_KEY: "k".repeat(24) },
        cwd: directory,
        trigger: PROMPT,
        answer: "\n",
      });

      expect(result.code).toBe(5);
      expect(fixture.requestCount()).toBe(0);
    });
  });
});

/**
 * The JSON result is the last JSON object in the merged terminal stream; the
 * echo of the typed answer and the preview come before it, and terminal line
 * wrapping must not be able to hide it.
 */
function lastJsonObject(output: string): string {
  const matches = output.match(/\{[^\n\r{}]*\}/gu) ?? [];
  const last = matches.at(-1);

  if (last === undefined) {
    throw new Error(`no JSON object in terminal output: ${output.slice(0, 800)}`);
  }

  return last;
}
